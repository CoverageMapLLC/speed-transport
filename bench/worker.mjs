// Benchmark cluster worker: the library's speed test server on every transport.
import { createSpeedTestServer, runClusterWorker } from '../dist/index.js';

process.on('message', (message) => {
  if (message?.type === 'bench:cpu') {
    const usage = process.cpuUsage();
    process.send({ type: 'bench:cpu', cpu: usage.user + usage.system });
  }
});

runClusterWorker(() =>
  // TLS settings arrive from the primary through setSecureContext.
  createSpeedTestServer({ tls: {} })
);
