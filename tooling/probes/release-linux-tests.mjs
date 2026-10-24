#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [reportFile, logDirectory, mode] = process.argv.slice(2);
assert(mode === undefined || mode === '--retry');
assert(reportFile && path.isAbsolute(reportFile));
assert(logDirectory && path.isAbsolute(logDirectory));
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert.equal(report.schema, 'amabie-release-linux-environment/1');
assert(/^\/var\/tmp\/amabie-release-linux\.[a-zA-Z0-9]+\/source$/.test(report.source));
assert.equal(report.runtime, `${report.environment}/node`);
fs.mkdirSync(logDirectory, { recursive: true });
const node = `${report.runtime}/bin/node`;
const npm = `${report.runtime}/lib/node_modules/npm/bin/npm-cli.js`;
if (mode === '--retry') {
  const root = path.resolve(import.meta.dirname, '../..');
  for (const relative of ['apps/cli/test/provider-status.test.ts', 'apps/cli/test/universal-project.test.ts',
    'packages/runner/executor/test/python-wiring.test.ts', 'apps/cli/test/v15-sealed-toolchain.test.ts']) {
    const hostFile = path.join(root, relative);
    const converted = spawnSync('wsl.exe', ['--distribution', report.distro, '--exec', 'wslpath', '-a', hostFile],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(converted.status, 0);
    const copied = spawnSync('wsl.exe', ['--distribution', report.distro, '--exec', 'cp', '--',
      converted.stdout.trim(), `${report.source}/${relative}`], { windowsHide: true });
    assert.equal(copied.status, 0);
  }
}
const steps = [
  ...mode === '--retry' ? [] : [
  ['linux-npm-ci', [node, npm, 'ci']],
  ['linux-go-install', [node, 'tooling/toolchains.mjs', 'go', '--go-version=1.27.2']],
  ],
  ['linux-python-venv', ['python3', '-m', 'venv', '_toolchains/py']],
  ['linux-pytest-install', [`${report.source}/_toolchains/py/bin/python`, '-m', 'pip', 'install', 'pytest==9.1.1']],
  [mode === '--retry' ? 'linux-npm-test-r2' : 'linux-npm-test', [node, npm, 'test']],
];
for (const [name, command] of steps) {
  const file = path.join(logDirectory, `${name}.log`);
  const fd = fs.openSync(file, 'w');
  console.log(`START ${name}: ${file}`);
  let result;
  try {
    result = spawnSync('wsl.exe', ['--distribution', report.distro, '--cd', report.source,
      '--exec', 'env', `PATH=${report.source}/_toolchains/py/bin:${report.path}`, ...command],
      { windowsHide: true, stdio: ['ignore', fd, fd], timeout: 1_800_000 });
  } finally { fs.closeSync(fd); }
  assert.equal(result.status, 0, `${name} failed: ${result.error?.message ?? `exit ${result.status}`}; see ${file}`);
  console.log(`PASS ${name}`);
}
