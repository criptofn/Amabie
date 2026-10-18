import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import {
  buildCorrectionAgentEnvironment,
  buildCorrectionAgentInvocation,
  evaluateClaudeCodeVersion,
  renderCorrectionAgentPrompt,
} from '../src/prompt-evidence-agents.js';

test('Codex resolves the native executable or npm shim and uses the shared stdin process contract', () => {
  const root = path.resolve('sample-project');
  const invocation = buildCorrectionAgentInvocation('codex', root);

  assert.equal(invocation.executable, 'codex');
  assert.deepEqual(invocation.args, [
    'exec', '--ephemeral', '--ignore-user-config', '-c', 'approval_policy=never', '--sandbox', 'workspace-write',
    '--color', 'never', '-C', root, '-',
  ]);
  assert.ok(!invocation.args.includes('--approve-for-me'));
  assert.ok(!invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('Claude Code uses the shared stdin contract with bounded turns and restricted tools', () => {
  const invocation = buildCorrectionAgentInvocation('claude', path.resolve('sample-project'));

  assert.equal(invocation.executable, 'claude');
  assert.deepEqual(invocation.args, [
    '--print', '--input-format', 'text', '--output-format', 'text', '--no-session-persistence', '--restricted',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--tools', 'Read,Edit,Write,Glob,Grep', '--strict-mcp-config', '--disallowedTools', 'mcp__*',
  ]);
});

test('Claude Code turn bound uses the documented environment setting and cannot be overridden by the caller', () => {
  const environment = buildCorrectionAgentEnvironment({ CLAUDE_CODE_MAX_TURNS: '99' }, 'claude');
  const invocation = buildCorrectionAgentInvocation('claude', path.resolve('sample-project'));

  assert.equal(environment.CLAUDE_CODE_MAX_TURNS, '6');
  assert.equal(invocation.args.includes('--max-turns'), false);
});

test('Claude Code preflight accepts the required minimum version and rejects older or unparseable output', () => {
  assert.deepEqual(evaluateClaudeCodeVersion('2.1.247 (Claude Code)'), {
    version: '2.1.247',
    supported: false,
    minimumVersion: '2.1.248',
  });
  assert.deepEqual(evaluateClaudeCodeVersion('Claude Code v2.1.248'), {
    version: '2.1.248',
    supported: true,
    minimumVersion: '2.1.248',
  });
  assert.deepEqual(evaluateClaudeCodeVersion('2.2.0 (Claude Code)'), {
    version: '2.2.0',
    supported: true,
    minimumVersion: '2.1.248',
  });
  assert.equal(evaluateClaudeCodeVersion('Claude Code version unavailable'), null);
});

test('built-in CLI environments keep executable and saved-login paths, not provider keys', () => {
  const environment = buildCorrectionAgentEnvironment({
    PATH: 'C:\\tools', USERPROFILE: 'C:\\Users\\test', HOME: 'C:\\Users\\test',
    APPDATA: 'C:\\Users\\test\\AppData\\Roaming', CODEX_HOME: 'C:\\Users\\test\\.codex',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\test\\.claude', TEMP: 'C:\\temp',
    OPENAI_API_KEY: 'must-not-pass', CODEX_API_KEY: 'must-not-pass',
    ANTHROPIC_API_KEY: 'must-not-pass', ANTHROPIC_AUTH_TOKEN: 'must-not-pass',
    CLAUDE_CODE_OAUTH_TOKEN: 'must-not-pass', AWS_SECRET_ACCESS_KEY: 'must-not-pass',
    ANTHROPIC_BASE_URL: 'https://billing-proxy.invalid',
  }, 'codex');

  assert.equal(environment.PATH, 'C:\\tools');
  assert.equal(environment.USERPROFILE, 'C:\\Users\\test');
  assert.equal(environment.CODEX_HOME, 'C:\\Users\\test\\.codex');
  assert.equal(environment.CLAUDE_CONFIG_DIR, 'C:\\Users\\test\\.claude');
  for (const key of [
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_BASE_URL',
  ]) assert.equal(environment[key], undefined, `${key} must not be inherited by a built-in agent profile`);
});

test('both built-in profiles use the same bounded stdin contract through local CLI shims', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amabie agent's profile shim-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const shimDirectory = path.join(tempRoot, 'bin');
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(shimDirectory);
  fs.mkdirSync(projectRoot);
  const shimSource = path.join(shimDirectory, 'fake-cli.cjs');
  fs.writeFileSync(shimSource, [
    "const fs = require('node:fs');",
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8'), cwd: process.cwd(), apiKeyPresent: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) }));",
  ].join('\n'));

  const quoteForPosixShell = (value: string) => "'" + value.replace(/'/g, String.raw`'\''`) + "'";
  for (const agent of ['codex', 'claude'] as const) {
    const executablePath = path.join(shimDirectory, process.platform === 'win32' ? `${agent}.cmd` : agent);
    const shimCommand = process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0fake-cli.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`
      : `#!/bin/sh\nexec ${quoteForPosixShell(process.execPath)} ${quoteForPosixShell(shimSource)} "$@"\n`;
    fs.writeFileSync(executablePath, shimCommand);
    if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o700);

    const invocation = buildCorrectionAgentInvocation(agent, projectRoot);
    const request = JSON.stringify({ schema: 'amabie-correction-request/1', cycle: 1 });
    const shimOnlyEnvironment: NodeJS.ProcessEnv = {
      PATH: shimDirectory,
      ...(process.platform === 'win32' ? {
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT,
        COMSPEC: process.env.ComSpec ?? process.env.COMSPEC,
      } : {}),
      OPENAI_API_KEY: 'must-not-pass',
      ANTHROPIC_API_KEY: 'must-not-pass',
    };
    const env = buildCorrectionAgentEnvironment(shimOnlyEnvironment, agent);
    assert.equal(env.PATH, shimDirectory, 'the isolated shim path must not fall back to an installed provider CLI');
    const result = crossSpawn.sync(invocation.executable, invocation.args, {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      input: request,
      timeout: 5_000,
      windowsHide: true,
    });

    assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, stderr: result.stderr, stdout: result.stdout }));
    const received = JSON.parse(result.stdout) as { args: string[]; input: string; cwd: string; apiKeyPresent: boolean };
    assert.deepEqual(received.args, invocation.args);
    assert.equal(received.input, request);
    assert.equal(received.cwd, projectRoot);
    assert.equal(received.apiKeyPresent, false);
  }
});

test('shared agent prompt carries structured evidence but never converts an agent claim to proof', () => {
  const request = JSON.stringify({ schema: 'amabie-correction-request/1', cycle: 1, report: { unresolved: [{ status: 'unmet' }] } });
  const prompt = renderCorrectionAgentPrompt(request);

  assert.match(prompt, /Inspect the project and apply a minimal code change/u);
  assert.match(prompt, /Do not return only a plan or explanation/u);
  assert.match(prompt, /Make only a focused change/u);
  assert.match(prompt, /Do not claim that checks passed/u);
  assert.match(prompt, /Amabie will rerun the complete sealed verification/u);
  assert.ok(prompt.endsWith(request));
});

test('unknown built-in coding agents are rejected', () => {
  assert.throws(() => buildCorrectionAgentInvocation('gemini' as never, process.cwd()), /unsupported correction agent/u);
});
