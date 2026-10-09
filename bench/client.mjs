// Benchmark client process, forked by bench/run.mjs.
//
//   argv: <transport: tcp|tcps|ws|wss> <direction: down|up> <port> <threads> <connsPerThread>
//
// Opens threads x conns sockets across worker threads, the way the speed test client
// library does, and drives them like its download and upload lanes. Raw TCP uses this
// library's client in discard mode; WebSocket uses Node's built-in WebSocket.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

const MIB = 1024 * 1024;

if (isMainThread) {
  const [transport, direction, port, threads, conns] = process.argv.slice(2);
  const counters = new BigInt64Array(new SharedArrayBuffer(8 * Number(threads)));
  let open = 0;
  const total = Number(threads) * Number(conns);
  for (let t = 0; t < Number(threads); t++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { transport, direction, port: Number(port), conns: Number(conns), counters: counters.buffer, slot: t },
    });
    worker.on('message', (m) => {
      if (m === 'open' && ++open === total) process.send({ type: 'open' });
    });
  }
  const bytes = () => {
    let sum = 0;
    for (let t = 0; t < counters.length; t++) sum += Number(Atomics.load(counters, t));
    return sum;
  };
  process.on('message', (m) => {
    if (m.type === 'sample') {
      const cpu = process.cpuUsage();
      process.send({ type: 'sample', bytes: bytes(), cpu: cpu.user + cpu.system });
    } else if (m.type === 'stop') {
      process.exit(0);
    }
  });
} else {
  const { transport, direction, port, conns, slot } = workerData;
  const counters = new BigInt64Array(workerData.counters);
  let bytes = 0;
  const add = (n) => {
    bytes += n;
    Atomics.store(counters, slot, BigInt(bytes));
  };
  const { SpeedTransportSocket } = await import('../dist/client/index.js');
  const chunk = new Uint8Array(MIB);

  for (let i = 0; i < conns; i++) {
    const socket =
      transport === 'tcp' || transport === 'tcps'
        ? new SpeedTransportSocket(`${transport}://127.0.0.1:${port}`, { rejectUnauthorized: false, binaryPayloads: 'discard' })
        : new WebSocket(`${transport}://127.0.0.1:${port}/v1/ws`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      parentPort.postMessage('open');
      if (direction === 'down') {
        for (let k = 0; k < 2; k++) socket.send('START 1024 500');
      } else {
        fill();
        setInterval(fill, 5);
      }
    };
    // Upload flow control matches the client library: two chunks queued, at most 64 in flight.
    let unacked = 0;
    const fill = () => {
      let sent = 0;
      while (sent < 4 && unacked < 64 && socket.bufferedAmount < 2 * MIB) {
        socket.send(chunk);
        unacked++;
        sent++;
      }
    };
    let received = 0;
    socket.onmessage = (event) => {
      if (direction === 'down') {
        if (typeof event.data === 'string') return;
        add(event.data.byteLength);
        if (++received % 500 === 0) socket.send('START 1024 500');
      } else if (event.data === 'ACK') {
        unacked--;
        add(MIB);
        fill();
      }
    };
  }
}
