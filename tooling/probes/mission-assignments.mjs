#!/usr/bin/env node
/**
 * T17 / P0:28 — PARALLEL WORKERS GET SEPARATE CHANGE AREAS, AND A COLLISION IS CAUGHT BEFORE RELEASE.
 *
 *   SEPARATE   two real worker processes claim clearly separated areas at once: both win, tokens differ
 *   COLLIDE    six real processes claim overlapping areas (same, nested, other letter case): exactly one wins
 *   REAL WORK  two real git worktrees with uncommitted and untracked changes: each releases only its own area,
 *              and neither worker's uncommitted bytes are touched by the other's release
 *   OVERSHOOT  a changeset that leaves the claimed area (also uncommitted/untracked) is refused at release
 *   BASELINE   a baseline that moved under the claimed area is detected before release; rebase makes it releasable
 *   LOST       an expired lease is recorded as expired when taken over; its old token can renew/rebase/release nothing,
 *              neither before nor after the takeover, and the takeover token is strictly higher
 *   RESTART    a fresh process reads the same assignments
 *
 *   node tooling/probes/mission-assignments.mjs
 *
 * Fixtures live only in the OS temp dir; workers are real child processes of this file (`--child`).
 * Prints PASS/FAIL; exit 0 only if every expectation held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const J = await import(pathToFileURL(path.join(repo, 'apps/cli/dist/src/mission-journal.js')).href);

const ci = process.argv.indexOf('--child');
if (ci !== -1) {
  const [dir, arg] = process.argv.slice(ci + 1);
  try { console.log(JSON.stringify(arg === 'read' ? J.readJournal(dir).state : J.transact(dir, JSON.parse(arg)))); process.exit(0); }
  catch (e) { console.log(JSON.stringify({ error: e.message })); process.exit(3); }
}

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-mission-assign-'));
let n = 0;
const fresh = () => path.join(root, `m${++n}`);
const tx = (d, events) => { try { return { ok: true, state: J.transact(d, events) }; } catch (e) { return { ok: false, error: e.message }; } };
const worker = (d, events) => new Promise(resolve => {
  let out = '';
  const k = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', d, events === 'read' ? 'read' : JSON.stringify(events)], { stdio: ['ignore', 'pipe', 'ignore'] });
  k.stdout.on('data', c => { out += c; });
  k.on('exit', code => { let o = null; try { o = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ } resolve({ code, out: o }); });
});
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const started = () => {
  const d = fresh();
  tx(d, [{ type: 'approve', mission: 'm-1', goal: 'Refactor in parallel', approvedBy: 'operator' }, { type: 'transition', to: 'working' }]);
  return d;
};
const A = (id, worker_, paths, baseHead, at, ttlMs = 60_000) => ({ type: 'assign', id, worker: worker_, paths, baseHead, at, ttlMs });
const asg = (d, id) => J.readJournal(d).state.assignments.find(x => x.id === id);

// SEPARATE + COLLIDE with real concurrent processes
{
  const d = started();
  const two = await Promise.all([worker(d, [A('w1', 'agent-1', ['src/parser'], 'h0', 1000)]), worker(d, [A('w2', 'agent-2', ['src/render'], 'h0', 1000)])]);
  const s = J.readJournal(d).state;
  check(two.every(r => r.code === 0) && s.assignments.length === 2 && s.assignments[0].token !== s.assignments[1].token,
    'SEPARATE: two workers claim separated areas at the same time; both hold a lease with distinct tokens', JSON.stringify(two));

  const d2 = started();
  const claims = [['src/lib'], ['src/lib/deep/file.ts'], ['SRC/LIB'], ['src\\lib'], ['./src/lib/'], ['src/lib/deep']];
  const res = await Promise.all(claims.map((p, i) => worker(d2, [A(`c${i}`, `agent-${i}`, p, 'h0', 1000)])));
  const won = res.filter(r => r.code === 0).length;
  const s2 = J.readJournal(d2).state;
  check(won === 1 && s2.assignments.length === 1 && res.filter(r => r.code === 3).every(r => /held by/.test(r.out.error)),
    'COLLIDE: six concurrent claims on one area (same, nested, other case, other slash) — exactly one wins, the rest are refused', JSON.stringify({ won, res: res.map(r => r.out?.error ?? 'ok') }));

  const bad = ['../outside', '/abs/path', 'C:/win', 'a/../b', ''].map(p => tx(d, [A('x', 'agent', [p], 'h0', 1000)]));
  check(bad.every(r => !r.ok && /repo-relative/.test(r.error)), 'COLLIDE: absolute, parent-escaping and empty areas are refused', JSON.stringify(bad));
  const dup = tx(d, [A('w1', 'agent-3', ['docs'], 'h0', 1000)]);
  check(!dup.ok && /already exists/.test(dup.error), 'COLLIDE: an assignment id cannot be claimed twice', JSON.stringify(dup));
}

// REAL WORK in two real git worktrees
{
  const main = path.join(root, 'repo');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  for (const f of ['a/x.txt', 'b/y.txt', 'shared/z.txt']) { fs.mkdirSync(path.join(main, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(main, f), `base ${f}\n`); }
  git(main, 'add', '-A'); git(main, 'commit', '-q', '-m', 'base');
  const base = git(main, 'rev-parse', 'HEAD');
  const wa = path.join(root, 'wt-a'), wb = path.join(root, 'wt-b');
  git(main, 'worktree', 'add', '-q', '-b', 'work-a', wa, base);
  git(main, 'worktree', 'add', '-q', '-b', 'work-b', wb, base);

  const d = started();
  tx(d, [A('wa', 'agent-a', ['a'], base, 1000), A('wb', 'agent-b', ['b'], base, 1000)]);
  const ta = asg(d, 'wa').token, tb = asg(d, 'wb').token;

  // uncommitted work in both trees, at the same time
  fs.writeFileSync(path.join(wa, 'a/x.txt'), 'A edited\n'); fs.writeFileSync(path.join(wa, 'a/new.txt'), 'A new\n');
  fs.writeFileSync(path.join(wb, 'b/y.txt'), 'B edited\n');
  const ca = J.changedPaths(wa, base), cb = J.changedPaths(wb, base);
  check(ca.sort().join() === 'a/new.txt,a/x.txt' && cb.join() === 'b/y.txt', 'REAL WORK: the changeset includes uncommitted and untracked bytes of each worktree', JSON.stringify({ ca, cb }));

  const relA = tx(d, [{ type: 'release', id: 'wa', token: ta, at: 2000, changed: ca, baseMoved: J.baselineMoves(wa, base, 'HEAD') }]);
  const stillB = fs.readFileSync(path.join(wb, 'b/y.txt'), 'utf8') === 'B edited\n' && J.changedPaths(wb, base).join() === 'b/y.txt';
  check(relA.ok && asg(d, 'wa').status === 'released' && asg(d, 'wb').status === 'active' && stillB,
    'REAL WORK: worker A releases its own area; worker B is still active and its uncommitted bytes are untouched', JSON.stringify(relA));

  // OVERSHOOT: B also touches shared/ (uncommitted) and an untracked file in A's area
  fs.writeFileSync(path.join(wb, 'shared/z.txt'), 'B overshoot\n'); fs.writeFileSync(path.join(wb, 'a-leak.txt'), 'leak\n');
  const over = tx(d, [{ type: 'release', id: 'wb', token: tb, at: 2000, changed: J.changedPaths(wb, base), baseMoved: [] }]);
  check(!over.ok && /outside the assigned area: .*shared\/z\.txt/.test(over.error) && asg(d, 'wb').status === 'active',
    'OVERSHOOT: a changeset leaving the claimed area is refused at release and nothing is recorded', JSON.stringify(over));
  fs.writeFileSync(path.join(wb, 'shared/z.txt'), 'base shared/z.txt\n'); fs.rmSync(path.join(wb, 'a-leak.txt'));
  git(wb, 'checkout', '-q', '--', 'shared/z.txt');

  // BASELINE: the shared line moves under B's area while B works
  fs.writeFileSync(path.join(main, 'b/y.txt'), 'main moved y\n');
  git(main, 'commit', '-q', '-am', 'someone else changed b/y.txt');
  const head2 = git(main, 'rev-parse', 'HEAD');
  const moved = J.baselineMoves(main, base, head2);
  const stale = tx(d, [{ type: 'release', id: 'wb', token: tb, at: 2000, changed: J.changedPaths(wb, base), baseMoved: moved }]);
  check(moved.join() === 'b/y.txt' && !stale.ok && /baseline moved under the assigned work: b\/y\.txt/.test(stale.error),
    'BASELINE: a moved baseline under the claimed area is detected before release', JSON.stringify({ moved, stale }));
  const unrelated = tx(d, [{ type: 'rebase', id: 'wb', token: tb, baseHead: head2, at: 2100 }, { type: 'release', id: 'wb', token: tb, at: 2200, changed: ['b/y.txt'], baseMoved: ['elsewhere/q.txt'] }]);
  check(unrelated.ok && asg(d, 'wb').status === 'released' && asg(d, 'wb').baseHead === head2,
    'BASELINE: after a controlled rebase, movement outside the claimed area does not block the release', JSON.stringify(unrelated));
}

// LOST responsibility
{
  const d = started();
  tx(d, [A('old', 'agent-old', ['pkg/core'], 'h0', 1000, 500)]);
  const t1 = asg(d, 'old').token;
  const early = tx(d, [A('thief', 'agent-new', ['pkg/core/inner'], 'h0', 1200)]);
  check(!early.ok && /held by agent-old/.test(early.error), 'LOST: a live lease cannot be taken over', JSON.stringify(early));
  const late = tx(d, [{ type: 'release', id: 'old', token: t1, at: 1600, changed: [], baseMoved: [] }]);
  check(!late.ok && /expired at 1500/.test(late.error), 'LOST: an expired lease cannot be released later, even without a takeover', JSON.stringify(late));
  const take = tx(d, [A('new', 'agent-new', ['pkg/core'], 'h1', 2000)]);
  const t2 = asg(d, 'new')?.token;
  check(take.ok && asg(d, 'old').status === 'expired' && t2 > t1, 'LOST: after expiry the area is taken over; the old lease is recorded as expired, the new token is higher', JSON.stringify(take));
  const replay = ['renew', 'rebase', 'release'].map(type => tx(d, [{ type, id: 'old', token: t1, at: 2001, ttlMs: 9999, baseHead: 'h9', changed: [], baseMoved: [] }]));
  check(replay.every(r => !r.ok && /responsibility was lost/.test(r.error)), 'LOST: the old holder can neither renew, rebase nor release with its old token', JSON.stringify(replay));
  const wrong = tx(d, [{ type: 'release', id: 'new', token: t1, at: 2001, changed: [], baseMoved: [] }]);
  check(!wrong.ok && /token .* is void/.test(wrong.error), 'LOST: a token from another lease cannot release the new one', JSON.stringify(wrong));
  const renewed = tx(d, [{ type: 'renew', id: 'new', token: t2, at: 2400, ttlMs: 1000 }, { type: 'release', id: 'new', token: t2, at: 3300, changed: ['pkg/core/a.ts'], baseMoved: [] }]);
  check(renewed.ok && asg(d, 'new').status === 'released', 'LOST: the current holder renews before expiry and then releases', JSON.stringify(renewed));
  const again = tx(d, [{ type: 'release', id: 'new', token: t2, at: 3301, changed: [], baseMoved: [] }]);
  check(!again.ok && /already released/.test(again.error), 'LOST: a released assignment cannot be released twice', JSON.stringify(again));
  tx(d, [A('n3', 'agent-3', ['docs'], 'h1', 5000, 100)]);
  const back = tx(d, [{ type: 'renew', id: 'n3', token: asg(d, 'n3').token, at: 1, ttlMs: 50 }]);
  check(back.ok && back.state.clock === 5000 && asg(d, 'n3').expiresAt === 5050,
    'LOST: a caller clock that goes backwards does not move the journal clock back (no lease can be stretched into the past)', JSON.stringify(back));
  // RESTART
  const r = await worker(d, 'read');
  check(r.code === 0 && r.out.assignments.length === 3 && r.out.fence === 3 && r.out.clock === 5000,
    'RESTART: a fresh process reads the same assignments, fence and clock', JSON.stringify(r));
}

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: mission assignments — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
