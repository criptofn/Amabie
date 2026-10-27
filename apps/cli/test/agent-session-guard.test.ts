import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { CLI_ENTRY } from '../src/cli-runtime.js';
import { writeConfig } from '../src/local-config.js';
import { readClaudeTurnState } from '../src/task-state.js';
import { agentToolProblem, isReadOnlyCommand, isTaskRegistration } from '../src/agent-session-guard.js';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-session-guard-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function cli(root: string, args: string[], input?: unknown, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, AMABIE_TRUST_STORE: path.join(temporary, 'store'), ...environment },
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
}

function hook(root: string, session: string, event: string, toolName?: string, toolInput?: unknown) {
  const result = cli(root, ['checkpoint'], {
    cwd: root, session_id: session, hook_event_name: event,
    ...(toolName === undefined ? {} : { tool_name: toolName, tool_input: toolInput }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function fixture(name: string, registered = true) {
  const root = path.join(temporary, name);
  const session = `session-${name}`;
  fs.mkdirSync(root);
  const initialized = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'node --test' } }));
  writeConfig(root, {
    version: '2.0.0', installedAt: new Date().toISOString(), pm: 'npm',
    cliPath: CLI_ENTRY, hookCommand: 'amabie checkpoint', hookCommands: ['amabie checkpoint'], touched: [],
    plan: [{ kind: 'tests', script: 'test' }],
  });
  hook(root, session, 'UserPromptSubmit');
  if (registered) {
    const intent = 'implement a normal project change';
    const result = cli(root, ['task', intent]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    hook(root, session, 'PostToolUse', 'mcp__amabie__amabie_task', { intent, requirements: [] });
    assert.ok(readClaudeTurnState(root, session)?.task, 'fixture must have a registered current task');
  }
  return { root, session };
}

function denied(output: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null, description: string): void {
  assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny', `${description} must be denied`);
  const reason = output?.hookSpecificOutput?.permissionDecisionReason ?? '';
  assert.match(reason, /operator|authority|protected|human|session|reseal/i);
  assert.doesNotMatch(reason, /registration is missing/i, 'this must be an authority guard, not a missing-task denial');
}

test('registered agents cannot reseal, bind, accept or uninstall their own verification', () => {
  const { root, session } = fixture('operator-commands');
  for (const command of [
    'amabie setup --yes',
    'amabie bind test --requirement "the change works" --reseal',
    'amabie accept candidate',
    'amabie uninstall',
    'canary setup --yes',
    'npx amabie-cli setup --yes',
    `node "${CLI_ENTRY}" setup --yes`,
  ]) denied(hook(root, session, 'PreToolUse', 'Bash', { command }), command);
  assert.equal(hook(root, session, 'PreToolUse', 'Bash', { command: 'npm test' }), null);
  assert.equal(hook(root, session, 'PreToolUse', 'Bash', { command: 'echo "amabie setup is an operator action"' }), null,
    'mentioning an operator command is not executing it');
});

test('registered agents cannot rewrite or remove verifier state and hook configuration', () => {
  const { root, session } = fixture('protected-paths');
  for (const relative of ['.amabie/amabie.local.json', '.amabie/task/current.json', '.claude/settings.json', '.codex/hooks.json', '.mcp.json']) {
    denied(hook(root, session, 'PreToolUse', 'Write', { file_path: path.join(root, relative), content: '{}' }), relative);
  }
  for (const [tool, input] of [
    ['Edit', { file_path: path.join(root, '.amabie/amabie.local.json'), old_string: '{}', new_string: '{}' }],
    ['MultiEdit', { file_path: path.join(root, '.claude/settings.json'), edits: [] }],
    ['NotebookEdit', { notebook_path: path.join(root, '.amabie/state.ipynb'), new_source: '' }],
  ] as const) denied(hook(root, session, 'PreToolUse', tool, input), tool);
  for (const [tool, command] of [
    ['Bash', 'rm -rf .amabie'],
    ['Bash', 'git checkout -- .claude/settings.json'],
    ['Bash', "printf '{}' > .mcp.json"],
    ['PowerShell', 'Remove-Item -Recurse .amabie'],
    ['PowerShell', "Set-Content .codex/hooks.json '{}'"],
  ] as const) denied(hook(root, session, 'PreToolUse', tool, { command }), command);
  assert.equal(hook(root, session, 'PreToolUse', 'Write', { file_path: path.join(root, 'src/feature.ts'), content: 'export const value = 1;' }), null);
});

test('an unapproved MCP server has an exact CLI registration fallback for the current request', () => {
  const { root, session } = fixture('cli-registration', false);
  const intent = 'document amabie setup and bind usage';
  const requirement = 'leading whitespace is ignored';
  const command = `amabie task "${intent}" --requirement "${requirement}" --session "${session}"`;
  const before = hook(root, session, 'PreToolUse', 'Write', { file_path: path.join(root, 'greeting.js'), content: '' });
  assert.equal(before?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(before.hookSpecificOutput.permissionDecisionReason, /--session|approve.*MCP|MCP.*approv/i,
    'the denial must explain a usable recovery path');
  assert.equal(hook(root, session, 'PreToolUse', 'Bash', { command }), null,
    'registration must remain reachable while project MCP approval is pending');
  assert.equal(hook(root, session, 'PreToolUse', 'Bash', {
    command: `node "${CLI_ENTRY}" task "${intent}" --requirement "${requirement}" --session "${session}"`,
  }), null, 'the installed CLI path can register without a globally installed command');
  assert.equal(hook(root, session, 'PreToolUse', 'PowerShell', { command }), null);
  const registration = cli(root, ['task', intent, '--requirement', requirement, '--session', session]);
  assert.equal(registration.status, 0, registration.stdout + registration.stderr);
  const state = readClaudeTurnState(root, session);
  assert.equal(state?.registeredPromptId, state?.promptId);
  assert.equal(state?.task?.requirementCount, 1);
  assert.equal(hook(root, session, 'PreToolUse', 'Write', { file_path: path.join(root, 'greeting.js'), content: '' }), null);
  hook(root, session, 'UserPromptSubmit');
  const next = hook(root, session, 'PreToolUse', 'Write', { file_path: path.join(root, 'greeting.js'), content: '' });
  assert.equal(next?.hookSpecificOutput?.permissionDecision, 'deny', 'registration must not carry over to a new request');
});

test('CLI registration fallback cannot authorize chained or redirected shell commands', () => {
  const { root, session } = fixture('fallback-command-shape', false);
  const command = `amabie task "fix the greeting" --session "${session}"`;
  for (const unsafe of [`${command}; npm test`, `${command} && git status`, `${command} > .mcp.json`]) {
    const output = hook(root, session, 'PreToolUse', 'Bash', { command: unsafe });
    assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny', unsafe);
  }
  assert.equal(readClaudeTurnState(root, session)?.registeredPromptId, null);
});

test('CLI fallback is idempotent but cannot replace a registered task within the same prompt', () => {
  const { root, session } = fixture('fallback-task-replacement');
  const original = readClaudeTurnState(root, session);
  const repeated = cli(root, ['task', 'implement a normal project change', '--session', session]);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  const changed = cli(root, ['task', 'do less work', '--session', session]);
  assert.equal(changed.status, 2, changed.stdout + changed.stderr);
  assert.deepEqual(readClaudeTurnState(root, session), original, 'refusal must preserve the registered task snapshot');
});

test('direct agent CLI cannot reseal even when it bypasses the PreToolUse hook', () => {
  const { root, session } = fixture('direct-agent-cli');
  const config = path.join(root, '.amabie/amabie.local.json');
  const before = fs.readFileSync(config);
  const originalTask = readClaudeTurnState(root, session);
  const result = cli(root, ['setup', '--yes'], undefined, { CLAUDECODE: '1' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /operator|human|agent/i);
  assert.deepEqual(fs.readFileSync(config), before, 'refused setup cannot reseal or rewrite local config');
  assert.deepEqual(readClaudeTurnState(root, session), originalTask);
  assert.equal(fs.existsSync(path.join(root, '.claude/settings.json')), false, 'refused setup must not install new hooks');
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false, 'refused setup must not register a new server');
});

test('authority guards cover MCP filesystem writes, aliases and chained commands without blocking quoted prose', () => {
  const { root } = fixture('guard-edge-cases');
  assert.ok(agentToolProblem(root, 'mcp__filesystem__write_file', { path: path.join(root, '.mcp.json') }));
  fs.symlinkSync(path.join(root, '.amabie'), path.join(root, 'state-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(agentToolProblem(root, 'Write', { file_path: path.join(root, 'state-alias/amabie.local.json') }));
  assert.ok(agentToolProblem(root, 'Bash', { command: 'git status && amabie setup --yes' }));
  assert.equal(agentToolProblem(root, 'Bash', { command: 'echo "amabie setup; is an operator action"' }), null);
  assert.equal(agentToolProblem(root, 'Bash', { command: 'cat .amabie/amabie.local.json' }), null);
  assert.equal(isTaskRegistration('amabie task "literal ; criterion" --session abc', 'abc'), true);
  assert.equal(isTaskRegistration('amabie task "test" --session abc && npm test', 'abc'), false);
  assert.equal(isTaskRegistration('npm run arbitrary -- amabie task "x" --session abc', 'abc'), false);
  assert.equal(isTaskRegistration('npx --package evil amabie task "x" --session abc', 'abc'), false);
  assert.ok(agentToolProblem(root, 'Write', { file_path: path.join(root, 'state-alias/new-parent/file.json') }));
  assert.equal(agentToolProblem(root, 'Bash', { command: 'echo ".mcp.json"' }), null);
  assert.equal(agentToolProblem(root, 'Bash', { command: 'printf "%s" ".amabie"' }), null);
  assert.ok(agentToolProblem(root, 'Bash', { command: 'echo "{}" > .mcp.json' }));
});

test('a pure question may read the project before a task exists, and nothing that could write', () => {
  const { root, session } = fixture('pure-question', false);
  for (const command of ['ls', 'ls -la src', 'cat package.json', 'head -n 20 README.md', 'git log --oneline -5', 'git diff HEAD~1', 'git status', 'Get-Content package.json', 'Get-ChildItem -Recurse src']) {
    assert.equal(hook(root, session, 'PreToolUse', command.startsWith('Get-') ? 'PowerShell' : 'Bash', { command }), null, `${command} is a read`);
    assert.equal(isReadOnlyCommand(command), true, command);
  }
  for (const command of [
    'ls > out.txt', 'cat package.json | sh', 'ls; rm -rf .', 'ls && npm test', 'cat $(touch x)', 'cat `touch x`', 'ls\ntouch x',
    'git log --output=evil.txt', 'git diff --ext-diff', 'git show --textconv HEAD', 'git branch -D main', 'git checkout .', 'git -c core.pager=sh log',
    'find . -delete', 'find . -exec rm {} ;', 'sed -i s/a/b/ package.json', 'tee file', 'node -e 1', 'python -c 1', 'npm test', 'echo hi > x',
    './cat package.json', '/tmp/evil/cat package.json', 'cat (Remove-Item x)', 'Get-Content {Remove-Item x}', 'ls "unterminated',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, `${command} is not a pure read`);
    const output = hook(root, session, 'PreToolUse', 'Bash', { command });
    assert.equal(output?.hookSpecificOutput?.permissionDecision, 'deny', `${command} stays blocked until a task is registered`);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /registration is missing/i);
  }
  // Writing tools are unchanged: reading is the only thing that became possible.
  const edit = hook(root, session, 'PreToolUse', 'Write', { file_path: path.join(root, 'a.txt'), content: 'x' });
  assert.equal(edit?.hookSpecificOutput?.permissionDecision, 'deny');
});
