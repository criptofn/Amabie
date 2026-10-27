import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { CLI_ENTRY } from '../src/cli-runtime.js';

/**
 * A failed check is run again, a bounded number of times, to tell a reproducible failure from an
 * unstable one. The fixture is deterministic: the check consumes one line per run from a sequence file
 * kept outside the repository ("pass" or "fail"), so exactly which run fails is decided by the test.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-flaky-'));
process.env.AMABIE_TRUST_STORE = path.join(TMP, 'store');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function git(root: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}
/** A human terminal: the agent markers are not set. */
function amabie(root: string, input: string | undefined, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd: root, input, encoding: 'utf8', windowsHide: true, timeout: 120_000, env });
}

let count = 0;
/** A set-up project whose only check follows the runs listed in `sequence` (once it is empty it passes). */
function fixture(): { root: string; sequence: (runs: string[]) => void; left: () => string[] } {
  const root = path.join(TMP, `p${count++}`);
  const seq = path.join(TMP, `seq${count}.txt`);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'flaky', private: true, scripts: { test: 'node --test tests/seq.test.cjs' } }));
  fs.writeFileSync(path.join(root, 'tests/seq.test.cjs'), [
    "const fs = require('node:fs'); const assert = require('node:assert/strict'); const { test } = require('node:test');",
    `const file = ${JSON.stringify(seq)};`,
    "test('follows the sequence', () => {",
    "  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean) : [];",
    "  const next = lines.shift() ?? 'pass'; fs.writeFileSync(file, lines.join('\\n'));",
    "  assert.equal(next, 'pass');",
    '});', '',
  ].join('\n'));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Amabie Regression'); git(root, 'config', 'user.email', 'regression@amabie.local');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  const setup = amabie(root, undefined, 'setup', '--yes');
  assert.equal(setup.status, 0, `${setup.stdout}${setup.stderr}`);
  return {
    root,
    sequence: (runs) => fs.writeFileSync(seq, runs.join('\n')),
    left: () => (fs.existsSync(seq) ? fs.readFileSync(seq, 'utf8').split('\n').filter(Boolean) : []),
  };
}
function stopHook(root: string): { decision?: string; reason?: string; systemMessage?: string } {
  const r = amabie(root, JSON.stringify({ cwd: root, stop_hook_active: false, hook_event_name: 'Stop' }), 'checkpoint');
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

test('a check that fails and then passes is reported as unstable and stays a block, never a pass', () => {
  const p = fixture();
  p.sequence(['fail', 'pass', 'pass']);
  const out = stopHook(p.root);
  assert.equal(out.decision, 'block', 'a later pass does not turn the failure into a pass');
  assert.match(out.reason ?? '', /UNSTABLE, not passing/);
  assert.match(out.reason ?? '', /passed 1 of 2 runs/);
  assert.deepEqual(p.left(), ['pass'], 'it stopped repeating as soon as the question was answered');
});

test('a reproducible failure is repeated a bounded number of times and is reported as before', () => {
  const p = fixture();
  p.sequence(['fail', 'fail', 'fail', 'fail', 'fail']);
  const out = stopHook(p.root);
  assert.equal(out.decision, 'block');
  assert.doesNotMatch(out.reason ?? '', /UNSTABLE/, 'a deterministic failure is not renamed');
  assert.deepEqual(p.left(), ['fail', 'fail'], 'three runs in all: the first and two repeats, no more');
});

test('a passing check is run once', () => {
  const p = fixture();
  p.sequence(['pass', 'fail', 'fail']);
  const out = stopHook(p.root);
  assert.notEqual(out.decision, 'block');
  assert.deepEqual(p.left(), ['fail', 'fail'], 'no repeat after a pass');
});
