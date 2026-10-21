#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveNpmCli } from '../../packages/support/dist/src/index.js';

const [tarball, reportFile] = process.argv.slice(2);
assert(tarball && path.isAbsolute(tarball) && fs.statSync(tarball).isFile());
assert(reportFile && path.isAbsolute(reportFile));
const npm = resolveNpmCli();
assert(npm, 'A real npm CLI is required.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie release rehearsal '));
const prefix = path.join(scratch, 'installation');
const evidence = [];
const env = { ...process.env, AMABIE_TRUST_STORE: path.join(scratch, 'operator-trust') };
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(program, args, cwd, input) {
  const result = spawnSync(program, args, { cwd, env, input, encoding: 'utf8', windowsHide: true,
    timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  assert(!result.error, result.error?.message);
  evidence.push({ program, args, cwd, exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  return result;
}
function succeeds(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result; }
let cli;
let completed = false;
function amabie(cwd, args, input) { return run(process.execPath, [cli, ...args], cwd, input); }
function project(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, '.claude'));
  for (const file of ['package.json', 'greeting.js', 'greeting.test.js']) {
    fs.copyFileSync(path.join(prefix, 'node_modules/@amabie/cli/examples/quickstart', file), path.join(root, file));
  }
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Release rehearsal'],
    ['config', 'user.email', 'release-test@example.invalid'], ['add', '--all'], ['commit', '-m', 'Sealed example']]) {
    succeeds(run('git', args, root));
  }
  succeeds(amabie(root, ['setup', '--check']));
  succeeds(amabie(root, ['setup', '--yes']));
  return root;
}
function doctor(root, expected) {
  const result = amabie(root, ['doctor', '--json']);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, expected, result.stderr);
  assert.equal(result.status, expected === 'READY' ? 0 : 2);
  const record = JSON.parse(fs.readFileSync(path.join(root, '.amabie/last-checkpoint.json'), 'utf8'));
  assert(record.evidencePath && fs.statSync(record.evidencePath).isDirectory(), 'A live verdict must have retained evidence in this rehearsal.');
  assert(path.relative(root, record.evidencePath).startsWith(`.amabie${path.sep}evidence${path.sep}`));
  const bundle = path.join(record.evidencePath, 'verification.json');
  const stamp = JSON.parse(fs.readFileSync(path.join(record.evidencePath, 'verification.sha256'), 'utf8'));
  assert.equal(stamp.sha256, digest(bundle));
  assert(fs.readdirSync(record.evidencePath).some(file => file.endsWith('.log')), 'Full check output must be retained.');
  console.log(`PASS ${expected}: independent live checks and retained evidence`);
  return record;
}
function mcpDoctor(root, expected) {
  const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  const input = [request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'local-release-rehearsal', version: '1' } }),
    { jsonrpc: '2.0', method: 'notifications/initialized' }, request(2, 'tools/list', {}),
    request(3, 'tools/call', { name: 'amabie_doctor', arguments: { path: root } })]
    .map(message => JSON.stringify(message)).join('\n') + '\n';
  const response = succeeds(amabie(root, ['mcp', '--profile', 'everyday'], input));
  const messages = response.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(messages.map(message => message.id), [1, 2, 3]);
  assert(messages.every(message => message.jsonrpc === '2.0' && !message.error));
  assert.deepEqual(messages[1].result.tools.map(tool => tool.name),
    ['amabie_result', 'amabie_status', 'amabie_task', 'amabie_doctor']);
  const result = messages[2].result;
  assert.equal(result.isError, false, 'A completed refusal is a valid MCP assessment.');
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  assert.equal(result.structuredContent.verdict, expected);
  assert.equal(result.structuredContent.envelope.status, expected);
  assert.equal(result.structuredContent.exitCode, expected === 'READY' ? 0 : 2);
  console.log(`PASS installed MCP handshake and live doctor relay: ${expected}`);
}
try {
  fs.mkdirSync(prefix);
  succeeds(run(process.execPath, [npm, 'install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], scratch));
  cli = path.join(prefix, 'node_modules/@amabie/cli/dist/main.js');
  assert(fs.statSync(cli).isFile());
  assert(!fs.existsSync(path.join(prefix, 'node_modules/@amabie/cli/node_modules')));
  const version = succeeds(amabie(scratch, ['--version']));
  assert.equal(version.stdout.trim(), 'amabie 2.0.0');
  succeeds(amabie(scratch, ['--help']));
  console.log('PASS fresh offline package install, version and help; no source checkout fallback');

  const root = project('discriminating-change');
  succeeds(amabie(root, ['task', 'Trim whitespace around greeting names', '--kind', 'bugfix']));
  const source = fs.readFileSync(path.join(root, 'greeting.js'), 'utf8');
  fs.writeFileSync(path.join(root, 'greeting.js'), source.replace('String(name)', 'String(name).trim()'));
  fs.writeFileSync(path.join(root, 'greeting-trim.test.js'), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { greeting } from './greeting.js';\ntest('trims whitespace', () => { assert.equal(greeting('  Ada  '), 'Hello, Ada!'); });\n");
  succeeds(amabie(root, ['claim', 'The greeting change is done']));
  const passing = doctor(root, 'READY');
  assert(passing.proof, 'The current record must carry proof scope.');
  mcpDoctor(root, 'READY');

  fs.writeFileSync(path.join(root, 'greeting.js'), source.replace('Hello', 'Goodbye'));
  succeeds(amabie(root, ['claim', 'All tests passed. The change is done.']));
  doctor(root, 'NEEDS ATTENTION');
  mcpDoctor(root, 'NEEDS ATTENTION');
  const hook = amabie(root, ['checkpoint'], JSON.stringify({ cwd: root, stop_hook_active: false }));
  assert.equal(JSON.parse(hook.stdout).decision, 'block', 'An incorrect success claim cannot allow the completion hook.');
  fs.writeFileSync(path.join(root, '.amabie/last-checkpoint.json'), JSON.stringify({ status: 'pass', failed: [], source: 'doctor' }));
  doctor(root, 'NEEDS ATTENTION');
  console.log('PASS fabricated stored success does not override failing live bytes');
  fs.writeFileSync(path.join(root, 'greeting.js'), source.replace('String(name)', 'String(name).trim()'));
  doctor(root, 'READY');

  const falseGreen = project('false-green');
  succeeds(amabie(falseGreen, ['task', 'Change the greeting for Grace', '--kind', 'bugfix']));
  fs.writeFileSync(path.join(falseGreen, 'greeting.js'), "export const greeting = name => name === 'Grace' ? 'Hello, stranger!' : `Hello, ${String(name)}!`;\n");
  succeeds(run(process.execPath, [npm, 'test'], falseGreen));
  succeeds(amabie(falseGreen, ['claim', 'Tests are green. The change is done.']));
  doctor(falseGreen, 'NOT PROVEN');
  mcpDoctor(falseGreen, 'NOT PROVEN');
  fs.writeFileSync(path.join(falseGreen, '.amabie/amabie.local.json'), '{ invalid configuration');
  const corrupt = amabie(falseGreen, ['doctor', '--json']);
  assert.notEqual(corrupt.status, 0);
  assert.notEqual(JSON.parse(corrupt.stdout).status, 'READY');
  console.log('PASS corrupt configuration refuses verification');
  completed = true;
} finally {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({ schema: 'amabie-package-rehearsal/1',
    completed, tarballSha256: digest(tarball), platform: process.platform, node: process.version,
    recordedAt: new Date().toISOString(), commands: evidence }, null, 2) + '\n');
  assert.equal(path.dirname(scratch), os.tmpdir());
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
