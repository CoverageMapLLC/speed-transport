import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createClusterPrimary,
  runClusterWorker,
  type ClusterChild,
  type ClusterPrimary,
  type PrimaryToWorkerMessage,
  type WorkerChannel,
  type WorkerToPrimaryMessage,
} from '../src/cluster.js';
import { createSpeedTestServer } from '../src/speedtest.js';
import { TRANSPORTS, connectClient, getCertificate, sleep } from './helpers.js';

interface FakeWorker extends ClusterChild {
  connections: number;
  crash(): void;
  messages: unknown[];
}

/** Runs the real worker logic in this process, bridged through an in-memory channel. */
function inProcessWorker(limited = true): FakeWorker {
  const toWorker = new EventEmitter();
  const toPrimary = new EventEmitter();
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    setImmediate(() => toPrimary.emit('exit', code));
  };
  const channel: WorkerChannel = {
    send: (message: WorkerToPrimaryMessage) => {
      if (!exited) setImmediate(() => toPrimary.emit('message', message));
    },
    on: (event, listener) => toWorker.on(event, listener),
  };
  const worker = {
    connections: 0,
    messages: [] as unknown[],
    send(message: PrimaryToWorkerMessage, handle?: Socket, callback?: (error: Error | null) => void) {
      if (message.type === 'speed-transport:connection') worker.connections++;
      setImmediate(() => {
        if (exited) {
          callback?.(new Error('worker exited'));
          return;
        }
        toWorker.emit('message', message, handle);
        callback?.(null);
      });
    },
    on(event: string, listener: (...args: any[]) => void) {
      toPrimary.on(event, listener);
    },
    kill: () => exit(null),
    crash: () => {
      toWorker.emit('message', { type: 'speed-transport:stop' });
      exit(1);
    },
  } as FakeWorker;

  runClusterWorker(
    (context) => {
      context.onBroadcast((message) => worker.messages.push(message));
      return createSpeedTestServer({
        tls: {},
        limiter: limited ? context.limiter : undefined,
        requestListener: (_req, res) => {
          context.request({ ask: 'status' }).then(
            (answer) => res.end(JSON.stringify(answer)),
            (error: Error) => {
              res.statusCode = 500;
              res.end(error.message);
            }
          );
        },
      });
    },
    channel,
    () => exit(0)
  );
  return worker;
}

function get(url: string): Promise<{ status: number; body: string }> {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    client
      .get(url, { rejectUnauthorized: false, agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

let primary: ClusterPrimary | null = null;
afterEach(async () => {
  await primary?.stop();
  primary = null;
});

async function startInProcess(workers: number, options: { maxConnectionsPerClient?: number; onRequest?: (m: unknown) => unknown; limited?: boolean } = {}) {
  const cert = await getCertificate();
  const spawned: FakeWorker[] = [];
  primary = createClusterPrimary({
    workers,
    workerModule: 'unused',
    port: 0,
    host: '127.0.0.1',
    secureContext: cert,
    maxConnectionsPerClient: options.maxConnectionsPerClient,
    onRequest: options.onRequest,
    restartDelayMs: 50,
    spawnWorker: () => {
      const worker = inProcessWorker(options.limited ?? true);
      spawned.push(worker);
      return worker;
    },
  });
  const { port } = await primary.start();
  return { port, workers: spawned };
}

describe('cluster with in-process workers', () => {
  it('serves every transport through the workers', async () => {
    const { port } = await startInProcess(2);
    for (const transport of TRANSPORTS) {
      const client = await connectClient(transport, port);
      client.send('PING');
      expect(await client.next()).toEqual({ text: 'PONG' });
      client.close();
    }
  });

  it('hands connections to the workers in turn', async () => {
    const { port, workers } = await startInProcess(3);
    const clients = await Promise.all(Array.from({ length: 6 }, () => connectClient('tcp', port)));
    expect(workers.map((w) => w.connections)).toEqual([2, 2, 2]);
    for (const client of clients) client.close();
  });

  it('enforces the connection limit across workers', async () => {
    const { port, workers } = await startInProcess(2, { maxConnectionsPerClient: 2 });
    const a = await connectClient('ws', port);
    const b = await connectClient('tcp', port);
    expect(workers.map((w) => w.connections)).toEqual([1, 1]);
    await expect(connectClient('tcps', port)).rejects.toThrow();
    a.close();
    await a.closed();
    await sleep(50);
    const c = await connectClient('wss', port);
    c.send('PING');
    expect(await c.next()).toEqual({ text: 'PONG' });
    b.close();
    c.close();
  });

  it('broadcasts messages to every worker', async () => {
    const { workers } = await startInProcess(3);
    primary!.broadcast({ hello: 'workers' });
    await sleep(20);
    expect(workers.map((w) => w.messages)).toEqual([[{ hello: 'workers' }], [{ hello: 'workers' }], [{ hello: 'workers' }]]);
  });

  it('answers worker requests through onRequest', async () => {
    const { port } = await startInProcess(2, { onRequest: (m) => ({ answered: m }) });
    expect(await get(`http://127.0.0.1:${port}/`)).toEqual({ status: 200, body: '{"answered":{"ask":"status"}}' });
  });

  it('reports request failures to the worker', async () => {
    const { port } = await startInProcess(1, {
      onRequest: () => {
        throw new Error('no status');
      },
    });
    expect(await get(`http://127.0.0.1:${port}/`)).toEqual({ status: 500, body: 'no status' });
  });

  it('applies certificate updates to every worker', async () => {
    const { port } = await startInProcess(2);
    const { generate } = await import('selfsigned');
    const fresh = await generate([{ name: 'commonName', value: 'rotated' }], { keySize: 2048 });
    primary!.setSecureContext({ cert: fresh.cert, key: fresh.private });
    await sleep(50);
    const tls = await import('node:tls');
    for (let i = 0; i < 2; i++) {
      const subject = await new Promise<string>((resolve) => {
        const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
          resolve(String(socket.getPeerCertificate().subject.CN));
          socket.destroy();
        });
      });
      expect(subject).toBe('rotated');
    }
  });

  it("releases a crashed worker's connection slots and restarts it", async () => {
    const { port, workers } = await startInProcess(2, { maxConnectionsPerClient: 1 });
    const client = await connectClient('tcp', port);
    await expect(connectClient('tcp', port)).rejects.toThrow();
    workers[0].crash();
    await client.closed();
    await sleep(200);
    expect(workers).toHaveLength(3);
    expect(primary!.readyWorkers).toBe(2);
    const replacement = await connectClient('tcp', port);
    replacement.send('PING');
    expect(await replacement.next()).toEqual({ text: 'PONG' });
    replacement.close();
  });

  it('stops every worker on stop', async () => {
    const { workers } = await startInProcess(3);
    const exits: Array<number | null> = [];
    for (const worker of workers) worker.on('exit', (code) => exits.push(code));
    await primary!.stop();
    primary = null;
    expect(exits).toEqual([0, 0, 0]);
  });

  it('fails to start when a worker dies before it is ready', async () => {
    primary = createClusterPrimary({
      workers: 1,
      workerModule: 'unused',
      port: 0,
      spawnWorker: () => {
        const emitter = new EventEmitter();
        setImmediate(() => emitter.emit('exit', 1));
        return { send: () => true, on: (e: string, l: (...a: any[]) => void) => emitter.on(e, l), kill: () => {} } as ClusterChild;
      },
    });
    await expect(primary.start()).rejects.toThrow(/before it was ready/);
    primary = null;
  });

  it('refuses to start twice', async () => {
    await startInProcess(1);
    await expect(primary!.start()).rejects.toThrow(/already started/);
  });
});

describe('cluster with real worker processes', () => {
  const workerModule = fileURLToPath(new URL('./fixtures/cluster-worker.mjs', import.meta.url));

  async function startReal(workers: number, options: { limited?: boolean; maxConnectionsPerClient?: number } = {}) {
    const cert = await getCertificate();
    primary = createClusterPrimary({
      workers,
      workerModule,
      port: 0,
      host: '127.0.0.1',
      secureContext: cert,
      workerData: { limited: options.limited ?? false },
      maxConnectionsPerClient: options.maxConnectionsPerClient,
      onRequest: (message) => ({ primary: process.pid, message }),
      restartDelayMs: 100,
    });
    return (await primary.start()).port;
  }

  it('spreads connections across processes over every transport', async () => {
    const port = await startReal(3);
    const pids = new Set<string>();
    for (let i = 0; i < 6; i++) pids.add((await get(`${i % 2 ? 'https' : 'http'}://127.0.0.1:${port}/pid`)).body);
    expect(pids.size).toBe(3);
    for (const transport of TRANSPORTS) {
      const client = await connectClient(transport, port);
      client.send('START 1024 8');
      let bytes = 0;
      while (bytes < 8 * 1024 * 1024) {
        const message = await client.next();
        if ('binary' in message) bytes += message.binary;
      }
      client.send(Buffer.alloc(1024 * 1024));
      expect(await client.nextText()).toBe('ACK');
      client.close();
    }
  });

  it('answers worker requests from the primary', async () => {
    const port = await startReal(2);
    const answer = JSON.parse((await get(`http://127.0.0.1:${port}/ask`)).body);
    expect(answer.primary).toBe(process.pid);
    expect(answer.message.from).not.toBe(process.pid);
  });

  it('enforces the global limit across processes', async () => {
    const port = await startReal(2, { limited: true, maxConnectionsPerClient: 2 });
    const a = await connectClient('tcp', port);
    const b = await connectClient('ws', port);
    await expect(connectClient('tcp', port)).rejects.toThrow();
    a.close();
    b.close();
  });

  it('restarts a worker process that exits', async () => {
    const port = await startReal(2);
    const pid = (await get(`http://127.0.0.1:${port}/pid`)).body;
    primary!.broadcast({ type: 'crash', pid: Number(pid) });
    await sleep(1500);
    expect(primary!.readyWorkers).toBe(2);
    const pids = new Set<string>();
    for (let i = 0; i < 4; i++) pids.add((await get(`http://127.0.0.1:${port}/pid`)).body);
    expect(pids.has(pid)).toBe(false);
    expect(pids.size).toBe(2);
  });
});
