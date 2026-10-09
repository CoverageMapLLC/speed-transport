import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/connection.js';
import { TCP_PREAMBLE } from '../src/detect.js';
import { Opcode, encodeFrame, encodeMaskedFrame } from '../src/frame.js';
import { createSpeedTestProtocol, type SpeedTestEvent } from '../src/speedtest.js';
import {
  TRANSPORTS,
  connectClient,
  rawWebSocket,
  sleep,
  startServer,
  startSpeedTestServer,
  type Running,
  type TestClient,
} from './helpers.js';

let running: Running | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function collectBinary(client: TestClient, count: number): Promise<number[]> {
  const sizes: number[] = [];
  while (sizes.length < count) {
    const message = await client.next();
    if ('binary' in message) sizes.push(message.binary);
  }
  return sizes;
}

describe.each(TRANSPORTS)('speed test protocol over %s', (transport) => {
  it('answers PING with PONG', async () => {
    running = await startSpeedTestServer();
    const client = await connectClient(transport, running.port);
    for (let i = 0; i < 5; i++) {
      client.send('PING');
      expect(await client.next()).toEqual({ text: 'PONG' });
    }
    client.close();
  });

  it('streams exactly count frames of kb KiB of zeros for START', async () => {
    running = await startSpeedTestServer();
    const client = await connectClient(transport, running.port);
    client.send('START 64 5');
    const frames: Buffer[] = [];
    while (frames.length < 5) {
      const message = await client.next();
      if ('bytes' in message && message.bytes) frames.push(message.bytes);
    }
    expect(frames.map((f) => f.length)).toEqual(Array(5).fill(64 * 1024));
    expect(frames.every((f) => f.every((b) => b === 0))).toBe(true);
    client.send('PING');
    expect(await client.next()).toEqual({ text: 'PONG' });
    client.close();
  });

  it('streams a large START completely', async () => {
    running = await startSpeedTestServer();
    const client = await connectClient(transport, running.port, { tcp: { binaryPayloads: 'discard' } });
    client.send('START 1024 40');
    const sizes = await collectBinary(client, 40);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(40 * 1024 * 1024);
    client.close();
  });

  it('serves concurrent START commands on one connection', async () => {
    running = await startSpeedTestServer();
    const client = await connectClient(transport, running.port);
    client.send('START 4 10');
    client.send('START 8 10');
    const sizes = await collectBinary(client, 20);
    expect(sizes.filter((s) => s === 4096)).toHaveLength(10);
    expect(sizes.filter((s) => s === 8192)).toHaveLength(10);
    client.close();
  });

  it('acknowledges every message over 128 bytes once', async () => {
    running = await startSpeedTestServer();
    const client = await connectClient(transport, running.port);
    client.send(Buffer.alloc(129));
    client.send(Buffer.alloc(1024 * 1024));
    client.send('x'.repeat(500));
    for (let i = 0; i < 3; i++) expect(await client.next()).toEqual({ text: 'ACK' });
    client.send('PING');
    expect(await client.next()).toEqual({ text: 'PONG' });
    client.close();
  });

  it('does not acknowledge messages of 128 bytes or less', async () => {
    running = await startSpeedTestServer();
    const client = await connectClient(transport, running.port);
    client.send(Buffer.alloc(128));
    client.send('HELLO');
    client.send('start 1 1');
    client.send('PING');
    expect(await client.next()).toEqual({ text: 'PONG' });
    client.close();
  });

  it.each(['START', 'START abc 1', 'START 0 1', 'START 5', 'START -1 1', 'START 1.5 1', 'START  1 1'])(
    'closes with 1008 for malformed %j',
    async (command) => {
      running = await startSpeedTestServer();
      const client = await connectClient(transport, running.port);
      client.send(command);
      expect((await client.closed()).code).toBe(1008);
    }
  );

  it('closes with 1008 when a START exceeds the limits', async () => {
    running = await startSpeedTestServer({ speedTest: { limits: { maxFrameSizeKb: 8, maxFrameCount: 4 } } });
    const size = await connectClient(transport, running.port);
    size.send('START 9 1');
    expect(await size.closed()).toEqual({ code: 1008, reason: 'Frame size limit exceeded' });
    const count = await connectClient(transport, running.port);
    count.send('START 8 5');
    expect(await count.closed()).toEqual({ code: 1008, reason: 'Frame count limit exceeded' });
    const exact = await connectClient(transport, running.port);
    exact.send('START 8 4');
    expect(await collectBinary(exact, 4)).toEqual([8192, 8192, 8192, 8192]);
    exact.close();
  });

  it('resets the connection at once on CLOSE, even with data queued', async () => {
    const server = (running = await startSpeedTestServer()).server;
    const client = await connectClient(transport, running.port, { tcp: { binaryPayloads: 'discard' } });
    client.send('START 1024 1000');
    await client.next();
    const started = Date.now();
    client.send('CLOSE');

    // The server ends the session at once instead of draining 1000 MiB first.
    await expect.poll(() => server.connectionCount, { timeout: 1000, interval: 5 }).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);

    // Whether the client sees the reset is up to its kernel: macOS may drop a reset whose
    // sequence number is not the one it expects (RFC 5961) and wait for its own next send.
    // The client library closes its side after CLOSE, so only check that the queued data
    // never arrived.
    await sleep(200);
    const binary = client.received.filter((message) => 'binary' in message).length;
    expect(binary).toBeLessThan(999);
    client.terminate();
  });
});

describe('speed test protocol details', () => {
  it('acknowledges a fragmented upload once, using its total size', async () => {
    running = await startSpeedTestServer();
    const conn = await rawWebSocket(running.port);
    conn.socket.write(
      Buffer.concat([
        encodeMaskedFrame(Opcode.Binary, Buffer.alloc(100), undefined, false),
        encodeMaskedFrame(Opcode.Continuation, Buffer.alloc(100)),
      ])
    );
    await conn.waitFor((d) => d.includes(Buffer.from('ACK')));
    await sleep(100);
    expect(conn.data().toString('latin1').split('ACK').length - 1).toBe(1);
  });

  it('pauses streaming while the client does not read and finishes when it does', async () => {
    const highWater = 1024 * 1024;
    running = await startSpeedTestServer({ limits: { sendHighWaterBytes: highWater } });
    const socket = net.connect(running.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    let received = 0;
    socket.on('data', (chunk: Buffer) => (received += chunk.length));
    socket.write(Buffer.concat([TCP_PREAMBLE, encodeFrame(Opcode.Text, Buffer.from('START 1024 200'))]));
    socket.pause();
    await sleep(500);

    // The server must not queue the whole 200 MiB in memory while the client is not reading.
    const [connection] = (running.server as unknown as { connections: Set<Connection> }).connections;
    expect(connection.bufferedAmount).toBeLessThan(highWater + 2 * 1024 * 1024);

    socket.resume();
    const expected = TCP_PREAMBLE.length + 200 * (1024 * 1024 + 10);
    const deadline = Date.now() + 20000;
    while (received < expected && Date.now() < deadline) await sleep(20);
    expect(received).toBe(expected);
    socket.destroy();
  });

  it('reports protocol events', async () => {
    const events: SpeedTestEvent['type'][] = [];
    running = await startSpeedTestServer({ speedTest: { onEvent: (event) => events.push(event.type) } });
    const client = await connectClient('tcp', running.port);
    client.send('START 1 2');
    await collectBinary(client, 2);
    client.send(Buffer.alloc(1000));
    await client.next();
    client.send('START 0 1');
    await client.closed();
    expect(events).toEqual(['start', 'upload', 'rejected']);
  });

  it('can be installed on a generic server', async () => {
    running = await startServer({
      onConnection: createSpeedTestProtocol(),
      limits: { maxBufferedMessageBytes: 128 },
    });
    const client = await connectClient('ws', running.port);
    client.send('PING');
    expect(await client.next()).toEqual({ text: 'PONG' });
    client.send(Buffer.alloc(5000));
    expect(await client.next()).toEqual({ text: 'ACK' });
    client.close();
  });

  it('treats buffered binary messages over 128 bytes as uploads', async () => {
    running = await startServer({
      onConnection: createSpeedTestProtocol(),
      limits: { maxBufferedMessageBytes: 4096 },
    });
    const client = await connectClient('tcp', running.port);
    client.send(Buffer.alloc(1000));
    expect(await client.next()).toEqual({ text: 'ACK' });
    client.close();
  });
});
