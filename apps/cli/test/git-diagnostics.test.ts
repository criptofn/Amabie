import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { gitCommand, type GitResult } from '../src/onboarding.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-git-diagnostics-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const repo = path.resolve(import.meta.dirname, '../../../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');

function metadata(result: GitResult): void {
  const observed = result as GitResult & { pid?: number; signal?: string | null; durationMs?: number };
  assert.equal(observed.signal, null, 'ordinary exits retain their null signal');
  assert.ok(Number.isInteger(observed.pid) && observed.pid! > 0, 'retain the actual spawned Git PID');
  assert.ok(Number.isFinite(observed.durationMs) && observed.durationMs! >= 0, 'retain measured invocation duration');
}

test('git diagnostics preserve real successful and unsuccessful exit metadata', () => {
  const success = gitCommand(tmp, ['--version']);
  assert.ok(success);
  assert.equal(success.status, 0);
  metadata(success);
  assert.equal(gitCommand(tmp, ['init', '-b', 'main'])?.status, 0);
  const failure = gitCommand(tmp, ['rev-parse', '--verify', 'HEAD']);
  assert.ok(failure);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Needed a single revision/);
  metadata(failure);
});

test('git diagnostics preserve an actual spawn failure separately from stderr', () => {
  const failure = gitCommand(path.join(tmp, 'missing-cwd'), ['--version']);
  assert.ok(failure);
  assert.equal(failure.status, null);
  assert.equal((failure as GitResult & { errorCode?: string }).errorCode, 'ENOENT');
  assert.equal((failure.error as NodeJS.ErrnoException).code, 'ENOENT');
  assert.ok(Number.isFinite((failure as GitResult & { durationMs?: number }).durationMs));
});

for (const partial of [false, true]) test(`failed isolate retains Git diagnostics without registration or repair (partial worktree: ${partial})`, () => {
  const root = path.join(tmp, partial ? 'partial-worktree' : 'blocked-worktrees');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'git-diagnostics-fixture', private: true,
    scripts: { test: `node "${path.join(repo, 'tooling/test-support/fixtures/f-pass.js')}"` },
  }));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    const result = gitCommand(root, args);
    assert.equal(result?.status, 0, result?.stderr);
  }
  const head = gitCommand(root, ['rev-parse', 'HEAD'])!.stdout;
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, root], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, AMABIE_TRUST_STORE: path.join(tmp, 'trust') },
  });
  const setup = run(['setup', '--yes']);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const obstruction = path.join(root, partial ? '.git/hooks/post-checkout' : '.git/worktrees');
  const obstructionBytes = partial
    ? fs.readFileSync(path.join(repo, 'tooling/test-support/fixtures/git-post-checkout-fail.sh'))
    : Buffer.from('deliberate fixture obstruction\n');
  fs.writeFileSync(obstruction, obstructionBytes, { mode: 0o755 });
  const result = run(['isolate', 'blocked']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /git worktree add failed — nothing was registered/);
  const record = (prefix: string): Record<string, unknown> => {
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith(prefix));
    assert.ok(line, `retain ${prefix} even when Git has written stderr:\n${result.stdout}`);
    return JSON.parse(line.slice(prefix.length));
  };
  const outcome = record('  git result: ');
  assert.notEqual(outcome.status, 0);
  if (partial) assert.equal(outcome.status, 1, 'the real checkout hook deliberately returns one after creating the worktree');
  assert.equal(outcome.signal, null);
  assert.ok(Number.isInteger(outcome.pid) && Number(outcome.pid) > 0);
  assert.ok(Number(outcome.durationMs) >= 0);
  assert.equal(outcome.errorCode, null);
  assert.equal(outcome.errorMessage, null);
  const state = record('  git failure state: ');
  assert.equal(state.targetExists, partial);
  assert.equal(state.targetListed, partial ? true : null, 'unresolvable filesystem identity is unknown, not proof of absence');
  assert.equal(state.worktreeListStatus, 0);
  assert.equal(state.worktreeCount, partial ? 2 : 1);
  assert.equal(state.indexLockQueryStatus, 0);
  assert.equal(state.indexLockExists, false);
  assert.ok(!fs.existsSync(path.join(root, '.amabie/candidates/blocked.json')));
  assert.deepEqual(fs.readFileSync(obstruction), obstructionBytes);
  assert.equal(gitCommand(root, ['rev-parse', 'HEAD'])!.stdout, head);
});
