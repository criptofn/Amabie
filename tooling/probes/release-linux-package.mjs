#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const [reportFile, destination, windowsTarball] = process.argv.slice(2);
assert(reportFile && path.isAbsolute(reportFile));
assert(destination && path.isAbsolute(destination));
assert(windowsTarball && path.isAbsolute(windowsTarball));
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert.equal(report.schema, 'amabie-release-linux-environment/1');
assert(/^\/var\/tmp\/amabie-release-linux\.[a-zA-Z0-9]+\/source$/.test(report.source));
const node = `${report.runtime}/bin/node`;
const npm = `${report.runtime}/lib/node_modules/npm/bin/npm-cli.js`;
const linuxPath = `${report.source}/_toolchains/py/bin:${report.path}`;
fs.mkdirSync(destination, { recursive: true });
function wsl(args, options = {}) {
  const result = spawnSync('wsl.exe', ['--distribution', report.distro, '--exec', ...args],
    { windowsHide: true, encoding: 'utf8', timeout: 300_000, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? `exit ${result.status}`);
  return result.stdout?.trim();
}
const nativeDestination = wsl(['wslpath', '-a', destination]);
const localTarball = `${report.source}/pack/npm/amabie-cli-2.0.0.tgz`;
const steps = [
  ['linux-final-build', [node, npm, 'run', 'build:force']],
  ['linux-package-reproducibility', [node, 'tooling/probes/release-package-reproducibility.mjs']],
  ['linux-cleanroom', [node, 'tooling/probes/cleanroom-packed-artifact.mjs']],
  ['linux-package-rehearsal', [node, 'tooling/probes/release-package-rehearsal.mjs', localTarball, `${nativeDestination}/linux-package-rehearsal.json`]],
];
for (const [name, command] of steps) {
  const file = path.join(destination, `${name}.log`);
  const fd = fs.openSync(file, 'w');
  console.log(`START ${name}: ${file}`);
  try { wsl(['env', `--chdir=${report.source}`, `PATH=${linuxPath}`, ...command], { stdio: ['ignore', fd, fd], timeout: 1_800_000 }); }
  finally { fs.closeSync(fd); }
  console.log(`PASS ${name}`);
}
wsl(['cp', '--', localTarball, `${nativeDestination}/amabie-cli-2.0.0.tgz`]);
wsl(['cp', '--', `${localTarball}.sha256`, `${nativeDestination}/amabie-cli-2.0.0.tgz.sha256`]);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const comparison = { schema: 'amabie-cross-os-package/1', windowsSha256: hash(windowsTarball),
  linuxSha256: hash(path.join(destination, 'amabie-cli-2.0.0.tgz')),
  recordedAt: new Date().toISOString() };
fs.writeFileSync(path.join(destination, 'cross-os-package.json'), JSON.stringify(comparison, null, 2) + '\n');
assert.equal(comparison.linuxSha256, comparison.windowsSha256, 'Linux and Windows packages differ; inspect bytes before claiming cross-OS reproducibility.');
console.log('PASS native Linux build, cleanroom, full verification rehearsal and byte-identical Windows/Linux packages');
