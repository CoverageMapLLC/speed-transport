import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpeedTransportCloseEvent,
  SpeedTransportSocket,
  parseTransportUrl,
  probeTcpTransport,
} from '../src/client/index.js';
import type { Connection } from '../src/connection.js';
import { getCertificate, sleep, startServer, startSpeedTestServer, type Running } from './helpers.js';

let running: Running | null = null;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await running?.close();
  running = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function opened(socket: SpeedTransportSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('close', () => reject(new Error('closed')));
  });
}

function closed(socket: SpeedTransportSocket): Promise<SpeedTransportCloseEvent> {
  return new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event as SpeedTransportCloseEvent)));
}

function nextMessage(socket: SpeedTransportSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(event as MessageEvent), { once: true }));
}

/** A server that accepts TCP and never answers. */
async function silentServer(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // It never reads, so it never sees clients leave: destroy its sockets before closing.
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('parseTransportUrl', () => {
  it('parses tcp and tcps URLs', () => {
    expect(parseTransportUrl('tcp://example.com:8080')).toEqual({ secure: false, host: 'example.com', port: 8080 });
    expect(parseTransportUrl('tcps://10.0.0.1:443/ignored')).toEqual({ secure: true, host: '10.0.0.1', port: 443 });
    expect(parseTransportUrl('tcp://[::1]:9000')).toEqual({ secure: false, host: '::1', port: 9000 });
  });

  it('rejects other schemes and missing ports', () => {
    expect(() => parseTransportUrl('ws://example.com:80')).toThrow(SyntaxError);
    expect(() => parseTransportUrl('tcp://example.com')).toThrow(/explicit port/);
    expect(() => new SpeedTransportSocket('wss://x:1')).toThrow(SyntaxError);
  });
});

describe('SpeedTransportSocket', () => {
  it('follows the WebSocket readyState lifecycle and API shape', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    expect(socket.readyState).toBe(SpeedTransportSocket.CONNECTING);
    expect(socket.CONNECTING).toBe(0);
    expect(socket.OPEN).toBe(1);
    expect(socket.url).toBe(`tcp://127.0.0.1:${running.port}`);
    expect(socket.protocol).toBe('');
    expect(socket.extensions).toBe('');
    expect(() => socket.send('early')).toThrow(/CONNECTING/);
    await opened(socket);
    expect(socket.readyState).toBe(SpeedTransportSocket.OPEN);
    socket.close();
    expect(socket.readyState).toBe(SpeedTransportSocket.CLOSING);
    const event = await closed(socket);
    expect(socket.readyState).toBe(SpeedTransportSocket.CLOSED);
    expect(event.code).toBe(1000);
    expect(event.wasClean).toBe(true);
  });

  it('calls onX handlers and addEventListener listeners', async () => {
    running = await startSpeedTestServer();
    const calls: string[] = [];
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    socket.onopen = () => calls.push('onopen');
    socket.addEventListener('open', () => calls.push('listener'));
    socket.onmessage = (event) => calls.push(`onmessage ${event.data}`);
    await opened(socket);
    socket.send('PING');
    await nextMessage(socket);
    socket.close();
    await closed(socket);
    expect(calls).toEqual(['listener', 'onopen', 'onmessage PONG']);
  });

  it('delivers binary as ArrayBuffer or Buffer', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    socket.send('START 2 1');
    const first = await nextMessage(socket);
    expect(first.data).toBeInstanceOf(ArrayBuffer);
    expect((first.data as ArrayBuffer).byteLength).toBe(2048);
    socket.binaryType = 'nodebuffer';
    socket.send('START 3 1');
    const second = await nextMessage(socket);
    expect(Buffer.isBuffer(second.data)).toBe(true);
    expect((second.data as Buffer).length).toBe(3072);
    socket.close();
  });

  it('sends strings, ArrayBuffers, and typed array views', async () => {
    const received: string[] = [];
    running = await startServer({
      onConnection: (c) => c.on('message', (data, binary) => received.push(binary ? data.toString('hex') : data.toString())),
    });
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    socket.send('text');
    socket.send(new Uint8Array([1, 2]).buffer);
    socket.send(new Uint8Array([0, 3, 4, 0]).subarray(1, 3));
    socket.send(new DataView(new Uint8Array([5, 6]).buffer));
    socket.send(new Uint8Array(0));
    await sleep(100);
    expect(received).toEqual(['text', '0102', '0304', '0506', '']);
    socket.close();
  });

  it('never copies bulk payloads in discard mode', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`, { binaryPayloads: 'discard' });
    await opened(socket);
    const payloads: ArrayBuffer[] = [];
    socket.onmessage = (event) => payloads.push(event.data as ArrayBuffer);
    socket.send('START 1024 3');
    socket.send('START 1 1');
    while (payloads.length < 4) await sleep(10);
    const bulk = payloads.filter((p) => p.byteLength === 1024 * 1024);
    expect(bulk).toHaveLength(3);
    expect(bulk[0]).toBe(bulk[1]);
    expect(payloads.find((p) => p.byteLength === 1024)).toBeDefined();
    socket.close();
  });

  it('reports bufferedAmount while data is queued', async () => {
    running = await startServer({ onConnection: () => {} });
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    expect(socket.bufferedAmount).toBe(0);
    for (let i = 0; i < 64; i++) socket.send(new Uint8Array(1024 * 1024));
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    socket.close();
  });

  it('receives server-initiated close codes and reasons', async () => {
    running = await startServer({ onConnection: (c) => c.on('message', () => c.close(4001, 'bye')) });
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    socket.send('x');
    const event = await closed(socket);
    expect([event.code, event.reason, event.wasClean]).toEqual([4001, 'bye', true]);
  });

  it('answers server pings', async () => {
    const pongs: number[] = [];
    let connection: Connection | null = null;
    running = await startServer({
      onConnection: (c) => {
        connection = c;
        c.on('pong', (payload) => pongs.push(payload.length));
      },
    });
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    connection!.ping();
    connection!.ping(Buffer.from('xyz'));
    await sleep(100);
    expect(pongs).toEqual([0, 3]);
    socket.close();
  });

  it('reports 1006 when the server resets the connection', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    socket.send('CLOSE');
    const event = await closed(socket);
    expect(event.code).toBe(1006);
    expect(event.wasClean).toBe(false);
  });

  it('closes before opening without throwing', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    const errors: string[] = [];
    socket.onerror = () => errors.push('error');
    socket.close();
    const event = await closed(socket);
    expect(event.code).toBe(1006);
    expect(errors).toEqual(['error']);
  });

  it('ignores send and close after closing', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${running.port}`);
    await opened(socket);
    socket.close();
    expect(() => socket.send('late')).not.toThrow();
    expect(() => socket.close()).not.toThrow();
    await closed(socket);
    expect(() => socket.send('later')).not.toThrow();
  });

  it('fails a protocol violation from the server with an error event', async () => {
    const server = net.createServer((s) => {
      s.once('data', () => s.write(Buffer.concat([Buffer.from('STCP/1\n'), Buffer.from([0x83, 0x00])])));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, {});
    const errors: string[] = [];
    socket.onerror = () => errors.push('error');
    await opened(socket);
    const event = await closed(socket);
    expect(errors).toEqual(['error']);
    expect(event.code).toBe(1002);
    server.close();
  });
});

describe('SpeedTransportSocket against servers that do not speak raw TCP', () => {
  it('fails against a plain HTTP server', async () => {
    const server = http.createServer((_req, res) => res.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    const errors: string[] = [];
    socket.onerror = () => errors.push('error');
    const event = await closed(socket);
    expect(errors).toEqual(['error']);
    expect(event.code).toBe(1006);
  });

  it('fails against a TLS-only server', async () => {
    const cert = await getCertificate();
    const server = https.createServer(cert, (_req, res) => res.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    expect((await closed(socket)).code).toBe(1006);
  });

  it('times out against a silent server', async () => {
    const port = await silentServer();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${port}`, { connectTimeoutMs: 300 });
    const started = Date.now();
    const event = await closed(socket);
    expect(event.code).toBe(1006);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fails when nothing listens', async () => {
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${await closedPort()}`);
    expect((await closed(socket)).code).toBe(1006);
  });

  // Error handlers commonly call close(). Before 0.1.1 that re-entered the failure and
  // dispatched error again until the stack overflowed.
  it.each([
    ['a plain HTTP server answers the preamble', async () => {
      const server = http.createServer((_req, res) => res.end('hi'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
      return { port: (server.address() as net.AddressInfo).port, options: {} };
    }],
    ['the server never answers', async () => ({ port: await silentServer(), options: { connectTimeoutMs: 200 } })],
    ['nothing listens', async () => ({ port: await closedPort(), options: {} })],
  ])('dispatches one error and one close when %s and the error handler calls close()', async (_case, start) => {
    const { port, options } = await start();
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${port}`, options);
    const events: string[] = [];
    socket.onerror = () => {
      events.push('error');
      socket.close();
    };
    socket.addEventListener('close', () => events.push('close'));
    await closed(socket);
    await sleep(50);
    expect(events).toEqual(['error', 'close']);
    expect(socket.readyState).toBe(SpeedTransportSocket.CLOSED);
  });

  it('dispatches one error and one close when closed while connecting', async () => {
    const socket = new SpeedTransportSocket(`tcp://127.0.0.1:${await silentServer()}`);
    const events: string[] = [];
    socket.onerror = () => {
      events.push('error');
      socket.close();
    };
    socket.addEventListener('close', () => events.push('close'));
    socket.close();
    await closed(socket);
    await sleep(50);
    expect(events).toEqual(['error', 'close']);
  });
});

describe('SpeedTransportSocket over TLS', () => {
  it('verifies certificates by default', async () => {
    running = await startSpeedTestServer();
    const socket = new SpeedTransportSocket(`tcps://127.0.0.1:${running.port}`);
    expect((await closed(socket)).code).toBe(1006);
  });

  it('follows NODE_TLS_REJECT_UNAUTHORIZED like the built-in WebSocket', async () => {
    running = await startSpeedTestServer();
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    cleanups.push(() => {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    });
    const socket = new SpeedTransportSocket(`tcps://127.0.0.1:${running.port}`);
    await opened(socket);
    socket.close();
    await closed(socket);

    // An explicit option still wins over the environment.
    const strict = new SpeedTransportSocket(`tcps://127.0.0.1:${running.port}`, { rejectUnauthorized: true });
    expect((await closed(strict)).code).toBe(1006);
  });

  it('accepts a certificate from a custom CA', async () => {
    running = await startSpeedTestServer();
    const cert = await getCertificate();
    const socket = new SpeedTransportSocket(`tcps://127.0.0.1:${running.port}`, { ca: cert.cert });
    await opened(socket);
    socket.send('PING');
    expect((await nextMessage(socket)).data).toBe('PONG');
    socket.close();
  });
});

describe('probeTcpTransport', () => {
  it('reports servers that speak the raw TCP transport', async () => {
    running = await startSpeedTestServer();
    expect(await probeTcpTransport('127.0.0.1', running.port)).toBe(true);
    expect(await probeTcpTransport('127.0.0.1', running.port, { secure: true, rejectUnauthorized: false })).toBe(true);
  });

  it('verifies certificates by default over TLS', async () => {
    running = await startSpeedTestServer();
    expect(await probeTcpTransport('127.0.0.1', running.port, { secure: true })).toBe(false);
  });

  it('reports servers that do not', async () => {
    const cert = await getCertificate();
    const tlsOnly = https.createServer(cert);
    await new Promise<void>((resolve) => tlsOnly.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => tlsOnly.close(() => resolve())));
    expect(await probeTcpTransport('127.0.0.1', (tlsOnly.address() as net.AddressInfo).port, { timeoutMs: 2000 })).toBe(false);

    const silent = await silentServer();
    expect(await probeTcpTransport('127.0.0.1', silent, { timeoutMs: 300 })).toBe(false);
    expect(await probeTcpTransport('127.0.0.1', await closedPort())).toBe(false);
  });

  it('does not hold a connection slot afterwards', async () => {
    const { ConnectionCounter } = await import('../src/limiter.js');
    const counter = new ConnectionCounter(1);
    running = await startSpeedTestServer({ limiter: counter });
    expect(await probeTcpTransport('127.0.0.1', running.port)).toBe(true);
    await sleep(100);
    expect(counter.total).toBe(0);
  });
});
