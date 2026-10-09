import { fork } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { availableParallelism } from 'node:os';
import type { SecureContextOptions } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { ConnectionCounter, type ConnectionLimiter } from './limiter.js';
import type { SpeedTransportServer } from './server.js';

/**
 * Multi-process serving. One Node.js process can only encrypt, decrypt, and frame a few
 * Gbps, so a primary process accepts TCP connections paused (nothing read) and hands each
 * socket to the next worker process. Workers run a `SpeedTransportServer` and detect the
 * protocol themselves. The primary owns what must exist once: the listener, per-client
 * connection counts, and the TLS certificate.
 */

const PREFIX = 'speed-transport:';

/** Serializable TLS settings: PEM strings rather than Buffers. */
export interface SerializableSecureContext {
  cert?: string | string[];
  key?: string | string[];
  ca?: string | string[];
  passphrase?: string;
  ciphers?: string;
  minVersion?: SecureContextOptions['minVersion'];
  maxVersion?: SecureContextOptions['maxVersion'];
}

export type PrimaryToWorkerMessage =
  | { type: `${typeof PREFIX}init`; workerData: unknown; secureContext: SerializableSecureContext | null }
  | { type: `${typeof PREFIX}secure-context`; options: SerializableSecureContext }
  | { type: `${typeof PREFIX}connection` }
  | { type: `${typeof PREFIX}acquired`; id: number; ok: boolean }
  | { type: `${typeof PREFIX}broadcast`; message: unknown }
  | { type: `${typeof PREFIX}reply`; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: `${typeof PREFIX}stop` };

export type WorkerToPrimaryMessage =
  | { type: `${typeof PREFIX}ready` }
  | { type: `${typeof PREFIX}acquire`; id: number; key: string }
  | { type: `${typeof PREFIX}release`; key: string }
  | { type: `${typeof PREFIX}request`; id: number; message: unknown };

/** The primary's end of one worker. `ChildProcess` satisfies it. */
export interface ClusterChild {
  send(message: PrimaryToWorkerMessage, handle?: Socket, callback?: (error: Error | null) => void): unknown;
  on(event: 'message', listener: (message: WorkerToPrimaryMessage) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

/** The worker's end of the IPC channel. `process` satisfies it in a forked worker. */
export interface WorkerChannel {
  send(message: WorkerToPrimaryMessage): unknown;
  on(event: 'message', listener: (message: PrimaryToWorkerMessage, handle?: unknown) => void): unknown;
}

export interface ClusterLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const silentLogger: ClusterLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Worker count for a configured value: `0` means one per core, up to `maxAuto`. */
export function resolveWorkerCount(configured: number, maxAuto = 6, cores = availableParallelism()): number {
  if (configured > 0) return Math.floor(configured);
  return Math.max(1, Math.min(cores, maxAuto));
}

export interface ClusterPrimaryOptions {
  /** Worker processes to run. Must be at least 1. */
  workers: number;
  /** Module each worker runs. It must call `runClusterWorker`. */
  workerModule: string | URL;
  port: number;
  host?: string;
  /** Sessions allowed per client key across all workers. Unlimited when unset. */
  maxConnectionsPerClient?: number;
  /** Passed to every worker's setup function. Must be serializable. */
  workerData?: unknown;
  /** TLS settings sent to every worker. Can be replaced later with `setSecureContext`. */
  secureContext?: SerializableSecureContext;
  /** Answers `context.request` calls from workers. */
  onRequest?: (message: unknown) => unknown;
  /** Starts one worker. Defaults to forking `workerModule`; tests run workers in process. */
  spawnWorker?: () => ClusterChild;
  logger?: ClusterLogger;
  /** Delay before replacing a worker that exited. Default 1 s. */
  restartDelayMs?: number;
  /** Workers still running this long after `stop` are killed. Default 5 s. */
  stopTimeoutMs?: number;
}

export interface ClusterPrimary {
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
  /** Delivers a message to every worker's `onBroadcast` listeners. */
  broadcast(message: unknown): void;
  /** Replaces the TLS certificate in every worker, and in workers started later. */
  setSecureContext(options: SerializableSecureContext): void;
  address(): AddressInfo | null;
  /** Workers currently ready for connections. */
  readonly readyWorkers: number;
}

interface WorkerSlot {
  child: ClusterChild;
  ready: boolean;
  /** Connection slots this worker holds per key, released if it dies. */
  held: Map<string, number>;
  exited: Promise<void>;
}

export function createClusterPrimary(options: ClusterPrimaryOptions): ClusterPrimary {
  const logger = options.logger ?? silentLogger;
  const workerCount = Math.max(1, Math.floor(options.workers));
  const counter = options.maxConnectionsPerClient
    ? new ConnectionCounter(options.maxConnectionsPerClient)
    : null;
  const spawnWorker =
    options.spawnWorker ??
    (() => {
      const modulePath =
        options.workerModule instanceof URL ? fileURLToPath(options.workerModule) : options.workerModule;
      return fork(modulePath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }) as unknown as ClusterChild;
    });
  const restartDelayMs = options.restartDelayMs ?? 1000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5000;

  const slots: WorkerSlot[] = [];
  let secureContext: SerializableSecureContext | null = options.secureContext ?? null;
  let listener: NetServer | null = null;
  let started = false;
  let stopping = false;
  let nextWorker = 0;

  const send = (slot: WorkerSlot, message: PrimaryToWorkerMessage, handle?: Socket, callback?: (error: Error | null) => void) => {
    try {
      slot.child.send(message, handle, callback);
    } catch (error) {
      callback?.(error as Error);
    }
  };

  const broadcastRaw = (message: PrimaryToWorkerMessage) => {
    for (const slot of slots) {
      if (slot.ready) send(slot, message);
    }
  };

  const startWorker = (index: number): Promise<void> =>
    new Promise<void>((resolveReady, rejectReady) => {
      const child = spawnWorker();
      let wasReady = false;
      let markExited: () => void = () => {};
      const slot: WorkerSlot = {
        child,
        ready: false,
        held: new Map(),
        exited: new Promise<void>((done) => {
          markExited = done;
        }),
      };
      slots[index] = slot;

      child.on('message', (message) => {
        switch (message?.type) {
          case `${PREFIX}ready`:
            slot.ready = true;
            wasReady = true;
            resolveReady();
            break;
          case `${PREFIX}acquire`: {
            const ok = counter ? counter.acquire(message.key) : true;
            if (ok && counter) slot.held.set(message.key, (slot.held.get(message.key) ?? 0) + 1);
            send(slot, { type: `${PREFIX}acquired`, id: message.id, ok });
            break;
          }
          case `${PREFIX}release`: {
            const held = slot.held.get(message.key) ?? 0;
            if (held === 0) break;
            if (held === 1) slot.held.delete(message.key);
            else slot.held.set(message.key, held - 1);
            counter?.release(message.key);
            break;
          }
          case `${PREFIX}request`:
            Promise.resolve()
              .then(() => {
                if (!options.onRequest) throw new Error('The primary does not handle requests');
                return options.onRequest(message.message);
              })
              .then(
                (value) => send(slot, { type: `${PREFIX}reply`, id: message.id, ok: true, value }),
                (error: unknown) =>
                  send(slot, {
                    type: `${PREFIX}reply`,
                    id: message.id,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  })
              );
            break;
        }
      });

      child.on('exit', (code) => {
        slot.ready = false;
        for (const [key, held] of slot.held) {
          for (let i = 0; i < held; i++) counter?.release(key);
        }
        slot.held.clear();
        markExited();
        if (!wasReady) {
          rejectReady(new Error(`Worker ${index} exited with code ${code} before it was ready`));
        } else if (started && !stopping) {
          logger.error(`Worker ${index} exited with code ${code}, restarting`);
          setTimeout(() => {
            if (!started || stopping) return;
            startWorker(index).catch((error: unknown) =>
              logger.error(`Worker ${index} failed to restart: ${(error as Error).message}`)
            );
          }, restartDelayMs).unref?.();
        }
      });

      send(slot, { type: `${PREFIX}init`, workerData: options.workerData ?? null, secureContext });
    });

  /** Hands an unread socket to the next ready worker. */
  const dispatch = (socket: Socket) => {
    for (let i = 0; i < slots.length; i++) {
      const index = (nextWorker + i) % slots.length;
      const slot = slots[index];
      if (!slot?.ready) continue;
      nextWorker = (index + 1) % slots.length;
      send(slot, { type: `${PREFIX}connection` }, socket, (error) => {
        if (error) socket.destroy();
      });
      return;
    }
    socket.destroy();
  };

  const stopWorkers = async () => {
    await Promise.all(
      slots.map(async (slot) => {
        send(slot, { type: `${PREFIX}stop` });
        const timer = setTimeout(() => slot.child.kill(), stopTimeoutMs);
        await slot.exited;
        clearTimeout(timer);
      })
    );
    slots.length = 0;
  };

  const closeListener = () =>
    new Promise<void>((resolve) => {
      const server = listener;
      listener = null;
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

  const address = (): AddressInfo | null => {
    const info = listener?.address();
    return info && typeof info === 'object' ? info : null;
  };

  return {
    async start() {
      if (started) throw new Error('Cluster already started');
      started = true;
      stopping = false;
      try {
        await Promise.all(Array.from({ length: workerCount }, (_, index) => startWorker(index)));
        await new Promise<void>((resolve, reject) => {
          const server = createNetServer({ pauseOnConnect: true }, dispatch);
          server.once('error', reject);
          server.listen(options.port, options.host, () => {
            server.off('error', reject);
            listener = server;
            resolve();
          });
        });
      } catch (error) {
        started = false;
        stopping = true;
        await closeListener();
        await stopWorkers();
        throw error;
      }
      return address() as AddressInfo;
    },
    async stop() {
      if (!started) return;
      started = false;
      stopping = true;
      await closeListener();
      await stopWorkers();
    },
    broadcast(message: unknown) {
      broadcastRaw({ type: `${PREFIX}broadcast`, message });
    },
    setSecureContext(context: SerializableSecureContext) {
      secureContext = context;
      broadcastRaw({ type: `${PREFIX}secure-context`, options: context });
    },
    address,
    get readyWorkers() {
      return slots.filter((slot) => slot?.ready).length;
    },
  };
}

export interface WorkerContext {
  /** `workerData` from the primary. */
  workerData: unknown;
  /** Connection limiter backed by the primary's global counts. */
  limiter: ConnectionLimiter;
  /** Sends a message to the primary's `onRequest` and resolves with its answer. */
  request(message: unknown, timeoutMs?: number): Promise<unknown>;
  /** Receives messages from `ClusterPrimary.broadcast`. */
  onBroadcast(listener: (message: unknown) => void): void;
}

/**
 * Runs the worker side of a cluster on `channel` (the process IPC channel by default).
 * `setup` creates the server; sockets from the primary are fed to `server.handle`.
 */
export function runClusterWorker(
  setup: (context: WorkerContext) => SpeedTransportServer | Promise<SpeedTransportServer>,
  channel: WorkerChannel = process as unknown as WorkerChannel,
  onStop: () => void = () => process.exit(0)
): void {
  let server: SpeedTransportServer | null = null;
  let pendingSecureContext: SerializableSecureContext | null = null;
  const broadcastListeners: Array<(message: unknown) => void> = [];
  const pendingAcquires = new Map<number, (ok: boolean) => void>();
  const pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;

  if (channel === (process as unknown as WorkerChannel)) {
    // The primary coordinates shutdown; terminal signals reach the whole process group.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    process.on('disconnect', () => process.exit(0));
  }

  const limiter: ConnectionLimiter = {
    acquire(key) {
      const id = ++nextId;
      return new Promise<boolean>((resolve) => {
        pendingAcquires.set(id, resolve);
        channel.send({ type: `${PREFIX}acquire`, id, key });
      });
    },
    release(key) {
      channel.send({ type: `${PREFIX}release`, key });
    },
  };

  const context: WorkerContext = {
    workerData: null,
    limiter,
    request(message, timeoutMs = 10_000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error('Timed out waiting for the primary process'));
        }, timeoutMs);
        timer.unref?.();
        pendingRequests.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        channel.send({ type: `${PREFIX}request`, id, message });
      });
    },
    onBroadcast(listener) {
      broadcastListeners.push(listener);
    },
  };

  channel.on('message', (message, handle) => {
    switch (message?.type) {
      case `${PREFIX}init`:
        context.workerData = message.workerData;
        Promise.resolve(setup(context)).then(
          (created) => {
            server = created;
            if (message.secureContext) server.setSecureContext(message.secureContext);
            if (pendingSecureContext) server.setSecureContext(pendingSecureContext);
            pendingSecureContext = null;
            channel.send({ type: `${PREFIX}ready` });
          },
          (error: unknown) => {
            console.error(`Worker setup failed: ${(error as Error).message}`);
            process.exit(1);
          }
        );
        break;
      case `${PREFIX}secure-context`:
        if (server) server.setSecureContext(message.options);
        else pendingSecureContext = message.options;
        break;
      case `${PREFIX}connection`:
        if (!handle) break;
        if (server) server.handle(handle as Socket);
        else (handle as Socket).destroy();
        break;
      case `${PREFIX}acquired`: {
        const resolve = pendingAcquires.get(message.id);
        pendingAcquires.delete(message.id);
        resolve?.(message.ok);
        break;
      }
      case `${PREFIX}reply`: {
        const pending = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        if (!pending) break;
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? 'Request failed'));
        break;
      }
      case `${PREFIX}broadcast`:
        for (const listener of broadcastListeners) listener(message.message);
        break;
      case `${PREFIX}stop`: {
        for (const resolve of pendingAcquires.values()) resolve(false);
        pendingAcquires.clear();
        const closing = server ? server.close() : Promise.resolve();
        void closing.finally(onStop);
        break;
      }
    }
  });
}
