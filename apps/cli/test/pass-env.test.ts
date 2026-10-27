import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { sanitizedEnv } from '@amabie/support';
import { runPlanStep } from '../src/check-runner.js';
import { CLI_ENTRY } from '../src/cli-runtime.js';
import { readConfig } from '../src/local-config.js';
import { sealedPassEnvNames } from '../src/pass-env.js';

/**
 * `amabie setup --pass-env NAME`: a human allows ONE variable by name; checks receive its value from
 * the operator's shell at run time. Nothing else from the shell reaches a check, a loader or
 * runtime-control name is refused, and the value never lands in the config, the trust store or output.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-pass-env-'));
const STORE = path.join(TMP, 'store');
process.env.AMABIE_TRUST_STORE = STORE;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SECRET = 'tok-7f3a9c1e5b2d4a60-sentinel';
const CHECK = [
  "const { test } = require('node:test'); const assert = require('node:assert/strict');",
  `test('receives the allowed variable', () => assert.equal(process.env.PASS_ENV_TEST_TOKEN?.length, ${SECRET.length}));`,
  "test('does not receive an unlisted variable', () => assert.equal(process.env.PASS_ENV_UNLISTED, undefined));",
  '',
].join('\n');

function git(root: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}
/** Run the CLI as a human terminal would: the shell's variables are the ones the test hands in. */
function amabie(root: string, shell: Record<string, string>, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, AMABIE_TRUST_STORE: STORE, ...shell };
  for (const name of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function fixture(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'node --test tests/env.test.cjs' } }));
  fs.writeFileSync(path.join(root, 'tests/env.test.cjs'), CHECK);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Amabie Regression'); git(root, 'config', 'user.email', 'regression@amabie.local');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  return root;
}
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('an allowed variable reaches the check, an unlisted one does not, and the value is stored nowhere', () => {
  const root = fixture('allowed');
  const shell = { PASS_ENV_TEST_TOKEN: SECRET, PASS_ENV_UNLISTED: 'also-in-the-shell' };
  const withName = amabie(root, shell, 'setup', '--yes', '--pass-env', 'PASS_ENV_TEST_TOKEN');
  assert.equal(withName.code, 0, withName.out);
  assert.match(withName.out, /PASS_ENV_TEST_TOKEN/);
  assert.doesNotMatch(withName.out, new RegExp(SECRET));
  assert.deepEqual(sealedPassEnvNames(root), ['PASS_ENV_TEST_TOKEN']);

  // The name is kept by a plain re-run; the VALUE is not, so a shell without it fails the check.
  assert.equal(amabie(root, shell, 'setup', '--yes').code, 0, 'a plain re-run keeps the allowed name');
  const without = amabie(root, { PASS_ENV_TEST_TOKEN: '' }, 'setup', '--yes');
  assert.notEqual(without.code, 0, 'the value was read from the shell, not remembered');

  for (const dir of [path.join(root, '.amabie'), STORE]) {
    for (const file of filesUnder(dir)) {
      assert.ok(!fs.readFileSync(file).includes(SECRET), `the secret value must not be written to ${path.relative(TMP, file)}`);
    }
  }
});

test('loader and runtime-control names are refused at setup and change nothing', () => {
  const root = fixture('refused');
  for (const name of ['PATH', 'path', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'GIT_SSH_COMMAND', 'AMABIE_TRUST_STORE', 'bad name']) {
    const r = amabie(root, {}, 'setup', '--yes', '--pass-env', name);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, /will not pass that variable/);
    assert.equal(readConfig(root), null, `${name} must leave the project unconfigured`);
  }
  assert.deepEqual(sealedPassEnvNames(root), []);
});

test('the sanitized environment door refuses a blocked name even from a forged record', () => {
  const ws = { root: path.join(TMP, 'ws'), fixture: TMP };
  for (const key of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'PYTHONSTARTUP']) {
    assert.throws(() => sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath), operatorEnv: { [key]: 'x' } }), /refused/);
  }
  const env = sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath), operatorEnv: { PASS_ENV_TEST_TOKEN: SECRET } });
  assert.equal(env['PASS_ENV_TEST_TOKEN'], SECRET);
  assert.ok(!Object.keys(env).includes('PASS_ENV_UNLISTED'));
});

test('--clear-pass-env revokes, and a baseline copy of the project still gets the sealed variable', () => {
  const root = fixture('revoked');
  assert.equal(amabie(root, { PASS_ENV_TEST_TOKEN: SECRET }, 'setup', '--yes', '--pass-env', 'PASS_ENV_TEST_TOKEN').code, 0);
  const cfg = readConfig(root);
  assert.ok(cfg && cfg !== 'corrupt');
  const step = cfg.plan[0]!;

  // A throwaway copy has no .amabie of its own (as the baseline worktree); the sealed authority is the project's.
  const copy = path.join(TMP, 'revoked-copy');
  fs.cpSync(root, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}.amabie`) && !src.includes(`${path.sep}.git${path.sep}`) });
  process.env['PASS_ENV_TEST_TOKEN'] = SECRET;
  try {
    assert.equal(runPlanStep(copy, cfg.pm, step, 60_000, root).ok, true, 'authority root supplies the variable');
    assert.equal(runPlanStep(copy, cfg.pm, step, 60_000).ok, false, 'a copy without the project authority gets nothing');
  } finally { delete process.env['PASS_ENV_TEST_TOKEN']; }

  const cleared = amabie(root, { PASS_ENV_TEST_TOKEN: SECRET }, 'setup', '--yes', '--clear-pass-env');
  assert.notEqual(cleared.code, 0, 'with the allowance revoked the check no longer sees the variable');
  assert.deepEqual(sealedPassEnvNames(root), []);
});
