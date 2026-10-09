#!/usr/bin/env node
// Loopback benchmark: this library against the ws-based baseline, on every transport.
//
//   npm run bench -- [--quick] [--runs 3] [--seconds 6] [--workers 1,2,4] [--threads 6]
//                    [--conns 2] [--transports tcp,tcps,ws,wss] [--json results.json]
//
// For every combination it starts the server, opens threads x conns client sockets, waits
// for them to warm up, then measures throughput and the CPU time of the client and every
// server process over the same window. Each result is the median of --runs runs.
import { fork } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generate } from 'selfsigned';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '6' },
    workers: { type: 'string', default: '1,2,4' },
    threads: { type: 'string', default: '6' },
    conns: { type: 'string', default: '2' },
    transports: { type: 'string', default: 'tcp,tcps,ws,wss' },
    implementations: { type: 'string', default: 'ws,speed-transport' },
    directions: { type: 'string', default: 'down,up' },
    json: { type: 'string' },
    quick: { type: 'boolean', default: false },
  },
});
if (values.quick) {
  values.runs = '1';
  values.seconds = '3';
  values.workers = '1';
}

const here = new URL('.', import.meta.url);
const certDir = mkdtempSync(join(tmpdir(), 'speed-transport-bench-'));
const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048 });
const certPath = join(certDir, 'cert.pem');
const keyPath = join(certDir, 'key.pem');
writeFileSync(certPath, pems.cert);
writeFileSync(keyPath, pems.private);

const once = (child, type) =>
  new Promise((resolve) => {
    const onMessage = (m) => {
      if (m?.type === type) {
        child.off('message', onMessage);
        resolve(m);
      }
    };
    child.on('message', onMessage);
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(implementation, transport, direction, workers) {
  const server = fork(new URL('./server.mjs', here), [implementation, String(workers), certPath, keyPath], { stdio: 'inherit' });
  const ready = await once(server, 'ready');
  const port = transport === 'tls' || transport === 'wss' || transport === 'tcps' ? ready.tlsPort : ready.plainPort;
  const client = fork(new URL('./client.mjs', here), [transport, direction, String(port), values.threads, values.conns], {
    stdio: 'inherit',
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' },
  });
  try {
    await Promise.race([once(client, 'open'), sleep(15000).then(() => { throw new Error('clients did not connect'); })]);
    await sleep(1500);
    const sample = async () => {
      client.send({ type: 'sample' });
      server.send({ type: 'cpu' });
      const [c, s] = await Promise.all([once(client, 'sample'), once(server, 'cpu')]);
      return { at: performance.now(), bytes: c.bytes, clientCpu: c.cpu, serverCpu: s.cpu };
    };
    const a = await sample();
    await sleep(Number(values.seconds) * 1000);
    const b = await sample();
    const ms = b.at - a.at;
    const gbps = ((b.bytes - a.bytes) * 8) / (ms * 1e6);
    return {
      gbps,
      serverCpu: ((b.serverCpu - a.serverCpu) / 1000 / ms) * 100,
      clientCpu: ((b.clientCpu - a.clientCpu) / 1000 / ms) * 100,
    };
  } finally {
    client.send({ type: 'stop' });
    server.send({ type: 'stop' });
    await sleep(500);
    client.kill();
    server.kill();
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];
for (const direction of values.directions.split(',')) {
  for (const workers of values.workers.split(',').map(Number)) {
    for (const transport of values.transports.split(',')) {
      for (const implementation of values.implementations.split(',')) {
        // The ws baseline has no raw TCP transport.
        if (implementation === 'ws' && (transport === 'tcp' || transport === 'tcps')) continue;
        const runs = [];
        for (let i = 0; i < Number(values.runs); i++) runs.push(await measure(implementation, transport, direction, workers));
        const result = {
          implementation,
          transport,
          direction,
          workers,
          gbps: +median(runs.map((r) => r.gbps)).toFixed(2),
          serverCpu: Math.round(median(runs.map((r) => r.serverCpu))),
          clientCpu: Math.round(median(runs.map((r) => r.clientCpu))),
        };
        result.serverCpuPerGbps = +(result.serverCpu / Math.max(result.gbps, 0.01)).toFixed(1);
        results.push(result);
        console.log(
          `${direction.padEnd(4)} workers=${workers} ${transport.padEnd(4)} ${implementation.padEnd(15)} ` +
            `${String(result.gbps).padStart(6)} Gbps  server ${String(result.serverCpu).padStart(4)}% ` +
            `(${String(result.serverCpuPerGbps).padStart(5)}%/Gbps)  client ${String(result.clientCpu).padStart(4)}%`
        );
      }
    }
  }
}
if (values.json) writeFileSync(values.json, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2));
process.exit(0);
