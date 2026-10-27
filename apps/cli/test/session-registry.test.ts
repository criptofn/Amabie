import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { operatorSessionProblem } from '../src/agent-session-guard.js';
import { CLI_ENTRY } from '../src/cli-runtime.js';
import { writeConfig } from '../src/local-config.js';
import { readSessionRegistry } from '../src/session-registry.js';
import { projectIdForRoot } from '../src/trust-store.js';

/**
 * The session-deletion bypass: a session removed `.amabie` (with Python, not a shell the hook guard
 * reads), unset the agent environment markers and ran `amabie setup --yes`, which resealed the tree
 * it had just edited as READY. The open session is also recorded in the user trust store.
 */
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-session-registry-'));
const store = path.join(temporary, 'store');
process.env.AMABIE_TRUST_STORE = store;
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

/** A human terminal: no agent markers, no TTY (spawnSync pipes), the isolated trust store. */
function humanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AMABIE_TRUST_STORE: store };
  for (const name of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  return env;
}
function cli(root: string, args: string[], input?: unknown) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: humanEnv(),
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
}
function hook(root: string, session: string, event: string, extra: Record<string, unknown> = {}) {
  const result = cli(root, ['checkpoint'], { cwd: root, session_id: session, hook_event_name: event, ...extra });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : null;
}
function project(name: string) {
  const root = path.join(temporary, name);
  fs.mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'node --test' } }));
  writeConfig(root, {
    version: '2.0.0', installedAt: new Date().toISOString(), pm: 'npm',
    cliPath: CLI_ENTRY, hookCommand: 'amabie checkpoint', hookCommands: ['amabie checkpoint'], touched: [],
    plan: [{ kind: 'tests', script: 'test' }],
  });
  return { root, session: `session-${name}` };
}
/** `operatorSessionProblem` as a human terminal would see it (markers unset, no TTY). */
async function operatorProblem(root: string): Promise<string | null> {
  const saved = { ...process.env };
  for (const name of ['CLAUDECODE', 'AI_AGENT']) delete process.env[name];
  try { return await operatorSessionProblem(root, 'setup'); } finally { Object.assign(process.env, saved); }
}

test('deleting .amabie and unsetting the agent markers does not make setup look like a human with no session', async () => {
  const { root, session } = project('delete-and-reseal');
  hook(root, session, 'UserPromptSubmit');
  fs.rmSync(path.join(root, '.amabie'), { recursive: true, force: true }); // the shutil.rmtree step
  const setup = cli(root, ['setup', '--yes']);
  assert.notEqual(setup.status, 0, setup.stdout + setup.stderr);
  assert.match(setup.stdout + setup.stderr, /agent session is open/i);
  assert.equal(fs.existsSync(path.join(root, '.amabie', 'amabie.local.json')), false, 'a refused setup must not recreate the authority');
  assert.match(await operatorProblem(root) ?? '', /agent session is open/i);
});

test('a project that never had an agent session is not blocked by the registry', async () => {
  const { root } = project('no-session');
  assert.deepEqual(readSessionRegistry(root), { state: 'none' });
  assert.equal(await operatorProblem(root), null);
});

test('the normal lifecycle: UserPromptSubmit opens the session, SessionEnd clears it, operator actions are allowed again', async () => {
  const { root, session } = project('lifecycle');
  const other = 'session-lifecycle-other';
  hook(root, session, 'UserPromptSubmit');
  hook(root, other, 'UserPromptSubmit');
  assert.equal(readSessionRegistry(root).state, 'active');
  hook(root, session, 'SessionEnd');
  assert.equal(readSessionRegistry(root).state, 'active', 'another session is still open');
  assert.match(await operatorProblem(root) ?? '', /agent session is open/i);
  hook(root, other, 'SessionEnd');
  assert.deepEqual(readSessionRegistry(root), { state: 'none' });
  assert.equal(await operatorProblem(root), null);
});

test('the registry is bound to the project: another repository is unaffected', async () => {
  const a = project('bound-a');
  const b = project('bound-b');
  hook(a.root, a.session, 'UserPromptSubmit');
  assert.match(await operatorProblem(a.root) ?? '', /agent session is open/i);
  assert.equal(await operatorProblem(b.root), null);
});

test('a damaged session record refuses operator actions instead of reading as "no session"', async () => {
  const { root, session } = project('damaged-record');
  hook(root, session, 'UserPromptSubmit');
  const record = path.join(store, 'records', projectIdForRoot(root), 'agent-sessions.json');
  assert.ok(fs.existsSync(record), 'the session record is in the user trust store, not in the repository');
  fs.writeFileSync(record, '{"not":"a sealed record"}');
  const problem = await operatorProblem(root);
  assert.match(problem ?? '', /could not inspect its record of open agent sessions/i);
  assert.equal(readSessionRegistry(root).state, 'unreadable');
});

test('the session record lives outside the repository', () => {
  const { root, session } = project('outside-repo');
  hook(root, session, 'UserPromptSubmit');
  const inRepo = fs.readdirSync(root, { recursive: true }).map(String).filter((entry) => /agent-sessions/.test(entry));
  assert.deepEqual(inRepo, []);
  assert.ok(fs.existsSync(path.join(store, 'records', projectIdForRoot(root), 'agent-sessions.json')));
});

test('Stop blocks when the open session has lost its .amabie configuration', () => {
  const { root, session } = project('stop-missing-config');
  hook(root, session, 'UserPromptSubmit');
  fs.rmSync(path.join(root, '.amabie'), { recursive: true, force: true });
  const stop = hook(root, session, 'Stop');
  assert.equal(stop?.decision, 'block');
  assert.match(String(stop?.reason), /configuration is missing/);
  const again = hook(root, session, 'Stop', { stop_hook_active: true });
  assert.equal(again?.decision, undefined, 'no loop: one repair turn, then an honest stop');
  assert.match(String(again?.systemMessage), /UNVERIFIED, not a pass/);
});

test('Stop blocks when the open session has lost its request tracking', () => {
  const { root, session } = project('stop-missing-turn');
  hook(root, session, 'UserPromptSubmit');
  fs.rmSync(path.join(root, '.amabie', 'task'), { recursive: true, force: true });
  const stop = hook(root, session, 'Stop');
  assert.equal(stop?.decision, 'block');
  assert.match(String(stop?.reason), /no tracking record/);
});

test('Stop stays out of the way for a project that was never wired and has no registered session', () => {
  const root = path.join(temporary, 'unwired');
  fs.mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true }).status, 0);
  assert.equal(hook(root, 'session-unwired', 'Stop'), null);
});

test('Stop after a legitimate SessionEnd is not blocked by the earlier registration', () => {
  const { root, session } = project('stop-after-end');
  hook(root, session, 'UserPromptSubmit');
  hook(root, session, 'SessionEnd');
  fs.rmSync(path.join(root, '.amabie'), { recursive: true, force: true });
  assert.equal(hook(root, session, 'Stop'), null);
});
