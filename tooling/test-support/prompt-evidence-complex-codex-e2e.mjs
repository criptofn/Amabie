import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AGENT_HELP_PROBES } from '../../apps/cli/dist/src/prompt-evidence-agents.js';
import {
  assertProductSourceIdentityMatches,
  collectProductSourceIdentity,
} from './prompt-evidence-source-identity.mjs';

const [mode, suppliedRoot, ...options] = process.argv.slice(2);
const fixtureCorrection = mode === 'correct-fixture';
const shimCorrection = mode === 'correct-shim';
let correctionAgent = fixtureCorrection ? 'fixture' : 'codex';
if (mode !== 'prepare' && mode !== 'correct' && !fixtureCorrection && !shimCorrection) {
  console.error('usage: node tooling/test-support/prompt-evidence-complex-codex-e2e.mjs prepare | correct <temp-root> [--agent codex|claude] | correct-fixture <temp-root> | correct-shim <temp-root> --agent codex|claude');
  process.exit(2);
}
if ((mode === 'prepare' || fixtureCorrection) && options.length > 0) {
  console.error(mode + ' mode does not accept options');
  process.exit(2);
}
if ((mode === 'correct' || shimCorrection) && options.length > 0) {
  if (options.length !== 2 || options[0] !== '--agent' || !['codex', 'claude'].includes(options[1])) {
    console.error('--agent must be codex or claude');
    process.exit(2);
  }
  correctionAgent = options[1];
}
if (shimCorrection && options.length === 0) {
  console.error('correct-shim requires --agent codex or claude');
  process.exit(2);
}
if ((mode === 'correct' || fixtureCorrection || shimCorrection) && !suppliedRoot) {
  console.error('correct mode needs the temp-root printed by prepare mode');
  process.exit(2);
}
if (mode === 'correct') {
  const usageGuard = correctionAgent === 'claude'
    ? 'AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE'
    : 'AMABIE_ALLOW_CODEX_PROVIDER_USAGE';
  if (process.env[usageGuard] !== '1') {
    console.error((correctionAgent === 'claude' ? 'Claude' : 'Codex')
      + ' usage is not started: set ' + usageGuard
      + '=1 only after the operator approves possible provider quota or charges.');
    process.exit(3);
  }
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cliEntry = path.join(repoRoot, 'apps', 'cli', 'dist', 'src', 'main.js');
const fixtureDir = path.join(repoRoot, 'tooling', 'test-support', 'fixtures');
const checker = path.join(fixtureDir, 'prompt-evidence-complex-csv-check.mjs');
const goal = [
  '1. Expose parseTransactions(csv) returning accepted transactions and structured row errors.',
  '2. Require id, date, amount, and description headers.',
  '3. Accept a UTF-8 BOM before the header.',
  '4. Parse quoted fields containing commas and escaped double quotes.',
  '5. Reject rows with missing or blank ids.',
  '6. Reject missing, non-numeric, NaN, and infinite amounts.',
  '7. Include the original one-based physical CSV line number in each row error.',
  '8. Apply first-row-wins semantics to duplicate ids.',
  '9. Compute a signed total from accepted transactions only.',
  '10. Export CSV with correct quoting, formula neutralization, and preservation of ordinary text.',
].join('\n');
const expectedRequirements = [
  'Expose parseTransactions(csv) returning accepted transactions and structured row errors.',
  'Require id, date, amount, and description headers.',
  'Accept a UTF-8 BOM before the header.',
  'Parse quoted fields containing commas and escaped double quotes.',
  'Reject rows with missing or blank ids.',
  'Reject missing, non-numeric, NaN, and infinite amounts.',
  'Include the original one-based physical CSV line number in each row error.',
  'Apply first-row-wins semantics to duplicate ids.',
  'Compute a signed total from accepted transactions only.',
  'Export CSV with correct quoting, formula neutralization, and preservation of ordinary text.',
];
const sentinelKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];
const baseEnv = { ...process.env };
for (const key of sentinelKeys) baseEnv[key] = 'amabie-invalid-sentinel-' + key.toLowerCase();
baseEnv.OPENAI_BASE_URL = 'http://127.0.0.1:1/unused';
baseEnv.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1/unused';

function runSync(executable, args, cwd, env = baseEnv, timeout = 120_000) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error && result.error.code === 'ETIMEDOUT' && result.pid) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(result.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    else {
      try { process.kill(-result.pid, 'SIGKILL'); } catch { /* the process may already have exited */ }
    }
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message };
}

function assertRun(result, expected, label) {
  assert.equal(result.status, expected, label + '\n' + (result.error ?? '') + '\n' + (result.stderr ?? '') + '\n' + (result.stdout ?? ''));
}

function digestRequirement(text) {
  return createHash('sha256').update(text.trim().replace(/\s+/gu, ' '), 'utf8').digest('hex');
}

function workspaceFileDigests(projectRoot) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(projectRoot, fullPath).split(path.sep).join('/');
      if (relative === '.git' || relative.startsWith('.git/')
        || relative === '.amabie' || relative.startsWith('.amabie/')) continue;
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.set(relative, createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex'));
    }
  };
  visit(projectRoot);
  return files;
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function git(args, cwd, env) {
  return runSync('git', args, cwd, env);
}

function sourceGitEnvironment() {
  if (process.platform === 'win32') return baseEnv;
  const gitMarker = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitMarker) || fs.statSync(gitMarker).isDirectory()) return baseEnv;
  const marker = fs.readFileSync(gitMarker, 'utf8');
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(marker)?.[1];
  assert.ok(pointer, 'the source worktree .git file must contain a gitdir pointer');
  let gitDir = pointer;
  if (/^[A-Za-z]:[\\/]/u.test(gitDir)) {
    const translated = runSync('wslpath', ['-u', gitDir], repoRoot, baseEnv, 5_000);
    assertRun(translated, 0, 'translate Windows source gitdir for WSL');
    gitDir = translated.stdout.trim();
  } else if (!path.isAbsolute(gitDir)) {
    gitDir = path.resolve(repoRoot, gitDir);
  }
  return { ...baseEnv, GIT_DIR: gitDir, GIT_WORK_TREE: repoRoot };
}

function currentProductIdentity() {
  const revision = git(['rev-parse', 'HEAD'], repoRoot, sourceGitEnvironment());
  assertRun(revision, 0, 'read Amabie source revision');
  const source = collectProductSourceIdentity(repoRoot);
  const cliEntryPath = 'apps/cli/dist/src/main.js';
  const cliEntry = source.files.find((file) => file.path === cliEntryPath);
  assert.ok(cliEntry, `the built Amabie CLI entry is missing from the source identity: ${cliEntryPath}`);
  return {
    ...source,
    repositoryHead: revision.stdout.trim(),
    nodeVersion: process.version,
    cliEntryPath,
    cliEntrySha256: cliEntry.sha256,
  };
}

function runPackageScript(script, cwd, env) {
  if (process.platform === 'win32') {
    return runSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run ' + script], cwd, env);
  }
  return runSync('npm', ['run', script], cwd, env);
}

function testCommand(group) {
  return 'node "' + checker.split(path.sep).join('/') + '" ' + group;
}

function writeProjectRequest(projectRoot, extracted) {
  const reviewed = {
    ...extracted,
    agentClaim: 'Everything is implemented and complete.',
    requirements: extracted.requirements.map((requirement, index) => ({
      ...requirement,
      clarity: 'clear',
      criteria: [{
        statement: 'A fresh sealed ' + (index < 5 ? 'unit' : 'integration')
          + ' check proves: ' + requirement.text,
        adapterId: 'amabie.coding.sealed-plan',
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    })),
  };
  const requestPath = path.join(projectRoot, '.amabie', 'prompt-evidence.json');
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify(reviewed, null, 2) + '\n');
  return requestPath;
}

function seedFalseDoneCandidate(projectRoot) {
  fs.copyFileSync(path.join(fixtureDir, 'prompt-evidence-complex-csv.false-done.mjs'), path.join(projectRoot, 'transactions.mjs'));
  fs.copyFileSync(path.join(fixtureDir, 'prompt-evidence-complex-legacy.false-done.mjs'), path.join(projectRoot, 'legacy.mjs'));
  return {
    claim: 'Everything is implemented and complete.',
    controlledOmissions: [
      'Reject invalid and non-finite amounts',
      'Preserve physical line numbers across quoted newlines',
      'Reject duplicate transaction ids',
      'Compute totals over accepted rows only',
      'Neutralize formula-leading CSV fields',
    ],
    injectedRegression: 'The legacy signed-total function now applies Math.abs to negative amounts.',
    source: 'deterministic false-done fixture; the correction agent is selected in the separate correct phase',
  };
}

async function runBounded(executable, args, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let received = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let timer;
    let closeTimer;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputExceeded,
        error,
      });
    };
    const terminate = (reason) => {
      if (reason === 'timeout') timedOut = true;
      else outputExceeded = true;
      if (child.pid && process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process may have exited */ }
      } else {
        child.kill('SIGKILL');
      }
      closeTimer = setTimeout(() => finish(null, reason + ' termination did not close the process'), 3_000);
    };
    const collect = (target, chunk) => {
      if (settled || timedOut || outputExceeded) return;
      received += chunk.length;
      if (received > 16 * 1024 * 1024) { terminate('output-limit'); return; }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => {
      collect(stderr, chunk);
      if (!settled) process.stderr.write(chunk);
    });
    child.once('error', (error) => finish(null, error.message));
    child.once('close', (code) => finish(code));
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
  });
}

function makeIsolatedEnv(tempRoot, agentShimDir) {
  const env = {
    ...baseEnv,
    AMABIE_TRUST_STORE: path.join(tempRoot, 'isolated-authority-store'),
  };
  if (agentShimDir) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = [agentShimDir, env[pathKey] ?? ''].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function installLocalAgentShim(tempRoot, agent) {
  const shimDir = path.join(tempRoot, 'agent-shim-bin');
  const capturePath = path.join(tempRoot, 'agent-shim-calls.jsonl');
  const shimProgram = path.join(tempRoot, 'agent-shim.mjs');
  const fixtureCorrector = path.join(fixtureDir, 'prompt-evidence-complex-fixture-corrector.mjs');
  fs.mkdirSync(shimDir, { recursive: true });
  const program = [
    "import { spawnSync } from 'node:child_process';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `const expectedAgent = ${JSON.stringify(agent)};`,
    `const capturePath = ${JSON.stringify(capturePath)};`,
    `const fixtureCorrector = ${JSON.stringify(fixtureCorrector)};`,
    'const [actualAgent, ...args] = process.argv.slice(2);',
    "const record = (event) => fs.appendFileSync(capturePath, JSON.stringify(event) + '\\n');",
    "if (actualAgent !== expectedAgent) { console.error('unexpected shim profile'); process.exit(20); }",
    `if (args.includes('--help')) { console.log(${JSON.stringify(AGENT_HELP_PROBES[agent].flags.join(' '))}); process.exit(0); }`,
    "if (actualAgent === 'claude' && args.length === 1 && args[0] === '--version') {",
    "  record({ kind: 'version', agent: actualAgent });",
    "  console.log('2.1.278 (Claude Code)');",
    '  process.exit(0);',
    '}',
    "const prompt = fs.readFileSync(0, 'utf8');",
    "const marker = prompt.lastIndexOf('\\n\\n');",
    "if (marker < 0) { console.error('correction prompt did not end with structured JSON'); process.exit(21); }",
    'let request;',
    'try { request = JSON.parse(prompt.slice(marker + 2)); } catch { console.error(\'correction request is not JSON\'); process.exit(22); }',
    "if (request?.schema !== 'amabie-correction-request/1' || request?.cycle !== 1) { console.error('unexpected correction request envelope'); process.exit(23); }",
    "const registered = JSON.parse(fs.readFileSync(path.join(process.cwd(), '..', '..', 'prompt-evidence.json'), 'utf8'));",
    'const unresolved = request.report?.unresolved;',
    "const criterionEntries = Array.isArray(unresolved) ? unresolved.flatMap((item) => Array.isArray(item?.criteria) ? item.criteria.map((criterion) => ({ item, criterion })) : []) : [];",
    "const criteriaContractsMatchRequest = request.report?.schema === 'amabie-correction-report/3' && Array.isArray(unresolved) && unresolved.every((item) => { const declaration = registered.requirements.find((requirement) => requirement.text === item.requirement); return Boolean(declaration) && item.status === 'unmet' && item.criteria.length === declaration.criteria.length && item.criteria.every((criterion) => typeof criterion.criterionId === 'string' && criterion.status === 'unmet' && typeof criterion.gap === 'string' && criterion.gap.length > 0 && declaration.criteria.some((expected) => expected.statement === criterion.statement && expected.adapterId === criterion.adapterId && expected.evidenceType === criterion.evidenceType && expected.predicate.path === criterion.predicate?.path && JSON.stringify(expected.predicate.equals) === JSON.stringify(criterion.predicate?.equals))); });",
    "const refusalContractMatchesRequest = request.report?.schema === 'amabie-correction-report/3' && Array.isArray(unresolved) && unresolved.length === registered.requirements.length && unresolved.every((item) => { const declaration = registered.requirements.find((requirement) => requirement.text === item.requirement); return Boolean(declaration) && item.status === 'unproven' && Array.isArray(item.criteria) && item.criteria.length === declaration.criteria.length && item.criteria.every((criterion) => criterion.status === 'unproven'); });",
    "const evidenceFactsIncluded = Array.isArray(unresolved) && unresolved.some((item) => Object.hasOwn(item, 'evidence') || item.criteria.some((criterion) => Object.hasOwn(criterion, 'facts') || Object.hasOwn(criterion, 'evidence')));",
    "record({ kind: 'correction', agent: actualAgent, arguments: args.map((value) => value === process.cwd() ? '<project>' : value), requestSchema: request.schema, reportSchema: request.report?.schema ?? null, cycle: request.cycle, unresolvedCount: unresolved?.length ?? null, unresolvedCriterionCount: criterionEntries.length, criteriaContractsMatchRequest, refusalContractMatchesRequest, evidenceFactsIncluded });",
    'const applied = spawnSync(process.execPath, [fixtureCorrector], { cwd: process.cwd(), input: JSON.stringify(request), encoding: \'utf8\', windowsHide: true, maxBuffer: 1024 * 1024 });',
    "if (applied.stdout) process.stdout.write(applied.stdout);",
    "if (applied.stderr) process.stderr.write(applied.stderr);",
    'process.exit(applied.status ?? 1);',
    '',
  ].join('\n');
  fs.writeFileSync(shimProgram, program);
  const shimName = process.platform === 'win32' ? `${agent}.cmd` : agent;
  const shimPath = path.join(shimDir, shimName);
  if (process.platform === 'win32') {
    fs.writeFileSync(shimPath, [
      '@echo off',
      `"${process.execPath}" "${shimProgram}" ${agent} %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));
  } else {
    const quote = (value) => `'${value.replace(/'/gu, "'\\''")}'`;
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shimProgram)} ${agent} "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
  }
  return { shimDir, capturePath };
}

function persistManifest(tempRoot, manifest, suffix) {
  const tempManifest = path.join(tempRoot, 'manifest.json');
  fs.writeFileSync(tempManifest, JSON.stringify(manifest, null, 2) + '\n');
  const agent = manifest.correction?.agent ?? correctionAgent;
  const artifactDir = path.resolve(repoRoot, '..', '..', 'release-logs', shimCorrection
    ? 'p2e-complex-agent-shim-e2e-2026-10-16'
    : `p2e-complex-${agent}-2026-10-15`);
  fs.mkdirSync(artifactDir, { recursive: true });
  const name = suffix + '-' + path.basename(tempRoot) + '.json';
  const destination = path.join(artifactDir, name);
  fs.copyFileSync(tempManifest, destination);
  fs.writeFileSync(destination + '.sha256', createHash('sha256').update(fs.readFileSync(destination)).digest('hex') + '  ' + name + '\n');
}

function safeDiagnostic(text) {
  return text
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu, '[redacted-token]')
    .slice(-32_000);
}

async function prepare() {
  assert.ok(fs.existsSync(cliEntry), 'run npm run build:force before this explicit E2E');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-codex-complex-p2e-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const env = makeIsolatedEnv(tempRoot);

  console.error('[complex-e2e] Extracting ten source-linked requirements.');
  const draft = runSync(process.execPath, [cliEntry, 'prompt-evidence', 'draft', goal, '--json'], projectRoot, env);
  assertRun(draft, 0, 'draft generation');
  const extracted = JSON.parse(draft.stdout);
  assert.deepEqual(extracted.requirements.map((requirement) => requirement.text), expectedRequirements);
  assert.equal(extracted.requirements.length, 10);
  for (const requirement of extracted.requirements) {
    const { focusStart, focusEnd } = requirement.sourceRef;
    assert.equal(goal.slice(focusStart, focusEnd), requirement.text, 'each candidate must retain an exact prompt span');
  }
  const sourceMap = /Source text mapped: (\d+)\/(\d+) non-whitespace characters/u.exec(draft.stderr);
  assert.ok(sourceMap, 'the CLI must report source mapping coverage');
  assert.equal(sourceMap[1], sourceMap[2], 'all non-whitespace prompt text must be mapped');
  const sourceCoverage = {
    mappedNonWhitespaceCharacters: Number(sourceMap[1]),
    nonWhitespaceCharacters: Number(sourceMap[2]),
    complete: true,
  };
  assert.ok(extracted.requirements.every((requirement) => requirement.clarity === 'unclear' && requirement.criteria.length === 0));

  fs.copyFileSync(path.join(fixtureDir, 'prompt-evidence-complex-csv.baseline.mjs'), path.join(projectRoot, 'transactions.mjs'));
  fs.copyFileSync(path.join(fixtureDir, 'prompt-evidence-complex-legacy.baseline.mjs'), path.join(projectRoot, 'legacy.mjs'));
  fs.writeFileSync(path.join(projectRoot, 'README.md'), [
    '# Transaction CSV module',
    '',
    'The local API is in transactions.mjs. parseTransactions returns { transactions, errors }.',
    'Errors carry a one-based physical lineNumber and a stable code. Amounts are finite numbers.',
    'Duplicate ids use first-row-wins semantics. The old sumLegacyAmounts API remains signed.',
    'exportTransactions returns CSV and neutralizes formula-leading text fields.',
    '',
  ].join('\n'));
  const proofs = Object.fromEntries(expectedRequirements.map((text, index) => [
    digestRequirement(text),
    index < 5 ? 'test' : 'e2e',
  ]));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'amabie-complex-csv-p2e-e2e',
    private: true,
    type: 'module',
    scripts: { test: testCommand('unit'), e2e: testCommand('e2e') },
    amabie: { proofs },
  }, null, 2) + '\n');

  assertRun(git(['init', '--quiet'], projectRoot), 0, 'initialize isolated project');
  assertRun(git(['config', 'user.email', 'amabie-test@example.invalid'], projectRoot), 0, 'set isolated commit identity');
  assertRun(git(['config', 'user.name', 'Amabie Complex E2E'], projectRoot), 0, 'set isolated commit identity');
  assertRun(git(['add', '--all'], projectRoot), 0, 'stage trusted baseline');
  assertRun(git(['commit', '--quiet', '-m', 'trusted transaction importer baseline'], projectRoot), 0, 'commit trusted baseline');

  console.error('[complex-e2e] Confirming both baseline check groups pass before the candidate is changed.');
  assertRun(runPackageScript('test', projectRoot, env), 0, 'baseline unit checks');
  assertRun(runPackageScript('e2e', projectRoot, env), 0, 'baseline integration checks');

  console.error('[complex-e2e] Sealing the project plan and the ten reviewed requirement bindings.');
  assertRun(runSync(process.execPath, [cliEntry, 'setup', '--yes'], projectRoot, env), 0, 'Amabie setup');
  assertRun(runSync(process.execPath, [cliEntry, 'task', goal,
    ...expectedRequirements.flatMap((text) => ['--requirement', text])], projectRoot, env), 0, 'register original task');
  const requestPath = writeProjectRequest(projectRoot, extracted);
  const falseDone = seedFalseDoneCandidate(projectRoot);
  // Corrections run in a disposable candidate cut from the committed base, so the false-done work must be committed.
  assertRun(git(['add', 'transactions.mjs', 'legacy.mjs'], projectRoot), 0, 'stage false-done candidate');
  assertRun(git(['commit', '--quiet', '-m', 'agent false-done candidate'], projectRoot), 0, 'commit false-done candidate');

  console.error('[complex-e2e] Running independent verification against the false-done candidate.');
  const initial = runSync(process.execPath, [cliEntry, 'doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json'], projectRoot, env);
  assertRun(initial, 2, 'Amabie must reject the incomplete candidate');
  const initialEnvelope = JSON.parse(initial.stdout);
  assert.equal(initialEnvelope.promptEvidence.verdict, 'NOT PROVEN');
  assert.deepEqual(initialEnvelope.promptEvidence.coverage, { total: 10, met: 5, unmet: 0, unproven: 5, blocked: 0 });

  const manifest = {
    schema: 'amabie-complex-codex-p2e-e2e/2',
    tempRoot,
    projectRoot,
    productIdentity: currentProductIdentity(),
    requestPath,
    goal,
    requirements: expectedRequirements,
    falseDone,
    initial: {
      processExitCode: initial.status,
      verdict: initialEnvelope.promptEvidence.verdict,
      coverage: initialEnvelope.promptEvidence.coverage,
      agentClaimIncludedInRequest: true,
      stdout: initial.stdout,
      stderr: initial.stderr,
    },
    correction: null,
  };
  persistManifest(tempRoot, manifest, 'prepared');
  console.log(JSON.stringify({
    status: 'PREPARED — no agent started; live provider use requires explicit operator opt-in and CLI project trust',
    tempRoot,
    projectRoot,
    requirements: extracted.requirements.length,
    sourceCoverage,
    initialVerdict: manifest.initial.verdict,
    initialCoverage: manifest.initial.coverage,
    falseDone,
    nextFixtureCommand: 'node tooling/test-support/prompt-evidence-complex-codex-e2e.mjs correct-fixture "' + tempRoot + '"',
    nextProviderCommand: 'node tooling/test-support/prompt-evidence-complex-codex-e2e.mjs correct "' + tempRoot + '" --agent codex|claude (requires explicit provider-usage opt-in)',
  }, null, 2));
}

async function correct() {
  const tempRoot = path.resolve(suppliedRoot);
  const relativeToTemp = path.relative(os.tmpdir(), tempRoot);
  if (path.isAbsolute(relativeToTemp) || relativeToTemp === '..' || relativeToTemp.startsWith('..' + path.sep)
    || !path.basename(tempRoot).startsWith('amabie-codex-complex-p2e-')) {
    throw new Error('correction mode accepts only this harness own disposable temp directory');
  }
  const manifestPath = path.join(tempRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'amabie-complex-codex-p2e-e2e/2'
    || path.resolve(manifest.tempRoot) !== tempRoot
    || path.resolve(manifest.projectRoot) !== path.join(tempRoot, 'project')
    || manifest.initial?.verdict !== 'NOT PROVEN'
    || manifest.productIdentity?.schema !== 'amabie-product-source-identity/1') {
    throw new Error('the saved temp manifest is not a verified false-done fixture');
  }
  assertProductSourceIdentityMatches(
    manifest.productIdentity,
    currentProductIdentity(),
    'Amabie source, build artifacts, or runtime changed after preparation; prepare the scenario again',
  );
  const projectRoot = manifest.projectRoot;
  const shim = shimCorrection ? installLocalAgentShim(tempRoot, correctionAgent) : null;
  const env = makeIsolatedEnv(tempRoot, shim?.shimDir);
  const before = workspaceFileDigests(projectRoot);
  const executionMode = fixtureCorrection ? 'deterministic local fixture'
    : shimCorrection ? `${correctionAgent} local executable shim`
      : correctionAgent;
  console.error(`[complex-e2e] Starting ${executionMode} with one authorized correction.`);
  const loopArgs = [
    cliEntry, 'prompt-evidence', 'loop',
    '--request', '.amabie/prompt-evidence.json',
  ];
  if (fixtureCorrection) {
    loopArgs.push(
      '--agent-executable', process.execPath,
      '--agent-arg', path.join(fixtureDir, 'prompt-evidence-complex-fixture-corrector.mjs'),
    );
  } else {
    loopArgs.push('--agent', correctionAgent);
  }
  loopArgs.push(
    '--authorize-corrections',
    '--max-corrections', '1',
    '--json',
  );
  const run = await runBounded(process.execPath, loopArgs, projectRoot, env, fixtureCorrection || shimCorrection ? 2 * 60_000 : 12 * 60_000);
  assertProductSourceIdentityMatches(
    manifest.productIdentity,
    currentProductIdentity(),
    'Amabie source, build artifacts, or runtime changed during the correction run',
  );
  const baseChanged = changedFiles(before, workspaceFileDigests(projectRoot));
  let envelope;
  try { envelope = JSON.parse(run.stdout); } catch { envelope = null; }
  const candidatePath = envelope?.candidate?.path ?? null;
  const changed = candidatePath ? changedFiles(before, workspaceFileDigests(candidatePath)) : [];
  const shimEvents = shim && fs.existsSync(shim.capturePath)
    ? fs.readFileSync(shim.capturePath, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    : [];
  const correctionEvent = shimEvents.find(event => event.kind === 'correction');
  const correction = {
    agent: correctionAgent,
    executionMode: shimCorrection ? 'local-agent-shim' : fixtureCorrection ? 'deterministic-local-fixture' : 'live-provider',
    providerCallMade: !fixtureCorrection && !shimCorrection,
    ...(shimCorrection ? {
      providerShim: {
        calls: shimEvents.map(({ kind, agent, arguments: callArguments }) => ({ kind, agent, arguments: callArguments })),
        requestSchema: correctionEvent?.requestSchema ?? null,
        reportSchema: correctionEvent?.reportSchema ?? null,
        cycle: correctionEvent?.cycle ?? null,
        unresolvedCount: correctionEvent?.unresolvedCount ?? null,
        unresolvedCriterionCount: correctionEvent?.unresolvedCriterionCount ?? null,
        criteriaContractsMatchRequest: correctionEvent?.criteriaContractsMatchRequest ?? false,
        refusalContractMatchesRequest: correctionEvent?.refusalContractMatchesRequest ?? false,
        evidenceFactsIncluded: correctionEvent?.evidenceFactsIncluded ?? null,
      },
    } : {}),
    processExitCode: run.status,
    timedOut: run.timedOut,
    outputExceeded: run.outputExceeded,
    error: run.error ?? null,
    status: envelope?.status ?? null,
    correctionAttempts: envelope?.correctionAttempts ?? null,
    verdict: envelope?.verification?.verdict ?? null,
    coverage: envelope?.verification?.coverage ?? null,
    claimUsedAsEvidence: envelope?.agentClaimUsedAsEvidence ?? null,
    stopReason: envelope?.stopReason ?? null,
    correctionReport: envelope?.correctionReport ?? null,
    amabieStdout: safeDiagnostic(run.stdout),
    amabieStderr: safeDiagnostic(run.stderr),
    changedFiles: changed,
    baseChangedFiles: baseChanged,
    candidatePath,
  };
  manifest.correction = correction;
  persistManifest(tempRoot, manifest, 'final');
  console.log(JSON.stringify(correction, null, 2));
  assert.equal(run.timedOut, false, 'the bounded provider process must complete within twelve minutes');
  assert.equal(run.outputExceeded, false, 'provider output remains bounded');
  assert.equal(run.status, 0, run.stderr + '\n' + run.stdout);
  assert.equal(envelope?.status, 'verified');
  assert.equal(envelope?.correctionAttempts, 1);
  assert.equal(envelope?.verification?.verdict, 'PASS');
  assert.deepEqual(envelope?.verification?.coverage, { total: 10, met: 10, unmet: 0, unproven: 0, blocked: 0 });
  assert.equal(envelope?.agentClaimUsedAsEvidence, false);
  assert.deepEqual(baseChanged, [], 'the authoritative project must not be modified; the correction lives in the candidate');
  assert.ok(changed.includes('transactions.mjs'), 'the selected correction agent must fix the candidate implementation');
  assert.ok(changed.includes('legacy.mjs'), 'the selected correction agent must restore the hidden legacy behavior regression');
  console.error(`PASS: ${executionMode} correction and a fresh independent Amabie verification completed.`);
  console.error('Scratch project and full local result retained at ' + tempRoot);
}

try {
  if (mode === 'prepare') await prepare();
  else await correct();
} catch (error) {
  console.error('Complex Prompt-to-Evidence E2E failed: ' + (error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
}
