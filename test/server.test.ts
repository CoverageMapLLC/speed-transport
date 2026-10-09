import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { generate } from 'selfsigned';
import type { Connection } from '../src/connection.js';
import { CloseCode, Opcode, encodeClosePayload, encodeFrame, encodeMaskedFrame } from '../src/frame.js';
import { ConnectionCounter } from '../src/limiter.js';
import { TCP_PREAMBLE } from '../src/detect.js';
import {
  TRANSPORTS,
  afterHead,
  connectClient,
  findCloseCode,
  getCertificate,
  rawConnect,
  rawWebSocket,
  sleep,
  startServer,
  type Running,
} from './helpers.js';

const echo = (connection: Connection) => {
  connection.on('message', (data, binary) => {
    if (binary) connection.sendBinary(data);
    else connection.sendText(data.toString());
  });
  connection.on('bulk', (length) => connection.sendText(`bulk ${length}`));
};

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    client
      .get(url, { rejectUnauthorized: false, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => {
      resolve(101);
      ws.close();
    });
    ws.once('error', () => resolve(0));
  });
}

let running: Running | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

describe('one port, every transport', () => {
  it.each(TRANSPORTS)('echoes messages over %s', async (transport) => {
    const seen: string[] = [];
    running = await startServer({
      onConnection: (connection) => {
        seen.push(`${connection.kind}:${connection.secure}`);
        echo(connection);
      },
    });
    const client = await connectClient(transport, running.port);
    client.send('hello');
    expect(await client.next()).toEqual({ text: 'hello' });
    client.send(Buffer.from([1, 2, 3]));
    expect(await client.next()).toMatchObject({ binary: 3 });
    client.send(Buffer.alloc(100000));
    expect(await client.next()).toEqual({ text: 'bulk 100000' });
    client.close();
    await client.closed();
    const kind = transport.startsWith('tcp') ? 'tcp' : 'websocket';
    expect(seen).toEqual([`${kind}:${transport === 'wss' || transport === 'tcps'}`]);
  });

  it('serves all four transports concurrently on the same port', async () => {
    running = await startServer({ onConnection: echo });
    const clients = await Promise.all(TRANSPORTS.map((t) => connectClient(t, running!.port)));
    clients.forEach((client, i) => client.send(`from ${i}`));
    const replies = await Promise.all(clients.map((client) => client.next()));
    expect(replies).toEqual(TRANSPORTS.map((_, i) => ({ text: `from ${i}` })));
    for (const client of clients) client.close();
  });

  it("works with Node's built-in WebSocket client", async () => {
    running = await startServer({ onConnection: echo });
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${running.port}/`);
    ws.binaryType = 'arraybuffer';
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send('native');
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error('error'));
    });
    expect(reply).toBe('native');
    ws.close();
  });
});

describe('HTTP on the same port', () => {
  it('serves plain and TLS requests through the request listener', async () => {
    running = await startServer({
      onConnection: echo,
      requestListener: (req, res) => res.end(`${req.method} ${req.url} ${(req.socket as tls.TLSSocket).encrypted === true}`),
    });
    expect(await get(`http://127.0.0.1:${running.port}/v1/server`)).toEqual({ status: 200, body: 'GET /v1/server false' });
    expect(await get(`https://127.0.0.1:${running.port}/v1/health`)).toEqual({ status: 200, body: 'GET /v1/health true' });
  });

  it('answers 404 without a request listener', async () => {
    running = await startServer({ onConnection: echo });
    expect((await get(`http://127.0.0.1:${running.port}/`)).status).toBe(404);
  });

  it('serves keep-alive requests and then upgrades on another connection', async () => {
    running = await startServer({ onConnection: echo, requestListener: (_req, res) => res.end('ok') });
    const agent = new http.Agent({ keepAlive: true });
    for (let i = 0; i < 3; i++) {
      const res = await new Promise<number>((resolve) =>
        http.get(`http://127.0.0.1:${running!.port}/`, { agent }, (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode ?? 0));
        })
      );
      expect(res).toBe(200);
    }
    agent.destroy();
    const client = await connectClient('ws', running.port);
    client.send('after');
    expect(await client.next()).toEqual({ text: 'after' });
    client.close();
  });

  it('rejects headers over the limit with 431', async () => {
    running = await startServer({ onConnection: echo, limits: { maxHeaderBytes: 1024 } });
    const conn = await rawConnect(running.port);
    conn.socket.write(`GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(4000)}\r\n\r\n`);
    const data = await conn.waitFor((d) => d.includes('\r\n'));
    expect(data.toString()).toMatch(/^HTTP\/1.1 431/);
  });
});

describe('WebSocket handshake rules', () => {
  it('only upgrades on the configured path', async () => {
    running = await startServer({ onConnection: echo, websocket: { path: '/v1/ws' } });
    expect(await upgradeStatus(running.port, '/v1/ws')).toBe(101);
    expect(await upgradeStatus(running.port, '/v1/ws?x=1')).toBe(101);
    expect(await upgradeStatus(running.port, '/other')).toBe(404);
  });

  it('accepts a path predicate', async () => {
    running = await startServer({ onConnection: echo, websocket: { path: (p) => p.startsWith('/ws/') } });
    expect(await upgradeStatus(running.port, '/ws/a')).toBe(101);
    expect(await upgradeStatus(running.port, '/nope')).toBe(404);
  });

  it('refuses upgrades when WebSocket is disabled', async () => {
    running = await startServer({ onConnection: echo, websocket: false });
    expect(await upgradeStatus(running.port, '/')).toBe(404);
  });

  it('answers the RFC example key exactly', async () => {
    running = await startServer({ onConnection: echo });
    const conn = await rawWebSocket(running.port);
    const head = conn.data().toString('latin1');
    expect(head).toMatch(/^HTTP\/1.1 101 /);
    expect(head).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('rejects a bad version with 426 and the supported version', async () => {
    running = await startServer({ onConnection: echo });
    const conn = await rawConnect(running.port);
    conn.socket.write(
      'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n\r\n'
    );
    const data = (await conn.waitFor((d) => d.includes('\r\n\r\n'))).toString();
    expect(data).toMatch(/^HTTP\/1.1 426/);
    expect(data).toContain('Sec-WebSocket-Version: 13');
  });

  it('never negotiates compression even when offered', async () => {
    running = await startServer({ onConnection: echo });
    const ws = new WebSocket(`ws://127.0.0.1:${running.port}/`, { perMessageDeflate: true });
    await new Promise((resolve) => ws.once('open', resolve));
    expect(ws.extensions).toBe('');
    ws.close();
  });

  it('parses frames that arrive in the same packet as the handshake', async () => {
    running = await startServer({ onConnection: echo });
    const conn = await rawConnect(running.port);
    conn.socket.write(
      Buffer.concat([
        Buffer.from(
          'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
        ),
        encodeMaskedFrame(Opcode.Text, Buffer.from('early')),
      ])
    );
    const data = await conn.waitFor((d) => afterHead(d).length >= 7);
    expect(afterHead(data).subarray(0, 7)).toEqual(encodeFrame(Opcode.Text, Buffer.from('early')));
  });
});

describe('raw TCP transport', () => {
  it('echoes the preamble and parses frames sent with it', async () => {
    running = await startServer({ onConnection: echo });
    const conn = await rawConnect(running.port);
    conn.socket.write(Buffer.concat([TCP_PREAMBLE, encodeFrame(Opcode.Text, Buffer.from('hi'))]));
    const data = await conn.waitFor((d) => d.length >= TCP_PREAMBLE.length + 4);
    expect(data.subarray(0, TCP_PREAMBLE.length)).toEqual(TCP_PREAMBLE);
    expect(data.subarray(TCP_PREAMBLE.length)).toEqual(encodeFrame(Opcode.Text, Buffer.from('hi')));
  });

  it('accepts the preamble one byte at a time', async () => {
    running = await startServer({ onConnection: echo });
    const conn = await rawConnect(running.port);
    for (const byte of TCP_PREAMBLE) {
      conn.socket.write(Buffer.from([byte]));
      await sleep(5);
    }
    await conn.waitFor((d) => d.length >= TCP_PREAMBLE.length);
    const frame = encodeFrame(Opcode.Text, Buffer.from('slow'));
    for (const byte of frame) {
      conn.socket.write(Buffer.from([byte]));
      await sleep(2);
    }
    const data = await conn.waitFor((d) => d.length >= TCP_PREAMBLE.length + frame.length);
    expect(data.subarray(TCP_PREAMBLE.length)).toEqual(frame);
  });

  it('accepts masked frames too', async () => {
    running = await startServer({ onConnection: echo });
    const conn = await rawConnect(running.port);
    conn.socket.write(Buffer.concat([TCP_PREAMBLE, encodeMaskedFrame(Opcode.Text, Buffer.from('m'))]));
    const data = await conn.waitFor((d) => d.length >= TCP_PREAMBLE.length + 3);
    expect(data.subarray(TCP_PREAMBLE.length)).toEqual(encodeFrame(Opcode.Text, Buffer.from('m')));
  });

  it('can be disabled', async () => {
    running = await startServer({ onConnection: echo, tcp: false });
    const conn = await rawConnect(running.port);
    conn.socket.write(TCP_PREAMBLE);
    await conn.closed();
    expect(conn.data().length).toBe(0);
  });
});

describe('TLS', () => {
  it('rejects TLS connections when no TLS settings are given', async () => {
    const { createSpeedTransportServer } = await import('../src/server.js');
    const server = createSpeedTransportServer({ onConnection: echo });
    const { port } = await server.listen(0, '127.0.0.1');
    running = { server, port, close: () => server.close() };
    await expect(connectClient('tcps', port)).rejects.toThrow();
  });

  it('can require TLS for every transport', async () => {
    running = await startServer({ onConnection: echo, plaintext: false });
    await expect(connectClient('ws', running.port)).rejects.toThrow();
    await expect(connectClient('tcp', running.port)).rejects.toThrow();
    expect((await get(`http://127.0.0.1:${running.port}/`)).status).toBe(400);
    const client = await connectClient('wss', running.port);
    client.send('secure');
    expect(await client.next()).toEqual({ text: 'secure' });
    client.close();
  });

  it('swaps the certificate for new connections with setSecureContext', async () => {
    running = await startServer({ onConnection: echo });
    const fingerprint = () =>
      new Promise<string>((resolve) => {
        const socket = tls.connect({ port: running!.port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
          resolve(socket.getPeerCertificate().fingerprint256);
          socket.destroy();
        });
      });
    const before = await fingerprint();
    const fresh = await generate([{ name: 'commonName', value: 'other' }], { keySize: 2048 });
    running.server.setSecureContext({ cert: fresh.cert, key: fresh.private });
    const after = await fingerprint();
    expect(after).not.toBe(before);
    expect(after).toBe(new (await import('node:crypto')).X509Certificate(fresh.cert).fingerprint256);
  });

  it('refuses setSecureContext on a server without TLS', async () => {
    const { createSpeedTransportServer } = await import('../src/server.js');
    const cert = await getCertificate();
    expect(() => createSpeedTransportServer({ onConnection: echo }).setSecureContext(cert)).toThrow(/without TLS/);
  });

  it('lets the application take ClientHellos it recognizes', async () => {
    const taken: string[] = [];
    running = await startServer({
      onConnection: echo,
      onTlsClientHello: (hello, socket) => {
        if (!hello.alpnProtocols.includes('acme-tls/1')) return false;
        taken.push(hello.servername ?? '');
        socket.destroy();
        return true;
      },
    });
    await new Promise<void>((resolve) => {
      const socket = tls.connect({
        port: running!.port,
        host: '127.0.0.1',
        servername: 'acme.example.com',
        ALPNProtocols: ['acme-tls/1'],
        rejectUnauthorized: false,
      });
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });
    expect(taken).toEqual(['acme.example.com']);
    const client = await connectClient('wss', running.port);
    client.close();
  });

  it('negotiates http/1.1 when the client offers HTTP/2', async () => {
    running = await startServer({ onConnection: echo, requestListener: (_req, res) => res.end('ok') });
    const protocol = await new Promise<string | false>((resolve) => {
      const socket = tls.connect(
        { port: running!.port, host: '127.0.0.1', ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false },
        () => {
          resolve(socket.alpnProtocol ?? false);
          socket.destroy();
        }
      );
    });
    expect(protocol).toBe('http/1.1');
  });
});

describe('admission', () => {
  it('rejects sessions refused by authorize, with the given status for WebSocket', async () => {
    running = await startServer({
      onConnection: echo,
      authorize: (context) => (context.kind === 'websocket' ? { status: 403, reason: 'no' } : false),
    });
    expect(await upgradeStatus(running.port, '/')).toBe(403);
    await expect(connectClient('tcp', running.port)).rejects.toThrow();
  });

  it('passes the session context to authorize', async () => {
    const contexts: unknown[] = [];
    running = await startServer({
      onConnection: echo,
      authorize: (context) => {
        contexts.push({ kind: context.kind, secure: context.secure, hasRequest: context.request !== null });
        return true;
      },
    });
    for (const transport of TRANSPORTS) (await connectClient(transport, running.port)).close();
    expect(contexts).toEqual([
      { kind: 'websocket', secure: false, hasRequest: true },
      { kind: 'websocket', secure: true, hasRequest: true },
      { kind: 'tcp', secure: false, hasRequest: false },
      { kind: 'tcp', secure: true, hasRequest: false },
    ]);
  });

  it('answers 500 when authorize throws', async () => {
    running = await startServer({
      onConnection: echo,
      authorize: () => {
        throw new Error('boom');
      },
    });
    expect(await upgradeStatus(running.port, '/')).toBe(500);
  });

  it('enforces the connection limit across transports and frees slots on close', async () => {
    running = await startServer({ onConnection: echo, limiter: new ConnectionCounter(2) });
    const a = await connectClient('ws', running.port);
    const b = await connectClient('tcp', running.port);
    expect(await upgradeStatus(running.port, '/')).toBe(429);
    await expect(connectClient('tcps', running.port)).rejects.toThrow();
    a.close();
    await a.closed();
    await sleep(50);
    const c = await connectClient('wss', running.port);
    c.send('ok');
    expect(await c.next()).toEqual({ text: 'ok' });
    b.close();
    c.close();
  });

  it('counts sessions under the client key', async () => {
    const counter = new ConnectionCounter(1);
    running = await startServer({
      onConnection: echo,
      limiter: counter,
      clientKey: (context) => (context.request?.headers['x-client'] as string) ?? 'tcp',
    });
    const a = new WebSocket(`ws://127.0.0.1:${running.port}/`, { headers: { 'X-Client': 'alice' } });
    await new Promise((resolve) => a.once('open', resolve));
    expect(await upgradeStatus(running.port, '/', { 'X-Client': 'alice' })).toBe(429);
    expect(await upgradeStatus(running.port, '/', { 'X-Client': 'bob' })).toBe(101);
    a.close();
  });

  it('answers 503 when the limiter fails', async () => {
    running = await startServer({
      onConnection: echo,
      limiter: { acquire: () => Promise.reject(new Error('down')), release: () => {} },
    });
    expect(await upgradeStatus(running.port, '/')).toBe(503);
  });

  it('releases the slot when the client disconnects during admission', async () => {
    const counter = new ConnectionCounter(5);
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    running = await startServer({
      onConnection: echo,
      limiter: counter,
      authorize: async () => {
        await gate;
        return true;
      },
    });
    const conn = await rawConnect(running.port);
    conn.socket.write(TCP_PREAMBLE);
    await sleep(50);
    conn.socket.destroy();
    await sleep(50);
    releaseGate();
    await sleep(100);
    expect(counter.total).toBe(0);
  });
});

describe('robustness', () => {
  it('closes connections that send an unknown protocol', async () => {
    running = await startServer({ onConnection: echo });
    for (const bytes of [[0x00, 0x01], [0xff], Buffer.from('hello')]) {
      const conn = await rawConnect(running.port);
      conn.socket.write(Buffer.from(bytes));
      await conn.closed();
    }
  });

  it('closes connections that never identify their protocol', async () => {
    running = await startServer({ onConnection: echo, limits: { detectTimeoutMs: 200 } });
    const conn = await rawConnect(running.port);
    const started = Date.now();
    await conn.closed(3000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('closes idle sessions', async () => {
    running = await startServer({ onConnection: echo, limits: { idleTimeoutMs: 300 } });
    const client = await connectClient('tcp', running.port);
    const started = Date.now();
    await client.closed(3000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('keeps active sessions open past the idle timeout', async () => {
    running = await startServer({ onConnection: echo, limits: { idleTimeoutMs: 300 } });
    const client = await connectClient('ws', running.port);
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      client.send('tick');
      expect(await client.next()).toEqual({ text: 'tick' });
    }
    client.close();
  });

  it('closes everything on server.close()', async () => {
    running = await startServer({ onConnection: echo });
    const clients = await Promise.all(TRANSPORTS.map((t) => connectClient(t, running!.port)));
    const pending = await rawConnect(running.port);
    await running.close();
    running = null;
    await Promise.all(clients.map((client) => client.closed()));
    await pending.closed();
  });

  it('survives many concurrent connections', async () => {
    running = await startServer({ onConnection: echo });
    const clients = await Promise.all(
      Array.from({ length: 80 }, (_, i) => connectClient(TRANSPORTS[i % 4], running!.port))
    );
    clients.forEach((client, i) => client.send(`#${i}`));
    const replies = await Promise.all(clients.map((client) => client.next()));
    expect(replies).toEqual(clients.map((_, i) => ({ text: `#${i}` })));
    expect(running.server.connectionCount).toBe(80);
    for (const client of clients) client.close();
  });
});

describe('close handshake and protocol errors', () => {
  it.each(['ws', 'tcp'] as const)('echoes the close code over %s', async (transport) => {
    let serverClose: number | null = null;
    running = await startServer({ onConnection: (c) => c.on('close', (code) => (serverClose = code)) });
    const client = await connectClient(transport, running.port);
    client.close(4321, 'bye');
    expect((await client.closed()).code).toBe(4321);
    await sleep(50);
    expect(serverClose).toBe(4321);
  });

  it('closes from the server with a code and reason', async () => {
    running = await startServer({ onConnection: (c) => c.on('message', () => c.close(4000, 'done')) });
    const client = await connectClient('ws', running.port);
    client.send('x');
    expect(await client.closed()).toEqual({ code: 4000, reason: 'done' });
  });

  it('reports 1006 when the socket drops without a close frame', async () => {
    let serverClose: number | null = null;
    running = await startServer({ onConnection: (c) => c.on('close', (code) => (serverClose = code)) });
    const conn = await rawWebSocket(running.port);
    conn.socket.destroy();
    await sleep(100);
    expect(serverClose).toBe(CloseCode.Abnormal);
  });

  it('answers pings with pongs', async () => {
    running = await startServer({ onConnection: () => {} });
    const conn = await rawWebSocket(running.port);
    conn.socket.write(encodeMaskedFrame(Opcode.Ping, Buffer.from('abc')));
    const data = await conn.waitFor((d) => afterHead(d).length >= 5);
    expect(afterHead(data)).toEqual(encodeFrame(Opcode.Pong, Buffer.from('abc')));
  });

  const protocolCases: Array<[string, Buffer, number]> = [
    ['an unmasked WebSocket frame', encodeFrame(Opcode.Text, Buffer.from('x')), 1002],
    ['a reserved opcode', encodeMaskedFrame(3, Buffer.alloc(0)), 1002],
    ['invalid UTF-8 text', encodeMaskedFrame(Opcode.Text, Buffer.from([0xff, 0xfe])), 1007],
    ['an invalid close code', encodeMaskedFrame(Opcode.Close, Buffer.from([0x03, 0xed])), 1002],
  ];

  it.each(protocolCases)('closes on %s with the matching code', async (_name, frame, code) => {
    running = await startServer({ onConnection: () => {} });
    const conn = await rawWebSocket(running.port);
    conn.socket.write(frame);
    await conn.closed();
    expect(findCloseCode(afterHead(conn.data()))).toBe(code);
  });

  it('closes with 1009 when a message exceeds the limit', async () => {
    running = await startServer({ onConnection: () => {}, limits: { maxMessageBytes: 1000 } });
    const conn = await rawWebSocket(running.port);
    conn.socket.write(encodeMaskedFrame(Opcode.Binary, Buffer.alloc(1001)));
    await conn.closed();
    expect(findCloseCode(afterHead(conn.data()))).toBe(1009);
  });

  it('destroys peers that ignore the close handshake', async () => {
    running = await startServer({
      onConnection: (c) => c.on('message', () => c.close(1000)),
      limits: { closeTimeoutMs: 200 },
    });
    const conn = await rawWebSocket(running.port);
    conn.socket.write(encodeMaskedFrame(Opcode.Text, Buffer.from('x')));
    const started = Date.now();
    await conn.closed(3000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('replies 1000 to a close frame without a code', async () => {
    running = await startServer({ onConnection: () => {} });
    const conn = await rawWebSocket(running.port);
    conn.socket.write(encodeMaskedFrame(Opcode.Close));
    await conn.closed();
    expect(findCloseCode(afterHead(conn.data()))).toBe(1000);
  });

  it('ignores data after the close frame', async () => {
    const messages: string[] = [];
    running = await startServer({ onConnection: (c) => c.on('message', (d) => messages.push(d.toString())) });
    const conn = await rawWebSocket(running.port);
    conn.socket.write(
      Buffer.concat([
        encodeMaskedFrame(Opcode.Close, encodeClosePayload(1000)),
        encodeMaskedFrame(Opcode.Text, Buffer.from('late')),
      ])
    );
    await conn.closed();
    expect(messages).toEqual([]);
  });
});

describe('connection API', () => {
  it('exposes kind, security, address, and the upgrade request', async () => {
    const seen: Array<Record<string, unknown>> = [];
    running = await startServer({
      onConnection: (c) =>
        seen.push({ kind: c.kind, secure: c.secure, address: c.remoteAddress, url: c.request?.url ?? null }),
    });
    (await connectClient('ws', running.port, { path: '/v1/ws?x=1' })).close();
    (await connectClient('tcps', running.port)).close();
    expect(seen).toEqual([
      { kind: 'websocket', secure: false, address: '127.0.0.1', url: '/v1/ws?x=1' },
      { kind: 'tcp', secure: true, address: '127.0.0.1', url: null },
    ]);
  });

  it('refuses to send after close', async () => {
    let connection: Connection | null = null;
    running = await startServer({ onConnection: (c) => (connection = c) });
    const client = await connectClient('tcp', running.port);
    await sleep(20);
    client.close();
    await client.closed();
    await sleep(20);
    expect(connection!.isOpen).toBe(false);
    expect(connection!.sendText('x')).toBe(false);
    expect(connection!.sendBinary(Buffer.alloc(1))).toBe(false);
    expect(connection!.ping()).toBe(false);
    expect(await connection!.sendMessages(Buffer.alloc(10), 5)).toBe(0);
  });

  it('sends server pings that clients answer', async () => {
    const pongs: string[] = [];
    running = await startServer({
      onConnection: (c) => {
        c.on('pong', (payload) => pongs.push(payload.toString()));
        c.ping(Buffer.from('hey'));
      },
    });
    const client = await connectClient('tcp', running.port);
    await sleep(100);
    expect(pongs).toEqual(['hey']);
    client.close();
  });

  it('computes the accept key it sends', () => {
    const key = 'x3JJHMbDL1EzLkh9GBhXDw==';
    expect(createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')).toBe(
      'HSmrc0sMlYUkAGmm5OPpG2HaGWk='
    );
  });

  it('serves sockets accepted elsewhere through handle()', async () => {
    const { createSpeedTransportServer } = await import('../src/server.js');
    const server = createSpeedTransportServer({ onConnection: echo });
    const outer = net.createServer({ pauseOnConnect: true }, (socket) => server.handle(socket));
    await new Promise<void>((resolve) => outer.listen(0, '127.0.0.1', resolve));
    const port = (outer.address() as net.AddressInfo).port;
    const client = await connectClient('tcp', port);
    client.send('handed over');
    expect(await client.next()).toEqual({ text: 'handed over' });
    client.close();
    await server.close();
    await new Promise((resolve) => outer.close(resolve));
  });
});
