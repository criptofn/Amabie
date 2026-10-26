#!/usr/bin/env node
/**
 * T16 / P0:27 — SUB-GOALS NEVER STAND IN FOR THE ROOT GOAL, AND NO DUTY IS LOST WHEN THE WORKER CHANGES.
 *
 *   ORDER      a sub-goal cannot be finished before the sub-goal it depends on
 *   ROOT       finishing the last worked sub-goal does not complete the mission; the root goal is checked separately
 *   DUTY       an earlier open duty blocks completion, also after a restart and a second agent taking over
 *   REVISION   an authorized revision turns finished sub-goals stale (unless explicitly kept) and un-verifies the root
 *   HANDOVER   an agent switch is an event; consumed attempts and open duties are not reset by it
 *
 *   node tooling/probes/mission-subgoals.mjs
 *
 * Fixtures live only in the OS temp dir; the second agent is a real child process of this file (`--child`).
 * Prints PASS/FAIL; exit 0 only if every expectation held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const J = await import(pathToFileURL(path.join(repo, 'apps/cli/dist/src/mission-journal.js')).href);

const ci = process.argv.indexOf('--child');
if (ci !== -1) {
  const [dir, arg] = process.argv.slice(ci + 1);
  try { console.log(JSON.stringify(J.transact(dir, JSON.parse(arg)))); process.exit(0); }
  catch (e) { console.log(JSON.stringify({ error: e.message })); process.exit(3); }
}

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-mission-subgoals-'));
let n = 0;
const fresh = () => path.join(root, `m${++n}`);
const tx = (d, events) => { try { return { ok: true, state: J.transact(d, events) }; } catch (e) { return { ok: false, error: e.message }; } };
const second = (d, events) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', d, JSON.stringify(events)], { encoding: 'utf8', timeout: 60_000 });
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* none */ }
  return { code: r.status, out };
};
const start = () => {
  const d = fresh();
  tx(d, [{ type: 'approve', mission: 'm-1', goal: 'Ship the parser', approvedBy: 'operator' }, { type: 'transition', to: 'working' }, { type: 'handover', to: 'agent-a' }]);
  return d;
};

// ORDER + ROOT
{
  const d = start();
  tx(d, [{ type: 'subgoal', id: 'a', goal: 'reject empty input' }, { type: 'subgoal', id: 'b', goal: 'report byte offsets', dependsOn: ['a'] }]);
  const early = tx(d, [{ type: 'subgoal-done', id: 'b' }]);
  check(!early.ok && /depends on a/.test(early.error), 'ORDER: a dependent sub-goal cannot be finished before its dependency', JSON.stringify(early));
  const unknown = tx(d, [{ type: 'subgoal', id: 'c', goal: 'x', dependsOn: ['ghost'] }]);
  check(!unknown.ok && /unknown ghost/.test(unknown.error), 'ORDER: a dependency on an unknown sub-goal is refused', JSON.stringify(unknown));
  tx(d, [{ type: 'subgoal-done', id: 'a' }, { type: 'subgoal-done', id: 'b' }, { type: 'transition', to: 'verifying' }]);
  const premature = tx(d, [{ type: 'transition', to: 'done' }]);
  check(!premature.ok && /root goal has not been verified/.test(premature.error), 'ROOT: every sub-goal done is still not the mission done', JSON.stringify(premature));
  const outside = tx(d, [{ type: 'transition', to: 'working' }, { type: 'root-verified' }]);
  check(!outside.ok && /not working/.test(outside.error) && J.readJournal(d).state.status === 'verifying', 'ROOT: the root check is refused outside verifying and the refused transaction wrote nothing', JSON.stringify(outside));
  const finished = tx(d, [{ type: 'root-verified' }, { type: 'transition', to: 'done' }]);
  check(finished.ok && finished.state.status === 'done', 'ROOT: after the explicit root check the mission completes', JSON.stringify(finished));
}

// DUTY + HANDOVER across a restart
{
  const d = start();
  tx(d, [{ type: 'duty', id: 'd1', text: 'keep CRLF line endings' }, { type: 'attempt' }, { type: 'subgoal', id: 'a', goal: 'reject empty input' }]);
  const taken = second(d, [{ type: 'handover', to: 'agent-b' }, { type: 'subgoal', id: 'b', goal: 'report byte offsets' }, { type: 'subgoal-done', id: 'a' }, { type: 'subgoal-done', id: 'b' }, { type: 'transition', to: 'verifying' }, { type: 'root-verified' }]);
  const s = taken.out;
  check(taken.code === 0 && s.agent === 'agent-b' && s.attemptsUsed === 1 && s.duties[0].open,
    'HANDOVER: the second agent continues; attempts stay used and the earlier duty stays open', JSON.stringify(taken));
  const blocked = second(d, [{ type: 'transition', to: 'done' }]);
  check(blocked.code === 3 && /duty d1/.test(blocked.out.error), 'DUTY: the earlier open duty blocks completion even though both sub-goals are done and the root was checked', JSON.stringify(blocked));
  const reopened = tx(d, [{ type: 'duty-close', id: 'd1' }]);
  check(reopened.ok && J.readJournal(d).state.rootVerified === true, 'DUTY: closing a duty is its own event', JSON.stringify(reopened));
  const bad = tx(d, [{ type: 'duty-close', id: 'd1' }]);
  check(!bad.ok, 'DUTY: closing a duty twice is refused', JSON.stringify(bad));
  const newDuty = tx(d, [{ type: 'duty', id: 'd2', text: 'update docs' }]);
  check(newDuty.ok && newDuty.state.rootVerified === false, 'DUTY: a new duty un-verifies the root goal', JSON.stringify(newDuty));
}

// REVISION
{
  const d = start();
  tx(d, [{ type: 'subgoal', id: 'a', goal: 'one' }, { type: 'subgoal', id: 'b', goal: 'two' }, { type: 'subgoal-done', id: 'a' }, { type: 'subgoal-done', id: 'b' }, { type: 'transition', to: 'verifying' }, { type: 'root-verified' }]);
  const r = tx(d, [{ type: 'revise', goal: 'Ship the parser with offsets', approvedBy: 'operator', keep: ['a'] }]);
  const st = Object.fromEntries((r.state?.subgoals ?? []).map(g => [g.id, g.status]));
  check(r.ok && st.a === 'done' && st.b === 'stale' && r.state.rootVerified === false && r.state.status === 'approved',
    'REVISION: kept sub-goal stays done, the other turns stale, the root is un-verified', JSON.stringify(r));
  tx(d, [{ type: 'transition', to: 'working' }]);
  const refused = tx(d, [{ type: 'transition', to: 'verifying' }, { type: 'root-verified' }, { type: 'transition', to: 'done' }]);
  check(!refused.ok && /sub-goal b \(stale\)/.test(refused.error), 'REVISION: a stale sub-goal blocks completion until it is redone', JSON.stringify(refused));
  const noKeep = tx(start(), [{ type: 'subgoal', id: 'a', goal: 'one' }, { type: 'subgoal-done', id: 'a' }, { type: 'revise', goal: 'new order', approvedBy: 'operator' }]);
  check(noKeep.ok && noKeep.state.subgoals[0].status === 'stale', 'REVISION: without an explicit keep every finished sub-goal is invalidated (conservative)', JSON.stringify(noKeep));
}

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: mission sub-goals — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
