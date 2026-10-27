/**
 * T11 — TASK REVISIONS ARE TRACEABLE AND ONLY A NEW REQUEST MAY WEAKEN THE DUTIES.
 *
 * `amabie task` overwrites the task record, so before the revision log a worker could re-register the
 * task with a requirement removed and leave no trace. Every registration is now appended to a
 * hash-chained .amabie/task-revisions.jsonl tagged with the harness request (promptId) it happened in.
 * Doctor turns a prompt-evidence PASS into NOT PROVEN when:
 *
 *   DROP      a registration inside ONE request drops or replaces a requirement
 *   TAMPER    the chain was edited (a line rewritten or removed from the middle)
 *   ROLLBACK  the registered task is not the last recorded revision
 *
 * and keeps PASS for:
 *
 *   CONTROL     one registration, unchanged
 *   AUTHORIZED  a NEW UserPromptSubmit (the user's own new request) followed by a narrower registration
 *   ADDITION    a registration inside one request that only ADDS a requirement
 *
 * LOCAL and same-user, like the original-prompt record: silent edits become visible, not impossible.
 * The overall doctor exit is not asserted (the fixture's sealed test also passes on the base commit).
 *
 *   node tooling/probes/task-revision-integrity.mjs [--cli <main.js>]
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-task-revision-'));
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
const submitPrompt = (dir, prompt) => run(process.execPath, [cli, 'checkpoint'], dir, JSON.stringify({
  hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 'task-revision-probe', prompt,
}));

const GOAL = 'Return a special greeting for Grace.';
const EXTRA = 'Keep the greeting under 40 characters.';
const GREETING_IMPL = 'export const greet = name => `Welcome, ${name}!`;\n';
const GREETING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greeting.mjs';\ntest('greets Grace', () => assert.equal(greet('Grace'), 'Welcome, Grace!'));\n";

/** steps: { prompt } submits a user request; { requirements } registers the task; the LAST registration is the one doctor sees. */
function scenario(name, { steps, tamper }) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `task-revision-${name}`, type: 'module', private: true, scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'greeting.mjs'), GREETING_IMPL);
  fs.writeFileSync(path.join(dir, 'greeting.test.mjs'), GREETING_TEST);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@amabie.local']);
  git(dir, ['config', 'user.name', 'Task Revision Probe']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'reviewed greeting check and implementation']);
  const setup = amabie(dir, ['setup', '--yes']);
  if (setup.status !== 0) throw new Error(`setup failed in ${name}: ${setup.stdout}${setup.stderr}`);
  // Binding is an operator act, made BEFORE any agent session opens (the product refuses to change
  // verification authority once UserPromptSubmit has opened one). The final registration's requirements
  // are the ones measured, so they are bound up front.
  const last = steps.filter(s => s.requirements).at(-1).requirements;
  for (const requirement of [...new Set(last)]) {
    const bind = amabie(dir, ['bind', 'test', '--requirement', requirement, '--reseal']);
    if (bind.status !== 0) throw new Error(`bind failed in ${name}: ${bind.stdout}${bind.stderr}`);
  }
  for (const step of steps) {
    if (step.prompt !== undefined) {
      const hook = submitPrompt(dir, step.prompt);
      if (hook.status !== 0) throw new Error(`UserPromptSubmit failed in ${name}: ${hook.stdout}${hook.stderr}`);
    } else {
      const args = ['task', step.requirements.join('\n'), '--kind', 'bugfix', ...step.requirements.flatMap(r => ['--requirement', r])];
      const task = amabie(dir, args);
      if (task.status !== 0) throw new Error(`task failed in ${name}: ${task.stdout}${task.stderr}`);
    }
  }
  if (tamper) tamper(path.join(dir, '.amabie', 'task-revisions.jsonl'));
  fs.writeFileSync(path.join(dir, '.amabie', 'prompt-evidence.json'), JSON.stringify({
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: last.join('\n') },
    requirements: last.map(text => {
      const start = last.join('\n').indexOf(text);
      return {
        text,
        sourceRef: { kind: 'goal', start, end: start + text.length, excerpt: text },
        clarity: 'clear',
        criteria: [{
          statement: 'The sealed greeting check passes for the greeting behaviour.',
          adapterId: 'amabie.coding.sealed-plan',
          evidenceType: 'sealed-check-run',
          predicate: { path: '/ok', equals: true },
        }],
      };
    }),
  }, null, 2) + '\n');
  const doctor = amabie(dir, ['doctor', '--prompt-evidence', '.amabie/prompt-evidence.json', '--json']);
  let envelope = null;
  try { envelope = JSON.parse(doctor.stdout); } catch { envelope = null; }
  return { envelope, raw: `${doctor.stdout}\n${doctor.stderr}`.trim() };
}

const verdictOf = r => r.envelope?.promptEvidence?.verdict ?? 'NO-ENVELOPE';
const issuesOf = r => (r.envelope?.promptEvidence?.issues ?? []).join(' | ');
const detail = r => `verdict=${verdictOf(r)} issues=${issuesOf(r) || '(none)'}${verdictOf(r) === 'NO-ENVELOPE' ? ` status=${r.envelope?.status} problems=${JSON.stringify(r.envelope?.problems ?? null).slice(0, 400)} raw=${r.raw.slice(0, 300)}` : ''}`;
const REVISION = /task revision|same request|revision log|recorded revision/i;

// ── CONTROLS ──────────────────────────────────────────────────────────────────────
const control = scenario('control', { steps: [{ prompt: GOAL }, { requirements: [GOAL] }] });
check(verdictOf(control) === 'PASS', 'CONTROL: one unchanged registration still reaches PASS', detail(control));

const addition = scenario('addition', { steps: [{ prompt: GOAL }, { requirements: [GOAL] }, { requirements: [GOAL, EXTRA] }] });
check(verdictOf(addition) !== 'NO-ENVELOPE' && !REVISION.test(issuesOf(addition)),
  'ADDITION: a registration inside one request that only ADDS a requirement raises no revision issue', detail(addition));

const authorized = scenario('authorized', {
  steps: [{ prompt: `${GOAL}\n${EXTRA}` }, { requirements: [GOAL, EXTRA] }, { prompt: GOAL }, { requirements: [GOAL] }],
});
check(verdictOf(authorized) === 'PASS' && !REVISION.test(issuesOf(authorized)),
  'AUTHORIZED: a narrower registration after a NEW user request is an authorized revision', detail(authorized));

// ── ATTACKS ───────────────────────────────────────────────────────────────────────
const drop = scenario('drop', { steps: [{ prompt: GOAL }, { requirements: [GOAL, EXTRA] }, { requirements: [GOAL] }] });
check(verdictOf(drop) !== 'PASS' && /same request/.test(issuesOf(drop)),
  'DROP: removing a requirement inside one request is NOT PROVEN, with an explicit issue', detail(drop));

const tamper = scenario('tamper', {
  steps: [{ prompt: GOAL }, { requirements: [GOAL] }, { requirements: [GOAL, EXTRA] }, { requirements: [GOAL] }],
  tamper: file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 1);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  },
});
check(verdictOf(tamper) !== 'PASS' && /does not chain/.test(issuesOf(tamper)),
  'TAMPER: a revision removed from the middle of the chain is NOT PROVEN', detail(tamper));

const rollback = scenario('rollback', {
  steps: [{ prompt: GOAL }, { requirements: [GOAL, EXTRA] }, { requirements: [GOAL] }],
  tamper: file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
  },
});
check(verdictOf(rollback) !== 'PASS' && /last recorded revision/.test(issuesOf(rollback)),
  'ROLLBACK: a task that is not the last recorded revision is NOT PROVEN', detail(rollback));

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: task revision integrity — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
