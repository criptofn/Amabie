import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Explicitly invokes a real, authenticated provider CLI. It is intentionally not part of npm test.
const agent = process.argv[2];
if (agent !== 'codex' && agent !== 'claude') {
  console.error('usage: node tooling/test-support/prompt-evidence-provider-agent-e2e.mjs codex|claude');
  process.exit(2);
}
const usageGuard = agent === 'codex'
  ? 'AMABIE_ALLOW_CODEX_PROVIDER_USAGE'
  : 'AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE';
if (process.env[usageGuard] !== '1') {
  console.error((agent === 'codex' ? 'Codex' : 'Claude')
    + ' usage is not started: set ' + usageGuard
    + '=1 only after the operator approves possible provider quota or charges.');
  process.exit(3);
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cliEntry = path.join(repoRoot, 'apps', 'cli', 'dist', 'src', 'main.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `amabie-${agent}-p2e-e2e-`));
const projectRoot = path.join(tempRoot, 'project');
const goal = 'Implement registration that rejects malformed email addresses. Reject passwords that are empty or whitespace-only.';
const agentKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];
const providerEnv = { ...process.env };
for (const key of agentKeys) providerEnv[key] = `amabie-invalid-${key.toLowerCase()}-sentinel`;
providerEnv.OPENAI_BASE_URL = 'http://127.0.0.1:1/should-not-be-used';
providerEnv.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1/should-not-be-used';
let phase = 'initialize isolated project';

function run(executable, args, cwd, { input, timeout = 120_000, env = providerEnv } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 12 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runCli(args, cwd = projectRoot, options = {}) {
  return run(process.execPath, [cliEntry, ...args], cwd, options);
}

function assertRun(result, expectedStatus, label) {
  assert.equal(result.status, expectedStatus, `${label}\n${result.stderr}\n${result.stdout}`);
}

function materialDigest(text) {
  const canonical = text.trim().replace(/\s+/gu, ' ');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function workspaceFileDigests() {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');
      if (relativePath === '.git' || relativePath.startsWith('.git/')
        || relativePath === '.amabie' || relativePath.startsWith('.amabie/')) continue;
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        files.set(relativePath, createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex'));
      }
    }
  };
  visit(projectRoot);
  return files;
}

function changedFilesBetween(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(file => before.get(file) !== after.get(file))
    .sort();
}

assert.deepEqual(
  changedFilesBetween(new Map([['same', 'a'], ['removed', 'b']]), new Map([['same', 'a'], ['added', 'c']])),
  ['added', 'removed'],
);

function git(args) {
  return run('git', args, projectRoot);
}

try {
  assert.ok(fs.existsSync(cliEntry), 'build Amabie before running this explicit provider E2E');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'test'), { recursive: true });

  phase = 'extract and review prompt requirements';
  const draft = runCli(['prompt-evidence', 'draft', goal, '--json']);
  assertRun(draft, 0, 'deterministic prompt extraction must return a review-only draft');
  const extracted = JSON.parse(draft.stdout);
  const requirements = extracted.requirements.map(({ text }) => text);
  assert.deepEqual(requirements, [
    'Implement registration that rejects malformed email addresses.',
    'Reject passwords that are empty or whitespace-only.',
  ]);
  assert.ok(extracted.requirements.every(({ clarity, criteria }) => clarity === 'unclear' && criteria.length === 0));

  const registrationFile = path.join(projectRoot, 'registration.mjs');
  const passwordFile = path.join(projectRoot, 'password-policy.mjs');
  fs.writeFileSync(registrationFile, [
    'export function isValidEmail(value) {',
    '  return typeof value === "string" && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(value);',
    '}',
  ].join('\n') + '\n');
  fs.writeFileSync(passwordFile, [
    'export function isPasswordAllowed(value) {',
    '  return typeof value === "string" && value.trim().length > 0;',
    '}',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(projectRoot, 'test', 'registration.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { isValidEmail } from "../registration.mjs";',
    'test("registration rejects malformed email addresses", () => {',
    '  assert.equal(isValidEmail("not-an-email"), false);',
    '  assert.equal(isValidEmail("person@example.org"), true);',
    '});',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(projectRoot, 'test', 'password-policy.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { isPasswordAllowed } from "../password-policy.mjs";',
    'test("password policy rejects empty and whitespace-only values", () => {',
    '  assert.equal(isPasswordAllowed(""), false);',
    '  assert.equal(isPasswordAllowed("   "), false);',
    '  assert.equal(isPasswordAllowed("long-password-123"), true);',
    '});',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(projectRoot, 'test', 'password-policy-check.mjs'), [
    'import assert from "node:assert/strict";',
    'import { isPasswordAllowed } from "../password-policy.mjs";',
    'assert.equal(isPasswordAllowed(""), false);',
    'assert.equal(isPasswordAllowed("   "), false);',
    'assert.equal(isPasswordAllowed("long-password-123"), true);',
    'console.log("password-policy check passed");',
  ].join('\n') + '\n');

  const proofs = Object.fromEntries(requirements.map((text, index) => [materialDigest(text), index === 0 ? 'test' : 'typecheck']));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), `${JSON.stringify({
    name: `amabie-${agent}-prompt-evidence-e2e`,
    type: 'module',
    scripts: {
      test: 'node --test test/registration.test.mjs',
      typecheck: 'node test/password-policy-check.mjs',
    },
    amabie: { proofs },
  }, null, 2)}\n`);
  assertRun(git(['init', '--quiet']), 0, 'initialize isolated project');
  assertRun(git(['config', 'user.email', 'amabie-test@example.invalid']), 0, 'set isolated commit identity');
  assertRun(git(['config', 'user.name', 'Amabie Provider E2E']), 0, 'set isolated commit identity');
  assertRun(git(['add', 'package.json', 'registration.mjs', 'password-policy.mjs', 'test']), 0, 'stage trusted baseline');
  assertRun(git(['commit', '--quiet', '-m', 'known-good verification baseline']), 0, 'commit trusted baseline');

  phase = 'seal the project verification plan';
  const setup = runCli(['setup', '--yes']);
  assertRun(setup, 0, 'seal the project check plan');
  const task = runCli(['task', goal, ...requirements.flatMap(text => ['--requirement', text])]);
  assertRun(task, 0, 'register the exact original request and reviewed requirements');

  const reviewedRequest = {
    ...extracted,
    requirements: extracted.requirements.map((requirement, index) => ({
      ...requirement,
      clarity: 'clear',
      criteria: [{
        statement: `A fresh sealed check provides evidence for: ${requirements[index]}`,
        adapterId: 'amabie.coding.sealed-plan',
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    })),
  };
  const requestPath = path.join(projectRoot, '.amabie', 'prompt-evidence.json');
  fs.writeFileSync(requestPath, `${JSON.stringify(reviewedRequest, null, 2)}\n`);

  // Simulate a false-done candidate: the registered checks independently reveal one unmet requirement.
  phase = 'verify the intentionally incomplete candidate';
  fs.writeFileSync(passwordFile, [
    'export function isPasswordAllowed(value) {',
    '  return typeof value === "string";',
    '}',
  ].join('\n') + '\n');
  const before = runCli(['doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json']);
  assertRun(before, 2, 'the false-done candidate must fail independent verification');
  const beforeReport = JSON.parse(before.stdout).promptEvidence;
  assert.equal(beforeReport.verdict, 'FAIL');
  assert.deepEqual(beforeReport.coverage, { total: 2, met: 1, unmet: 1, unproven: 0, blocked: 0 });

  const filesBeforeCorrection = workspaceFileDigests();
  phase = 'run one bounded provider correction';
  const loop = runCli([
    'prompt-evidence', 'loop', '--request', '.amabie/prompt-evidence.json', '--agent', agent,
    '--authorize-corrections', '--max-corrections', '1', '--json',
  ], projectRoot, { timeout: 12 * 60_000 });
  const result = JSON.parse(loop.stdout);
  const filesAfterCorrection = workspaceFileDigests();
  const changedFiles = changedFilesBetween(filesBeforeCorrection, filesAfterCorrection);
  const summary = {
    status: loop.status === 0 && result.status === 'verified' ? 'PASS' : 'FAIL',
    providerCli: agent,
    processExitCode: loop.status,
    loopStatus: result.status,
    initialVerdict: beforeReport.verdict,
    initialCoverage: beforeReport.coverage,
    correctionAttempts: result.correctionAttempts,
    finalVerdict: result.verification?.verdict ?? null,
    finalCoverage: result.verification?.coverage ?? null,
    stopReason: result.stopReason ?? null,
    agentClaimUsedAsEvidence: result.agentClaimUsedAsEvidence,
    changedFiles,
    projectRoot,
    providerApiKeysPassed: false,
  };
  fs.writeFileSync(path.join(tempRoot, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (loop.status !== 0 || result.status !== 'verified') {
    throw new Error(`${agent} correction did not verify: exit ${loop.status}; ${result.status}; ${result.stopReason ?? 'no stop reason'}`);
  }
  phase = 'assert fresh evidence and correction scope';
  assert.equal(result.status, 'verified');
  assert.equal(result.correctionAttempts, 1, 'the provider must run no more than once in this approval-bounded scenario');
  assert.equal(result.verification.verdict, 'PASS');
  assert.deepEqual(result.verification.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  assert.equal(result.agentClaimUsedAsEvidence, false);
  assert.match(fs.readFileSync(passwordFile, 'utf8'), /value\.trim\(\)\.length\s*>\s*0/u);
  assert.deepEqual(changedFiles, ['password-policy.mjs'], 'the correction must remain focused on the missing behavior');
  summary.status = 'PASS';
  fs.writeFileSync(path.join(tempRoot, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  fs.writeFileSync(path.join(tempRoot, 'result.json'), `${JSON.stringify({
    status: 'FAIL',
    providerCli: agent,
    phase,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    projectRoot,
  }, null, 2)}\n`);
  console.error(`Provider E2E failed; isolated project preserved at ${projectRoot}`);
  console.error(`${phase}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
