#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Bootstrap a native Linux runtime; never use the Windows npm exposed by WSL's inherited PATH.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.platform, 'win32', 'Run this WSL preparation probe on Windows.');
const distro = 'Ubuntu-24.04';
function linux(...args) {
  const result = spawnSync('wsl.exe', ['--distribution', distro, '--exec', ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
assert.equal(linux('uname', '-sm'), 'Linux x86_64');
const hashes = await (await fetch('https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt')).text();
const match = hashes.match(/^([a-f0-9]{64})\s+(node-(v22\.\d+\.\d+)-linux-x64\.tar\.xz)$/m);
assert(match, 'Official Node22 Linux x64 checksum not found.');
const [, expected, filename, version] = match;
const cache = path.join(root, '_toolchains', 'linux-node-bootstrap', version);
fs.mkdirSync(cache, { recursive: true });
const archive = path.join(cache, filename);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (!fs.existsSync(archive) || digest(fs.readFileSync(archive)) !== expected) {
  const response = await fetch(`https://nodejs.org/dist/${version}/${filename}`);
  assert(response.ok, `Node archive HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), expected, 'Node archive SHA256 mismatch; nothing extracted.');
  fs.writeFileSync(archive, bytes);
}
// WSL clears /tmp when its idle VM restarts; /var/tmp is still temporary but survives that restart.
const environment = linux('mktemp', '-d', '/var/tmp/amabie-release-linux.XXXXXX');
assert(/^\/var\/tmp\/amabie-release-linux\.[a-zA-Z0-9]+$/.test(environment));
const runtime = `${environment}/node`;
linux('mkdir', runtime);
linux('tar', '-xJf', linux('wslpath', '-a', archive), '--strip-components=1', '-C', runtime);
assert.equal(linux(`${runtime}/bin/node`, '--version'), version);
const report = { schema: 'amabie-release-linux-environment/1', distro, environment, runtime, nativeNode: version, nodeArchiveSha256: expected, path: `${runtime}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, createdAt: new Date().toISOString() };
const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), 'Supply an absolute evidence JSON path.');
fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
console.log('PASS: verified native Linux Node runtime prepared.');
console.log(JSON.stringify(report, null, 2));
