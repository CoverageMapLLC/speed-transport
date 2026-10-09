import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { TCP_PREAMBLE } from '../src/detect.js';
import { Opcode, encodeFrame, encodeMaskedFrame } from '../src/frame.js';
import { ConnectionCounter } from '../src/limiter.js';
import { TRANSPORTS, connectClient, rawWebSocket, sleep, startSpeedTestServer, type Running } from './helpers.js';

let running: Running | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** Opens a raw connection, sends `chunks` with small pauses, and waits for the server to close it or for `waitMs`. */
async function blast(port: number, chunks: Buffer[], secure = false, waitMs = 300): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = secure
      ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
      : net.connect(port, '127.0.0.1');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };
    socket.on('error', finish);
    socket.on('close', finish);
    socket.once(secure ? 'secureConnect' : 'connect', async () => {
      for (const chunk of chunks) {
        if (socket.destroyed) break;
        socket.write(chunk);
        await sleep(1);
      }
      setTimeout(finish, waitMs);
    });
  });
}

async function assertHealthy(port: number): Promise<void> {
  for (const transport of TRANSPORTS) {
    const client = await connectClient(transport, port);
    client.send('PING');
    expect(await client.next()).toEqual({ text: 'PONG' });
    client.close();
    await client.closed();
  }
}

describe('fuzzing every entry point', () => {
  it('survives random first bytes', async () => {
    running = await startSpeedTestServer({ limits: { detectTimeoutMs: 200 } });
    await Promise.all(Array.from({ length: 100 }, () => blast(running!.port, [randomBytes(1 + Math.floor(Math.random() * 64))], false, 50)));
    await assertHealthy(running.port);
  });

  it('survives random frames after the raw TCP preamble', async () => {
    running = await startSpeedTestServer();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        blast(running!.port, [TCP_PREAMBLE, randomBytes(1 + Math.floor(Math.random() * 2000))], i % 2 === 1, 50)
      )
    );
    await assertHealthy(running.port);
  });

  it('survives random frames after a WebSocket handshake', async () => {
    running = await startSpeedTestServer();
    for (let i = 0; i < 60; i++) {
      const conn = await rawWebSocket(running.port, '/', i % 2 === 1);
      conn.socket.write(randomBytes(1 + Math.floor(Math.random() * 2000)));
      await Promise.race([conn.closed(), sleep(50)]);
      conn.socket.destroy();
    }
    await assertHealthy(running.port);
  });

  it('survives random HTTP request lines and headers', async () => {
    running = await startSpeedTestServer();
    const lines = [
      'GET / HTTP/1.1\r\n\r\n',
      'GET /v1/ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n',
      'POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello',
      'GET / HTTP/9.9\r\n\r\n',
      'GET\r\n\r\n',
      `GET /${'a'.repeat(20000)} HTTP/1.1\r\n\r\n`,
      'GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: !!!!\r\n\r\n',
    ];
    await Promise.all(lines.map((line) => blast(running!.port, [Buffer.from(line)], false, 100)));
    await Promise.all(lines.map((line) => blast(running!.port, [Buffer.from(line)], true, 100)));
    await assertHealthy(running.port);
  });

  it('survives random bytes inside TLS before the inner protocol is known', async () => {
    running = await startSpeedTestServer({ limits: { detectTimeoutMs: 200 } });
    await Promise.all(Array.from({ length: 30 }, () => blast(running!.port, [randomBytes(64)], true, 50)));
    await assertHealthy(running.port);
  });

  it('survives garbage that pretends to be TLS', async () => {
    running = await startSpeedTestServer();
    await Promise.all(
      Array.from({ length: 30 }, () => blast(running!.port, [Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), randomBytes(200)])], false, 50))
    );
    await assertHealthy(running.port);
  });
});

describe('abrupt disconnects', () => {
  const stages: Array<[string, Buffer[]]> = [
    ['mid preamble', [TCP_PREAMBLE.subarray(0, 3)]],
    ['mid frame header', [TCP_PREAMBLE, Buffer.from([0x82, 0x7f, 0x00])]],
    ['mid payload', [TCP_PREAMBLE, Buffer.concat([Buffer.from([0x82, 0x7e, 0x10, 0x00]), Buffer.alloc(1000)])]],
    ['mid HTTP head', [Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n')]],
    ['during a download', [TCP_PREAMBLE, encodeFrame(Opcode.Text, Buffer.from('START 1024 100'))]],
  ];

  it.each(stages)('leaves no session behind when a client vanishes %s', async (_name, chunks) => {
    const counter = new ConnectionCounter(1000);
    running = await startSpeedTestServer({ limiter: counter });
    for (let i = 0; i < 10; i++) await blast(running.port, chunks, i % 2 === 1, 20);
    await sleep(200);
    expect(running.server.connectionCount).toBe(0);
    expect(counter.total).toBe(0);
    await assertHealthy(running.port);
  });

  it('cleans up hundreds of short sessions', async () => {
    const counter = new ConnectionCounter(10000);
    running = await startSpeedTestServer({ limiter: counter });
    for (let round = 0; round < 5; round++) {
      const clients = await Promise.all(Array.from({ length: 40 }, (_, i) => connectClient(TRANSPORTS[i % 4], running!.port)));
      for (const client of clients) client.close();
      await Promise.all(clients.map((client) => client.closed()));
    }
    await sleep(100);
    expect(running.server.connectionCount).toBe(0);
    expect(counter.total).toBe(0);
  });
});

describe('interoperability with the ws client', () => {
  it('handles fragmented messages and pings from ws', async () => {
    running = await startSpeedTestServer();
    const ws = new WebSocket(`ws://127.0.0.1:${running.port}/`);
    await new Promise((resolve) => ws.once('open', resolve));
    const messages: string[] = [];
    ws.on('message', (data) => messages.push(data.toString()));
    const pong = new Promise((resolve) => ws.once('pong', resolve));
    ws.ping('abc');
    await pong;
    ws.send(Buffer.alloc(100), { fin: false, binary: true });
    ws.send(Buffer.alloc(100), { fin: true, binary: true });
    ws.send('PI', { fin: false });
    ws.send('NG', { fin: true });
    while (messages.length < 2) await sleep(10);
    expect(messages).toEqual(['ACK', 'PONG']);
    ws.close();
  });

  it('streams large downloads to ws intact', async () => {
    running = await startSpeedTestServer();
    const ws = new WebSocket(`wss://127.0.0.1:${running.port}/`, { rejectUnauthorized: false });
    await new Promise((resolve) => ws.once('open', resolve));
    let bytes = 0;
    let nonZero = false;
    ws.on('message', (data: Buffer, isBinary) => {
      if (!isBinary) return;
      bytes += data.length;
      if (data.some((b) => b !== 0)) nonZero = true;
    });
    ws.send('START 4096 10');
    while (bytes < 40 * 1024 * 1024) await sleep(20);
    expect(bytes).toBe(40 * 1024 * 1024);
    expect(nonZero).toBe(false);
    ws.close();
  });

  it('accepts masked frames from a hand-written client with every mask', async () => {
    running = await startSpeedTestServer();
    const conn = await rawWebSocket(running.port);
    for (let i = 0; i < 20; i++) {
      conn.socket.write(encodeMaskedFrame(Opcode.Text, Buffer.from('PING'), randomBytes(4)));
    }
    await conn.waitFor((d) => d.toString('latin1').split('PONG').length - 1 === 20);
  });
});
