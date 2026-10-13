#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceFile = process.argv[2];
const refresh = process.argv[3] === '--refresh';
assert(process.argv[3] === undefined || refresh);
assert(evidenceFile && path.isAbsolute(evidenceFile));
const report = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
assert.equal(report.schema, 'amabie-release-linux-environment/1');
assert(/^\/var\/tmp\/amabie-release-linux\.[a-zA-Z0-9]+$/.test(report.environment));
const source = `${report.environment}/source`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-release-index-'));
const index = path.join(scratch, 'index');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const git = args => run('git', args, { ...process.env, GIT_INDEX_FILE: index });
const linux = args => run('wsl.exe', ['--distribution', report.distro, '--exec', ...args]);
const mainIndex = run('git', ['rev-parse', '--git-path', 'index']);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = digest(mainIndex);
try {
  // Temporary index creates a canonical source tree without changing HEAD, staged work or checkout bytes.
  git(['read-tree', 'HEAD']);
  git(['add', '--all']);
  const tree = git(['write-tree']);
  assert(/^[a-f0-9]{40}$/.test(tree));
  const archive = path.join(scratch, 'source.tar');
  git(['archive', '--format=tar', `--output=${archive}`, tree]);
  assert.equal(digest(mainIndex), before, 'Default Git index changed during source export.');
  if (refresh) {
    assert.equal(report.source, source);
    linux(['test', '-d', `${source}/.git`]);
  } else linux(['mkdir', source]);
  linux(['tar', '-xf', linux(['wslpath', '-a', archive]), '-C', source]);
  const native = args => linux(['env', `PATH=${report.path}`, ...args]);
  if (!refresh) {
    native(['git', '-C', source, 'init', '-b', 'codex/amabie-release-rehearsal']);
    native(['git', '-C', source, 'config', 'user.name', 'Amabie release test']);
    native(['git', '-C', source, 'config', 'user.email', 'release-test@example.invalid']);
  }
  native(['git', '-C', source, 'add', '--all']);
  native(['git', '-C', source, 'commit', '--allow-empty', '-m', 'Canonical local release source']);
  Object.assign(report, { source, sourceTree: tree, sourceArchiveSha256: digest(archive) });
  fs.writeFileSync(evidenceFile, JSON.stringify(report, null, 2) + '\n');
  console.log('PASS: canonical release source exported to a fresh native Linux Git repository.');
  console.log(JSON.stringify(report, null, 2));
} finally {
  assert(path.dirname(scratch) === os.tmpdir());
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
