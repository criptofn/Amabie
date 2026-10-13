import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const installed = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(repo, 'pack/legacy-upgrade/state.json'), 'utf8')).newCli;
assert.ok(installed && fs.existsSync(installed), 'provide a frozen installed CLI entry; this probe does not read development dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-proof-gap-doc-'));
const project = path.join(temp, 'fresh example');
const observations = [];
function run(program, args) {
  const result = spawnSync(program, args, { cwd: project, encoding: 'utf8', timeout: 240_000, windowsHide: true, env: { ...process.env, AMABIE_TRUST_STORE: path.join(temp, 'trust') } });
  observations.push({ program, args, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  return result;
}
try {
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true }); // The guide explicitly labels this as a synthetic hook configuration.
  const example = path.resolve(path.dirname(installed), '../examples/quickstart');
  for (const name of ['package.json', 'greeting.js', 'greeting.test.js']) fs.copyFileSync(path.join(example, name), path.join(project, name));
  for (const args of [['init'], ['config', '--local', 'user.name', 'Amabie proof-gap example'], ['config', '--local', 'user.email', 'example@example.invalid'], ['add', 'package.json', 'greeting.js', 'greeting.test.js'], ['commit', '-m', 'Start uncovered-change example']]) {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(run('git', ['status', '--short']).stdout.trim(), '', 'baseline must be clean before the first setup');
  const setup = run(process.execPath, [installed, 'setup', '--yes']);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const task = run(process.execPath, [installed, 'task', 'Change the greeting for Grace', '--kind', 'bugfix']);
  assert.equal(task.status, 0, task.stdout + task.stderr);
  fs.writeFileSync(path.join(project, 'greeting.js'), "export const greeting = name => name === 'Grace' ? 'Hello, stranger!' : `Hello, ${String(name)}!`;\n");
  const tests = run(process.execPath, ['--test', 'greeting.test.js']);
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  assert.equal(run(process.execPath, [installed, 'claim', 'The greeting change is done']).status, 0);
  const doctor = run(process.execPath, [installed, 'doctor', '--json']);
  const verdict = JSON.parse(doctor.stdout);
  assert.notEqual(doctor.status, 0, 'an insufficient claim cannot complete successfully');
  assert.equal(verdict.status, 'NOT PROVEN', doctor.stdout + doctor.stderr);
  const result = run(process.execPath, [installed, 'result', '--json']);
  assert.equal(JSON.parse(result.stdout).lastVerification.status, 'unproven');
  fs.writeFileSync(path.join(repo, 'pack/quickstart-proof-gap.json'), JSON.stringify({ schema: 'amabie-quickstart-proof-gap/1', platform: process.platform, node: process.version, installed, syntheticHookConfiguration: true, observations, verdict }, null, 2) + '\n');
  console.log('PASS documented fresh-copy sequence: clean initial baseline, passing checks, agent claim and deterministic NOT PROVEN');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
