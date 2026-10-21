import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, it } from 'node:test';
import { materialDigest } from '../src/authorization.js';
import { AGENT_HELP_PROBES, type BuiltinCorrectionAgent } from '../src/prompt-evidence-agents.js';

// What a shim prints for the no-call capability preflight: every option the built-in profile relies on.
const shimHelpLine = (agent: BuiltinCorrectionAgent) => `if (process.argv.includes('--help')) { console.log(${JSON.stringify(AGENT_HELP_PROBES[agent].flags.join(' '))}); process.exit(0); }`;

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-p2e-cli-'));
process.env.AMABIE_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-p2e-trust-'));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(process.env.AMABIE_TRUST_STORE!, { recursive: true, force: true });
});

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, env });
}

function runAsync(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', status => {
      clearTimeout(timeout);
      resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

it('built-in Codex and Claude profiles require explicit correction authorization before provider use', () => {
  const root = path.join(TMP, 'agent-profile-authorization');
  fs.mkdirSync(root, { recursive: true });

  for (const agent of ['codex', 'claude']) {
    const result = run(['prompt-evidence', 'loop', '--request', 'request.json', '--agent', agent], root);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /add --authorize-corrections only when you want this agent to change files/u);
  }
});

it('built-in profiles reject custom executable overrides before starting a process', () => {
  const root = path.join(TMP, 'agent-profile-override');
  fs.mkdirSync(root, { recursive: true });
  const result = run([
    'prompt-evidence', 'loop', '--request', 'request.json', '--agent', 'codex',
    '--agent-executable', process.execPath, '--authorize-corrections',
  ], root);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot be combined with --agent-executable/u);
});

it('correction-cycle caps accept only integers from one through three before any provider is started', () => {
  const root = path.join(TMP, 'agent-profile-cycle-cap');
  fs.mkdirSync(root, { recursive: true });
  for (const cap of ['0', '4', '1.5', 'unlimited']) {
    const result = run([
      'prompt-evidence', 'loop', '--request', 'request.json', '--agent', 'codex',
      '--max-corrections', cap, '--authorize-corrections',
    ], root);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /--max-corrections must be an integer from 1 to 3/u);
  }
});

it('Claude Code versions older than the profile minimum are rejected before the correction process starts', () => {
  const project = prepareProject({ includeBindings: 1 }, 'claude-outdated-version');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const shimDir = path.join(TMP, 'claude-outdated-version-shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const invokedPath = path.join(TMP, 'claude-outdated-agent-invoked.txt');
  const shimProgram = path.join(shimDir, 'fake-claude.mjs');
  fs.writeFileSync(shimProgram, [
    "import fs from 'node:fs';",
    "if (process.argv.includes('--version')) console.log('2.1.247 (Claude Code)');",
    `else fs.writeFileSync(${JSON.stringify(invokedPath)}, 'invoked');`,
  ].join('\n'));
  const shimPath = path.join(shimDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(shimPath, [
      '@echo off',
      `"${process.execPath}" "${shimProgram}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
  } else {
    const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shimProgram)} "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
  }
  const providerExecutables = new Set(['claude', 'claude.exe', 'claude.cmd', 'claude.ps1']);
  const safePath = (process.env.PATH ?? '').split(path.delimiter).filter(entry =>
    entry && ![...providerExecutables].some(executable => fs.existsSync(path.join(entry, executable))),
  );
  const result = run([
    'prompt-evidence', 'loop', '--request', request, '--agent', 'claude',
    '--authorize-corrections', '--max-corrections', '1', '--json',
  ], project.root, { ...process.env, PATH: [shimDir, ...safePath].join(path.delimiter) });

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(fs.existsSync(invokedPath), false, 'an unsupported Claude CLI must not receive the correction report');
  const envelope = JSON.parse(result.stdout) as { status: string; stopReason: string; agentClaimUsedAsEvidence: boolean };
  assert.equal(envelope.status, 'correction-blocked');
  assert.match(envelope.stopReason, /Claude Code 2\.1\.247 is unsupported; version 2\.1\.248 or newer is required/u);
  assert.equal(envelope.agentClaimUsedAsEvidence, false);
});

function makeProject(name: string, options: { fixture?: 'f-pass.js' | 'f-controlled.js'; includeBindings: number }): { root: string; goal: string; requirements: string[] } {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'amabie-test@example.invalid'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Amabie Test'], { cwd: root }).status, 0);
  const requirements = [
    'Registration rejects an invalid email address.',
    'Passwords are stored using the configured password hash.',
  ];
  const goal = requirements.join('\n');
  const proofs = Object.fromEntries(requirements.slice(0, options.includeBindings).map(text => [materialDigest(text), 'test']));
  const fixture = path.join(FIXTURES, options.fixture ?? 'f-pass.js').replace(/\\/gu, '/');
  const marker = path.join(root, '.amabie', 'controlled-failure').replace(/\\/gu, '/');
  const testCommand = options.fixture === 'f-controlled.js' ? `node "${fixture}" "${marker}"` : `node "${fixture}"`;
  const manifest = { name, scripts: { test: testCommand }, amabie: { proofs } };
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(spawnSync('git', ['add', 'package.json'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0);
  return { root, goal, requirements };
}

function writeRequest(root: string, goal: string, requirements: string[], claim?: string): string {
  let cursor = 0;
  const request = {
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: goal },
    ...(claim === undefined ? {} : { agentClaim: claim }),
    requirements: requirements.map(text => {
      const start = goal.indexOf(text, cursor);
      if (start < 0) throw new Error(`test fixture requirement is not present in its goal: ${text}`);
      const end = start + text.length;
      cursor = end + 1;
      return {
        text,
        sourceRef: { kind: 'goal', start, end, excerpt: text },
        clarity: 'clear',
        criteria: [{
          statement: `A sealed project check proves: ${text}`,
          adapterId: 'amabie.coding.sealed-plan',
          evidenceType: 'sealed-check-run',
          predicate: { path: '/ok', equals: true },
        }],
      };
    }),
  };
  const dir = path.join(root, '.amabie');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prompt-evidence.json');
  fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`);
  return path.relative(root, file);
}

function prepareProject(options: Parameters<typeof makeProject>[1], name: string) {
  const project = makeProject(name, options);
  const setup = run(['setup', '--yes'], project.root);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const task = run(['task', project.goal, ...project.requirements.flatMap(r => ['--requirement', r])], project.root);
  assert.equal(task.status, 0, task.stderr || task.stdout);
  return project;
}

it('Scenario A: the CLI includes requirement-level evidence from the fresh sealed plan run', () => {
  const project = prepareProject({ includeBindings: 2 }, 'scenario-a');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout) as { status: string; evidencePath?: string; promptEvidence?: { verdict: string; coverage: { total: number; met: number }; requirements: Array<{ status: string }>; evidence: Array<{ provenance: string; facts: { checkId?: string } }> } };
  assert.equal(envelope.status, 'READY');
  assert.equal(envelope.promptEvidence?.verdict, 'PASS');
  assert.deepEqual(envelope.promptEvidence?.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  assert.ok(envelope.promptEvidence?.evidence.every(e => e.provenance === 'verifier-collected' && e.facts.checkId === 'test'));
  assert.ok(envelope.evidencePath);
  const saved = JSON.parse(fs.readFileSync(path.join(envelope.evidencePath!, 'verification.json'), 'utf8')) as { promptEvidence?: { requirements: Array<Record<string, unknown>> } };
  assert.ok(saved.promptEvidence?.requirements.every(r => !Object.hasOwn(r, 'text')), 'persisted evidence omits user requirement prose');
});

it('prompt-evidence draft emits review-required, source-linked requirements without writing project state', () => {
  const root = path.join(TMP, 'draft-intake');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Implement registration:\n- Validate email input.\n- Hash passwords.';
  const result = run(['prompt-evidence', 'draft', goal, '--json'], root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const request = JSON.parse(result.stdout) as { schema: string; goal: { text: string }; requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { start: number; end: number; excerpt: string } }> };
  assert.equal(request.schema, 'amabie-prompt-evidence/1');
  assert.equal(request.goal.text, goal);
  assert.deepEqual(request.requirements.map(requirement => requirement.text), ['Implement registration:', 'Validate email input.', 'Hash passwords.']);
  assert.ok(request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  assert.ok(request.requirements.every(requirement => goal.slice(requirement.sourceRef.start, requirement.sourceRef.end) === requirement.sourceRef.excerpt));
  assert.match(result.stderr, /DRAFT ONLY.*NOT PROVEN/u);
  assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
});

it('text draft reports exact candidate offsets and warns that source coverage is not semantic completeness', () => {
  const root = path.join(TMP, 'draft-text-offsets');
  fs.mkdirSync(root, { recursive: true });
  const goal = '- Validate email input.\n- Hash passwords.';
  const result = run(['prompt-evidence', 'draft', goal], root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const candidate = 'Validate email input.';
  const focusStart = goal.indexOf(candidate);
  assert.ok(result.stdout.includes(`1. [UNCLEAR] ${candidate} (focus ${focusStart}:${focusStart + candidate.length}; mapped source 0:`), result.stdout);
  assert.match(result.stdout, /does not establish semantic completeness/u);
  assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
});

it('Ollama-assisted draft accepts only exact quotes and still emits an unverified review request', async () => {
  const root = path.join(TMP, 'ollama-draft-intake');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Implement account creation that validates email addresses. Hash passwords.';
  const modelQuotes = ['Implement account creation', 'validates email addresses', 'Hash passwords.'];
  const normalizedQuotes = ['Implement account creation that validates email addresses', 'Hash passwords.'];
  let responseQuotes = modelQuotes;
  const observedRequests: Record<string, unknown>[] = [];
  let observedPath = '';
  const server = createServer((request, response) => {
    observedPath = request.url ?? '';
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      observedRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'fixture-model',
        done: true,
        message: { role: 'assistant', content: JSON.stringify({ quotes: responseQuotes }) },
        prompt_eval_count: 12,
        eval_count: 7,
        total_duration: 25_000_000,
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const request = JSON.parse(result.stdout) as { goal: { text: string }; requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { start: number; end: number; focusStart: number; focusEnd: number } }> };
    assert.equal(request.goal.text, goal);
    assert.deepEqual(request.requirements.map(requirement => requirement.text), normalizedQuotes);
    assert.ok(request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.ok(request.requirements.every(requirement => goal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd) === requirement.text));
    assert.match(result.stderr, /DRAFT ONLY — NOT PROVEN.*local Ollama model fixture-model/u);
    assert.match(result.stderr, /Source coverage is lexical, not semantic completeness/u);
    assert.match(result.stderr, /Every candidate remains unclear with no criteria/u);
    assert.match(result.stderr, /Candidates 1 and 2 were combined across dependent-clause marker "that"/u);
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
    assert.equal(observedPath, '/api/chat');
    assert.equal(observedRequests.length, 1);
    const observedRequest = observedRequests[0]!;
    assert.equal(observedRequest.model, 'fixture-model');
    assert.equal(observedRequest.stream, false);
    assert.equal(observedRequest.think, false);
    assert.equal((observedRequest.options as { temperature: number }).temperature, 0);
    assert.equal(((observedRequest.messages as Array<{ content: string }>)[1]!).content, goal);
    const systemPrompt = ((observedRequest.messages as Array<{ content: string }>)[0]!).content;
    assert.match(systemPrompt, /complete obligation phrase/u);
    assert.match(systemPrompt, /Never return a dependent fragment/u);
    assert.match(systemPrompt, /dependent clause/u);
    assert.match(systemPrompt, /question-form requests that propose a change/u);
    assert.match(systemPrompt, /independent obligations.*separate source quotes/u);
    assert.equal((observedRequest.format as { properties: { quotes: unknown } }).properties.quotes !== undefined, true);

    responseQuotes = ['Implement account creation', 'that validates email addresses', 'Hash passwords.'];
    const markerIncluded = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(markerIncluded.status, 0, markerIncluded.stderr || markerIncluded.stdout);
    const markerIncludedRequest = JSON.parse(markerIncluded.stdout) as { requirements: Array<{ text: string; clarity: string; criteria: unknown[] }> };
    assert.deepEqual(markerIncludedRequest.requirements.map(requirement => requirement.text), normalizedQuotes);
    assert.ok(markerIncludedRequest.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.match(markerIncluded.stderr, /Candidates 1 and 2 were combined across dependent-clause marker "that"/u);

    const gapGoal = 'Implement account registration, validate email addresses, hash passwords with Argon2, preserve existing login behavior, and add tests.';
    responseQuotes = ['Implement account registration', 'validate email addresses', 'hash passwords with Argon2', 'add tests.'];
    const gapResult = await runAsync([
      'prompt-evidence', 'draft', gapGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(gapResult.status, 0, gapResult.stderr || gapResult.stdout);
    const gapRequest = JSON.parse(gapResult.stdout) as { requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { excerpt: string; focusStart: number; focusEnd: number } }> };
    assert.ok(gapRequest.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    const recoveredCandidate = gapRequest.requirements.find(requirement => requirement.text === 'preserve existing login behavior');
    assert.ok(recoveredCandidate);
    assert.equal(gapGoal.slice(recoveredCandidate.sourceRef.focusStart, recoveredCandidate.sourceRef.focusEnd), recoveredCandidate.text);

    const conditionalGoal = 'Can we add CSV import? If a row is malformed, show its line number and skip that row.';
    responseQuotes = ['Can we add CSV import?', 'If a row is malformed, show its line number and skip that row.'];
    const conditionalResult = await runAsync([
      'prompt-evidence', 'draft', conditionalGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(conditionalResult.status, 0, conditionalResult.stderr || conditionalResult.stdout);
    const conditionalRequest = JSON.parse(conditionalResult.stdout) as { requirements: Array<{ text: string }> };
    assert.deepEqual(conditionalRequest.requirements.map(requirement => requirement.text), responseQuotes);

    const coordinatedGoal = 'Try at most three times with exponential backoff and respect Retry-After.';
    responseQuotes = [coordinatedGoal];
    const coordinatedResult = await runAsync([
      'prompt-evidence', 'draft', coordinatedGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(coordinatedResult.status, 0, coordinatedResult.stderr || coordinatedResult.stdout);
    const coordinatedRequest = JSON.parse(coordinatedResult.stdout) as {
      requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { excerpt: string; focusStart: number; focusEnd: number } }>;
    };
    assert.deepEqual(coordinatedRequest.requirements.map(requirement => requirement.text), [
      'Try at most three times with exponential backoff',
      'respect Retry-After.',
    ]);
    assert.ok(coordinatedRequest.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.ok(coordinatedRequest.requirements.every(requirement => coordinatedGoal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd) === requirement.text));
    assert.equal(coordinatedRequest.requirements[0]!.sourceRef.excerpt, 'Try at most three times with exponential backoff and ');
    assert.match(coordinatedResult.stderr, /deterministic action-verb rule split one exact quote at a coordinated action/u);

    const attachGoal = 'Parse quoted fields containing commas and escaped quotes, and attach each rejection to its original physical line number.';
    responseQuotes = [attachGoal];
    const attachResult = await runAsync([
      'prompt-evidence', 'draft', attachGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(attachResult.status, 0, attachResult.stderr || attachResult.stdout);
    const attachRequest = JSON.parse(attachResult.stdout) as { requirements: Array<{ text: string; sourceRef: { focusStart: number; focusEnd: number } }> };
    assert.deepEqual(attachRequest.requirements.map(requirement => requirement.text), [
      'Parse quoted fields containing commas and escaped quotes',
      'attach each rejection to its original physical line number.',
    ]);
    assert.ok(attachRequest.requirements.every(requirement => attachGoal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd) === requirement.text));
    assert.match(attachResult.stderr, /deterministic action-verb rule split one exact quote at a coordinated action/u);

    const butGoal = 'Add CSV import but preserve the existing signed-total behavior.';
    responseQuotes = [butGoal];
    const butResult = await runAsync([
      'prompt-evidence', 'draft', butGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(butResult.status, 0, butResult.stderr || butResult.stdout);
    const butRequest = JSON.parse(butResult.stdout) as {
      requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { focusStart: number; focusEnd: number } }>;
    };
    assert.deepEqual(butRequest.requirements.map(requirement => requirement.text), [
      'Add CSV import', 'preserve the existing signed-total behavior.',
    ]);
    assert.ok(butRequest.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.ok(butRequest.requirements.every(requirement => butGoal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd) === requirement.text));
    assert.match(butResult.stderr, /deterministic action-verb rule split one exact quote at a coordinated action/u);
    assert.match(butResult.stderr, /DRAFT ONLY — NOT PROVEN/u);

    const retryAfterGoal = 'Respect Retry-After and log each retry.';
    responseQuotes = [retryAfterGoal];
    const retryAfterResult = await runAsync([
      'prompt-evidence', 'draft', retryAfterGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(retryAfterResult.status, 0, retryAfterResult.stderr || retryAfterResult.stdout);
    const retryAfterRequest = JSON.parse(retryAfterResult.stdout) as { requirements: Array<{ text: string }> };
    assert.deepEqual(retryAfterRequest.requirements.map(requirement => requirement.text), ['Respect Retry-After', 'log each retry.']);

    const keepAndAddGoal = 'Keep API tokens out of logs and add regression tests.';
    responseQuotes = [keepAndAddGoal];
    const keepAndAddResult = await runAsync([
      'prompt-evidence', 'draft', keepAndAddGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(keepAndAddResult.status, 0, keepAndAddResult.stderr || keepAndAddResult.stdout);
    const keepAndAddRequest = JSON.parse(keepAndAddResult.stdout) as { requirements: Array<{ text: string; clarity: string; criteria: unknown[] }> };
    assert.deepEqual(keepAndAddRequest.requirements.map(requirement => requirement.text), [
      'Keep API tokens out of logs', 'add regression tests.',
    ]);
    assert.ok(keepAndAddRequest.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));

    const whileGoal = 'Emit deterministic Markdown while keeping the current JSON mode and its CLI flags intact.';
    responseQuotes = ['Emit deterministic Markdown', 'keeping the current JSON mode and its CLI flags intact.'];
    const whileResult = await runAsync([
      'prompt-evidence', 'draft', whileGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(whileResult.status, 0, whileResult.stderr || whileResult.stdout);
    const whileRequest = JSON.parse(whileResult.stdout) as {
      requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { focusStart: number; focusEnd: number } }>;
    };
    assert.deepEqual(whileRequest.requirements.map(requirement => requirement.text), responseQuotes);
    assert.ok(whileRequest.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.ok(whileRequest.requirements.every(requirement => whileGoal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd) === requirement.text));
    assert.match(whileResult.stderr, /Candidates 1 and 2 were kept separate across action-gerund marker "while"/u);

    const dependentWhileGoal = 'Write the report while the input file remains open.';
    responseQuotes = ['Write the report', 'the input file remains open.'];
    const dependentWhileResult = await runAsync([
      'prompt-evidence', 'draft', dependentWhileGoal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(dependentWhileResult.status, 0, dependentWhileResult.stderr || dependentWhileResult.stdout);
    const dependentWhileRequest = JSON.parse(dependentWhileResult.stdout) as { requirements: Array<{ text: string }> };
    assert.deepEqual(dependentWhileRequest.requirements.map(requirement => requirement.text), [dependentWhileGoal]);
    assert.match(dependentWhileResult.stderr, /combined across dependent-clause marker "while"/u);

    const gapCandidates = gapRequest.requirements.map(requirement => requirement.text);
    assert.ok(gapCandidates.some(candidate => candidate.includes('preserve existing login behavior')));
    assert.match(gapResult.stderr, /Unquoted prompt text was not covered by the extractor's exact quotes and has been preserved as additional unresolved candidates:.*preserve existing login behavior/u);
    assert.match(gapResult.stderr, /DRAFT ONLY — NOT PROVEN/u);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('Ollama-assisted draft refuses non-loopback endpoints before writing a request', async () => {
  const root = path.join(TMP, 'ollama-draft-non-loopback');
  fs.mkdirSync(root, { recursive: true });
  const result = await runAsync([
    'prompt-evidence', 'draft', 'Check this task.',
    '--extractor', 'ollama', '--ollama-host', 'http://example.com', '--json',
  ], root);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /only supports an unauthenticated loopback Ollama HTTP origin/u);
  assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
});

it('Ollama criterion suggestions stay outside the request and are tied to exact draft candidates', async () => {
  const root = path.join(TMP, 'ollama-criterion-review');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Implement registration. Validate email input. Hash passwords.';
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push(payload);
      const messages = payload.messages as Array<{ role: string; content: string }>;
      let content: Record<string, unknown>;
      if (requests.length % 2 === 1) content = { quotes: ['Implement registration.', 'Validate email input.', 'Hash passwords.'] };
      else {
        const reviewInput = JSON.parse(messages[1]!.content) as { candidates: Array<{ id: string; text: string }> };
        content = {
          suggestions: reviewInput.candidates.map(candidate => ({
            requirementId: candidate.id,
            criteria: [{
              statement: `An independent check verifies ${candidate.text} with an 8-value case.`,
              evidenceIdea: `A fresh HTTP 400 result for ${candidate.text}.`,
              assumptions: candidate.text.includes('email') ? ['The project defines what counts as a malformed email.'] : [],
            }],
          })),
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'fixture-model', done: true,
        message: { role: 'assistant', content: JSON.stringify(content) },
        prompt_eval_count: 5, eval_count: 4, total_duration: 10_000_000,
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--suggest-criteria', '--model', 'fixture-model',
      '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const review = JSON.parse(result.stdout) as {
      schema: string;
      authority: string;
      verdict: string;
      request: { requirements: Array<{ text: string; clarity: string; criteria: unknown[] }> };
      suggestions: Array<{ requirementId: string; sourceText: string; reviewStatus: string; criteria: Array<{ statement: string; evidenceIdea: string; assumptions: string[]; reviewWarnings: string[] }> }>;
    };
    assert.equal(review.schema, 'amabie-prompt-evidence-review/1');
    assert.equal(review.authority, 'advisory-only');
    assert.equal(review.verdict, 'NOT PROVEN');
    assert.deepEqual(review.request.requirements.map(requirement => requirement.text), ['Implement registration.', 'Validate email input.', 'Hash passwords.']);
    assert.ok(review.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.equal(review.suggestions.length, review.request.requirements.length);
    assert.deepEqual(review.suggestions.map(suggestion => suggestion.sourceText), review.request.requirements.map(requirement => requirement.text));
    assert.ok(review.suggestions.every(suggestion => suggestion.reviewStatus === 'unreviewed' && suggestion.criteria.length === 1));
    assert.ok(review.suggestions.every(suggestion => review.request.requirements.some(requirement => requirement.text === suggestion.sourceText)));
    assert.ok(review.suggestions.find(suggestion => suggestion.sourceText.includes('email'))?.criteria[0]?.assumptions.includes('The project defines what counts as a malformed email.'));
    assert.deepEqual(review.suggestions[0]!.criteria[0]!.reviewWarnings, ['Contains numeric values absent from original task: 8, 400.']);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(payload => payload.model === 'fixture-model' && payload.stream === false && payload.think === false));
    const reviewSystemPrompt = ((requests[1]!.messages as Array<{ content: string }>)[0]!).content;
    assert.match(reviewSystemPrompt, /Never invent thresholds, status codes, algorithms, policies/u);
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
    assert.match(result.stderr, /suggestions are advisory only.*NOT PROVEN/u);
    assert.match(result.stderr, /Extraction call inference: 5 prompt tokens, 4 response tokens, 10 ms/u);
    assert.match(result.stderr, /Criteria suggestion call inference: 5 prompt tokens, 4 response tokens, 10 ms/u);

    const textResult = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--suggest-criteria', '--model', 'fixture-model',
      '--ollama-host', `http://127.0.0.1:${address.port}`,
    ], root);
    assert.equal(textResult.status, 0, textResult.stderr || textResult.stdout);
    assert.match(textResult.stdout, /DRAFT ONLY — NOT PROVEN/u);
    assert.match(textResult.stdout, /Unreviewed criterion idea/u);
    assert.match(textResult.stdout, /Possible evidence \(not collected\)/u);
    assert.match(textResult.stdout, /Assumption to review/u);
    assert.match(textResult.stdout, /Review warning: Contains numeric values absent from original task: 8, 400/u);
    assert.match(textResult.stdout, /Criteria suggestion call inference: 5 prompt tokens, 4 response tokens, 10 ms/u);
    assert.equal(requests.length, 4);
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('Ollama criterion suggestions reject requirement IDs that are not in the exact draft', async () => {
  const root = path.join(TMP, 'ollama-criterion-review-foreign-id');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Validate email input.';
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const extraction = requestsForForeignTest++ === 0;
      const content = extraction ? { quotes: [goal] } : { suggestions: [{ requirementId: 'not-a-real-requirement', criteria: [] }] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'fixture-model', done: true, message: { role: 'assistant', content: JSON.stringify(content) } }));
    });
  });
  let requestsForForeignTest = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--suggest-criteria', '--model', 'fixture-model',
      '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown requirement ID/u);
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('Ollama criterion preview cannot run without opting into the local extractor', () => {
  const root = path.join(TMP, 'criterion-preview-needs-ollama');
  fs.mkdirSync(root, { recursive: true });
  const result = run(['prompt-evidence', 'draft', 'Validate email input.', '--suggest-criteria', '--json'], root);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--suggest-criteria requires --extractor ollama/u);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
});

it('omitted model suggestions stay empty in the review preview and never fill request criteria', async () => {
  const root = path.join(TMP, 'ollama-criterion-review-omitted');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Implement account registration. Validate email input.';
  let call = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      const content = call++ === 0 ? { quotes: ['Implement account registration.', 'Validate email input.'] } : { suggestions: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'fixture-model', done: true, message: { role: 'assistant', content: JSON.stringify(content) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--suggest-criteria', '--model', 'fixture-model',
      '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const review = JSON.parse(result.stdout) as {
      verdict: string;
      request: { requirements: Array<{ criteria: unknown[] }> };
      suggestions: Array<{ criteria: unknown[]; reviewStatus: string }>;
    };
    assert.equal(review.verdict, 'NOT PROVEN');
    assert.ok(review.request.requirements.every(requirement => requirement.criteria.length === 0));
    assert.equal(review.suggestions.length, review.request.requirements.length);
    assert.ok(review.suggestions.every(suggestion => suggestion.criteria.length === 0 && suggestion.reviewStatus === 'unreviewed'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('criterion preview rejects terminal control characters from the local model', async () => {
  const root = path.join(TMP, 'ollama-criterion-review-terminal-control');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Validate email input.';
  let call = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> };
      let content: Record<string, unknown>;
      if (call++ === 0) content = { quotes: [goal] };
      else {
        const reviewInput = JSON.parse(payload.messages[1]!.content) as { candidates: Array<{ id: string }> };
        content = {
          suggestions: [{
            requirementId: reviewInput.candidates[0]!.id,
            criteria: [{ statement: '\u001b[2Jclear terminal', evidenceIdea: 'A test result.', assumptions: [] }],
          }],
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'fixture-model', done: true, message: { role: 'assistant', content: JSON.stringify(content) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--suggest-criteria', '--model', 'fixture-model',
      '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /printable text/u);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('Ollama-assisted draft does not follow redirects from the local endpoint', async () => {
  const root = path.join(TMP, 'ollama-draft-redirect');
  fs.mkdirSync(root, { recursive: true });
  let redirectedRequests = 0;
  const destination = createServer((request, response) => {
    redirectedRequests += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'fixture-model', done: true,
      message: { role: 'assistant', content: JSON.stringify({ quotes: ['Check this task.'] }) },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    destination.once('error', reject);
    destination.listen(0, '127.0.0.1', resolve);
  });
  const destinationAddress = destination.address();
  assert.ok(destinationAddress && typeof destinationAddress !== 'string');
  const redirect = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${destinationAddress.port}/api/chat` });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    redirect.once('error', reject);
    redirect.listen(0, '127.0.0.1', resolve);
  });
  const redirectAddress = redirect.address();
  assert.ok(redirectAddress && typeof redirectAddress !== 'string');
  try {
    const result = await runAsync([
      'prompt-evidence', 'draft', 'Check this task.',
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${redirectAddress.port}`, '--json',
    ], root);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /could not prepare the prompt-evidence draft: fetch failed/u);
    assert.equal(redirectedRequests, 0, 'the redirect target must never receive the prompt');
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
  } finally {
    await Promise.all([redirect, destination].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

it('built-in Codex and Claude profiles launch npm shims through the bounded correction bridge without provider requests', () => {
  for (const agent of ['codex', 'claude'] as const) {
    const project = prepareProject({ includeBindings: 1 }, `builtin-shim-${agent}`);
    const request = writeRequest(project.root, project.goal, project.requirements);
    const shimDir = path.join(TMP, 'provider shims', agent);
    fs.mkdirSync(shimDir, { recursive: true });
    const shimProgram = path.join(shimDir, 'capture-input.mjs');
    const capturedPrompt = path.join(TMP, `${agent}-captured-correction-prompt.txt`);
    fs.writeFileSync(shimProgram, [
      "import fs from 'node:fs';",
      "if (process.argv.includes('--version')) { console.log('2.1.278 (Claude Code)'); process.exit(0); }",
      shimHelpLine(agent),
      ...(agent === 'claude' ? ["if (process.env.CLAUDE_CODE_MAX_TURNS !== '6') process.exit(12);"] : []),
      'fs.writeFileSync(process.argv[2], fs.readFileSync(0, \'utf8\'));',
      "console.log('Done.');",
      '',
    ].join('\n'));

    const shimName = process.platform === 'win32' ? `${agent}.cmd` : agent;
    const shimPath = path.join(shimDir, shimName);
    if (process.platform === 'win32') {
      fs.writeFileSync(shimPath, [
        '@echo off',
        `"${process.execPath}" "${shimProgram}" "${capturedPrompt}" %*`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'));
    } else {
      const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
      fs.writeFileSync(shimPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shimProgram)} ${quote(capturedPrompt)} "$@"\n`);
      fs.chmodSync(shimPath, 0o755);
    }

    // Exclude real provider installations so this transport test cannot spend quota or send a model request.
    const providerExecutables = new Set([
      'codex', 'codex.exe', 'codex.cmd', 'codex.ps1',
      'claude', 'claude.exe', 'claude.cmd', 'claude.ps1',
    ]);
    const safePath = (process.env.PATH ?? '').split(path.delimiter).filter(entry =>
      entry && ![...providerExecutables].some(executable => fs.existsSync(path.join(entry, executable))),
    );
    const env = { ...process.env, PATH: [shimDir, ...safePath].join(path.delimiter) };
    const result = run([
      'prompt-evidence', 'loop', '--request', request, '--agent', agent,
      '--authorize-corrections', '--max-corrections', '1', '--json',
    ], project.root, env);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout) as {
      status: string; correctionAttempts: number; agentClaimUsedAsEvidence: boolean;
      verification: { verdict: string };
    };
    assert.equal(envelope.status, 'correction-blocked');
    assert.equal(envelope.correctionAttempts, 1);
    assert.equal(envelope.verification.verdict, 'NOT PROVEN');
    assert.equal(envelope.agentClaimUsedAsEvidence, false);
    assert.match(fs.readFileSync(capturedPrompt, 'utf8'), /amabie-correction-request\/1/u);
  }
});

for (const agent of ['codex', 'claude'] as const) {
it(`${agent} profile uses the shared correction loop and fresh independent verification through a local shim`, () => {
  const root = path.join(TMP, `${agent}-shim-success-e2e`);
  fs.mkdirSync(root, { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'amabie-test@example.invalid'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Amabie Test'], { cwd: root }).status, 0);

  const requirements = [
    'Registration rejects an invalid email address.',
    'Password storage rejects blank input.',
  ];
  const goal = requirements.join('\n');
  const registrationFile = path.join(root, 'registration.mjs');
  const passwordFile = path.join(root, 'password-policy.mjs');
  fs.writeFileSync(registrationFile, 'export const emailRule = "rejects invalid email";\n');
  fs.writeFileSync(passwordFile, 'export const passwordRule = "rejects blank input";\n');
  const check = path.join(FIXTURES, 'prompt-evidence-source-check.mjs');
  const scripts = {
    test: `node "${check}" registration.mjs "rejects invalid email"`,
    typecheck: `node "${check}" password-policy.mjs "rejects blank input"`,
  };
  const proofs = Object.fromEntries(requirements.map((text, index) => [materialDigest(text), index === 0 ? 'test' : 'typecheck']));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: `${agent}-shim-success-e2e`, scripts, amabie: { proofs } }, null, 2)}\n`);
  assert.equal(spawnSync('git', ['add', 'package.json', 'registration.mjs', 'password-policy.mjs'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0);

  const setup = run(['setup', '--yes'], root);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const task = run(['task', goal, ...requirements.flatMap(text => ['--requirement', text])], root);
  assert.equal(task.status, 0, task.stderr || task.stdout);
  const request = writeRequest(root, goal, requirements, 'Everything is implemented and complete.');
  fs.writeFileSync(passwordFile, 'export const passwordRule = "accepts blank input";\n');

  const initial = run(['doctor', '--prompt-evidence', request, '--json'], root);
  assert.equal(initial.status, 2, initial.stderr || initial.stdout);
  const initialEnvelope = JSON.parse(initial.stdout) as {
    promptEvidence: { verdict: string; coverage: { total: number; met: number; unmet: number } };
  };
  assert.equal(initialEnvelope.promptEvidence.verdict, 'FAIL');
  assert.deepEqual(initialEnvelope.promptEvidence.coverage, { total: 2, met: 1, unmet: 1, unproven: 0, blocked: 0 });

  const shimDir = path.join(TMP, `${agent}-success-shim`);
  fs.mkdirSync(shimDir, { recursive: true });
  const fakeProgram = path.join(shimDir, 'apply-scoped-correction.mjs');
  const capturedPrompt = path.join(TMP, `${agent}-success-captured-prompt.json`);
  fs.writeFileSync(fakeProgram, [
    "import fs from 'node:fs';",
    "if (process.argv.includes('--version')) { console.log('2.1.278 (Claude Code)'); process.exit(0); }",
    shimHelpLine(agent),
    "const input = fs.readFileSync(0, 'utf8');",
    `fs.writeFileSync(${JSON.stringify(capturedPrompt)}, input);`,
    "const request = JSON.parse(input.slice(input.lastIndexOf('\\n\\n') + 2));",
    "if (request.schema !== 'amabie-correction-request/1' || request.cycle !== 1) process.exit(10);",
    `if (request.report.unresolved.length !== 1 || request.report.unresolved[0]?.requirement !== ${JSON.stringify(requirements[1])} || request.report.unresolved[0]?.status !== 'unmet') process.exit(11);`,
    `fs.writeFileSync('password-policy.mjs', ${JSON.stringify('export const passwordRule = "rejects blank input";\n')});`,
    "console.log('Focused correction applied.');",
    '',
  ].join('\n'));

  const shimName = process.platform === 'win32' ? `${agent}.cmd` : agent;
  const shimPath = path.join(shimDir, shimName);
  if (process.platform === 'win32') {
    fs.writeFileSync(shimPath, [
      '@echo off',
      `"${process.execPath}" "${fakeProgram}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
  } else {
    const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeProgram)} "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
  }

  const providerExecutables = new Set([
    'codex', 'codex.exe', 'codex.cmd', 'codex.ps1',
    'claude', 'claude.exe', 'claude.cmd', 'claude.ps1',
  ]);
  const safePath = (process.env.PATH ?? '').split(path.delimiter).filter(entry =>
    entry && ![...providerExecutables].some(executable => fs.existsSync(path.join(entry, executable))),
  );
  const env = { ...process.env, PATH: [shimDir, ...safePath].join(path.delimiter) };
  // Capability preflight: a CLI that does not advertise a required option, or whose help probe fails, stops before any correction request.
  const workingProgram = fs.readFileSync(fakeProgram, 'utf8');
  const [firstFlag] = AGENT_HELP_PROBES[agent].flags;
  const deficientHelp = shimHelpLine(agent).replace(`${firstFlag} `, '');
  const brokenHelp = shimHelpLine(agent).replace('process.exit(0)', 'process.exit(7)');
  for (const [variant, expected] of [[deficientHelp, /does not advertise required option.*--/u], [brokenHelp, /capability preflight exited 7/u]] as const) {
    fs.writeFileSync(fakeProgram, workingProgram.replace(shimHelpLine(agent), variant));
    const blocked = run([
      'prompt-evidence', 'loop', '--request', request, '--agent', agent,
      '--authorize-corrections', '--max-corrections', '1', '--json',
    ], root, { ...process.env, PATH: [shimDir, ...safePath].join(path.delimiter) });
    assert.notEqual(blocked.status, 0, blocked.stdout);
    assert.match(blocked.stdout + blocked.stderr, expected);
    assert.equal(fs.existsSync(capturedPrompt), false, 'no correction request may be sent after a failed capability preflight');
  }
  fs.writeFileSync(fakeProgram, workingProgram);
  const result = run([
    'prompt-evidence', 'loop', '--request', request, '--agent', agent,
    '--authorize-corrections', '--max-corrections', '1', '--json',
  ], root, env);
  const captured = fs.existsSync(capturedPrompt) ? fs.readFileSync(capturedPrompt, 'utf8') : `<fake ${agent} process was not reached>`;
  assert.equal(result.status, 0, result.stderr + result.stdout + `\nFake ${agent} input: ` + captured);

  const envelope = JSON.parse(result.stdout) as {
    status: string; correctionAttempts: number; agentClaimUsedAsEvidence: boolean; candidate: { path: string };
    verification: { verdict: string; coverage: { total: number; met: number; unmet: number }; evidence: Array<{ provenance: string }> };
  };
  assert.equal(envelope.status, 'verified');
  assert.equal(envelope.correctionAttempts, 1);
  assert.equal(envelope.verification.verdict, 'PASS');
  assert.deepEqual(envelope.verification.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  assert.ok(envelope.verification.evidence.every(evidence => evidence.provenance === 'verifier-collected'));
  assert.equal(envelope.agentClaimUsedAsEvidence, false);
  const capturedText = fs.readFileSync(capturedPrompt, 'utf8');
  const sent = JSON.parse(capturedText.slice(capturedText.lastIndexOf('\n\n') + 2)) as {
    schema: string; cycle: number; report: { unresolved: Array<{ requirement: string; status: string; criteria: Array<{
      criterionId: string; statement: string; adapterId: string; evidenceType: string;
      predicate: { path: string; equals: boolean }; status: string; gap: string;
    }> }> };
  };
  assert.equal(sent.schema, 'amabie-correction-request/1');
  assert.equal(sent.cycle, 1);
  assert.deepEqual(sent.report.unresolved.map(({ requirement, status }) => ({ requirement, status })), [
    { requirement: requirements[1], status: 'unmet' },
  ]);
  const registered = JSON.parse(fs.readFileSync(path.join(root, request), 'utf8')) as {
    requirements: Array<{ criteria: Array<{ statement: string; adapterId: string; evidenceType: string; predicate: { path: string; equals: boolean } }> }>;
  };
  assert.deepEqual(sent.report.unresolved[0]?.criteria.map(({ statement, adapterId, evidenceType, predicate, status }) => ({
    statement, adapterId, evidenceType, predicate, status,
  })), [{
    ...registered.requirements[1]!.criteria[0]!,
    status: 'unmet',
  }]);
  assert.ok(sent.report.unresolved[0]?.criteria[0]?.gap);
  // The correction lands in the disposable candidate; nothing is silently adopted into the project.
  assert.match(fs.readFileSync(path.join(envelope.candidate.path, 'password-policy.mjs'), 'utf8'), /rejects blank input/u);
  assert.match(fs.readFileSync(passwordFile, 'utf8'), /accepts blank input/u);
});
}

it('experimental correction loop scopes a separate agent process to unresolved evidence and verifies fresh checks', () => {
  const root = path.join(TMP, 'correction-loop-e2e');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'amabie-test@example.invalid'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Amabie Test'], { cwd: root }).status, 0);

  const requirements = [
    'Registration rejects an invalid email address.',
    'Password storage rejects blank input.',
  ];
  const goal = requirements.join('\n');
  const registrationFile = path.join(root, 'registration.mjs');
  const passwordFile = path.join(root, 'password-policy.mjs');
  fs.writeFileSync(registrationFile, 'export const emailRule = "rejects invalid email";\n');
  fs.writeFileSync(passwordFile, 'export const passwordRule = "rejects blank input";\n');
  const check = path.join(FIXTURES, 'prompt-evidence-source-check.mjs');
  const scripts = {
    test: `node "${check}" registration.mjs "rejects invalid email"`,
    typecheck: `node "${check}" password-policy.mjs "rejects blank input"`,
  };
  const proofs = Object.fromEntries(requirements.map((text, index) => [materialDigest(text), index === 0 ? 'test' : 'typecheck']));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'correction-loop-e2e', scripts, amabie: { proofs } }, null, 2)}\n`);
  assert.equal(spawnSync('git', ['add', 'package.json', 'registration.mjs', 'password-policy.mjs'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0);

  const setup = run(['setup', '--yes'], root);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const task = run(['task', goal, ...requirements.flatMap(text => ['--requirement', text])], root);
  assert.equal(task.status, 0, task.stderr || task.stdout);
  const request = writeRequest(root, goal, requirements);

  // A separate first-attempt agent process creates a candidate that misses one requirement, then claims completion.
  const agent = path.join(FIXTURES, 'prompt-evidence-fixture-agent.mjs');
  const initialAgent = spawnSync(process.execPath, [agent, passwordFile, '', '', 'initial-false-done'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
    input: JSON.stringify({ schema: 'amabie-agent-task/1', goal: { taskType: 'coding', text: goal }, requirements }),
  });
  assert.equal(initialAgent.status, 0, initialAgent.stderr || initialAgent.stdout);
  assert.match(initialAgent.stdout, /Everything is done/u);
  assert.match(fs.readFileSync(passwordFile, 'utf8'), /accepts blank input/u);
  const initialVerification = run(['doctor', '--prompt-evidence', request, '--json'], root);
  assert.equal(initialVerification.status, 2, initialVerification.stderr || initialVerification.stdout);
  const initialEnvelope = JSON.parse(initialVerification.stdout) as {
    promptEvidence: { verdict: string; requirements: Array<{ status: string }>; coverage: { met: number; unmet: number } };
  };
  assert.equal(initialEnvelope.promptEvidence.verdict, 'FAIL');
  assert.deepEqual(initialEnvelope.promptEvidence.requirements.map(requirement => requirement.status), ['met', 'unmet']);
  assert.deepEqual(initialEnvelope.promptEvidence.coverage, { total: 2, met: 1, unmet: 1, unproven: 0, blocked: 0 });

  const agentReportFile = path.join(TMP, 'agent-received-report.json');
  const denied = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', agent,
    '--agent-arg', 'password-policy.mjs',
    '--agent-arg', requirements[1]!,
    '--agent-arg', agentReportFile,
    '--json',
  ], root);
  assert.equal(denied.status, 3);
  assert.equal(fs.existsSync(agentReportFile), false, 'the agent is not started without explicit correction authorization');

  const result = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', agent,
    '--agent-arg', 'password-policy.mjs',
    '--agent-arg', requirements[1]!,
    '--agent-arg', agentReportFile,
    '--authorize-corrections', '--json',
  ], root);
  assert.match(result.stderr, /The correction agent edits a disposable candidate worktree, not this project/u);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const envelope = JSON.parse(result.stdout) as {
    schema: string; status: string; correctionAttempts: number; candidate: { path: string };
    verification: { verdict: string; attempt: number; coverage: { total: number; met: number }; requirements: Array<{ status: string }>; evidence: Array<{ facts: Record<string, unknown> }> };
  };
  assert.equal(envelope.schema, 'amabie-prompt-evidence-loop/1');
  assert.equal(envelope.status, 'verified');
  assert.equal(envelope.correctionAttempts, 1);
  assert.equal(envelope.verification.verdict, 'PASS');
  assert.equal(envelope.verification.attempt, 1);
  assert.deepEqual(envelope.verification.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  assert.deepEqual(envelope.verification.requirements.map(requirement => requirement.status), ['met', 'met']);
  assert.ok(envelope.verification.evidence.every(evidence => typeof evidence.facts.runId === 'string' && typeof evidence.facts.planDigest === 'string'));
  const sent = JSON.parse(fs.readFileSync(agentReportFile, 'utf8')) as { schema: string; cycle: number; report: { unresolved: Array<{ requirement: string; status: string }> } };
  assert.equal(sent.schema, 'amabie-correction-request/1');
  assert.equal(sent.cycle, 1);
  assert.deepEqual(sent.report.unresolved.map(({ requirement, status }) => ({ requirement, status })), [
    { requirement: requirements[1], status: 'unmet' },
  ]);
  // The correction landed in the disposable candidate; the project itself is untouched.
  assert.match(fs.readFileSync(path.join(envelope.candidate.path, 'password-policy.mjs'), 'utf8'), /rejects blank input/u);
  assert.match(fs.readFileSync(passwordFile, 'utf8'), /accepts blank input/u);

  // A second agent process only claims completion and exits successfully; no workspace change means no re-verification PASS.
  fs.writeFileSync(passwordFile, 'export const passwordRule = "accepts blank input";\n');
  const stalledReport = path.join(TMP, 'claim-only-report.json');
  const stalled = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', agent,
    '--agent-arg', 'password-policy.mjs',
    '--agent-arg', requirements[1]!,
    '--agent-arg', stalledReport,
    '--agent-arg', 'claim-only',
    '--authorize-corrections', '--json',
  ], root);
  assert.equal(stalled.status, 2, stalled.stderr || stalled.stdout);
  const stalledEnvelope = JSON.parse(stalled.stdout) as { status: string; correctionAttempts: number; verification: { verdict: string; attempt: number }; agentClaimUsedAsEvidence: boolean };
  assert.equal(stalledEnvelope.status, 'correction-blocked');
  assert.equal(stalledEnvelope.correctionAttempts, 1);
  assert.equal(stalledEnvelope.verification.verdict, 'FAIL');
  assert.equal(stalledEnvelope.verification.attempt, 0);
  assert.equal(stalledEnvelope.agentClaimUsedAsEvidence, false);
  assert.match(fs.readFileSync(passwordFile, 'utf8'), /accepts blank input/u);

  const maxTurnsText = 'Maximum turns reached.';
  const maxTurnsAgent = path.join(TMP, 'agent-max-turns.mjs');
  fs.writeFileSync(maxTurnsAgent, `process.stderr.write(${JSON.stringify(maxTurnsText)}); process.exit(1);\n`);
  const maxTurns = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', maxTurnsAgent,
    '--authorize-corrections', '--max-corrections', '1', '--json',
  ], root);
  assert.equal(maxTurns.status, 2, maxTurns.stderr || maxTurns.stdout);
  const maxTurnsEnvelope = JSON.parse(maxTurns.stdout) as {
    status: string;
    stopReason: string;
    agentProcessDiagnostics: Array<{
      cycle: number;
      exitCode: number | null;
      stdoutBytes: number;
      stderrBytes: number;
      diagnosticHint: string;
    }>;
  };
  assert.equal(maxTurnsEnvelope.status, 'correction-blocked');
  assert.match(maxTurnsEnvelope.stopReason, /correction agent exited 1/u);
  assert.deepEqual(maxTurnsEnvelope.agentProcessDiagnostics, [{
    cycle: 1,
    exitCode: 1,
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(maxTurnsText),
    diagnosticHint: 'turn-limit',
  }]);
  assert.doesNotMatch(maxTurns.stdout, /Maximum turns reached/u);

  // An agent can make unrelated Git-visible changes on every cycle; the actual process bridge must still stop at its hard limit.
  const persistentReport = path.join(TMP, 'persistent-unresolved-report.json');
  const persistent = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', agent,
    '--agent-arg', 'password-policy.mjs',
    '--agent-arg', requirements[1]!,
    '--agent-arg', persistentReport,
    '--agent-arg', 'persistent-unresolved',
    '--authorize-corrections', '--json',
  ], root);
  assert.equal(persistent.status, 2, persistent.stderr || persistent.stdout);
  const persistentEnvelope = JSON.parse(persistent.stdout) as {
    status: string; correctionAttempts: number; agentClaimUsedAsEvidence: boolean; candidate: { path: string };
    verification: { verdict: string; attempt: number; coverage: { met: number; unmet: number } };
  };
  assert.equal(persistentEnvelope.status, 'limit-reached');
  assert.equal(persistentEnvelope.correctionAttempts, 3);
  assert.equal(persistentEnvelope.verification.verdict, 'FAIL');
  assert.equal(persistentEnvelope.verification.attempt, 3);
  assert.deepEqual(persistentEnvelope.verification.coverage, { total: 2, met: 1, unmet: 1, unproven: 0, blocked: 0 });
  assert.equal(persistentEnvelope.agentClaimUsedAsEvidence, false);
  assert.equal(fs.readFileSync(path.join(persistentEnvelope.candidate.path, 'password-policy.mjs.attempts'), 'utf8'), '3');
  const finalCorrectionRequest = JSON.parse(fs.readFileSync(persistentReport, 'utf8')) as { cycle: number };
  assert.equal(finalCorrectionRequest.cycle, 3);

  const cappedReport = path.join(TMP, 'single-cycle-report.json');
  const capped = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', agent,
    '--agent-arg', 'password-policy.mjs',
    '--agent-arg', requirements[1]! ,
    '--agent-arg', cappedReport,
    '--agent-arg', 'persistent-unresolved',
    '--authorize-corrections', '--max-corrections', '1', '--json',
  ], root);
  assert.equal(capped.status, 2, capped.stderr || capped.stdout);
  const cappedEnvelope = JSON.parse(capped.stdout) as {
    status: string; correctionAttempts: number; candidate: { path: string }; verification: { verdict: string; attempt: number };
  };
  assert.equal(cappedEnvelope.status, 'limit-reached');
  assert.equal(cappedEnvelope.correctionAttempts, 1);
  assert.equal(cappedEnvelope.verification.verdict, 'FAIL');
  assert.equal(cappedEnvelope.verification.attempt, 1);
  assert.equal(fs.readFileSync(path.join(cappedEnvelope.candidate.path, 'password-policy.mjs.attempts'), 'utf8'), '1');
  const singleCycleRequest = JSON.parse(fs.readFileSync(cappedReport, 'utf8')) as { cycle: number };
  assert.equal(singleCycleRequest.cycle, 1);

  const scopeChanged = run([
    'prompt-evidence', 'loop', '--request', request,
    '--agent-executable', process.execPath,
    '--agent-arg', agent,
    '--agent-arg', path.join(root, request),
    '--agent-arg', requirements[1]!,
    '--agent-arg', path.join(TMP, 'scope-change-report.json'),
    '--agent-arg', 'scope-change',
    '--authorize-corrections', '--json',
  ], root);
  assert.equal(scopeChanged.status, 2, scopeChanged.stderr || scopeChanged.stdout);
  const scopeEnvelope = JSON.parse(scopeChanged.stdout) as { status: string; correctionAttempts: number; verification: { verdict: string; attempt: number } };
  assert.equal(scopeEnvelope.status, 'scope-change-blocked');
  assert.equal(scopeEnvelope.correctionAttempts, 1);
  assert.equal(scopeEnvelope.verification.verdict, 'FAIL');
  assert.equal(scopeEnvelope.verification.attempt, 0, 'a changed request scope must stop before re-verification');
});

it('doctor rejects a request whose task domain differs from the registered coding task', () => {
  const project = prepareProject({ includeBindings: 2 }, 'task-domain-mismatch');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const absoluteRequest = path.join(project.root, request);
  const data = JSON.parse(fs.readFileSync(absoluteRequest, 'utf8')) as { goal: { taskType: string } };
  data.goal.taskType = 'document';
  fs.writeFileSync(absoluteRequest, `${JSON.stringify(data, null, 2)}\n`);

  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 3);
  const envelope = JSON.parse(result.stdout) as { status: string; problems?: string[] };
  assert.equal(envelope.status, 'NEEDS ATTENTION');
  assert.match(envelope.problems?.join(' ') ?? '', /task type does not match/u);
});

it('Scenario B/C: green checks and an agent done claim do not cover an unbound requirement', () => {
  const project = prepareProject({ includeBindings: 1 }, 'scenario-b');
  const request = writeRequest(project.root, project.goal, project.requirements, 'All requirements are complete.');
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout) as { status: string; promptEvidence?: { verdict: string; requirements: Array<{ status: string; criteria: Array<{ note: string }> }> } };
  assert.equal(envelope.status, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.verdict, 'NOT PROVEN');
  assert.deepEqual(envelope.promptEvidence?.requirements.map(r => r.status), ['met', 'unproven']);
  assert.match(envelope.promptEvidence?.requirements[1]?.criteria[0]?.note ?? '', /no operator-sealed proof binding/u);
});

it('a green check cannot hide original-goal text omitted from the registered requirement set', () => {
  const project = makeProject('unmapped-goal', { includeBindings: 1 });
  const setup = run(['setup', '--yes'], project.root);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const task = run(['task', project.goal, '--requirement', project.requirements[0]!], project.root);
  assert.equal(task.status, 0, task.stderr || task.stdout);
  const request = writeRequest(project.root, project.goal, [project.requirements[0]!]);
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout) as { status: string; promptEvidence?: { verdict: string; sourceCoverage: { complete: boolean }; issues: string[] } };
  assert.equal(envelope.status, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.verdict, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.sourceCoverage.complete, false);
  assert.match(envelope.promptEvidence?.issues.join(' ') ?? '', /uncovered non-whitespace/u);
});

it('Scenario D: a failing sealed check shared by two requirements blocks completion but refutes neither', () => {
  const project = prepareProject({ fixture: 'f-controlled.js', includeBindings: 2 }, 'scenario-d');
  fs.writeFileSync(path.join(project.root, '.amabie', 'controlled-failure'), 'fail');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout) as { status: string; promptEvidence?: { verdict: string; coverage: { unmet: number; unproven: number } } };
  assert.equal(envelope.status, 'NEEDS ATTENTION');
  // One sealed check run reports one outcome for both requirements, so neither is individually refuted (P1:23).
  assert.equal(envelope.promptEvidence?.verdict, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.coverage.unmet, 0);
  assert.equal(envelope.promptEvidence?.coverage.unproven, 2);
});

it('Scenario E: a failed password-policy check is FAIL, while a green unbound check remains NOT PROVEN', () => {
  const makeSecurityCase = (name: string, bindProof: boolean, source: string) => {
    const root = path.join(TMP, name);
    fs.mkdirSync(root, { recursive: true });
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'amabie-test@example.invalid'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Amabie Test'], { cwd: root }).status, 0);

    const requirement = 'The password policy rejects passwords shorter than 12 characters.';
    const candidate = path.join(root, 'password-policy.mjs');
    const check = path.join(FIXTURES, 'prompt-evidence-password-policy-check.mjs');
    const safeBaseline = 'export function isPasswordAllowed(value) { return typeof value === "string" && value.length >= 12; }\n';
    fs.writeFileSync(candidate, safeBaseline);
    const proofs = bindProof ? { [materialDigest(requirement)]: 'test' } : {};
    const testCommand = `node "${check}" "${candidate}"`;
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
      name,
      scripts: { test: testCommand },
      amabie: { proofs },
    }, null, 2)}\n`);
    assert.equal(spawnSync('git', ['add', 'package.json', 'password-policy.mjs'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0);

    const setup = run(['setup', '--yes'], root);
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    const task = run(['task', requirement, '--requirement', requirement], root);
    assert.equal(task.status, 0, task.stderr || task.stdout);
    const request = writeRequest(root, requirement, [requirement], 'All password security requirements are satisfied.');
    if (source !== safeBaseline) fs.writeFileSync(candidate, source);
    return { root, request };
  };

  const insecure = makeSecurityCase(
    'scenario-e-security-fail',
    true,
    'export function isPasswordAllowed(value) { return typeof value === "string" && value.length > 0; }\n',
  );
  const failedCheck = run(['doctor', '--prompt-evidence', insecure.request, '--json'], insecure.root);
  assert.equal(failedCheck.status, 2, failedCheck.stderr || failedCheck.stdout);
  const failed = JSON.parse(failedCheck.stdout) as {
    status: string;
    promptEvidence: { verdict: string; coverage: { unmet: number }; requirements: Array<{ status: string }> };
  };
  assert.equal(failed.promptEvidence.verdict, 'FAIL');
  assert.equal(failed.promptEvidence.coverage.unmet, 1);
  assert.deepEqual(failed.promptEvidence.requirements.map(requirement => requirement.status), ['unmet']);

  const passing = makeSecurityCase(
    'scenario-e-security-unproven',
    false,
    'export function isPasswordAllowed(value) { return typeof value === "string" && value.length >= 12; }\n',
  );
  const greenButUnbound = run(['doctor', '--prompt-evidence', passing.request, '--json'], passing.root);
  assert.equal(greenButUnbound.status, 2, greenButUnbound.stderr || greenButUnbound.stdout);
  const unproven = JSON.parse(greenButUnbound.stdout) as {
    status: string;
    promptEvidence: { verdict: string; coverage: { unproven: number }; requirements: Array<{ status: string; criteria: Array<{ note: string }> }> };
  };
  assert.equal(unproven.status, 'NOT PROVEN');
  assert.equal(unproven.promptEvidence.verdict, 'NOT PROVEN');
  assert.equal(unproven.promptEvidence.coverage.unproven, 1);
  assert.deepEqual(unproven.promptEvidence.requirements.map(requirement => requirement.status), ['unproven']);
  assert.match(unproven.promptEvidence.requirements[0]?.criteria[0]?.note ?? '', /no operator-sealed proof binding/u);
});

it('the command refuses selected-check and fast paths that cannot establish full requirement coverage', () => {
  const project = prepareProject({ includeBindings: 2 }, 'no-partial');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const partial = run(['doctor', '--prompt-evidence', request, '--check', 'tests'], project.root);
  assert.equal(partial.status, 3);
  assert.match(partial.stdout, /cannot be combined with --check/u);
  const fast = run(['doctor', '--prompt-evidence', request, '--fast'], project.root);
  assert.equal(fast.status, 3);
  assert.match(fast.stdout, /cannot be combined with --fast/u);
});

it('Ollama draft preserves compound source clauses when noun-list splitting would create fragments', async () => {
  const root = path.join(TMP, 'ollama-coordinated-components');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Implement user registration with input validation, tests, and secure password storage. Preserve existing login behavior and document the new configuration.';
  const responseQuotes = [
    'Implement user registration with input validation, tests, and secure password storage.',
    'Preserve existing login behavior and document the new configuration.',
  ];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'fixture-model',
        done: true,
        message: { role: 'assistant', content: JSON.stringify({ quotes: responseQuotes }) },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await runAsync([
      'prompt-evidence', 'draft', goal,
      '--extractor', 'ollama', '--model', 'fixture-model', '--ollama-host', `http://127.0.0.1:${address.port}`, '--json',
    ], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const request = JSON.parse(result.stdout) as {
      goal: { text: string };
      requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { focusStart: number; focusEnd: number } }>;
    };
    assert.equal(request.goal.text, goal);
    assert.deepEqual(request.requirements.map(requirement => requirement.text), [
      'Implement user registration with input validation, tests, and secure password storage.',
      'Preserve existing login behavior',
      'document the new configuration.',
    ]);
    assert.ok(request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
    assert.ok(request.requirements.every(requirement => goal.slice(requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd) === requirement.text));
    assert.match(result.stderr, /DRAFT ONLY — NOT PROVEN/u);
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('a correction agent that cannot start, or that writes outside its candidate, ends blocked with no re-verification', () => {
  const project = prepareProject({ includeBindings: 0 }, 'correction-candidate-blocked');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const loop = (...agentArgs: string[]) => run([
    'prompt-evidence', 'loop', '--request', request, '--max-corrections', '1', '--authorize-corrections', '--json', ...agentArgs,
  ], project.root);

  const missing = loop('--agent-executable', path.join(TMP, 'no-such-agent-executable'));
  assert.equal(missing.status, 2, missing.stderr || missing.stdout);
  const missingEnvelope = JSON.parse(missing.stdout) as { status: string; stopReason: string; verification: { attempt: number } };
  assert.equal(missingEnvelope.status, 'correction-blocked');
  assert.match(missingEnvelope.stopReason, /correction agent could not run/u);
  assert.equal(missingEnvelope.verification.attempt, 0);

  const intruder = path.join(project.root, 'intruder.txt');
  const writer = path.join(TMP, 'agent-writes-base.mjs');
  fs.writeFileSync(writer, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(intruder)}, 'x');\n`);
  const escaped = loop('--agent-executable', process.execPath, '--agent-arg', writer);
  assert.equal(escaped.status, 2, escaped.stderr || escaped.stdout);
  const escapedEnvelope = JSON.parse(escaped.stdout) as { status: string; stopReason: string; verification: { attempt: number }; agentClaimUsedAsEvidence: boolean };
  assert.equal(escapedEnvelope.status, 'correction-blocked');
  assert.match(escapedEnvelope.stopReason, /outside its candidate/u);
  assert.equal(escapedEnvelope.verification.attempt, 0);
  assert.equal(escapedEnvelope.agentClaimUsedAsEvidence, false);
});
