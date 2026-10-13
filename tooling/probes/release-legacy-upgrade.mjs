import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cache = path.join(repo, 'pack', 'legacy-upgrade');
const stateFile = path.join(cache, 'state.json');
const mode = process.argv[2] ?? 'prepare';
assert.ok(['prepare', 'upgrade'].includes(mode), 'usage: node tooling/probes/release-legacy-upgrade.mjs [prepare|upgrade]');
const sha = value => createHash('sha256').update(value).digest('hex');
const npmCli = [
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
].find(file => fs.existsSync(file));
assert.ok(npmCli, 'the verifying Node installation must contain npm');
fs.mkdirSync(cache, { recursive: true });
const observations = [];
let fixture;
const run = (executable, args, cwd) => {
  const result = spawnSync(executable, args, {
    cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, CANARY_TRUST_STORE: path.join(fixture, 'trust'), AMABIE_TRUST_STORE: path.join(fixture, 'trust') },
  });
  observations.push({ executable, args, cwd, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  return result;
};
const npm = (...args) => run(process.execPath, [npmCli, ...args], fixture);
const git = (project, ...args) => {
  const result = run('git', ['-C', project, ...args], fixture);
  assert.equal(result.status, 0, result.stderr);
};
const cli = (entry, project, ...args) => run(process.execPath, [entry, ...args], project);
const save = state => fs.writeFileSync(stateFile, JSON.stringify({ ...state, observations }, null, 2) + '\n');

if (mode === 'prepare') {
  assert.ok(!fs.existsSync(stateFile), 'legacy fixture already prepared; use upgrade or inspect the existing state');
  const filename = 'canary-rn-cli-1.5.0.tgz';
  const expected = 'cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386';
  const url = `https://github.com/criptofn/Canary/releases/download/v1.5.0/${filename}`;
  for (const name of [filename, filename + '.sha256']) {
    const response = await fetch(url + (name.endsWith('.sha256') ? '.sha256' : ''), { signal: AbortSignal.timeout(60_000) });
    assert.equal(response.ok, true, `download ${name}: HTTP ${response.status}`);
    fs.writeFileSync(path.join(cache, name), Buffer.from(await response.arrayBuffer()));
  }
  const tarball = path.join(cache, filename);
  assert.equal(sha(fs.readFileSync(tarball)), expected, 'published Canary artifact SHA-256');
  assert.equal(fs.readFileSync(tarball + '.sha256', 'utf8').trim().split(/\s+/)[0], expected, 'published checksum');
  console.log(`PASS published Canary v1.5.0 download matches ${expected}`);
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie legacy upgrade '));
  const prefix = path.join(fixture, 'isolated prefix');
  const project = path.join(fixture, 'existing project');
  fs.mkdirSync(project);
  const installed = npm('install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball);
  assert.equal(installed.status, 0, installed.stderr);
  const globalModules = process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  const oldCli = path.join(globalModules, '@canary-rn', 'cli', 'dist', 'main.js');
  assert.equal(cli(oldCli, project, '--version').stdout.trim(), 'canary 1.5.0');
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo preserve-foreign-hook' }] }] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'legacy-upgrade-fixture', private: true, scripts: { test: 'node --test greeting.test.cjs' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'greeting.cjs'), 'module.exports = name => "Hello, " + name + "!";\n');
  fs.writeFileSync(path.join(project, 'greeting.test.cjs'), 'const assert = require("node:assert/strict"); const test = require("node:test"); const greet = require("./greeting.cjs"); test("greeting", () => assert.equal(greet("Ada"), "Hello, Ada!"));\n');
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'Amabie upgrade rehearsal');
  git(project, 'config', 'user.email', 'upgrade@example.invalid');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'Legacy example');
  const setup = cli(oldCli, project, 'setup', '--yes');
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const doctor = cli(oldCli, project, 'doctor', '--json');
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).status, 'READY');
  const oldConfig = path.join(project, '.canary', 'canary.local.json');
  assert.ok(fs.existsSync(oldConfig));
  const state = { schema: 'amabie-legacy-upgrade/1', phase: 'prepared', platform: process.platform, node: process.version, fixture, prefix, project, globalModules, oldCli, oldConfig, oldConfigSha256: sha(fs.readFileSync(oldConfig)), oldArtifactSha256: expected, source: url };
  save(state);
  console.log(`PASS real published Canary setup and doctor READY in isolated prefix/project; state ${stateFile}`);
} else {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.phase, 'prepared', 'upgrade runs once after the prepared phase');
  fixture = state.fixture;
  observations.push(...state.observations);
  const tarball = path.join(repo, 'pack', 'npm', 'amabie-cli-2.0.0.tgz');
  assert.equal(fs.readFileSync(tarball + '.sha256', 'utf8').trim().split(/\s+/)[0], sha(fs.readFileSync(tarball)));
  assert.equal(sha(fs.readFileSync(state.oldConfig)), state.oldConfigSha256, 'legacy state preserved before upgrade');
  const collision = npm('install', '--global', '--prefix', state.prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball);
  const collisionStatus = collision.status === 0 ? 'INSTALL_SUCCEEDED_WITH_EXISTING_CANARY_BIN' : 'INSTALL_REFUSED';
  console.log(`OBSERVED npm bin collision: ${collisionStatus} (exit ${collision.status})`);
  assert.equal(sha(fs.readFileSync(state.oldConfig)), state.oldConfigSha256, 'installation must not mutate project state');
  const removed = npm('uninstall', '--global', '--prefix', state.prefix, '--ignore-scripts', '--no-audit', '--no-fund', '@canary-rn/cli');
  assert.equal(removed.status, 0, removed.stderr);
  const installed = npm('install', '--global', '--prefix', state.prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball);
  assert.equal(installed.status, 0, installed.stderr);
  const newCli = path.join(state.globalModules, '@amabie', 'cli', 'dist', 'main.js');
  assert.equal(cli(newCli, state.project, '--version').stdout.trim(), 'amabie 2.0.0');
  const setup = cli(newCli, state.project, 'setup', '--yes');
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const doctor = cli(newCli, state.project, 'doctor', '--json');
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).status, 'READY');
  assert.ok(fs.existsSync(path.join(state.project, '.amabie', 'amabie.local.json')));
  const settings = fs.readFileSync(path.join(state.project, '.claude', 'settings.json'), 'utf8');
  assert.ok(settings.includes('preserve-foreign-hook'), 'foreign hook must survive');
  assert.ok(settings.includes('@amabie'), 'new hook must invoke the new installation');
  assert.ok(fs.existsSync(path.join(state.prefix, process.platform === 'win32' ? 'canary.cmd' : 'bin/canary')), 'compatibility bin still present');
  save({ ...state, phase: 'upgraded', collisionStatus, artifactSha256: sha(fs.readFileSync(tarball)), newCli });
  console.log(`PASS installed Canary1.5 → Amabie2.0 upgrade, migrated state, preserved foreign hook and new doctor READY; state ${stateFile}`);
}
