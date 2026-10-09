#!/usr/bin/env node
// Runs the Autobahn WebSocket conformance suite (crossbario/autobahn-testsuite in Docker)
// against an echo server built on this library, and fails on any FAILED case.
//
//   npm run autobahn                 # Docker Desktop: reaches the host as host.docker.internal
//   AUTOBAHN_HOST_NETWORK=1 npm run autobahn   # Linux CI: --network host, 127.0.0.1
//
// Cases 12.* and 13.* test permessage-deflate, which the library never negotiates (it would
// cost CPU and distort throughput measurements), so they are excluded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpeedTransportServer } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const hostNetwork = process.env.AUTOBAHN_HOST_NETWORK === '1';
const port = Number(process.env.AUTOBAHN_PORT ?? 9001);
const image = process.env.AUTOBAHN_IMAGE ?? 'crossbario/autobahn-testsuite:latest';
const maxMessageBytes = 64 * 1024 * 1024;

const server = createSpeedTransportServer({
  limits: { maxMessageBytes, maxBufferedMessageBytes: maxMessageBytes, idleTimeoutMs: 120_000 },
  onConnection: (connection) => {
    connection.on('message', (data, binary) => {
      if (binary) connection.sendBinary(data);
      else connection.sendFrame(Buffer.concat([textHeader(data.length), data]));
    });
  },
});

function textHeader(length) {
  if (length < 126) return Buffer.from([0x81, length]);
  if (length < 65536) {
    const header = Buffer.from([0x81, 126, 0, 0]);
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

await server.listen(port, hostNetwork ? '127.0.0.1' : '0.0.0.0');

const configDir = join(here, 'config');
const reportsDir = join(here, 'reports');
rmSync(reportsDir, { recursive: true, force: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
writeFileSync(
  join(configDir, 'fuzzingclient.json'),
  JSON.stringify(
    {
      outdir: '/reports/servers',
      servers: [
        {
          agent: 'speed-transport',
          url: `ws://${hostNetwork ? '127.0.0.1' : 'host.docker.internal'}:${port}`,
        },
      ],
      cases: ['*'],
      'exclude-cases': ['12.*', '13.*'],
      'exclude-agent-cases': {},
    },
    null,
    2
  )
);

let exitCode = 0;
try {
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      ...(hostNetwork ? ['--network', 'host'] : []),
      '-v',
      `${configDir}:/config`,
      '-v',
      `${reportsDir}:/reports`,
      image,
      'wstest',
      '-m',
      'fuzzingclient',
      '-s',
      '/config/fuzzingclient.json',
    ],
    { stdio: 'inherit' }
  );

  const index = JSON.parse(readFileSync(join(reportsDir, 'servers', 'index.json'), 'utf8'))['speed-transport'];
  const counts = {};
  const failures = [];
  for (const [id, result] of Object.entries(index)) {
    for (const behavior of [result.behavior, result.behaviorClose]) {
      counts[behavior] = (counts[behavior] ?? 0) + 1;
    }
    if (result.behavior === 'FAILED' || result.behaviorClose === 'FAILED') failures.push(id);
  }
  console.log(`\nAutobahn: ${Object.keys(index).length} cases`, counts);
  if (failures.length > 0) {
    console.error(`FAILED cases: ${failures.join(', ')}`);
    exitCode = 1;
  } else {
    console.log('No failed cases. Report: autobahn/reports/servers/index.html');
  }
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
