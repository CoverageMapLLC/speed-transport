import net from 'node:net';
import tls from 'node:tls';
import { generate } from 'selfsigned';
import WebSocket from 'ws';
import { SpeedTransportSocket, type SpeedTransportSocketOptions } from '../src/client/index.js';
import {
  createSpeedTestServer,
  createSpeedTransportServer,
  encodeMaskedFrame,
  type SpeedTestServerOptions,
  type SpeedTransportServer,
  type SpeedTransportServerOptions,
} from '../src/index.js';

export interface Certificate {
  cert: string;
  key: string;
}

let certificate: Promise<Certificate> | null = null;

/** A self-signed certificate for localhost and 127.0.0.1, shared by every test. */
export function getCertificate(): Promise<Certificate> {
  certificate ??= generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  }).then((pems) => ({ cert: pems.cert, key: pems.private }));
  return certificate;
}

export interface Running {
  server: SpeedTransportServer;
  port: number;
  close(): Promise<void>;
}

export async function listen(server: SpeedTransportServer): Promise<Running> {
  const { port } = await server.listen(0, '127.0.0.1');
  return { server, port, close: () => server.close() };
}

/** A speed test server with TLS on an ephemeral port. */
export async function startSpeedTestServer(options: Partial<SpeedTestServerOptions> = {}): Promise<Running> {
  const cert = await getCertificate();
  return listen(createSpeedTestServer({ tls: cert, ...options }));
}

export async function startServer(options: Partial<SpeedTransportServerOptions> & Pick<SpeedTransportServerOptions, 'onConnection'>): Promise<Running> {
  const cert = await getCertificate();
  return listen(createSpeedTransportServer({ tls: cert, ...options }));
}

export type TransportName = 'ws' | 'wss' | 'tcp' | 'tcps';
export const TRANSPORTS: TransportName[] = ['ws', 'wss', 'tcp', 'tcps'];

/** A received message: text or the byte length of a binary message. */
export type Received = { text: string } | { binary: number; bytes?: Buffer };

export interface TestClient {
  received: Received[];
  next(timeoutMs?: number): Promise<Received>;
  nextText(timeoutMs?: number): Promise<string>;
  send(data: string | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Destroys the client's socket without a close handshake. */
  terminate(): void;
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  bufferedAmount(): number;
  raw: WebSocket | SpeedTransportSocket;
}

function makeClient(
  raw: WebSocket | SpeedTransportSocket,
  open: Promise<void>
): Promise<TestClient> {
  const received: Received[] = [];
  const waiters: Array<(message: Received) => void> = [];
  let closeResult: { code: number; reason: string } | null = null;
  const closeWaiters: Array<(result: { code: number; reason: string }) => void> = [];

  const push = (message: Received) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else received.push(message);
  };

  const onMessage = (data: unknown) => {
    if (typeof data === 'string') push({ text: data });
    else if (data instanceof ArrayBuffer) push({ binary: data.byteLength, bytes: Buffer.from(data) });
    else if (Buffer.isBuffer(data)) push({ binary: data.length, bytes: data });
    else push({ binary: -1 });
  };
  const onClose = (code: number, reason: string) => {
    closeResult = { code, reason };
    for (const waiter of closeWaiters.splice(0)) waiter(closeResult);
  };

  if (raw instanceof SpeedTransportSocket) {
    raw.binaryType = 'arraybuffer';
    raw.onmessage = (event) => onMessage(event.data);
    raw.onclose = (event) => onClose(event.code, event.reason);
  } else {
    raw.binaryType = 'nodebuffer';
    raw.on('message', (data: Buffer, isBinary: boolean) => onMessage(isBinary ? data : data.toString('utf8')));
    raw.on('close', (code: number, reason: Buffer) => onClose(code, reason.toString()));
    raw.on('error', () => {});
  }

  const client: TestClient = {
    received,
    raw,
    next(timeoutMs = 5000) {
      const queued = received.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No message within ${timeoutMs} ms`)), timeoutMs);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async nextText(timeoutMs) {
      for (;;) {
        const message = await client.next(timeoutMs);
        if ('text' in message) return message.text;
      }
    },
    send(data) {
      raw.send(data);
    },
    close(code, reason) {
      raw.close(code, reason);
    },
    terminate() {
      if (raw instanceof SpeedTransportSocket) (raw as unknown as { socket: net.Socket }).socket.destroy();
      else raw.terminate();
    },
    closed(timeoutMs = 5000) {
      if (closeResult) return Promise.resolve(closeResult);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Not closed within ${timeoutMs} ms`)), timeoutMs);
        closeWaiters.push((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
    bufferedAmount() {
      return raw.bufferedAmount;
    },
  };
  return open.then(() => client);
}

/** Connects a client over `transport`. WebSocket transports use the `ws` package. */
export function connectClient(
  transport: TransportName,
  port: number,
  options: { path?: string; tcp?: SpeedTransportSocketOptions } = {}
): Promise<TestClient> {
  if (transport === 'tcp' || transport === 'tcps') {
    const socket = new SpeedTransportSocket(`${transport}://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
      ...options.tcp,
    });
    const open = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('close', () => reject(new Error('closed before open')));
    });
    return makeClient(socket, open);
  }
  const ws = new WebSocket(`${transport}://127.0.0.1:${port}${options.path ?? '/'}`, { rejectUnauthorized: false });
  const open = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return makeClient(ws, open);
}

/** A raw socket that collects every byte the server sends. */
export interface RawConnection {
  socket: net.Socket;
  data(): Buffer;
  waitFor(predicate: (data: Buffer) => boolean, timeoutMs?: number): Promise<Buffer>;
  closed(timeoutMs?: number): Promise<{ hadError: boolean; reset: boolean }>;
}

export function rawConnect(port: number, secure = false): Promise<RawConnection> {
  return new Promise((resolve, reject) => {
    let collected = Buffer.alloc(0);
    let closeResult: { hadError: boolean; reset: boolean } | null = null;
    let reset = false;
    const listeners: Array<() => void> = [];
    const socket = secure
      ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => resolve(connection))
      : net.connect(port, '127.0.0.1', () => resolve(connection));
    socket.on('data', (chunk: Buffer) => {
      collected = Buffer.concat([collected, chunk]);
      for (const listener of listeners.slice()) listener();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNRESET') reset = true;
      if (!closeResult && socket.connecting) reject(error);
    });
    socket.on('close', (hadError) => {
      closeResult = { hadError, reset };
      for (const listener of listeners.slice()) listener();
    });
    const connection: RawConnection = {
      socket,
      data: () => collected,
      waitFor(predicate, timeoutMs = 5000) {
        return new Promise((resolveWait, rejectWait) => {
          const check = () => {
            if (predicate(collected)) {
              cleanup();
              resolveWait(collected);
            } else if (closeResult) {
              cleanup();
              rejectWait(new Error(`Connection closed; received ${collected.length} bytes`));
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            rejectWait(new Error(`Condition not met within ${timeoutMs} ms; received ${collected.length} bytes`));
          }, timeoutMs);
          const cleanup = () => {
            clearTimeout(timer);
            const index = listeners.indexOf(check);
            if (index >= 0) listeners.splice(index, 1);
          };
          listeners.push(check);
          check();
        });
      },
      closed(timeoutMs = 5000) {
        if (closeResult) return Promise.resolve(closeResult);
        return new Promise((resolveClose, rejectClose) => {
          const timer = setTimeout(() => rejectClose(new Error(`Not closed within ${timeoutMs} ms`)), timeoutMs);
          const check = () => {
            if (closeResult) {
              clearTimeout(timer);
              resolveClose(closeResult);
            }
          };
          listeners.push(check);
        });
      },
    };
  });
}

/** Performs a WebSocket handshake by hand and returns the raw connection. */
export async function rawWebSocket(port: number, path = '/', secure = false): Promise<RawConnection> {
  const connection = await rawConnect(port, secure);
  connection.socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
  );
  await connection.waitFor((data) => data.includes('\r\n\r\n'));
  return connection;
}

/** Bytes after the HTTP response head. */
export function afterHead(data: Buffer): Buffer {
  const end = data.indexOf('\r\n\r\n');
  return end < 0 ? Buffer.alloc(0) : data.subarray(end + 4);
}

export const masked = encodeMaskedFrame;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the close code from the first close frame in `frames`, if any. */
export function findCloseCode(frames: Buffer): number | null {
  let offset = 0;
  while (offset + 2 <= frames.length) {
    const opcode = frames[offset] & 0x0f;
    let length = frames[offset + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > frames.length) return null;
      length = frames.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > frames.length) return null;
      length = Number(frames.readBigUInt64BE(offset + 2));
      header = 10;
    }
    if (opcode === 0x8) {
      return length >= 2 ? frames.readUInt16BE(offset + header) : 1005;
    }
    offset += header + length;
  }
  return null;
}
