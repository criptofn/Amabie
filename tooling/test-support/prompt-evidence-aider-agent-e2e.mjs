import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cliEntry = path.join(repoRoot, 'apps', 'cli', 'dist', 'src', 'main.js');
const initialAgent = path.join(repoRoot, 'tooling', 'test-support', 'fixtures', 'prompt-evidence-fixture-agent.mjs');
const aiderAgent = path.join(repoRoot, 'tooling', 'agents', 'aider-correction-adapter.mjs');
const npmCli = process.env.AMABIE_NPM_CLI ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-aider-e2e-'));
const projectRoot = path.join(artifactRoot, 'project');
const agentTempRoot = path.join(artifactRoot, 'agent-state');
const modelTranscriptPath = path.join(artifactRoot, 'aider-transcript.json');
const goal = 'Implement registration that rejects malformed email addresses. Reject passwords that are empty or whitespace-only.';
const endpoint = new URL(process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434');
const model = process.env.AMABIE_LOCAL_MODEL ?? 'qwen3.5:9b';
const aiderModel = process.env.AMABIE_AIDER_MODEL ?? `ollama_chat/${model}`;
const requirements = [
  'Implement registration that rejects malformed email addresses.',
  'Reject passwords that are empty or whitespace-only.',
];
const localEnv = {
  ...process.env,
  OLLAMA_HOST: endpoint.origin,
  OLLAMA_NO_CLOUD: '1',
  AMABIE_LOCAL_MODEL: model,
  AMABIE_AIDER_MODEL: aiderModel,
  AMABIE_AIDER_TEMP_ROOT: agentTempRoot,
  AMABIE_AIDER_TRANSCRIPT: modelTranscriptPath,
};

function run(executable, args, cwd, { input, timeout = 120_000, env = localEnv } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runNpm(args, cwd) {
  if (process.platform === 'win32') {
    assert.ok(fs.existsSync(npmCli), `npm JavaScript entrypoint not found at ${npmCli}; set AMABIE_NPM_CLI if Node and npm are installed separately`);
    return run(process.execPath, [npmCli, ...args], cwd);
  }
  return run('npm', args, cwd);
}

function assertRun(result, expectedStatus, label) {
  assert.equal(result.status, expectedStatus, `${label}\n${result.stderr}\n${result.stdout}`);
}

function materialDigest(text) {
  const canonical = text.trim().replace(/\s+/gu, ' ');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function writeReviewedRequest(extractedRequest) {
  assert.equal(extractedRequest.schema, 'amabie-prompt-evidence/1');
  assert.equal(extractedRequest.goal.text, goal);
  assert.deepEqual(extractedRequest.requirements.map(requirement => requirement.text), requirements, 'the extracted source-backed split must be reviewed before it is registered');
  const reviewed = {
    ...extractedRequest,
    requirements: extractedRequest.requirements.map((requirement, index) => {
      assert.equal(requirement.clarity, 'unclear', 'automatic extraction cannot decide that a requirement is clear');
      assert.deepEqual(requirement.criteria, [], 'automatic extraction cannot invent verification criteria');
      assert.equal(goal.slice(requirement.sourceRef.start, requirement.sourceRef.end), requirement.sourceRef.excerpt);
      assert.equal(goal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd), requirement.text);
      return {
        ...requirement,
        clarity: 'clear',
        criteria: [{
          statement: `A fresh sealed project check provides evidence for: ${requirements[index]}`,
          adapterId: 'amabie.coding.sealed-plan',
          evidenceType: 'sealed-check-run',
          predicate: { path: '/ok', equals: true },
        }],
      };
    }),
  };
  const directory = path.join(projectRoot, '.amabie');
  fs.mkdirSync(directory, { recursive: true });
  const requestPath = path.join(directory, 'prompt-evidence.json');
  fs.writeFileSync(requestPath, `${JSON.stringify(reviewed, null, 2)}\n`, 'utf8');
  return { requestPath, reviewed };
}

try {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(agentTempRoot, { recursive: true });
  assert.ok(fs.existsSync(cliEntry), 'build Amabie before running the local Aider end-to-end scenario');
  assert.equal(endpoint.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'requirement extraction must use a loopback Ollama endpoint');
  const health = await fetch(`${endpoint.origin}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(health.ok, true, 'local Ollama must be running');
  const models = (await health.json()).models.map(({ name }) => name);
  assert.ok(models.includes(model), `the selected local model must be installed: ${model}`);

  const aiderVersion = run(process.env.AMABIE_AIDER_EXECUTABLE ?? 'aider', ['--version'], projectRoot);
  assertRun(aiderVersion, 0, 'Aider must be installed in the caller-selected test environment');

  const draft = run(process.execPath, [
    cliEntry, 'prompt-evidence', 'draft', goal,
    '--extractor', 'ollama', '--model', model, '--suggest-criteria', '--json',
  ], projectRoot, { timeout: 5 * 60_000 });
  assertRun(draft, 0, 'local model must extract source-linked candidates and generate a review-only criteria preview');
  const reviewPreview = JSON.parse(draft.stdout);
  assert.equal(reviewPreview.schema, 'amabie-prompt-evidence-review/1');
  assert.equal(reviewPreview.authority, 'advisory-only');
  assert.equal(reviewPreview.verdict, 'NOT PROVEN');
  assert.deepEqual(reviewPreview.request.requirements.map(requirement => requirement.text), requirements);
  assert.ok(reviewPreview.request.requirements.every(({ clarity, criteria }) => clarity === 'unclear' && criteria.length === 0), 'suggestions must not populate executable criteria');
  assert.equal(reviewPreview.suggestions.length, reviewPreview.request.requirements.length);
  assert.ok(reviewPreview.suggestions.every((suggestion, index) => suggestion.reviewStatus === 'unreviewed'
    && suggestion.sourceText === reviewPreview.request.requirements[index].text), 'every preview must remain tied to its exact source candidate');
  const extractedRequest = reviewPreview.request;
  const { requestPath, reviewed } = writeReviewedRequest(extractedRequest);

  const git = (args) => run('git', args, projectRoot);
  assertRun(git(['init', '--quiet']), 0, 'initialize synthetic project');
  assertRun(git(['config', 'user.email', 'amabie-test@example.invalid']), 0, 'configure synthetic commit identity');
  assertRun(git(['config', 'user.name', 'Amabie Local Agent Test']), 0, 'configure synthetic commit identity');

  const registrationFile = path.join(projectRoot, 'registration.mjs');
  const passwordFile = path.join(projectRoot, 'password-policy.mjs');
  const testDirectory = path.join(projectRoot, 'test');
  fs.mkdirSync(testDirectory, { recursive: true });
  fs.writeFileSync(registrationFile, [
    'export function isValidEmail(value) {',
    '  return typeof value === "string" && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(value);',
    '}',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(passwordFile, [
    'export function acceptsPassword(value) {',
    '  return typeof value === "string";',
    '}',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(testDirectory, 'registration.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { isValidEmail } from "../registration.mjs";',
    'test("registration rejects malformed emails and accepts valid addresses", () => {',
    '  assert.equal(isValidEmail("not-an-email"), false);',
    '  assert.equal(isValidEmail("person@example.org"), true);',
    '});',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(testDirectory, 'run-password-policy-check.mjs'), [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'const acceptance = "test/password-policy.test.mjs";',
    'if (!fs.existsSync(acceptance)) { console.log("no evaluator-provided password acceptance test is present"); process.exit(0); }',
    'const result = spawnSync(process.execPath, ["--test", acceptance], { stdio: "inherit" });',
    'if (result.error) { console.error(result.error.message); process.exit(1); }',
    'process.exit(result.status ?? 1);',
  ].join('\n') + '\n', 'utf8');
  const scripts = {
    test: 'node --test test/registration.test.mjs',
    typecheck: 'node test/run-password-policy-check.mjs',
  };
  const proofs = Object.fromEntries(requirements.map((requirement, index) => [materialDigest(requirement), index === 0 ? 'test' : 'typecheck']));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), `${JSON.stringify({ name: 'amabie-prompt-evidence-aider-e2e', scripts, amabie: { proofs } }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.env'), 'OPENAI_API_KEY=amabie-not-a-real-test-credential\n', 'utf8');
  assertRun(runNpm(['run', 'test'], projectRoot), 0, 'the baseline registration check must pass');
  assertRun(runNpm(['run', 'typecheck'], projectRoot), 0, 'the baseline password check must pass');
  assertRun(git(['add', '.env', 'package.json', 'registration.mjs', 'password-policy.mjs', 'test']), 0, 'stage the verified baseline');
  assertRun(git(['commit', '--quiet', '-m', 'verified baseline']), 0, 'seal the verified baseline commit');

  assertRun(run(process.execPath, [cliEntry, 'setup', '--yes'], projectRoot), 0, 'seal the synthetic project checks');
  assertRun(run(process.execPath, [cliEntry, 'task', goal, ...requirements.flatMap(requirement => ['--requirement', requirement])], projectRoot), 0, 'register the reviewed extracted task');
  const requestRelativePath = path.relative(projectRoot, requestPath).split(path.sep).join('/');

  const acceptancePath = path.join(testDirectory, 'password-policy.test.mjs');
  fs.writeFileSync(acceptancePath, [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { acceptsPassword } from "../password-policy.mjs";',
    'test("password handling rejects empty and whitespace-only values", () => {',
    '  assert.equal(acceptsPassword(""), false);',
    '  assert.equal(acceptsPassword("   "), false);',
    '  assert.equal(acceptsPassword("correct horse battery staple"), true);',
    '});',
  ].join('\n') + '\n', 'utf8');
  const acceptanceDigest = createHash('sha256').update(fs.readFileSync(acceptancePath)).digest('hex');
  assert.equal(git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'test/password-policy.test.mjs']).stdout.trim(), '', 'the evaluator-owned acceptance check must not be present in the sealed baseline');

  const initialAgentResult = run(process.execPath, [initialAgent, passwordFile, '', '', 'initial-false-done-behavior'], projectRoot, {
    input: JSON.stringify({ schema: 'amabie-agent-task/1', goal: { taskType: 'coding', text: goal }, requirements }),
  });
  assertRun(initialAgentResult, 0, 'initial fixture agent must complete its partial attempt');
  assert.match(initialAgentResult.stdout, /Everything is done/u);
  assert.equal(createHash('sha256').update(fs.readFileSync(acceptancePath)).digest('hex'), acceptanceDigest, 'the independent acceptance check must remain unchanged by the initial agent');
  const initial = run(process.execPath, [cliEntry, 'doctor', '--prompt-evidence', requestRelativePath, '--json'], projectRoot);
  assertRun(initial, 2, 'Amabie must reject the false-done candidate using the failing password test');
  const initialReport = JSON.parse(initial.stdout).promptEvidence;
  assert.equal(initialReport.verdict, 'FAIL');
  assert.deepEqual(initialReport.coverage, { total: 2, met: 1, unmet: 1, unproven: 0, blocked: 0 });
  assert.deepEqual(initialReport.requirements.map(({ status }) => status), ['met', 'unmet']);

  const startedAt = performance.now();
  const loop = run(process.execPath, [
    cliEntry, 'prompt-evidence', 'loop', '--request', requestRelativePath,
    '--agent-executable', process.execPath,
    '--agent-arg', aiderAgent,
    '--agent-arg', 'password-policy.mjs',
    '--authorize-corrections', '--json',
  ], projectRoot, { timeout: 35 * 60_000 });
  const correctionRuntimeMs = Math.round(performance.now() - startedAt);
  assertRun(loop, 0, 'bounded Aider correction loop must reverify the complete sealed plan');
  const loopReport = JSON.parse(loop.stdout);
  assert.equal(loopReport.status, 'verified');
  assert.equal(loopReport.correctionAttempts, 1);
  assert.equal(loopReport.verification.verdict, 'PASS');
  assert.deepEqual(loopReport.verification.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  const candidateRoot = loopReport.candidate.path;
  assert.match(fs.readFileSync(path.join(candidateRoot, 'password-policy.mjs'), 'utf8'), /value\.trim\(\)\.length\s*>\s*0/u);
  assert.doesNotMatch(fs.readFileSync(passwordFile, 'utf8'), /value\.trim\(\)\.length\s*>\s*0/u, 'the authoritative project is not silently corrected');
  assert.equal(createHash('sha256').update(fs.readFileSync(acceptancePath)).digest('hex'), acceptanceDigest, 'the correction agent must not edit the evaluator-owned acceptance check');

  const changedFiles = run('git', ['-C', candidateRoot, 'diff', '--name-only', loopReport.candidate.baseHead], projectRoot).stdout.trim().split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(changedFiles, ['password-policy.mjs'], 'the coding agent may change only the requirement-specific fixture');
  const transcript = JSON.parse(fs.readFileSync(modelTranscriptPath, 'utf8'));
  assert.equal(transcript.exitCode, 0);
  assert.equal(transcript.model, aiderModel);
  assert.match(transcript.stdout, /Applied edit to password-policy\.mjs/u);
  const envFileIndex = transcript.args.indexOf('--env-file');
  assert.ok(envFileIndex >= 0, 'Aider must be pointed at an isolated empty environment file instead of the project .env');
  assert.equal(fs.readFileSync(transcript.args[envFileIndex + 1], 'utf8'), '# Deliberately empty: do not load project or user credentials.\n');
  const attachedFiles = transcript.args.flatMap((argument, index) => argument === '--file' ? [transcript.args[index + 1]] : []);
  assert.deepEqual(attachedFiles.map(file => path.basename(file)), ['password-policy.mjs'], 'Aider must receive only the explicitly selected correction target');

  console.log(JSON.stringify({
    status: 'PASS',
    requirementExtraction: {
      extractor: 'local Ollama',
      model,
      candidateCount: extractedRequest.requirements.length,
      suggestionCount: reviewPreview.suggestions.reduce((count, suggestion) => count + suggestion.criteria.length, 0),
      suggestionsRemainUnreviewed: reviewPreview.suggestions.every(({ reviewStatus }) => reviewStatus === 'unreviewed'),
      exactSourceCoverage: true,
      operatorReviewRequired: extractedRequest.requirements.every(({ clarity, criteria }) => clarity === 'unclear' && criteria.length === 0),
    },
    initialAgentClaim: initialAgentResult.stdout.trim(),
    initialVerdict: initialReport.verdict,
    initialCoverage: initialReport.coverage,
    correctionAgent: 'Aider CLI',
    aiderVersion: aiderVersion.stdout.trim(),
    aiderModel,
    correctionAttempts: loopReport.correctionAttempts,
    correctionRuntimeMs,
    finalPromptEvidenceVerdict: loopReport.verification.verdict,
    finalCoverage: loopReport.verification.coverage,
    changedFiles,
    requirements: requirements.map((text, index) => ({ id: reviewed.requirements[index].id, text })),
    artifactRoot,
    transcriptPath: modelTranscriptPath,
  }, null, 2));
} catch (error) {
  console.error(`Aider Prompt-to-Evidence E2E failed; inspect scratch project ${projectRoot}`);
  console.error(error);
  process.exitCode = 1;
}
