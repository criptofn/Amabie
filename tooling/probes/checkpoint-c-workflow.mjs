#!/usr/bin/env node
/**
 * Checkpoint C / P0:30 — ONE SMALL REAL WORKFLOW through journal, sub-goals, leases and bound evidence.
 *
 *   STATUS     each sub-goal, the root goal and the mission have their own status; none stands in for another
 *   EVIDENCE   a result is bound to the exact dirty bytes it was measured on and goes stale when they change
 *   BUDGET     consumed correction attempts are not reset by a restart, an agent switch or a new process
 *   SESSIONS   a second session with an older view cannot overwrite; an overlapping area is refused
 *   RETENTION  evidence the open mission still needs survives retention; finishing the mission frees it
 *
 *   node tooling/probes/checkpoint-c-workflow.mjs
 *
 * A real git repository and the second session (a real child process of this file) live only in the OS temp dir.
 * Prints PASS/FAIL; exit 0 only if every expectation held.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dist = m => pathToFileURL(path.join(repo, `apps/cli/dist/src/${m}.js`)).href;
const E = await import(dist('evidence-binding'));
const J = await import(dist('mission-journal'));

const ci = process.argv.indexOf('--child');
if (ci !== -1) {
  const [dir, arg, seq] = process.argv.slice(ci + 1);
  try { console.log(JSON.stringify(J.transact(dir, JSON.parse(arg), seq === undefined ? undefined : Number(seq)))); process.exit(0); }
  catch (e) { console.log(JSON.stringify({ error: e.message })); process.exit(3); }
}

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-checkpoint-c-'));
const w = path.join(root, 'work'), jd = path.join(root, 'journal'), store = path.join(root, 'evidence');
const git = (...a) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: w, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tx = (events, seq) => { try { return { ok: true, state: J.transact(jd, events, seq) }; } catch (e) { return { ok: false, error: e.message }; } };
const session = (events, seq) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', jd, JSON.stringify(events), ...(seq === undefined ? [] : [String(seq)])], { encoding: 'utf8', timeout: 60_000 });
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* none */ }
  return { code: r.status, out };
};
const state = () => J.readJournal(jd).state;

fs.mkdirSync(path.join(w, 'src'), { recursive: true });
git('init', '-q');
fs.writeFileSync(path.join(w, 'src', 'parser.js'), 'export const parse = s => s;\n');
git('add', '-A'); git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD').trim();

// agent A takes the mission
tx([{ type: 'approve', mission: 'cp-c', goal: 'Reject empty input and report byte offsets', approvedBy: 'operator' }, { type: 'transition', to: 'working' }, { type: 'handover', to: 'agent-a' },
  { type: 'subgoal', id: 'empty', goal: 'reject empty input' }, { type: 'subgoal', id: 'offsets', goal: 'report byte offsets', dependsOn: ['empty'] },
  { type: 'duty', id: 'docs', text: 'document the new error' },
  { type: 'assign', id: 'a1', worker: 'agent-a', paths: ['src'], baseHead: base, at: 1000, ttlMs: 600_000 }]);
const lease = state().assignments[0];

// STATUS
{
  const early = tx([{ type: 'subgoal-done', id: 'offsets' }]);
  check(!early.ok && /depends on empty/.test(early.error), 'STATUS: a sub-goal cannot be finished before the one it depends on', JSON.stringify(early));
  tx([{ type: 'subgoal-done', id: 'empty' }, { type: 'subgoal-done', id: 'offsets' }, { type: 'transition', to: 'verifying' }]);
  const notDone = tx([{ type: 'transition', to: 'done' }]);
  check(!notDone.ok && /duty docs/.test(notDone.error), 'STATUS: all sub-goals done is not mission done while a duty is open', JSON.stringify(notDone));
  tx([{ type: 'transition', to: 'working' }]);
}

// EVIDENCE bound to exact dirty bytes
const dims = snap => ({ kind: 'test-run', snapshot: snap, task: 'task-1', oracle: 'oracle-1', policy: 'policy-1', env: 'node-26', subject: 'src/parser.js' });
fs.writeFileSync(path.join(w, 'src', 'parser.js'), "export const parse = s => { if (!s) throw new Error('empty'); return s; };\n");
const snapA = E.snapshotDigest(w);
const evId = E.put(store, dims(snapA), 'tests: 4 passed', 2000);
tx([{ type: 'evidence', id: evId }, { type: 'attempt', note: 'agent-a: first fix' }]);
{
  const cur = () => ({ ...dims(E.snapshotDigest(w)) });
  check(E.staleDimensions(E.get(store, evId).binding, cur()).length === 0, 'EVIDENCE: unchanged dirty bytes = current evidence');
  fs.appendFileSync(path.join(w, 'src', 'parser.js'), '// tweak\n');
  const stale = E.staleDimensions(E.get(store, evId).binding, cur());
  check(stale.length === 1 && stale[0] === 'snapshot', 'EVIDENCE: the same HEAD with one more dirty line makes it stale', JSON.stringify(stale));
  fs.writeFileSync(path.join(w, 'src', 'parser.js'), "export const parse = s => { if (!s) throw new Error('empty'); return s; };\n");
  check(E.staleDimensions(E.get(store, evId).binding, cur()).length === 0, 'EVIDENCE: undoing the line makes it current again');
  check(E.staleDimensions(E.get(store, evId).binding, { ...cur(), oracle: 'oracle-2' }).join() === 'oracle', 'EVIDENCE: a changed oracle makes it stale');
}

// BUDGET across restart and agent switch (second session = separate process)
{
  tx([{ type: 'attempt', note: 'agent-a: second fix' }]);
  const b = session([{ type: 'handover', to: 'agent-b' }, { type: 'attempt', note: 'agent-b: third fix' }]);
  check(b.code === 0 && b.out.attemptsUsed === 3 && b.out.agent === 'agent-b', 'BUDGET: a new process and a new agent continue at attempt 3, not at 1', JSON.stringify(b));
  const c = session([{ type: 'attempt', note: 'agent-b: fourth' }]);
  check(c.code === 3 && /limit 3/.test(c.out.error), 'BUDGET: the fourth attempt is refused in the new process', JSON.stringify(c));
  const d = session([{ type: 'revise', goal: 'Reject empty input, offsets in bytes', approvedBy: 'operator' }]);
  check(d.code === 0 && state().attemptsUsed === 3, 'BUDGET: even an authorized revision does not reset consumed attempts', JSON.stringify(state().attemptsUsed));
}

// SESSIONS
{
  const seq = J.readJournal(jd).seq;
  const first = session([{ type: 'duty', id: 'x1', text: 'from session 1' }], seq);
  const second = session([{ type: 'duty', id: 'x2', text: 'from session 2' }], seq);
  check(first.code === 0 && second.code === 3 && /moved/.test(second.out.error) && !state().duties.some(x => x.id === 'x2'), 'SESSIONS: a second session holding the old view is refused, nothing is overwritten', JSON.stringify({ first, second }));
  tx([{ type: 'transition', to: 'working' }]);
  const clash = tx([{ type: 'assign', id: 'b1', worker: 'agent-b', paths: ['src/parser.js'], baseHead: base, at: 2000, ttlMs: 1000 }]);
  check(!clash.ok && /held by agent-a/.test(clash.error), 'SESSIONS: an overlapping area is refused while the first lease is live', JSON.stringify(clash));
}

// RETENTION and finish
{
  const spare = E.put(store, { ...dims(snapA), task: 'task-0' }, 'old and unneeded', 1);
  const kept = E.retain(store, { referenced: J.openEvidence(state()), maxAgeMs: 0, now: Date.now() });
  check(kept.kept.includes(evId) && kept.removed.includes(spare), 'RETENTION: the open mission keeps its evidence, the unneeded old entry goes', JSON.stringify(kept));
  tx([{ type: 'duty-close', id: 'docs' }, { type: 'duty-close', id: 'x1' }]);
  const reopen = state();
  check(reopen.subgoals.every(g => g.status === 'stale'), 'STATUS: the revision made the earlier sub-goal results stale', JSON.stringify(reopen.subgoals));
  tx([{ type: 'subgoal-done', id: 'empty' }, { type: 'subgoal-done', id: 'offsets' }, { type: 'transition', to: 'verifying' }]);
  const unverified = tx([{ type: 'transition', to: 'done' }]);
  check(!unverified.ok && /root goal/.test(unverified.error), 'STATUS: finishing the last sub-goal does not verify the root goal', JSON.stringify(unverified));
  const fin = tx([{ type: 'root-verified' }, { type: 'transition', to: 'done' }]);
  check(fin.ok && fin.state.status === 'done', 'STATUS: root goal verified separately, then the mission is done', JSON.stringify(fin));
  check(J.openEvidence(state()).size === 0, 'RETENTION: a finished mission no longer holds evidence');
  check(lease.token === 1 && state().assignments[0].status === 'active', 'STATUS: the unreleased lease is still recorded as such, not silently closed by completion');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
