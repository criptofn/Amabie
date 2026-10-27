import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { CLI_ENTRY } from '../src/cli-runtime.js';
import { starterPath } from '../src/setup-command.js';

/**
 * A project with no check at all gets a way to start — a real typecheck or one first smoke test for its
 * stack — and never a generated test, which could not fail and so would be a false proof.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-starter-'));
process.env.AMABIE_TRUST_STORE = path.join(TMP, 'store');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('the starter path names a typecheck for TypeScript, a first test for plain Node and Python, and never writes one', () => {
  const ts = fs.mkdtempSync(path.join(TMP, 'ts-'));
  fs.writeFileSync(path.join(ts, 'tsconfig.json'), '{}');
  assert.match(starterPath(ts, ['node']), /"typecheck": "tsc --noEmit"/);

  const plain = fs.mkdtempSync(path.join(TMP, 'plain-'));
  assert.match(starterPath(plain, ['node']), /"test": "node --test"/);
  assert.match(starterPath(plain, ['python']), /unittest or pytest/);
  assert.match(starterPath(plain, []), /build or typecheck command your stack already has/);
  for (const text of [starterPath(ts, ['node']), starterPath(plain, ['node', 'python'])]) {
    assert.match(text, /does not generate tests/);
  }
});

test('setup in a Node project with no scripts is refused with that path and creates nothing', () => {
  const root = path.join(TMP, 'empty');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'empty', private: true }));
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-m', 'x']]) {
    assert.equal(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).status, 0);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  const r = spawnSync(process.execPath, [CLI_ENTRY, 'setup', '--yes'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, env });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2, out);
  assert.match(out, /NEEDS ATTENTION/);
  assert.match(out, /add a "test" script to package\.json/);
  assert.match(out, /then run: amabie setup/);
  assert.ok(!fs.existsSync(path.join(root, 'tests')), 'no test file was generated');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts, undefined, 'package.json was not edited');
});
