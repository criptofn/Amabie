import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { CLI_ENTRY } from '../src/cli-runtime.js';
import { projectDigest, trustedStart } from '../src/task-boundary.js';

/**
 * The task boundary at Stop. Work an earlier request committed AND that its own Stop let through is not
 * carried into a later request's verdict, and a plain question does not re-run the whole suite for it.
 * Work an earlier request left blocked or unproven IS carried: a clean tree, a commit and a fresh prompt
 * are not acceptance, so the next request is judged from the sealed baseline and cannot move past it.
 */
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-task-boundary-'));
const store = path.join(temporary, 'store');
process.env.AMABIE_TRUST_STORE = store;
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const SOURCE = "module.exports = n => 'hello ' + n;\n";
const FIXED = "module.exports = n => 'hello ' + n.trimStart();\n";
const BOTH = "module.exports = n => 'hello ' + n.trim();\n";
// Every run of the suite in the project itself leaves a line here, so a skipped suite is observable.
const TEST = "const {test} = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');\n"
  + "const dir = path.join(__dirname, '..', '.amabie'); fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'suite-runs.log'), 'x');\n"
  + "const greet = require('../greet.cjs'); test('greet', () => assert.equal(greet('Ada'), 'hello Ada'));\n";
const LEADING = "test('leading whitespace', () => assert.equal(greet('  Ada'), 'hello Ada'));\n";
const TRAILING = "test('trailing whitespace', () => assert.equal(greet('Ada  '), 'hello Ada'));\n";

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AMABIE_TRUST_STORE: store };
  for (const name of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete e[name];
  return e;
}
function cli(root: string, args: string[], input?: unknown) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180_000, env: env(),
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
}
function git(root: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function commit(root: string) { git(root, 'add', '.'); git(root, 'commit', '--allow-empty', '-m', 'fixture'); }
function write(root: string, file: string, text: string) { fs.writeFileSync(path.join(root, file), text); }
function suiteRuns(root: string): number {
  try { return fs.readFileSync(path.join(root, '.amabie', 'suite-runs.log'), 'utf8').length; } catch { return 0; }
}

function project(name: string): string {
  const root = path.join(temporary, name);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  write(root, 'package.json', JSON.stringify({ name, private: true, scripts: { test: 'node --test "tests/*.test.cjs"' } }));
  write(root, 'greet.cjs', SOURCE); write(root, 'tests/greet.test.cjs', TEST);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Amabie Boundary'); git(root, 'config', 'user.email', 'boundary@amabie.local');
  commit(root);
  assert.equal(cli(root, ['setup', '--yes']).status, 0);
  commit(root);
  assert.equal(cli(root, ['setup', '--yes']).status, 0);
  commit(root);
  return root;
}

type Envelope = { decision?: string; reason?: string; systemMessage?: string };
function hook(root: string, session: string, event: string, extra: Record<string, unknown> = {}): Envelope {
  const r = cli(root, ['checkpoint'], { cwd: root, session_id: session, hook_event_name: event, ...extra });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) as Envelope : {};
}
/** A request: the prompt opens it, the task is registered (unless it is a question), and the caller then works. */
function request(root: string, session: string, intent: string | null): void {
  const opened = hook(root, session, 'UserPromptSubmit', { prompt: intent ?? 'a question' });
  assert.notEqual(opened.decision, 'block', opened.reason);
  if (intent !== null) {
    const r = cli(root, ['task', intent, '--kind', 'bugfix', '--session', session]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
}

test('a later request is judged on its own change: the earlier request\'s committed work is not carried into its verdict, and a question does not re-run the suite', () => {
  const root = project('successive');
  const session = 'session-task-boundary-successive';

  // Request 1: a fix with its own regression test. It earns regression evidence and is then committed.
  request(root, session, 'fix leading whitespace in greet');
  write(root, 'greet.cjs', FIXED); write(root, 'tests/leading.test.cjs', TEST + LEADING);
  const first = hook(root, session, 'Stop');
  assert.notEqual(first.decision, 'block', first.reason);
  assert.match(first.systemMessage ?? '', /with a caveat/);
  assert.match(first.systemMessage ?? '', /tests\/leading\.test\.cjs \(created by this session\)/);
  commit(root);

  // Request 2: a source-only change. It is judged from its own start, where request 1's fix and test are
  // already part of the starting tree: it has no evidence of its own.
  request(root, session, 'fix trailing whitespace in greet');
  assert.ok(trustedStart(root, session), 'a request that begins on committed work its own Stop let through has a trusted boundary');
  write(root, 'greet.cjs', BOTH);
  const second = hook(root, session, 'Stop');
  assert.equal(second.decision, 'block', JSON.stringify(second));
  assert.match(second.reason ?? '', /NOT PROVEN/);
  assert.match(second.reason ?? '', /pass on the base commit too/);
  assert.doesNotMatch(second.reason ?? '', /leading\.test\.cjs/);

  // The same request, now with its own test, is proven by that test alone.
  write(root, 'tests/trailing.test.cjs', TEST + TRAILING);
  const third = hook(root, session, 'Stop');
  assert.notEqual(third.decision, 'block', third.reason);
  assert.match(third.systemMessage ?? '', /tests\/trailing\.test\.cjs \(created by this session\)/);
  assert.doesNotMatch(third.systemMessage ?? '', /leading\.test\.cjs/, 'the earlier request\'s check is not part of this request\'s caveat (judged from the sealed baseline, the caveat names it)');
  commit(root);

  // Request 3: a question after committed work. Nothing changed, so the suite is not run at all.
  request(root, session, null);
  const runsBefore = suiteRuns(root);
  const question = hook(root, session, 'Stop');
  assert.notEqual(question.decision, 'block', question.reason);
  assert.match(question.systemMessage ?? '', /changed nothing in the project/);
  assert.equal(suiteRuns(root), runsBefore, 'a request that changed nothing must not re-run the whole suite');

  // doctor still answers for the project as a whole, from the sealed baseline.
  const doctor = cli(root, ['doctor', '--json']);
  assert.ok(doctor.stdout.includes('regression-evidence'), doctor.stdout + doctor.stderr);
});

test('a request that begins with uncommitted work has no trusted boundary and keeps the cumulative view', () => {
  const root = project('dirty-start');
  write(root, 'greet.cjs', FIXED); // earlier request's work, not committed
  request(root, 'session-task-boundary-dirty', 'fix trailing whitespace in greet');
  assert.equal(trustedStart(root, 'session-task-boundary-dirty'), undefined, 'a dirty start cannot be separated from the request\'s own work');
});

test('a question never skips the check of a deleted test: removed coverage stays visible from the sealed baseline', () => {
  const root = project('deleted-test');
  fs.rmSync(path.join(root, 'tests', 'greet.test.cjs'));
  commit(root);
  request(root, 'session-task-boundary-deleted', null);
  const question = hook(root, 'session-task-boundary-deleted', 'Stop');
  assert.doesNotMatch(question.systemMessage ?? '', /changed nothing in the project/, 'the shortcut must not hide a deleted sealed test');
});

test('a new prompt on a clean committed tree does not launder an earlier request\'s blocked test rewrite', () => {
  // The exact sequence Codex reproduced: the first request breaks main() and rewrites its sealed test to
  // assert.ok(true) and commits; Stop correctly blocks. A fresh prompt on the clean tree must not make
  // that commit part of its starting point.
  const root = path.join(temporary, 'launder');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const session = 'session-task-boundary-launder';
  const original = (assertion: string) => `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('main',()=>${assertion});\n`;
  write(root, 'package.json', JSON.stringify({ private: true, scripts: { test: 'node --test *.test.cjs' } }));
  write(root, 'index.cjs', 'exports.main = () => 1;\n');
  write(root, 'original.test.cjs', original("assert.equal(require('./index.cjs').main(),1)"));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Amabie Boundary'); git(root, 'config', 'user.email', 'boundary@amabie.local');
  commit(root);
  assert.equal(cli(root, ['setup', '--yes']).status, 0); commit(root);
  assert.equal(cli(root, ['setup', '--yes']).status, 0); commit(root);

  request(root, session, 'fix main');
  write(root, 'index.cjs', 'exports.main = () => -1;\n');
  write(root, 'original.test.cjs', original('assert.ok(true)'));
  commit(root);
  const first = hook(root, session, 'Stop');
  assert.equal(first.decision, 'block', JSON.stringify(first));

  request(root, session, 'add a helper');
  assert.equal(trustedStart(root, session), undefined, 'work its own Stop did not let through is not a trusted starting point');
  fs.appendFileSync(path.join(root, 'index.cjs'), 'exports.helper = () => 42;\n');
  write(root, 'helper.test.cjs', "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('helper',()=>assert.equal(require('./index.cjs').helper(),42));\n");
  const next = hook(root, session, 'Stop');
  assert.equal(next.decision, 'block', `a later request must not move past an unresolved committed rewrite: ${JSON.stringify(next)}`);
  assert.ok(fs.readFileSync(path.join(root, 'index.cjs'), 'utf8').includes('=> -1'));

  // Not even a question after it passes quietly: nothing was verified, so the suite is not skipped.
  commit(root);
  request(root, session, null);
  const question = hook(root, session, 'Stop');
  assert.doesNotMatch(question.systemMessage ?? '', /changed nothing in the project/);
});

test('a source-only commit its own Stop called NOT PROVEN is not a starting point for the next request', () => {
  const root = project('unproven-commit');
  const session = 'session-task-boundary-unproven';

  request(root, session, 'fix leading whitespace in greet');
  write(root, 'greet.cjs', FIXED); // behaviour changed, no test of its own
  commit(root);
  const first = hook(root, session, 'Stop');
  assert.equal(first.decision, 'block', JSON.stringify(first));
  assert.match(first.reason ?? '', /NOT PROVEN/);

  // A question on the clean committed tree is not a free pass: nothing was verified, so the suite and the
  // regression comparison run again and the unresolved commit is still what Stop reports.
  request(root, session, null);
  assert.equal(trustedStart(root, session), undefined);
  const question = hook(root, session, 'Stop');
  assert.equal(question.decision, 'block', JSON.stringify(question));
  assert.match(question.reason ?? '', /NOT PROVEN/);

  // So is the next change on top of it: judged from the sealed baseline, the earlier commit is still in it.
  request(root, session, 'fix trailing whitespace in greet');
  write(root, 'greet.cjs', BOTH);
  const second = hook(root, session, 'Stop');
  assert.equal(second.decision, 'block', `the unresolved source-only commit stays unresolved: ${JSON.stringify(second)}`);
  assert.match(second.reason ?? '', /NOT PROVEN/);
});

test('a start that its own Stop let through only counts for the content it verified', () => {
  const root = project('verified-then-edited');
  const session = 'session-task-boundary-edited';
  request(root, session, 'fix leading whitespace in greet');
  write(root, 'greet.cjs', FIXED); write(root, 'tests/leading.test.cjs', TEST + LEADING);
  assert.notEqual(hook(root, session, 'Stop').decision, 'block');
  // After the verdict, and before the next prompt, the verified file is rewritten and committed.
  write(root, 'tests/leading.test.cjs', "const {test} = require('node:test'); test('leading whitespace', () => {});\n");
  commit(root);
  request(root, session, 'fix trailing whitespace in greet');
  assert.equal(trustedStart(root, session), undefined, 'content that differs from what was verified is not verified');
});

test('the content digest measures what it can and refuses what it cannot: a directory entry is unmeasured, the execute bit counts', () => {
  const root = path.join(temporary, 'digest-shapes');
  fs.mkdirSync(root, { recursive: true });
  write(root, 'tool.sh', '#!/bin/sh\necho hi\n');
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Amabie Boundary'); git(root, 'config', 'user.email', 'boundary@amabie.local');
  commit(root);
  const base = git(root, 'rev-parse', 'HEAD');
  assert.equal(projectDigest(root, base)?.empty, true);

  write(root, 'tool.sh', '#!/bin/sh\necho changed\n');
  const edited = projectDigest(root, base);
  assert.ok(edited && !edited.empty);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(root, 'tool.sh'), 0o755);
    assert.notEqual(projectDigest(root, base)?.digest, edited.digest, 'the same bytes, now executable, are not the verified file');
  }

  // A nested repository shows up as a directory entry: its contents are not hashed, so nothing is claimed.
  const nested = path.join(root, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  write(nested, 'a.txt', 'one\n');
  git(nested, 'init', '-b', 'main'); git(nested, 'config', 'user.name', 'n'); git(nested, 'config', 'user.email', 'n@amabie.local');
  git(nested, 'add', '.'); git(nested, 'commit', '-m', 'nested');
  assert.equal(projectDigest(root, base), null, 'a changed directory entry yields no digest, so no boundary can advance over it');
});
