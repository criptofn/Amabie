import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_ENTRY } from '../../apps/cli/dist/src/cli-runtime.js';
import { resolveNpmCli, sanitizedEnv } from '../../packages/support/dist/src/index.js';
import { hostGit } from '../../tooling/test-support/host-git.mjs';

const upstream = 'https://github.com/component/escape-html.git';
const revision = 'b42947eefa79efff01b3fe988c4c7e7b051ec8d8';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-real-repo-'));
const root = path.join(scratch, 'project');
fs.mkdirSync(root);
const env = { ...sanitizedEnv({ ws: { root: scratch, fixture: root }, nodeDir: path.dirname(process.execPath) }),
  AMABIE_TRUST_STORE: path.join(scratch, 'trust') };
const git = hostGit();
const npm = resolveNpmCli();
assert.ok(npm, 'npm is required');
const steps = [];
const run = (program, args, input) => {
  const result = spawnSync(program, args, { cwd: root, env, encoding: 'utf8', windowsHide: true,
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${path.basename(program)} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const record = (label, command, output) => {
  steps.push({ label, command, output: output.replaceAll(scratch, '<scratch>').slice(-2400) });
  console.log(`PASS ${label}`);
};
try {
  run(git, ['init', '--quiet']);
  run(git, ['remote', 'add', 'origin', upstream]);
  run(git, ['fetch', '--quiet', '--depth=1', 'origin', revision]);
  run(git, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  assert.equal(run(git, ['rev-parse', 'HEAD']).trim(), revision);
  run(git, ['config', 'user.name', 'Amabie demonstration']);
  run(git, ['config', 'user.email', 'demo@example.invalid']);
  run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(git, ['add', '-A']);
  run(git, ['commit', '--quiet', '--allow-empty', '-m', 'Record dependency installation']);
  fs.mkdirSync(path.join(root, '.claude'));
  record('Original upstream tests pass', 'npm test', run(process.execPath, [npm, 'test']));
  run(process.execPath, [CLI_ENTRY, 'setup', '--yes']);
  const originalCode = fs.readFileSync(path.join(root, 'index.js'));
  const originalPackage = fs.readFileSync(path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = value => String(value);\n');
  const pkg = JSON.parse(originalPackage);
  pkg.scripts.test = 'node --version';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  run(git, ['add', 'index.js', 'package.json']);
  run(git, ['commit', '--quiet', '-m', 'Simulated false completion: broken escaping and weakened test command']);
  record('Broken implementation hides behind a green command', 'npm test', run(process.execPath, [npm, 'test']));
  const blocked = JSON.parse(run(process.execPath, [CLI_ENTRY, 'checkpoint'], { cwd: root, stop_hook_active: false }));
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /authority|sealed|changed/i);
  record('Amabie blocks the simulated completion', 'amabie checkpoint', blocked.reason);
  fs.writeFileSync(path.join(root, 'index.js'), originalCode);
  fs.writeFileSync(path.join(root, 'package.json'), originalPackage);
  run(git, ['add', 'index.js', 'package.json']);
  run(git, ['commit', '--quiet', '-m', 'Restore reviewed implementation and checks']);
  const tests = run(process.execPath, [npm, 'test']);
  const completion = run(process.execPath, [CLI_ENTRY, 'checkpoint'], { cwd: root, stop_hook_active: false });
  assert.equal(completion.trim(), '', 'restoring the reviewed tree must allow completion');
  record('Restored implementation passes the real tests and completion gate', 'npm test; amabie checkpoint', tests);
  if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify({
    upstream, revision, simulatedAgentCompletion: true, runtime: { node: process.version, platform: process.platform }, steps,
  }, null, 2) + '\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
