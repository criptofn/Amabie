import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const harness = path.resolve('tooling/test-support/prompt-evidence-complex-codex-e2e.mjs');
const liveHarness = path.resolve('tooling/test-support/prompt-evidence-provider-agent-e2e.mjs');

function run(args, { allowCodexUsage = false, allowClaudeUsage = false } = {}) {
  const env = { ...process.env };
  delete env.AMABIE_ALLOW_CODEX_PROVIDER_USAGE;
  delete env.AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE;
  if (allowCodexUsage) env.AMABIE_ALLOW_CODEX_PROVIDER_USAGE = '1';
  if (allowClaudeUsage) env.AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE = '1';
  return spawnSync(process.execPath, [harness, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
}

function runLiveProvider(agent) {
  const env = { ...process.env };
  delete env.AMABIE_ALLOW_CODEX_PROVIDER_USAGE;
  delete env.AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE;
  return spawnSync(process.execPath, [liveHarness, agent], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
}

test('complex correction harness rejects unsupported provider names before opening a project', () => {
  const result = run(['correct', path.join(os.tmpdir(), 'not-a-scenario'), '--agent', 'gemini']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--agent must be codex or claude/u);
});

test('fixture correction mode validates its own scratch-project boundary before opening a project', () => {
  const result = run(['correct-fixture', path.join(os.tmpdir(), 'not-a-scenario')]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /correction mode accepts only this harness own disposable temp directory/u);
  assert.doesNotMatch(result.stderr, /Starting (?:codex|claude)|Fixture corrector applied/u);
});

test('complex Claude correction is blocked before project access unless usage is explicitly enabled', () => {
  const result = run(['correct', path.join(os.tmpdir(), 'not-a-scenario'), '--agent', 'claude']);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /Claude usage is not started/u);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /Starting (?:claude|codex)|Correction \d/iu);
});

test('complex Codex correction is blocked before project access unless usage is explicitly enabled', () => {
  const result = run(['correct', path.join(os.tmpdir(), 'not-a-scenario')]);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /Codex usage is not started/u);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /Starting (?:claude|codex)|Correction \d/iu);
});

test('explicit Codex usage opt-in reaches ordinary scenario validation without starting a provider', () => {
  const result = run(
    ['correct', path.join(os.tmpdir(), 'not-a-scenario')],
    { allowCodexUsage: true },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only this harness own disposable temp directory/u);
  assert.doesNotMatch(result.stderr, /Claude usage is not started/u);
  assert.doesNotMatch(result.stderr, /Codex usage is not started/u);
  assert.doesNotMatch(result.stderr, /Starting claude|Correction \d/iu);
});

test('explicit Claude usage opt-in reaches ordinary scenario validation without starting a provider', () => {
  const result = run(
    ['correct', path.join(os.tmpdir(), 'not-a-scenario'), '--agent', 'claude'],
    { allowClaudeUsage: true },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /only this harness own disposable temp directory/u);
  assert.doesNotMatch(result.stderr, /Claude usage is not started/u);
});

for (const agent of ['codex', 'claude']) {
  test('real-provider E2E blocks ' + agent + ' before creating a project unless usage is explicitly enabled', () => {
    const prefix = 'amabie-' + agent + '-p2e-e2e-';
    const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)).sort();
    const result = runLiveProvider(agent);
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix)).sort();

    assert.equal(result.status, 3);
    assert.match(result.stderr, new RegExp(agent === 'codex' ? 'Codex usage is not started' : 'Claude usage is not started', 'u'));
    assert.equal(result.stdout, '');
    assert.deepEqual(after, before, 'provider opt-in must be checked before creating a scratch project');
  });
}
