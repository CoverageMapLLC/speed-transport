import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import tls, { type SecureContextOptions, type TLSSocket, type TlsOptions } from 'node:tls';
import { Connection, DEFAULT_CONNECTION_LIMITS, type ConnectionLimits, type TransportKind } from './connection.js';
import { TCP_PREAMBLE, detectProtocol, parseClientHello, type ClientHelloInfo } from './detect.js';
import { buildHttpErrorResponse, buildUpgradeResponse, validateUpgradeRequest } from './handshake.js';
import type { ConnectionLimiter } from './limiter.js';
import { withDefaults } from './defaults.js';

export interface ServerLimits extends ConnectionLimits {
  /** Connections that do not identify their protocol within this time are destroyed. */
  detectTimeoutMs: number;
  /** Largest HTTP request head accepted, in bytes. */
  maxHeaderBytes: number;
}

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  ...DEFAULT_CONNECTION_LIMITS,
  detectTimeoutMs: 10_000,
  maxHeaderBytes: 16 * 1024,
};

/** Who is opening a session. Passed to `authorize` and `clientKey`. */
export interface SessionContext {
  kind: TransportKind;
  secure: boolean;
  remoteAddress: string | undefined;
  /** The HTTP upgrade request for WebSocket sessions, null for raw TCP. */
  request: IncomingMessage | null;
}

/** `true` admits the session; anything else rejects it (with the status for WebSocket). */
export type AuthorizeResult = boolean | { status: number; reason?: string };

export interface SpeedTransportServerOptions {
  /** Called for every established session, on any transport. */
  onConnection: (connection: Connection) => void;
  /**
   * TLS settings. When present, TLS connections are accepted and the decrypted stream is
   * routed again, which gives secure WebSocket and raw TCP over TLS. The certificate can
   * be replaced at runtime with `setSecureContext`.
   */
  tls?: TlsOptions | null;
  /** Accept WebSocket and raw TCP without TLS. Default true. */
  plaintext?: boolean;
  /** Accept the raw TCP transport. Default true. */
  tcp?: boolean;
  /** Accept WebSocket upgrades, optionally only on some paths. Default true, any path. */
  websocket?: boolean | { path?: string | ((pathname: string) => boolean) };
  /** Handles plain HTTP requests on the same port. Default: 404 for everything. */
  requestListener?: (req: IncomingMessage, res: ServerResponse) => void;
  /** Decides whether a session may open, after the handshake and before the limiter. */
  authorize?: (context: SessionContext) => AuthorizeResult | Promise<AuthorizeResult>;
  /** Caps sessions per client, see `ConnectionCounter`. */
  limiter?: ConnectionLimiter;
  /** The key sessions are counted under. Default: the socket's remote address. */
  clientKey?: (context: SessionContext) => string;
  /**
   * Sees the TLS ClientHello before the handshake. Return true to take the socket over,
   * for example to answer an ACME TLS-ALPN-01 challenge. The bytes read so far have been
   * pushed back onto the socket.
   */
  onTlsClientHello?: (hello: ClientHelloInfo, socket: Socket) => boolean;
  limits?: Partial<ServerLimits>;
}

const NOT_FOUND = (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
};

function rejectSocket(socket: Socket, status: number, reason: string, headers?: Record<string, string>): void {
  if (socket.writable) socket.end(buildHttpErrorResponse(status, reason, headers));
  socket.destroySoon?.();
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

/**
 * Serves raw TCP, WebSocket, and secure WebSocket (plus raw TCP over TLS) on one port.
 *
 * `listen` binds a port; `handle` accepts sockets accepted elsewhere, which is how cluster
 * workers and front doors feed it.
 */
export class SpeedTransportServer {
  readonly limits: ServerLimits;
  readonly httpServer: http.Server;
  readonly tlsServer: tls.Server | null;
  private listener: net.Server | null = null;
  private readonly connections = new Set<Connection>();
  private readonly pending = new Set<Socket>();
  private readonly options: SpeedTransportServerOptions;
  private readonly websocketPath: ((pathname: string) => boolean) | null;

  constructor(options: SpeedTransportServerOptions) {
    this.options = options;
    this.limits = withDefaults(DEFAULT_SERVER_LIMITS, options.limits);

    const websocket = options.websocket ?? true;
    if (websocket === false) {
      this.websocketPath = null;
    } else {
      const path = typeof websocket === 'object' ? websocket.path : undefined;
      this.websocketPath =
        path === undefined ? () => true : typeof path === 'string' ? (p) => p === path : path;
    }

    this.httpServer = http.createServer(
      { maxHeaderSize: this.limits.maxHeaderBytes },
      options.requestListener ?? NOT_FOUND
    );
    this.httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.handleUpgrade(req, socket, head);
    });

    if (options.tls) {
      this.tlsServer = tls.createServer({ ALPNProtocols: ['http/1.1'], ...options.tls });
      this.tlsServer.on('secureConnection', (socket: TLSSocket) => this.sniff(socket, true));
      this.tlsServer.on('tlsClientError', (_error, socket) => socket.destroy());
    } else {
      this.tlsServer = null;
    }
  }

  /** Open sessions on every transport. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Replaces the TLS certificate for new connections. */
  setSecureContext(options: SecureContextOptions): void {
    if (!this.tlsServer) throw new Error('This server was created without TLS');
    this.tlsServer.setSecureContext(options);
  }

  /** Binds a TCP port and serves it. */
  listen(port: number, host?: string): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const listener = net.createServer((socket) => this.handle(socket));
      listener.once('error', reject);
      listener.listen(port, host, () => {
        listener.off('error', reject);
        this.listener = listener;
        resolve(listener.address() as AddressInfo);
      });
    });
  }

  address(): AddressInfo | null {
    const address = this.listener?.address();
    return address && typeof address === 'object' ? address : null;
  }

  /** Serves a socket accepted elsewhere. Nothing may have been read from it yet. */
  handle(socket: Socket): void {
    this.sniff(socket, false);
  }

  /** Stops listening and ends every connection. */
  async close(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    for (const connection of this.connections) connection.terminate();
    for (const socket of this.pending) socket.destroy();
    this.pending.clear();
    if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
  }

  /** Reads until the first bytes identify the protocol, then routes the socket. */
  private sniff(socket: Socket, secure: boolean): void {
    this.pending.add(socket);
    socket.on('error', () => {});
    let buffered: Buffer | null = null;

    const timer = setTimeout(() => socket.destroy(), this.limits.detectTimeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      this.pending.delete(socket);
    };
    const onClose = () => done();
    const onData = (chunk: Buffer) => {
      buffered = buffered ? Buffer.concat([buffered, chunk]) : chunk;
      const detected = detectProtocol(buffered, !secure);
      if (detected === 'incomplete') return;
      done();
      socket.pause();
      this.route(socket, detected, buffered, secure);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    // Sockets accepted with pauseOnConnect (cluster hand-off) start paused.
    socket.resume();
  }

  private route(socket: Socket, detected: string, data: Buffer, secure: boolean): void {
    switch (detected) {
      case 'tls': {
        if (!this.tlsServer) {
          socket.destroy();
          return;
        }
        socket.unshift(data);
        if (this.options.onTlsClientHello) {
          const hello = parseClientHello(data);
          if (hello && this.options.onTlsClientHello(hello, socket)) return;
        }
        // The TLS layer reads the socket's native handle itself; resuming here would make
        // the stream consume bytes the handshake needs.
        this.tlsServer.emit('connection', socket);
        return;
      }
      case 'tcp': {
        if ((!secure && this.options.plaintext === false) || this.options.tcp === false) {
          socket.destroy();
          return;
        }
        void this.startTcp(socket, secure, data.subarray(TCP_PREAMBLE.length));
        return;
      }
      case 'http': {
        if (!secure && this.options.plaintext === false) {
          rejectSocket(socket, 400, 'TLS required');
          return;
        }
        socket.unshift(data);
        this.httpServer.emit('connection', socket);
        socket.resume();
        return;
      }
      default:
        socket.destroy();
    }
  }

  /** Runs `authorize` and the limiter. Resolves with a release function, or null if refused. */
  private async admit(
    context: SessionContext
  ): Promise<{ release: () => void } | { status: number; reason: string }> {
    if (this.options.authorize) {
      let result: AuthorizeResult;
      try {
        result = await this.options.authorize(context);
      } catch {
        return { status: 500, reason: 'Authorization failed' };
      }
      if (result !== true) {
        return typeof result === 'object'
          ? { status: result.status, reason: result.reason ?? 'Forbidden' }
          : { status: 403, reason: 'Forbidden' };
      }
    }

    const limiter = this.options.limiter;
    if (!limiter) return { release: () => {} };
    const key = this.options.clientKey?.(context) ?? context.remoteAddress ?? 'unknown';
    let acquired: boolean;
    try {
      acquired = await limiter.acquire(key);
    } catch {
      return { status: 503, reason: 'Connection limit unavailable' };
    }
    if (!acquired) return { status: 429, reason: 'Too many connections' };
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        limiter.release(key);
      },
    };
  }

  private async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on('error', () => {});
    const pathname = (req.url ?? '/').split('?')[0];
    if (!this.websocketPath || !this.websocketPath(pathname)) {
      rejectSocket(socket, 404, 'Not found');
      return;
    }
    const validation = validateUpgradeRequest(req);
    if (!validation.ok) {
      rejectSocket(socket, validation.status, validation.reason, validation.headers);
      return;
    }

    const secure = (socket as TLSSocket).encrypted === true;
    const admission = await this.admit({
      kind: 'websocket',
      secure,
      remoteAddress: socket.remoteAddress,
      request: req,
    });
    if (!('release' in admission)) {
      rejectSocket(socket, admission.status, admission.reason);
      return;
    }
    if (socket.destroyed) {
      admission.release();
      return;
    }

    socket.write(buildUpgradeResponse(validation.key));
    this.open(
      new Connection(socket, { kind: 'websocket', secure, request: req, limits: this.limits, head }),
      admission.release
    );
  }

  private async startTcp(socket: Socket, secure: boolean, head: Buffer): Promise<void> {
    this.pending.add(socket);
    const admission = await this.admit({
      kind: 'tcp',
      secure,
      remoteAddress: socket.remoteAddress,
      request: null,
    });
    this.pending.delete(socket);
    if (!('release' in admission)) {
      socket.destroy();
      return;
    }
    if (socket.destroyed) {
      admission.release();
      return;
    }

    socket.write(TCP_PREAMBLE);
    this.open(new Connection(socket, { kind: 'tcp', secure, limits: this.limits, head }), admission.release);
  }

  private open(connection: Connection, release: () => void): void {
    this.connections.add(connection);
    connection.once('close', () => {
      this.connections.delete(connection);
      release();
    });
    this.options.onConnection(connection);
    connection.start();
  }
}

export function createSpeedTransportServer(options: SpeedTransportServerOptions): SpeedTransportServer {
  return new SpeedTransportServer(options);
}
