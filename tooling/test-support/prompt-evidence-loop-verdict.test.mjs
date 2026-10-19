import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// P0-1 regression: the prompt-evidence loop must never report `verified/PASS` while the overall
// doctor gate refuses. P0-21 regression: a check the candidate wrote or rewrote itself is not independent
// authority, so it cannot make a requirement met. The READY control proves an unchanged, operator-committed
// oracle still verifies a real change.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const cliEntry = path.join(repoRoot, 'apps', 'cli', 'dist', 'src', 'main.js');
const checkFixture = path.join(repoRoot, 'tooling', 'test-support', 'fixtures', 'prompt-evidence-source-check.mjs');
const noopAgent = path.join(repoRoot, 'tooling', 'test-support', 'fixtures', 'prompt-evidence-noop-agent.mjs');
const loopArgs = ['prompt-evidence', 'loop', '--request', '.amabie/prompt-evidence.json', '--agent-executable', process.execPath, '--agent-arg', noopAgent, '--authorize-corrections', '--max-corrections', '1', '--json'];
const doctorArgs = ['doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json'];

const requirements = [
  'Registration rejects an invalid email address.',
  'Password storage rejects blank input.',
];
const goal = requirements.join('\n');

function materialDigest(text) {
  const canonical = text.trim().replace(/\s+/gu, ' ');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function assertRun(result, expectedStatus, label) {
  assert.equal(result.status, expectedStatus, `${label}\n${result.stderr}\n${result.stdout}`);
}

function passwordSource(rule) {
  return `export const passwordRule = "${rule}";\n`;
}

// The check for the password requirement. It passes only when the rule it names is present in the
// policy file. Its bytes are the operator's oracle when they are committed before the candidate starts.
function passwordCheckSource(rule) {
  return [
    "import fs from 'node:fs';",
    '',
    "const source = fs.readFileSync(new URL('./password-policy.mjs', import.meta.url), 'utf8');",
    `if (!source.includes("${rule}")) {`,
    "  console.error('password-policy.mjs does not contain the required rule');",
    '  process.exit(1);',
    '}',
    "console.log('PASS password rule present');",
    '',
  ].join('\n');
}

/** A scratch project whose sealed plan runs two source checks. The starting commit holds the policy at
 *  `baseRule` and the operator's oracle (password-policy.test.mjs), which requires `fixtureRule`; `setup`
 *  seals that commit as the comparison base. The candidate is written uncommitted and is what the verdict
 *  reads. `rewriteCheckTo` makes the candidate rewrite the oracle itself. */
function makeProject({ baseRule, candidateRule, candidateNote = '', rewriteCheckTo, breakStable = false, fixtureRule = 'rejects blank input' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-loop-verdict-'));
  const git = (args) => run('git', args, root);
  assertRun(git(['init', '--quiet']), 0, 'initialize scratch repository');
  assertRun(git(['config', 'user.email', 'amabie-test@example.invalid']), 0, 'set scratch commit identity');
  assertRun(git(['config', 'user.name', 'Amabie Loop Verdict Test']), 0, 'set scratch commit identity');

  const registrationFile = path.join(root, 'registration.mjs');
  const passwordFile = path.join(root, 'password-policy.mjs');
  const passwordCheckFile = path.join(root, 'password-policy.test.mjs');
  const stableFile = path.join(root, 'stable.mjs');
  fs.writeFileSync(registrationFile, 'export const emailRule = "rejects invalid email";\n');
  fs.writeFileSync(passwordFile, passwordSource(baseRule));
  fs.writeFileSync(passwordCheckFile, passwordCheckSource(fixtureRule));
  fs.writeFileSync(stableFile, 'export const existingFeature = true;\n');
  const proofs = Object.fromEntries(requirements.map((requirement, index) => [materialDigest(requirement), index === 0 ? 'test' : 'typecheck']));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'amabie-loop-verdict',
    scripts: {
      test: `node "${checkFixture}" registration.mjs "rejects invalid email"`,
      typecheck: 'node password-policy.test.mjs',
      build: 'node --check stable.mjs',
    },
    amabie: { proofs },
  }, null, 2)}\n`);
  assertRun(git(['add', 'package.json', 'registration.mjs', 'password-policy.mjs', 'password-policy.test.mjs', 'stable.mjs']), 0, 'stage fixture baseline');
  assertRun(git(['commit', '--quiet', '-m', 'fixture baseline']), 0, 'commit fixture baseline');

  const cli = (args) => run(process.execPath, [cliEntry, ...args], root);
  // A red starting commit is the realistic base for a new behaviour: `setup` exits 2 ("setup baseline is
  // red") and still seals the plan, which is how the discrimination suite builds its frozen base.
  const setup = cli(['setup', '--yes']);
  assert.ok([0, 2].includes(setup.status), `configure Amabie in scratch project\n${setup.stderr}\n${setup.stdout}`);
  assertRun(cli(['task', goal, ...requirements.flatMap(requirement => ['--requirement', requirement])]), 0, 'register original task and requirements');

  const [registrationText, passwordText] = requirements;
  const request = {
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: goal },
    requirements: [
      {
        text: registrationText,
        sourceRef: { kind: 'goal', start: 0, end: registrationText.length, excerpt: registrationText },
        clarity: 'clear',
        criteria: [{ statement: 'A sealed project check proves the requirement.', adapterId: 'amabie.coding.sealed-plan', evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }],
      },
      {
        text: passwordText,
        sourceRef: { kind: 'goal', start: registrationText.length + 1, end: goal.length, excerpt: passwordText },
        clarity: 'clear',
        criteria: [{ statement: 'A sealed project check proves the requirement.', adapterId: 'amabie.coding.sealed-plan', evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }],
      },
    ],
  };
  fs.mkdirSync(path.join(root, '.amabie'), { recursive: true });
  fs.writeFileSync(path.join(root, '.amabie', 'prompt-evidence.json'), `${JSON.stringify(request, null, 2)}\n`);
  fs.writeFileSync(passwordFile, `${passwordSource(candidateRule)}${candidateNote}`);
  if (rewriteCheckTo !== undefined) fs.writeFileSync(passwordCheckFile, passwordCheckSource(rewriteCheckTo));
  if (breakStable) fs.writeFileSync(stableFile, 'export const = broken;\n');
  return { root, cli };
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}: stdout is not JSON (${error.message})\n${result.stderr}\n${result.stdout}`);
  }
}

test('NOT PROVEN: a green per-requirement block with no discrimination is never reported as a verified loop', () => {
  // The candidate adds only a comment: no behaviour change, so the sealed checks pass on the base too.
  // The overall doctor gate must refuse with NOT PROVEN even though every requirement reads PASS.
  const project = makeProject({ baseRule: 'rejects blank input', candidateRule: 'rejects blank input', candidateNote: '// reviewed: comment only\n' });
  try {
    const doctor = project.cli(doctorArgs);
    const doctorEnvelope = parseJson(doctor, 'doctor');
    assert.equal(doctorEnvelope.status, 'NOT PROVEN', `the outer gate must refuse this candidate\n${doctor.stdout}`);
    assert.equal(doctor.status, 2);

    const loop = project.cli(loopArgs);
    const loopEnvelope = parseJson(loop, 'loop');
    assert.notEqual(loopEnvelope.status, 'verified', `the loop must not claim verified\n${loop.stdout}`);
    assert.notEqual(loopEnvelope.verification?.verdict, 'PASS', `the loop must not claim PASS\n${loop.stdout}`);
    assert.equal(loopEnvelope.verification?.verdict, 'NOT PROVEN', `the loop must carry the doctor's NOT PROVEN\n${loop.stdout}`);
    assert.equal(loop.status, 2, 'a refused candidate exits 2');
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('READY control: an unchanged operator oracle verifies a real change that the base fails', () => {
  // The base breaks the policy and the operator's check, byte-identical to the fixture, fails there.
  // The candidate restores the rule without touching the check. The change is discriminated by an
  // independent oracle, so the overall gate must reach READY and the loop may report verified/PASS.
  const project = makeProject({ baseRule: 'accepts blank input', candidateRule: 'rejects blank input' });
  try {
    const doctor = project.cli(doctorArgs);
    const doctorEnvelope = parseJson(doctor, 'doctor');
    assert.equal(doctorEnvelope.status, 'READY', `the real change must reach READY\n${doctor.stdout}`);
    assert.equal(doctor.status, 0);

    const loop = project.cli(loopArgs);
    const loopEnvelope = parseJson(loop, 'loop');
    assert.equal(loopEnvelope.status, 'verified', `\n${loop.stdout}`);
    assert.equal(loopEnvelope.verification.verdict, 'PASS', `\n${loop.stdout}`);
    assert.equal(loop.status, 0);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('NEEDS ATTENTION: a failing sealed check elsewhere keeps the loop off PASS even when every requirement is discriminated', () => {
  // Both requirement checks discriminate the real password change, so the per-requirement block reads
  // PASS. An unbound sealed check breaks on the candidate, so the overall gate refuses with NEEDS ATTENTION.
  const project = makeProject({ baseRule: 'accepts blank input', candidateRule: 'rejects blank input', breakStable: true });
  try {
    const doctor = project.cli(doctorArgs);
    const doctorEnvelope = parseJson(doctor, 'doctor');
    assert.equal(doctorEnvelope.status, 'NEEDS ATTENTION', `the broken sealed check must refuse the overall gate\n${doctor.stdout}`);
    assert.equal(doctor.status, 2);

    const loop = project.cli(loopArgs);
    const loopEnvelope = parseJson(loop, 'loop');
    assert.notEqual(loopEnvelope.status, 'verified', `the loop must not claim verified\n${loop.stdout}`);
    assert.notEqual(loopEnvelope.verification?.verdict, 'PASS', `the loop must not claim PASS\n${loop.stdout}`);
    assert.equal(loop.status, 2, 'a refused candidate exits 2');
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('P0-21: a candidate that rewrites the check to match its own wrong behaviour does not satisfy the requirement', () => {
  // The candidate ships a policy the requirement does not ask for, and rewrites the existing check to assert
  // that same wrong text. Against the base the rewritten check fails, so it discriminates the change, but its
  // text is the worker's own. It must not be counted as independent satisfaction of the requirement.
  const project = makeProject({
    baseRule: 'accepts blank input',
    candidateRule: 'accepts blank input with warning',
    rewriteCheckTo: 'accepts blank input with warning',
  });
  try {
    const doctor = project.cli(doctorArgs);
    const doctorEnvelope = parseJson(doctor, 'doctor');
    assert.notEqual(doctorEnvelope.status, 'READY', `a worker-rewritten check must not reach READY\n${doctor.stdout}`);
    assert.notEqual(doctor.status, 0, `a worker-rewritten check must not exit 0\n${doctor.stdout}`);
    // The base failure is real, so the obligation must be UNPROVEN for the worker-written check, not failed or met.
    const regression = doctorEnvelope.proof?.obligations?.find(o => o.id === 'regression-evidence');
    assert.equal(regression?.status, 'unproven', `the worker-rewritten check must leave regression evidence UNPROVEN\n${doctor.stdout}`);
    assert.match(regression?.caveat ?? '', /password-policy\.test\.mjs/, 'the caveat must name the rewritten check file');

    const loop = project.cli(loopArgs);
    const loopEnvelope = parseJson(loop, 'loop');
    assert.notEqual(loopEnvelope.status, 'verified', `the loop must not claim verified\n${loop.stdout}`);
    assert.notEqual(loopEnvelope.verification?.verdict, 'PASS', `the loop must not claim PASS\n${loop.stdout}`);
    assert.equal(loop.status, 2, 'a refused candidate exits 2');
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});
