#!/usr/bin/env node
// Packs the library, installs the tarball into an empty project, and imports both entry
// points, the way a consumer would. Catches missing files and broken export maps.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = mkdtempSync(join(tmpdir(), 'speed-transport-pack-'));
try {
  execFileSync(npm, ['pack', '--pack-destination', work], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  execFileSync(npm, ['install', '--no-audit', '--no-fund', join(work, tarball)], { cwd: work, stdio: 'inherit', shell: process.platform === 'win32' });
  writeFileSync(
    join(work, 'check.mjs'),
    `import * as server from '@coveragemap/speed-transport';
import * as client from '@coveragemap/speed-transport/client';
const required = ['createSpeedTransportServer', 'createSpeedTestServer', 'createClusterPrimary', 'runClusterWorker', 'FrameParser', 'TCP_PREAMBLE'];
for (const name of required) if (!(name in server)) throw new Error('missing export ' + name);
if (typeof client.SpeedTransportSocket !== 'function' || typeof client.probeTcpTransport !== 'function') throw new Error('missing client exports');
const s = server.createSpeedTestServer({});
const { port } = await s.listen(0, '127.0.0.1');
const ok = await client.probeTcpTransport('127.0.0.1', port);
await s.close();
if (!ok) throw new Error('probe failed');
console.log('package OK');
`
  );
  execFileSync(process.execPath, ['check.mjs'], { cwd: work, stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
