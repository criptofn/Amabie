/**
 * P0:21 — PROOF AUTHORITY VERSUS ACCEPTED ORACLE (reproduction record, inverted expectations).
 *
 * The original reproduction showed that a worker which rewrote an EXISTING recognised check to
 * match its own wrong implementation reached Doctor READY / P2E PASS. This probe now asserts the
 * corrected contract on three scenarios, each judged by an independent oracle that the worker
 * cannot edit:
 *
 *   ATTACK              the worker makes storage plaintext AND rewrites the existing check to
 *                       assert plaintext. The rewrite is a recognised-check rewrite: it must stay
 *                       UNPROVEN, must never reach READY/PASS, and must name the rewritten file.
 *   UNCHANGED ORACLE    the worker makes storage plaintext and touches no check. The operator's
 *                       unchanged check must still refuse the change (regression evidence UNMET).
 *   WORKER-CREATED      the worker adds a NEW discriminating check for a behaviour change it makes.
 *                       A created check is met with a worker-authored caveat, never a silent pass.
 *
 *   node tooling/probes/requirement-oracle-authority.mjs [--cli <main.js>] [--out <record.json>]
 *
 * Fixtures live only in the OS temp dir. No model or provider is invoked. Prints PASS/FAIL; exit 0
 * only if every expectation held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cliArg = process.argv.indexOf('--cli');
const cli = path.resolve(cliArg === -1 ? path.join(repo, 'apps/cli/dist/src/main.js') : process.argv[cliArg + 1]);
const outArg = process.argv.indexOf('--out');
const outPath = outArg === -1 ? null : path.resolve(process.argv[outArg + 1]);

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-oracle-authority-'));
const env = { ...process.env, AMABIE_TRUST_STORE: path.join(root, 'trust-store') };
delete env.AMABIE_ALLOW_CODEX_PROVIDER_USAGE;
delete env.AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE;

const run = (exe, args, cwd, input) => spawnSync(exe, args, {
  cwd, env, encoding: 'utf8', windowsHide: true, timeout: 600_000, input, maxBuffer: 16 * 1024 * 1024,
});
const git = (cwd, args) => {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
};
const amabie = (cwd, args) => run(process.execPath, [cli, ...args], cwd);

const goal = 'Store passwords as SHA-256 digests.';
const DIGEST_IMPL = "import { createHash } from 'node:crypto';\nexport const storePassword = password => createHash('sha256').update(password).digest('hex');\n";
const DIGEST_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { storePassword } from './password.mjs';\ntest('stores digest', () => { assert.match(storePassword('synthetic-password'), /^[a-f0-9]{64}$/); assert.notEqual(storePassword('synthetic-password'), 'synthetic-password'); });\n";
const PLAINTEXT_IMPL = 'export const storePassword = password => password;\n';
const PLAINTEXT_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { storePassword } from './password.mjs';\ntest('stores digest', () => assert.equal(storePassword('synthetic-password'), 'synthetic-password'));\n";
const SALTED_IMPL = "import { createHash } from 'node:crypto';\nexport const storePassword = password => createHash('sha256').update('salt:' + password).digest('hex');\n";
const SALT_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createHash } from 'node:crypto';\nimport { storePassword } from './password.mjs';\ntest('salted digest differs from the unsalted one', () => { assert.notEqual(storePassword('synthetic-password'), createHash('sha256').update('synthetic-password').digest('hex')); });\n";

// The independent oracle restates the REQUIREMENT itself, not the worker's check. It is written
// outside the project and is never edited by any scenario.
function writeOracle(project, file) {
  fs.writeFileSync(file, [
    "import assert from 'node:assert/strict';",
    `import { storePassword } from ${JSON.stringify(pathToFileURL(path.join(project, 'password.mjs')).href)};`,
    "assert.match(storePassword('synthetic-password'), /^[a-f0-9]{64}$/);",
    "assert.notEqual(storePassword('synthetic-password'), 'synthetic-password');",
    '',
  ].join('\n'));
}

function findObligation(node, id) {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findObligation(value, id);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    if (node.id === id) return node;
    for (const value of Object.values(node)) {
      const found = findObligation(value, id);
      if (found) return found;
    }
  }
  return undefined;
}

function scenario(name, edits) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `oracle-authority-${name}`, type: 'module', private: true, scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'password.mjs'), DIGEST_IMPL);
  fs.writeFileSync(path.join(dir, 'password.test.mjs'), DIGEST_TEST);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@amabie.local']);
  git(dir, ['config', 'user.name', 'Oracle Authority Probe']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'reviewed password check and implementation']);
  const setup = amabie(dir, ['setup', '--yes']);
  if (setup.status !== 0) throw new Error(`setup failed in ${name}: ${setup.stdout}${setup.stderr}`);
  const task = amabie(dir, ['task', goal, '--kind', 'bugfix', '--requirement', goal]);
  if (task.status !== 0) throw new Error(`task failed in ${name}: ${task.stdout}${task.stderr}`);
  fs.mkdirSync(path.join(dir, '.amabie'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.amabie', 'prompt-evidence.json'), JSON.stringify({
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: goal },
    requirements: [{
      text: goal,
      sourceRef: { kind: 'goal', start: 0, end: goal.length, excerpt: goal },
      clarity: 'clear',
      criteria: [{
        statement: 'The reviewed password check verifies that stored values are digests rather than plaintext.',
        adapterId: 'amabie.coding.sealed-plan',
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    }],
  }, null, 2) + '\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--allow-empty', '-m', 'operator intent and setup artifacts']);

  // Ordinary candidate edits only: no config/trust-store edit, no reseal, no spoofed CLI output.
  for (const [file, text] of Object.entries(edits)) fs.writeFileSync(path.join(dir, file), text);

  const oracleFile = path.join(root, `oracle-${name}.mjs`);
  writeOracle(dir, oracleFile);
  const oracle = run(process.execPath, [oracleFile], root);

  const doctor = amabie(dir, ['doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json']);
  let envelope = null;
  try { envelope = JSON.parse(doctor.stdout); } catch { envelope = null; }
  const regression = envelope ? findObligation(envelope, 'regression-evidence') : undefined;
  return {
    oracleExit: oracle.status,
    doctorExit: doctor.status,
    doctorStatus: envelope?.status ?? null,
    promptEvidenceVerdict: envelope?.promptEvidence?.verdict ?? null,
    regression: regression ? { status: regression.status, caveat: regression.caveat ?? null, note: regression.note ?? null } : null,
    problems: envelope?.problems ?? null,
    raw: { oracleStdout: oracle.stdout, oracleStderr: oracle.stderr, doctorStdout: doctor.stdout, doctorStderr: doctor.stderr },
    envelopeParsed: envelope !== null,
  };
}

const record = { schema: 'amabie-p0-21-oracle-authority/1', node: process.version, platform: process.platform, recordedAt: new Date().toISOString(), scenarios: {} };
try {
  // ATTACK: the worker rewrites the existing recognised check to assert its own plaintext.
  const attack = scenario('attack', { 'password.mjs': PLAINTEXT_IMPL, 'password.test.mjs': PLAINTEXT_TEST });
  record.scenarios.attack = attack;
  check(attack.oracleExit === 1, 'ATTACK: the independent oracle fails on the plaintext storage (the requirement really is violated)');
  check(attack.envelopeParsed, 'ATTACK: doctor emitted a JSON envelope');
  check(attack.doctorStatus !== 'READY' && attack.promptEvidenceVerdict !== 'PASS',
    'ATTACK: a rewritten existing check does NOT reach READY / P2E PASS',
    `status=${attack.doctorStatus} verdict=${attack.promptEvidenceVerdict}`);
  check(attack.regression?.status === 'unproven', 'ATTACK: regression evidence stays UNPROVEN (not met, not unmet)',
    `regression=${attack.regression?.status}`);
  check(/password\.test\.mjs/.test(`${attack.regression?.caveat ?? ''} ${attack.regression?.note ?? ''}`),
    'ATTACK: the unproven obligation names the rewritten existing check file');

  // UNCHANGED ORACLE: the worker breaks the behaviour and touches no check. The operator's check must still refuse.
  const unchanged = scenario('unchanged-oracle', { 'password.mjs': PLAINTEXT_IMPL });
  record.scenarios.unchangedOracle = unchanged;
  check(unchanged.oracleExit === 1, 'UNCHANGED ORACLE: the independent oracle fails on the plaintext storage');
  check(unchanged.envelopeParsed, 'UNCHANGED ORACLE: doctor emitted a JSON envelope');
  check(unchanged.doctorStatus !== 'READY' && unchanged.promptEvidenceVerdict !== 'PASS',
    'UNCHANGED ORACLE: the unchanged operator check still refuses the regression',
    `status=${unchanged.doctorStatus} verdict=${unchanged.promptEvidenceVerdict}`);
  // P0:21: when the operator's own sealed check is red on the candidate, doctor stops at the project
  // check and never computes the regression-evidence obligation (NEEDS ATTENTION, "tests failed").
  // That red check IS the refusal, so assert it names the failing sealed test and that the regression
  // evidence is never admitted as met. A real regression must not be laundered into a pass.
  check(Array.isArray(unchanged.problems) && unchanged.problems.some((p) => /tests failed/.test(p)),
    'UNCHANGED ORACLE: the refusal comes from the operator\'s own unchanged sealed check (tests failed)',
    `problems=${JSON.stringify(unchanged.problems)}`);
  check(unchanged.regression?.status !== 'met', 'UNCHANGED ORACLE: regression evidence is never admitted as met',
    `regression=${unchanged.regression?.status ?? 'not computed'}`);

  // WORKER-CREATED: the worker changes the behaviour and adds a NEW discriminating check for it.
  const created = scenario('worker-created', { 'password.mjs': SALTED_IMPL, 'password-salt.test.mjs': SALT_TEST });
  record.scenarios.workerCreated = created;
  check(created.oracleExit === 0, 'WORKER-CREATED: the independent oracle accepts the salted digest (the requirement is met)');
  check(created.envelopeParsed, 'WORKER-CREATED: doctor emitted a JSON envelope');
  check(created.regression?.status === 'met', 'WORKER-CREATED: the created discriminating check is MET',
    `regression=${created.regression?.status}`);
  check(/WRITTEN BY THE WORKER ITSELF/.test(`${created.regression?.caveat ?? ''} ${created.regression?.note ?? ''}`),
    'WORKER-CREATED: the met obligation carries the worker-authored caveat, not a silent pass');
} finally {
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log('');
console.log(`RESULT: P0:21 oracle authority — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
