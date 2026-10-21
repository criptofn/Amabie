import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cliEntry = path.join(repoRoot, 'apps', 'cli', 'dist', 'src', 'main.js');
const checkFixture = path.join(repoRoot, 'tooling', 'test-support', 'fixtures', 'prompt-evidence-source-check.mjs');
const localAgent = path.join(repoRoot, 'tooling', 'test-support', 'fixtures', 'prompt-evidence-ollama-agent.mjs');

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-local-agent-e2e-'));
const metricsPath = path.join(scratchRoot, '.amabie', 'local-model-metrics.json');
const localEnv = {
  ...process.env,
  OLLAMA_HOST: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
  AMABIE_LOCAL_MODEL: process.env.AMABIE_LOCAL_MODEL ?? 'qwen3.5:9b',
  AMABIE_LOCAL_AGENT_METRICS: metricsPath,
};
const requirements = [
  'Registration rejects an invalid email address.',
  'Password storage rejects blank input.',
];
const goal = requirements.join('\n');

function run(executable, args, cwd, { input, timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: localEnv,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runCli(args, options) {
  return run(process.execPath, [cliEntry, ...args], scratchRoot, options);
}

function assertRun(result, expectedStatus, label) {
  assert.equal(result.status, expectedStatus, `${label}\n${result.stderr}\n${result.stdout}`);
}

function materialDigest(text) {
  const canonical = text.trim().replace(/\s+/gu, ' ');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function writeRequest() {
  const [registration, password] = requirements;
  const request = {
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: goal },
    requirements: [
      {
        text: registration,
        sourceRef: { kind: 'goal', start: 0, end: registration.length, excerpt: registration },
        clarity: 'clear',
        criteria: [{ statement: 'A sealed project check proves the requirement.', adapterId: 'amabie.coding.sealed-plan', evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }],
      },
      {
        text: password,
        sourceRef: { kind: 'goal', start: registration.length + 1, end: goal.length, excerpt: password },
        clarity: 'clear',
        criteria: [{ statement: 'A sealed project check proves the requirement.', adapterId: 'amabie.coding.sealed-plan', evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }],
      },
    ],
  };
  const directory = path.join(scratchRoot, '.amabie');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'prompt-evidence.json'), `${JSON.stringify(request, null, 2)}\n`);
}

try {
  const health = await fetch(`${localEnv.OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(health.ok, true, 'local Ollama endpoint must be running and reachable');

  const git = (args) => run('git', args, scratchRoot);
  assertRun(git(['init', '--quiet']), 0, 'initialize scratch repository');
  assertRun(git(['config', 'user.email', 'amabie-test@example.invalid']), 0, 'set scratch commit identity');
  assertRun(git(['config', 'user.name', 'Amabie Local Agent Test']), 0, 'set scratch commit identity');

  const registrationFile = path.join(scratchRoot, 'registration.mjs');
  const passwordFile = path.join(scratchRoot, 'password-policy.mjs');
  fs.writeFileSync(registrationFile, 'export const emailRule = "rejects invalid email";\n');
  fs.writeFileSync(passwordFile, 'export const passwordRule = "rejects blank input";\n');
  const testCommand = `node "${checkFixture}" "${registrationFile}" "rejects invalid email"`;
  const typecheckCommand = `node "${checkFixture}" "${passwordFile}" "rejects blank input"`;
  const proofs = Object.fromEntries(requirements.map((requirement, index) => [materialDigest(requirement), index === 0 ? 'test' : 'typecheck']));
  fs.writeFileSync(path.join(scratchRoot, 'package.json'), `${JSON.stringify({
    name: 'amabie-local-agent-e2e',
    scripts: { test: testCommand, typecheck: typecheckCommand },
    amabie: { proofs },
  }, null, 2)}\n`);
  assertRun(git(['add', 'package.json', 'registration.mjs', 'password-policy.mjs']), 0, 'stage fixture baseline');
  assertRun(git(['commit', '--quiet', '-m', 'fixture baseline']), 0, 'commit fixture baseline');

  assertRun(runCli(['setup', '--yes']), 0, 'configure Amabie in scratch project');
  const taskArgs = ['task', goal, ...requirements.flatMap(requirement => ['--requirement', requirement])];
  assertRun(runCli(taskArgs), 0, 'register original task and requirements');
  writeRequest();

  // Seed the same observable state as a false-done coding-agent attempt.
  fs.writeFileSync(passwordFile, 'export const passwordRule = "accepts blank input";\n');
  const before = runCli(['doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json']);
  assertRun(before, 2, 'incomplete candidate must fail independent verification');
  const beforeReport = JSON.parse(before.stdout).promptEvidence;
  assert.equal(beforeReport.verdict, 'FAIL');
  assert.deepEqual(beforeReport.coverage, { total: 2, met: 1, unmet: 1, unproven: 0, blocked: 0 });

  const loopArgs = [
    'prompt-evidence', 'loop', '--request', '.amabie/prompt-evidence.json',
    '--agent-executable', process.execPath,
    '--agent-arg', localAgent,
    '--agent-arg', 'password-policy.mjs',
    '--authorize-corrections', '--json',
  ];
  const loop = runCli(loopArgs, { timeout: 35 * 60_000 });
  assertRun(loop, 0, 'local coding agent must correct the one reported gap');
  const loopReport = JSON.parse(loop.stdout);
  assert.equal(loopReport.status, 'verified');
  assert.equal(loopReport.correctionAttempts, 1);
  assert.equal(loopReport.verification.verdict, 'PASS');
  assert.deepEqual(loopReport.verification.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  const candidateRoot = loopReport.candidate.path;
  assert.match(fs.readFileSync(path.join(candidateRoot, 'password-policy.mjs'), 'utf8'), /rejects blank input/u);
  assert.match(fs.readFileSync(passwordFile, 'utf8'), /accepts blank input/u, 'the authoritative project is not silently corrected');

  const changedFiles = run('git', ['-C', candidateRoot, 'diff', '--name-only', loopReport.candidate.baseHead], scratchRoot).stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.deepEqual(changedFiles, ['password-policy.mjs'], 'the local coding agent should change only the unresolved fixture');
  const modelMetrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  console.log(JSON.stringify({
    status: 'PASS',
    provider: 'local Ollama endpoint',
    model: modelMetrics.model,
    promptTokens: modelMetrics.promptTokens,
    responseTokens: modelMetrics.responseTokens,
    inferenceDurationMs: modelMetrics.inferenceDurationMs,
    initialVerdict: beforeReport.verdict,
    initialCoverage: beforeReport.coverage,
    correctionAttempts: loopReport.correctionAttempts,
    loopVerdict: loopReport.verification.verdict,
    changedFiles,
    scratchRoot,
  }, null, 2));
} catch (error) {
  console.error(`Local agent E2E failed; inspect scratch project ${scratchRoot}`);
  console.error(error);
  process.exitCode = 1;
}
