#!/usr/bin/env node
/**
 * T15 / P0:26 — A MISSION SURVIVES A RESTART, AN INTERRUPTED TRANSACTION AND A CONCURRENT WRITER.
 *
 *   RESTART        order, revision, state and CONSUMED ATTEMPTS are read back by a fresh process
 *   LIMIT          the attempt limit still refuses after a restart (no silent budget reset)
 *   TORN TAIL      a writer that died mid-append leaves the previous consistent state, then healing append works
 *   ATOMIC         a transaction containing an illegal step writes NOTHING (no half-applied transitions)
 *   CORRUPTION     a damaged middle record, or a projection the events do not produce, is BLOCKED — never repaired
 *   NO DEFAULT     an empty/forged journal never yields an approved mission
 *   CAS / LOCK     a stale writer is refused; concurrent writers all land in one valid chain
 *
 *   node tooling/probes/mission-journal.mjs
 *
 * Fixtures live only in the OS temp dir. Children are real processes of this same file (`--child`).
 * Prints PASS/FAIL; exit 0 only if every expectation held.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const lib = pathToFileURL(path.join(repo, 'apps/cli/dist/src/mission-journal.js')).href;
const J = await import(lib);

// ── child mode: act on a journal dir, then exit (or die) ────────────────────────────
const ci = process.argv.indexOf('--child');
if (ci !== -1) {
  const [mode, dir, arg] = process.argv.slice(ci + 1);
  try {
    if (mode === 'tx') { const s = J.transact(dir, JSON.parse(arg)); console.log(JSON.stringify(s)); }
    else if (mode === 'read') { const r = J.readJournal(dir); console.log(JSON.stringify({ status: r.status, seq: r.seq, state: r.state, torn: r.tornTail, reason: r.reason })); }
    else if (mode === 'die-mid-append') {
      // Same bytes a real append would write, cut off before the newline: the process dies mid-write.
      const cur = J.readJournal(dir);
      const body = JSON.stringify({ seq: cur.seq + 1, prev: cur.lastSum, events: [{ type: 'attempt' }], projection: cur.state });
      const line = `${crypto.createHash('sha256').update(body).digest('hex')} ${body}`;
      fs.appendFileSync(J.journalPath(dir), line.slice(0, Math.floor(line.length / 2)));
      process.exit(137);
    }
  } catch (e) { console.log(JSON.stringify({ error: e.message })); process.exit(3); }
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-mission-journal-'));
let n = 0;
const fresh = () => path.join(root, `m${++n}`);
const child = (mode, dir, arg = '') => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', mode, dir, arg], { encoding: 'utf8', timeout: 60_000 });
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* none */ }
  return { code: r.status, out };
};
const APPROVE = { type: 'approve', mission: 'm-1', goal: 'Fix the greeting', approvedBy: 'operator' };

// RESTART + LIMIT
{
  const d = fresh();
  child('tx', d, JSON.stringify([APPROVE, { type: 'transition', to: 'working' }]));
  child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  const r = child('read', d).out;
  check(r.status === 'ok' && r.state.attemptsUsed === 2 && r.state.status === 'working' && r.state.goal === 'Fix the greeting' && r.state.revision === 1,
    'RESTART: a fresh process reads order, revision, status and the two consumed attempts', JSON.stringify(r));
  child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  const over = child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  check(over.code === 3 && /limit 3/.test(over.out.error), 'LIMIT: the 4th attempt is refused by a new process — no budget reset on restart', JSON.stringify(over));
  const rev = child('tx', d, JSON.stringify([{ type: 'revise', goal: 'Fix the greeting and the farewell', approvedBy: 'operator' }]));
  check(rev.out.attemptsUsed === 3 && rev.out.revision === 2, 'LIMIT: an authorized revision does not give the used attempts back', JSON.stringify(rev));
}

// TORN TAIL
{
  const d = fresh();
  child('tx', d, JSON.stringify([APPROVE, { type: 'transition', to: 'working' }]));
  const died = child('die-mid-append', d);
  const r = child('read', d).out;
  check(died.code === 137 && r.status === 'ok' && r.torn && r.seq === 1 && r.state.attemptsUsed === 0,
    'TORN TAIL: the writer died mid-append; the previous consistent state is the truth', JSON.stringify({ died: died.code, r }));
  const healed = child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  const after = child('read', d).out;
  check(healed.code === 0 && after.status === 'ok' && !after.torn && after.seq === 2 && after.state.attemptsUsed === 1,
    'TORN TAIL: the next append drops the fragment and the journal is whole again', JSON.stringify({ healed, after }));
}

// ATOMIC
{
  const d = fresh();
  child('tx', d, JSON.stringify([APPROVE, { type: 'transition', to: 'working' }]));
  const before = fs.readFileSync(J.journalPath(d));
  const bad = child('tx', d, JSON.stringify([{ type: 'transition', to: 'verifying' }, { type: 'transition', to: 'done' }, { type: 'attempt' }]));
  check(bad.code === 3 && Buffer.compare(before, fs.readFileSync(J.journalPath(d))) === 0,
    'ATOMIC: a transaction whose last step is illegal writes nothing — no half-applied transitions', JSON.stringify(bad));
  const skip = child('tx', d, JSON.stringify([{ type: 'transition', to: 'done' }]));
  check(skip.code === 3, 'ATOMIC: working -> done without verification is refused', JSON.stringify(skip));
}

// CORRUPTION / NO DEFAULT
{
  const d = fresh();
  const empty = child('read', d).out;
  check(empty.status === 'ok' && empty.state.status === 'none' && empty.state.approvedBy === null && empty.state.mission === null,
    'NO DEFAULT: no journal means no mission and no approval', JSON.stringify(empty));
  child('tx', d, JSON.stringify([APPROVE]));
  child('tx', d, JSON.stringify([{ type: 'transition', to: 'working' }]));
  child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  const file = J.journalPath(d);
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.replace('Fix the greeting', 'Fix the greetinG'));
  const damaged = child('read', d).out;
  check(damaged.status === 'blocked' && /checksum/.test(damaged.reason), 'CORRUPTION: a damaged middle record is BLOCKED, not repaired', JSON.stringify(damaged));
  const refused = child('tx', d, JSON.stringify([{ type: 'attempt' }]));
  check(refused.code === 3 && /blocked/.test(refused.out.error), 'CORRUPTION: a blocked journal accepts no further writes', JSON.stringify(refused));

  // A forged but self-consistent line: valid checksum + chain, but it claims an approval no event made.
  const body = JSON.stringify({ seq: 1, prev: '', events: [{ type: 'transition', to: 'working' }], projection: { ...J.emptyState(), status: 'working', approvedBy: 'operator', mission: 'x', goal: 'x', revision: 1 } });
  const forged = fresh(); fs.mkdirSync(forged, { recursive: true });
  fs.writeFileSync(J.journalPath(forged), `${crypto.createHash('sha256').update(body).digest('hex')} ${body}\n`);
  const f = child('read', forged).out;
  check(f.status === 'blocked', 'NO DEFAULT: a record whose events do not create the approval it claims is BLOCKED', JSON.stringify(f));
  const body2 = JSON.stringify({ seq: 1, prev: '', events: [APPROVE], projection: { ...J.emptyState(), status: 'approved', approvedBy: 'someone-else', mission: 'm-1', goal: 'Fix the greeting', revision: 1 } });
  const lie = fresh(); fs.mkdirSync(lie, { recursive: true });
  fs.writeFileSync(J.journalPath(lie), `${crypto.createHash('sha256').update(body2).digest('hex')} ${body2}\n`);
  check(child('read', lie).out.status === 'blocked', 'NO DEFAULT: a stored projection that differs from the events is BLOCKED');
}

// CAS + LOCK
{
  const d = fresh();
  child('tx', d, JSON.stringify([APPROVE, { type: 'transition', to: 'working' }]));
  let stale = null;
  try { J.transact(d, [{ type: 'attempt' }], 0); } catch (e) { stale = e.message; }
  check(stale !== null && /moved/.test(stale), 'CAS: a writer holding an older seq is refused', String(stale));
  const kids = Array.from({ length: 6 }, (_, i) => new Promise(resolve => {
    const k = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', 'tx', d, JSON.stringify([{ type: 'revise', goal: `goal ${i}`, approvedBy: 'operator' }])], { stdio: 'ignore' });
    k.on('exit', code => resolve(code));
  }));
  const codes = await Promise.all(kids);
  const r = J.readJournal(d);
  check(codes.every(c => c === 0) && r.status === 'ok' && r.seq === 7 && r.state.revision === 7,
    'LOCK: six concurrent writers all land in one valid, gap-free chain', JSON.stringify({ codes, seq: r.seq, status: r.status, reason: r.reason }));
  fs.writeFileSync(path.join(d, 'journal.lock'), '99999999'); // a dead holder
  check((() => { try { J.transact(d, [{ type: 'revise', goal: 'after stale lock', approvedBy: 'operator' }]); return true; } catch { return false; } })(),
    'LOCK: a lock left by a dead process does not wedge the journal');
}

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: mission journal — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
