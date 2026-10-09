// Benchmark server process, forked by bench/run.mjs.
//
//   argv: <implementation: speed-transport | ws> <workers> <certPath> <keyPath>
//
// speed-transport: this library's clustered speed test server, plain and TLS on one port.
// ws: the baseline the CoverageMap servers ran before this library, the `ws` package with
//     bufferutil and Node's cluster module: one plain port and one TLS port.
//
// Reports `ready` with its ports, answers `cpu` with the CPU time of every server process.
import cluster from 'node:cluster';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const [implementation, workersArg, certPath, keyPath] = process.argv.slice(2);
const workers = Number(workersArg);
const cpuNow = () => {
  const usage = process.cpuUsage();
  return usage.user + usage.system;
};

if (implementation === 'speed-transport') {
  const { createClusterPrimary } = await import('../dist/index.js');
  const children = [];
  const { fork } = await import('node:child_process');
  const workerModule = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const primary = createClusterPrimary({
    workers,
    workerModule,
    port: 0,
    host: '127.0.0.1',
    secureContext: { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') },
    spawnWorker: () => {
      const child = fork(workerModule, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push(child);
      return child;
    },
  });
  const { port } = await primary.start();
  process.on('message', async (message) => {
    if (message.type === 'cpu') {
      const parts = await Promise.all(
        children.filter((c) => c.connected).map(
          (c) =>
            new Promise((resolve) => {
              const onMessage = (m) => {
                if (m?.type === 'bench:cpu') {
                  c.off('message', onMessage);
                  resolve(m.cpu);
                }
              };
              c.on('message', onMessage);
              c.send({ type: 'bench:cpu' });
            })
        )
      );
      process.send({ type: 'cpu', cpu: cpuNow() + parts.reduce((a, b) => a + b, 0) });
    } else if (message.type === 'stop') {
      await primary.stop();
      process.exit(0);
    }
  });
  process.send({ type: 'ready', plainPort: port, tlsPort: port });
} else {
  // Baseline: ws + bufferutil, one process per worker through Node's cluster module.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  if (cluster.isPrimary) {
    const list = [];
    let ready = 0;
    let ports = null;
    for (let i = 0; i < workers; i++) {
      const worker = cluster.fork({ BENCH_CERT: certPath, BENCH_KEY: keyPath });
      list.push(worker);
      worker.on('message', (m) => {
        if (m.type === 'ready') {
          ports = m;
          if (++ready === workers) process.send({ type: 'ready', plainPort: ports.plainPort, tlsPort: ports.tlsPort });
        }
      });
    }
    process.on('message', async (message) => {
      if (message.type === 'cpu') {
        const parts = await Promise.all(
          list.map((w) => new Promise((resolve) => {
            w.once('message', (m) => resolve(m.cpu));
            w.send({ type: 'cpu' });
          }))
        );
        process.send({ type: 'cpu', cpu: cpuNow() + parts.reduce((a, b) => a + b, 0) });
      } else if (message.type === 'stop') {
        for (const w of list) w.kill();
        process.exit(0);
      }
    });
  } else {
    const { WebSocketServer } = await import('ws');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Same behaviour as the production server: ACK uploads, stream START with a 10 MB
    // buffered limit polled every millisecond, terminate on CLOSE.
    const onConnection = (ws) => {
      ws.on('message', (data) => {
        if (data.length > 128) {
          ws.send('ACK');
          return;
        }
        const message = data.toString();
        if (message === 'PING') ws.send('PONG');
        else if (message === 'CLOSE') ws.terminate();
        else if (message.startsWith('START ')) {
          const [, kb, count] = message.split(' ');
          const payload = Buffer.alloc(Number(kb) * 1024);
          (async () => {
            for (let i = 0; i < Number(count); i++) {
              ws.send(payload, { binary: true, compress: false, mask: false });
              while (ws.bufferedAmount > 10 * 1024 * 1024) {
                await sleep(1);
                if (ws.readyState !== 1) return;
              }
              if (ws.readyState !== 1) return;
            }
          })();
        }
      });
    };
    const options = { perMessageDeflate: false, skipUTF8Validation: true, maxPayload: 10 * 1024 * 1024 };
    const plain = http.createServer();
    new WebSocketServer({ server: plain, ...options }).on('connection', onConnection);
    const secure = https.createServer({ cert: readFileSync(process.env.BENCH_CERT), key: readFileSync(process.env.BENCH_KEY) });
    new WebSocketServer({ server: secure, ...options }).on('connection', onConnection);
    await new Promise((resolve) => plain.listen(47611, '127.0.0.1', resolve));
    await new Promise((resolve) => secure.listen(47612, '127.0.0.1', resolve));
    process.on('message', (m) => {
      if (m.type === 'cpu') process.send({ type: 'cpu', cpu: cpuNow() });
    });
    process.send({ type: 'ready', plainPort: 47611, tlsPort: 47612 });
  }
}
