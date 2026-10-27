/**
 * P0:22 — ORIGINAL PROMPT BOUND THROUGH TRUSTED INTAKE TO APPROVAL.
 *
 * The request goal is written by the worker. Before the fix, a worker could register a goal that
 * silently dropped a line of the user's original prompt, and doctor still reported PASS with complete
 * source coverage, because coverage was measured against the worker's own goal text. This probe drives
 * the real UserPromptSubmit hook (the harness-side intake), the real task registration, the real bind
 * step and the real doctor path, then asserts the corrected contract on the prompt-evidence verdict:
 *
 *   CONTROL (bound)     the goal carries every line of the recorded original prompt       -> PASS
 *   CONTROL (no record) no trusted intake record exists                                  -> PASS, labelled
 *                       as manual operator confirmation (never silent)
 *   OMISSION            the original prompt has a second line the goal drops              -> NOT PROVEN
 *   NEGATION            the worker registers and requests a goal that rewrites that line   -> NOT PROVEN
 *   REPLAY              a request for an older prompt, after a newer prompt was submitted  -> NOT PROVEN
 *
 * The overall doctor exit is reported but not asserted: this fixture's sealed test also passes on the
 * base commit, so doctor's regression-evidence gate stays open for every scenario. The question here is
 * only whether the prompt-evidence verdict is faithful to the original prompt.
 *
 * The binding is LOCAL and same-user: the record lives in the project's .amabie directory and stores
 * only SHA-256 digests of each normalised prompt line, never the raw prompt text. A same-user process
 * can rewrite it; this probe proves the harness-to-doctor path, not worker-independent trust.
 *
 *   node tooling/probes/original-prompt-binding.mjs [--cli <main.js>]
 *
 * Fixtures live only in the OS temp dir. No model or provider is invoked. Prints PASS/FAIL; exit 0
 * only if every expectation held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cliArg = process.argv.indexOf('--cli');
const cli = path.resolve(cliArg === -1 ? path.join(repo, 'apps/cli/dist/src/main.js') : process.argv[cliArg + 1]);

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-original-prompt-'));
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
// The harness-side intake: the UserPromptSubmit hook receives the user's prompt verbatim.
const submitPrompt = (dir, prompt) => run(process.execPath, [cli, 'checkpoint'], dir, JSON.stringify({
  hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 'original-prompt-binding-probe', prompt,
}));

const FIRST = 'Return a special greeting for Grace.';
const SECOND = 'Reject empty passwords.';
const NEGATED = 'Accept empty passwords.';
const GREETING_IMPL = 'export const greet = name => `Welcome, ${name}!`;\n';
const GREETING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greeting.mjs';\ntest('greets Grace', () => assert.equal(greet('Grace'), 'Welcome, Grace!'));\n";

/**
 * One scenario: a project whose sealed check passes, the worker registers `registeredGoal` as the
 * task and requirement, an optional sequence of prompts reaches the intake hook, and the worker's
 * request declares `requestGoal`. Returns the doctor envelope.
 */
function scenario(name, { prompts, registeredGoal, requestGoal, mutate }) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `original-prompt-${name}`, type: 'module', private: true, scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'greeting.mjs'), GREETING_IMPL);
  fs.writeFileSync(path.join(dir, 'greeting.test.mjs'), GREETING_TEST);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@amabie.local']);
  git(dir, ['config', 'user.name', 'Original Prompt Probe']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'reviewed greeting check and implementation']);
  const setup = amabie(dir, ['setup', '--yes']);
  if (setup.status !== 0) throw new Error(`setup failed in ${name}: ${setup.stdout}${setup.stderr}`);
  // Binding is an operator act: the registered requirement is measured by the sealed test script. It is
  // made BEFORE any agent session opens, as a human at a terminal would; once UserPromptSubmit has opened
  // a session the product refuses to change verification authority (and this probe must not hide that).
  const bind = amabie(dir, ['bind', 'test', '--requirement', registeredGoal, '--reseal']);
  if (bind.status !== 0) throw new Error(`bind failed in ${name}: ${bind.stdout}${bind.stderr}`);
  for (const prompt of prompts) {
    const hook = submitPrompt(dir, prompt);
    if (hook.status !== 0) throw new Error(`UserPromptSubmit failed in ${name}: ${hook.stdout}${hook.stderr}`);
  }
  const task = amabie(dir, ['task', registeredGoal, '--kind', 'bugfix', '--requirement', registeredGoal]);
  if (task.status !== 0) throw new Error(`task failed in ${name}: ${task.stdout}${task.stderr}`);
  fs.mkdirSync(path.join(dir, '.amabie'), { recursive: true });
  mutate?.(dir);
  fs.writeFileSync(path.join(dir, '.amabie', 'prompt-evidence.json'), JSON.stringify({
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: requestGoal },
    requirements: [{
      text: registeredGoal,
      sourceRef: { kind: 'goal', start: 0, end: registeredGoal.length, excerpt: registeredGoal },
      clarity: 'clear',
      criteria: [{
        statement: 'The sealed greeting check passes for the greeting behaviour.',
        adapterId: 'amabie.coding.sealed-plan',
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    }],
  }, null, 2) + '\n');
  const doctor = amabie(dir, ['doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json']);
  let envelope = null;
  try { envelope = JSON.parse(doctor.stdout); } catch { envelope = null; }
  return { doctorExit: doctor.status, envelope, raw: `${doctor.stdout}\n${doctor.stderr}`.trim() };
}

const verdictOf = result => result.envelope?.promptEvidence?.verdict ?? 'NO-ENVELOPE';
const issuesOf = result => (result.envelope?.promptEvidence?.issues ?? []).join(' | ');
const doctorOf = result => result.envelope
  ? `doctor=${result.envelope.status} exit=${result.doctorExit}`
  : `doctor exit=${result.doctorExit} raw=${result.raw.slice(0, 300)}`;

// ── CONTROLS ──────────────────────────────────────────────────────────────────────
// Bound: the recorded prompt is exactly the goal, so every prompt line is covered.
const bound = scenario('control-bound', { prompts: [FIRST], registeredGoal: FIRST, requestGoal: FIRST });
check(verdictOf(bound) === 'PASS',
  'CONTROL bound: a goal that carries every recorded prompt line still reaches PASS',
  `verdict=${verdictOf(bound)} ${doctorOf(bound)} issues=${issuesOf(bound) || '(none)'}`);

// No record: no hook ever ran, so the original prompt is unbound. It must say so, not stay silent.
const unbound = scenario('control-no-record', { prompts: [], registeredGoal: FIRST, requestGoal: FIRST });
check(/manual operator confirmation/.test(issuesOf(unbound)),
  'CONTROL no record: the original prompt is labelled as manual operator confirmation, not silently trusted',
  `verdict=${verdictOf(unbound)} issues=${issuesOf(unbound) || '(none)'}`);

// ── ATTACKS ───────────────────────────────────────────────────────────────────────
const bothLines = `${FIRST}\n${SECOND}`;

// OMISSION: the user asked for two things; the worker's goal and requirement carry only the first.
const omission = scenario('omission', { prompts: [bothLines], registeredGoal: FIRST, requestGoal: FIRST });
check(verdictOf(omission) !== 'PASS' && /original prompt/.test(issuesOf(omission)),
  'OMISSION: a goal that drops a line of the original prompt is NOT PROVEN, with an explicit issue',
  `verdict=${verdictOf(omission)} issues=${issuesOf(omission) || '(none)'}`);

// NEGATION: the worker registers AND requests a goal whose second line is the opposite of the user's.
// Request and registration agree with each other, so only the original-prompt binding can refuse it.
const negatedGoal = `${FIRST}\n${NEGATED}`;
const negation = scenario('negation', { prompts: [bothLines], registeredGoal: negatedGoal, requestGoal: negatedGoal });
check(verdictOf(negation) !== 'PASS' && /original prompt/.test(issuesOf(negation)),
  'NEGATION: a goal that negates a line of the original prompt is NOT PROVEN, with an explicit issue',
  `verdict=${verdictOf(negation)} ${doctorOf(negation)} issues=${issuesOf(negation) || '(none)'}`);

// REPLAY: an older request is re-declared after a newer prompt was submitted in the same project.
const replay = scenario('replay', { prompts: [FIRST, 'Unrelated follow-up request.'], registeredGoal: FIRST, requestGoal: FIRST });
check(verdictOf(replay) !== 'PASS' && /original prompt/.test(issuesOf(replay)),
  'REPLAY: a request that answers an older prompt, not the latest one, is NOT PROVEN',
  `verdict=${verdictOf(replay)} issues=${issuesOf(replay) || '(none)'}`);

// FOREIGN RECORD (T10): the record carries the right lines but a promptId this project never minted,
// as when a record is copied from another project or replayed. The lines match; only the id can refuse it.
const foreign = scenario('foreign-record', {
  prompts: [FIRST], registeredGoal: FIRST, requestGoal: FIRST,
  mutate: dir => {
    const file = path.join(dir, '.amabie', 'original-prompt.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.promptId = '00000000-0000-4000-8000-000000000000';
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  },
});
check(verdictOf(foreign) !== 'PASS' && /replay/.test(issuesOf(foreign)),
  'FOREIGN RECORD: an original-prompt record whose promptId no session of this project minted is NOT PROVEN',
  `verdict=${verdictOf(foreign)} issues=${issuesOf(foreign) || '(none)'}`);

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: original prompt binding — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
