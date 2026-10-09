import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { TCP_PREAMBLE, detectProtocol, parseClientHello } from '../src/detect.js';
import {
  buildHttpErrorResponse,
  buildUpgradeResponse,
  computeAcceptKey,
  validateUpgradeRequest,
} from '../src/handshake.js';
import { ConnectionCounter } from '../src/limiter.js';
import { resolveWorkerCount } from '../src/cluster.js';
import { ZeroBufferPool, createSpeedTestServer, parseStartCommand } from '../src/speedtest.js';
import { withDefaults } from '../src/defaults.js';
import { DEFAULT_SERVER_LIMITS, createSpeedTransportServer } from '../src/server.js';

/** Captures the first bytes a real TLS client sends. */
function captureClientHello(options: tls.ConnectionOptions): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.once('data', (data) => {
        resolve(data);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      const client = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, ...options });
      client.on('error', () => {});
    });
  });
}

describe('detectProtocol', () => {
  it('detects TLS from the handshake record type', () => {
    expect(detectProtocol(Buffer.from([0x16]))).toBe('tls');
    expect(detectProtocol(Buffer.from([0x16, 0x03, 0x01]))).toBe('tls');
  });

  it('does not accept TLS inside TLS', () => {
    expect(detectProtocol(Buffer.from([0x16]), false)).toBe('unknown');
  });

  it('detects the raw TCP preamble, also when it arrives in pieces', () => {
    expect(detectProtocol(TCP_PREAMBLE)).toBe('tcp');
    expect(detectProtocol(Buffer.concat([TCP_PREAMBLE, Buffer.from([0x81, 0x00])]))).toBe('tcp');
    for (let i = 1; i < TCP_PREAMBLE.length; i++) {
      expect(detectProtocol(TCP_PREAMBLE.subarray(0, i))).toBe('incomplete');
    }
  });

  it('routes HTTP methods to the HTTP parser', () => {
    for (const method of ['GET / HTTP/1.1', 'POST', 'OPTIONS', 'HEAD', 'PUT', 'SEARCH']) {
      expect(detectProtocol(Buffer.from(method))).toBe('http');
    }
  });

  it('treats a diverging S... prefix as HTTP rather than TCP', () => {
    expect(detectProtocol(Buffer.from('STCX'))).toBe('http');
  });

  it('rejects everything else', () => {
    for (const bytes of [[0x00], [0xff], [0x61], [0x0d, 0x0a], [0x80, 0x00]]) {
      expect(detectProtocol(Buffer.from(bytes))).toBe('unknown');
    }
    expect(detectProtocol(Buffer.from('get / HTTP/1.1'))).toBe('unknown');
  });

  it('waits for the first byte', () => {
    expect(detectProtocol(Buffer.alloc(0))).toBe('incomplete');
  });
});

describe('parseClientHello', () => {
  it('reads SNI and ALPN from a real ClientHello', async () => {
    const hello = await captureClientHello({ servername: 'speed.example.com', ALPNProtocols: ['acme-tls/1', 'http/1.1'] });
    expect(parseClientHello(hello)).toEqual({
      servername: 'speed.example.com',
      alpnProtocols: ['acme-tls/1', 'http/1.1'],
    });
  });

  it('reports no SNI or ALPN when the client sends none', async () => {
    const hello = await captureClientHello({});
    expect(parseClientHello(hello)).toEqual({ servername: null, alpnProtocols: [] });
  });

  it('rejects data that is not a ClientHello', () => {
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1'))).toBeNull();
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01]))).toBeNull();
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0, 0, 0]))).toBeNull();
  });

  it('never throws on truncated or random records', async () => {
    const hello = await captureClientHello({ servername: 'a.example.com', ALPNProtocols: ['http/1.1'] });
    for (let length = 0; length <= hello.length; length++) {
      expect(() => parseClientHello(hello.subarray(0, length))).not.toThrow();
    }
    for (let round = 0; round < 500; round++) {
      const random = Buffer.from(hello);
      random[5 + Math.floor(Math.random() * (random.length - 5))] = Math.floor(Math.random() * 256);
      expect(() => parseClientHello(random)).not.toThrow();
    }
  });
});

const request = (headers: Record<string, string>, method = 'GET') =>
  ({ method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) }) as IncomingMessage;

const validHeaders = {
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

describe('WebSocket handshake', () => {
  it('computes the RFC 6455 example accept key', () => {
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('accepts a valid request, with header tokens in any case and lists', () => {
    expect(validateUpgradeRequest(request(validHeaders))).toEqual({ ok: true, key: 'dGhlIHNhbXBsZSBub25jZQ==' });
    expect(
      validateUpgradeRequest(request({ ...validHeaders, Upgrade: 'WebSocket', Connection: 'keep-alive, Upgrade' }))
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['POST', validHeaders, 405],
    ['GET', { ...validHeaders, Upgrade: 'h2c' }, 400],
    ['GET', { ...validHeaders, Connection: 'keep-alive' }, 400],
    ['GET', { ...validHeaders, 'Sec-WebSocket-Version': '8' }, 426],
    ['GET', { ...validHeaders, 'Sec-WebSocket-Key': 'short' }, 400],
    ['GET', { ...validHeaders, 'Sec-WebSocket-Key': '' }, 400],
  ])('rejects %s with %j', (method, headers, status) => {
    expect(validateUpgradeRequest(request(headers as Record<string, string>, method))).toMatchObject({ ok: false, status });
  });

  it('advertises version 13 when the version is unsupported', () => {
    const result = validateUpgradeRequest(request({ ...validHeaders, 'Sec-WebSocket-Version': '12' }));
    expect(result).toMatchObject({ ok: false, headers: { 'Sec-WebSocket-Version': '13' } });
  });

  it('builds the 101 response without extensions or subprotocols', () => {
    const response = buildUpgradeResponse('dGhlIHNhbXBsZSBub25jZQ==');
    expect(response.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(response).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n');
    expect(response).not.toMatch(/Sec-WebSocket-(Extensions|Protocol)/);
    expect(response.endsWith('\r\n\r\n')).toBe(true);
  });

  it('builds error responses with a body and extra headers', () => {
    const response = buildHttpErrorResponse(426, 'nope', { 'Sec-WebSocket-Version': '13' });
    expect(response).toMatch(/^HTTP\/1.1 426 Upgrade Required\r\n/);
    expect(response).toContain('Content-Length: 4\r\n');
    expect(response).toContain('Sec-WebSocket-Version: 13\r\n');
    expect(response.endsWith('\r\n\r\nnope')).toBe(true);
  });
});

describe('ConnectionCounter', () => {
  it('counts per key and refuses beyond the limit', () => {
    const counter = new ConnectionCounter(2);
    expect(counter.acquire('a')).toBe(true);
    expect(counter.acquire('a')).toBe(true);
    expect(counter.acquire('a')).toBe(false);
    expect(counter.acquire('b')).toBe(true);
    expect(counter.total).toBe(3);
    counter.release('a');
    expect(counter.count('a')).toBe(1);
    expect(counter.acquire('a')).toBe(true);
  });

  it('forgets keys at zero and tolerates extra releases', () => {
    const counter = new ConnectionCounter(1);
    counter.acquire('a');
    counter.release('a');
    counter.release('a');
    expect(counter.count('a')).toBe(0);
    expect(counter.total).toBe(0);
  });
});

describe('resolveWorkerCount', () => {
  it('uses one per core up to the cap when set to 0', () => {
    expect(resolveWorkerCount(0, 6, 1)).toBe(1);
    expect(resolveWorkerCount(0, 6, 4)).toBe(4);
    expect(resolveWorkerCount(0, 6, 32)).toBe(6);
    expect(resolveWorkerCount(0, 8, 32)).toBe(8);
  });

  it('uses explicit counts as given', () => {
    expect(resolveWorkerCount(3, 6, 1)).toBe(3);
    expect(resolveWorkerCount(2.7, 6, 8)).toBe(2);
  });
});

describe('parseStartCommand', () => {
  it('parses well formed commands', () => {
    expect(parseStartCommand('START 1024 500')).toEqual({ sizeKb: 1024, count: 500 });
    expect(parseStartCommand('START 1 1')).toEqual({ sizeKb: 1, count: 1 });
  });

  it.each(['START', 'START 1', 'START 1 1 1', 'START 0 1', 'START 1 0', 'START -1 1', 'START 1.5 1', 'START 1e3 1', 'START +1 1', 'START  1 1', 'START 01 1', 'start 1 1', 'START 99999999999999999999 1'])(
    'rejects %j',
    (command) => expect(parseStartCommand(command)).toBeNull()
  );
});

describe('ZeroBufferPool', () => {
  it('allocates zero-filled buffers once per size', () => {
    const pool = new ZeroBufferPool();
    const a = pool.get(4);
    expect(pool.get(4)).toBe(a);
    expect(a.length).toBe(4096);
    expect(a.every((byte) => byte === 0)).toBe(true);
    expect(pool.get(8)).not.toBe(a);
    expect(pool.size).toBe(2);
  });
});

describe('withDefaults', () => {
  it('keeps defaults for missing and undefined overrides', () => {
    expect(withDefaults({ a: 1, b: 2 }, { b: undefined })).toEqual({ a: 1, b: 2 });
    expect(withDefaults({ a: 1, b: 2 }, undefined)).toEqual({ a: 1, b: 2 });
    expect(withDefaults({ a: 1, b: 2 }, null)).toEqual({ a: 1, b: 2 });
  });

  it('applies defined overrides, including zero and false', () => {
    expect(withDefaults({ a: 1, b: true }, { a: 0, b: false })).toEqual({ a: 0, b: false });
  });

  it('never changes the defaults object', () => {
    const defaults = { a: 1 };
    withDefaults(defaults, { a: 2 });
    expect(defaults).toEqual({ a: 1 });
  });
});

describe('server limits', () => {
  it('keep their defaults when an option is explicitly undefined', () => {
    const server = createSpeedTransportServer({
      onConnection: () => {},
      limits: { sendHighWaterBytes: undefined, idleTimeoutMs: 5 },
    });
    expect(server.limits.sendHighWaterBytes).toBe(DEFAULT_SERVER_LIMITS.sendHighWaterBytes);
    expect(server.limits.idleTimeoutMs).toBe(5);
  });

  it('buffer at most command sized messages in the speed test server unless overridden', () => {
    expect(createSpeedTestServer({ limits: { maxBufferedMessageBytes: undefined } }).limits.maxBufferedMessageBytes).toBe(128);
    expect(createSpeedTestServer({ limits: { maxBufferedMessageBytes: 4096 } }).limits.maxBufferedMessageBytes).toBe(4096);
  });
});
