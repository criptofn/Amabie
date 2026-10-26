#!/usr/bin/env node
/**
 * T18 / P0:29 — EVIDENCE IS BOUND TO THE EXACT SUBJECT AND SURVIVES RETENTION WHILE A MISSION NEEDS IT.
 *
 *   DIRTY      same HEAD, different uncommitted bytes (edit, delete, untracked, binary) = different snapshot;
 *              undoing the change reproduces the identical snapshot
 *   STALE      a changed or unknown task/oracle/policy/env/subject/snapshot makes evidence stale
 *   STORE      a rewritten payload or binding is refused; an incomplete binding is refused
 *   RETENTION  an entry referenced by an open mission survives routine retention, also after a restart (real
 *              child process); released/done missions free it; unreadable files are kept; purge needs force
 *
 *   node tooling/probes/evidence-binding.mjs
 *
 * Fixtures live only in the OS temp dir. Prints PASS/FAIL; exit 0 only if every expectation held.
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
  const [journalDir, store] = process.argv.slice(ci + 1);
  const r = E.retain(store, { referenced: J.openEvidence(J.readJournal(journalDir).state), maxAgeMs: 0, now: Date.now() + 1000 });
  console.log(JSON.stringify(r));
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-evidence-binding-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };

// DIRTY
{
  const w = path.join(root, 'w');
  fs.mkdirSync(w);
  git(w, 'init', '-q');
  fs.writeFileSync(path.join(w, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(w, 'b.txt'), 'two\n');
  git(w, 'add', '-A'); git(w, 'commit', '-q', '-m', 'base');
  const clean = E.snapshotDigest(w);
  check(E.snapshotDigest(w) === clean, 'DIRTY: an unchanged subject digests identically');
  fs.writeFileSync(path.join(w, 'a.txt'), 'one edited\n');
  const edited = E.snapshotDigest(w);
  check(edited !== clean && edited.split(':').slice(0, 2).join(':') === clean.split(':').slice(0, 2).join(':'), 'DIRTY: the same HEAD with different dirty bytes is a different snapshot', `${clean} ${edited}`);
  fs.writeFileSync(path.join(w, 'a.txt'), 'one edited!\n');
  check(E.snapshotDigest(w) !== edited, 'DIRTY: a one-byte difference between two dirty states is detected');
  fs.writeFileSync(path.join(w, 'a.txt'), 'one\n');
  check(E.snapshotDigest(w) === clean, 'DIRTY: undoing the change reproduces the identical snapshot (replay)');
  fs.rmSync(path.join(w, 'b.txt'));
  const deleted = E.snapshotDigest(w);
  check(deleted !== clean, 'DIRTY: a deleted file changes the snapshot');
  fs.writeFileSync(path.join(w, 'b.txt'), 'two\n');
  fs.writeFileSync(path.join(w, 'new file.txt'), 'x');
  const untracked = E.snapshotDigest(w);
  check(untracked !== clean, 'DIRTY: an untracked file (with a space in its name) changes the snapshot');
  fs.writeFileSync(path.join(w, 'new file.txt'), 'y');
  check(E.snapshotDigest(w) !== untracked, 'DIRTY: untracked content is hashed, not just listed');
  fs.rmSync(path.join(w, 'new file.txt'));
  fs.writeFileSync(path.join(w, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
  const bin1 = E.snapshotDigest(w);
  fs.writeFileSync(path.join(w, 'bin.dat'), Buffer.from([0, 1, 2, 254]));
  check(E.snapshotDigest(w) !== bin1, 'DIRTY: a binary byte flip is detected');
  fs.rmSync(path.join(w, 'bin.dat'));
  git(w, 'commit', '-q', '--allow-empty', '-m', 'move');
  check(E.snapshotDigest(w) !== clean, 'DIRTY: a different HEAD is a different snapshot even with identical bytes');
  check(throws(() => E.snapshotDigest(path.join(root, 'nope')), /./), 'DIRTY: an unidentifiable subject throws instead of guessing');
}

// STALE
{
  const b = { kind: 'check', snapshot: 's1', task: 't1', oracle: 'o1', policy: 'p1', env: 'e1', subject: 'u1' };
  check(E.staleDimensions(b, { snapshot: 's1', task: 't1', oracle: 'o1', policy: 'p1', env: 'e1', subject: 'u1' }).length === 0, 'STALE: nothing changed = not stale');
  for (const d of E.DIMENSIONS) {
    const cur = { snapshot: 's1', task: 't1', oracle: 'o1', policy: 'p1', env: 'e1', subject: 'u1', [d]: 'changed' };
    const s = E.staleDimensions(b, cur);
    check(s.length === 1 && s[0] === d, `STALE: a changed ${d} makes exactly that dimension stale`, JSON.stringify(s));
  }
  const unknown = E.staleDimensions(b, { snapshot: 's1', task: 't1', oracle: 'unknown', policy: 'p1', env: 'e1' });
  check(unknown.includes('oracle') && unknown.includes('subject') && unknown.length === 2, 'STALE: an unknown or missing current dimension is stale (conservative)', JSON.stringify(unknown));
  check(E.staleDimensions({ ...b, env: 'unknown' }, { snapshot: 's1', task: 't1', oracle: 'o1', policy: 'p1', env: 'unknown', subject: 'u1' }).includes('env'), 'STALE: evidence recorded with an unknown dimension never counts as current');
}

// STORE
const store = path.join(root, 'store');
const bind = (over = {}) => ({ kind: 'check', snapshot: 's1', task: 't1', oracle: 'o1', policy: 'p1', env: 'e1', subject: 'u1', ...over });
{
  const id = E.put(store, bind(), 'result: pass', 1000);
  const e = E.get(store, id);
  check(/^[0-9a-f]{64}$/.test(id) && Buffer.from(e.payload, 'base64').toString() === 'result: pass' && e.binding.task === 't1', 'STORE: put/get round-trips payload and binding');
  check(E.put(store, bind(), 'result: pass', 2000) === id, 'STORE: the same binding and payload has the same id');
  check(E.put(store, bind({ task: 't2' }), 'result: pass', 1000) !== id, 'STORE: the same payload under another task is another entry');
  const p = path.join(store, `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...raw, payload: Buffer.from('result: PASS!').toString('base64') }));
  check(throws(() => E.get(store, id), /does not match/), 'STORE: a rewritten payload is refused');
  fs.writeFileSync(p, JSON.stringify({ ...raw, binding: { ...raw.binding, oracle: 'o-other' } }));
  check(throws(() => E.get(store, id), /does not match/), 'STORE: a rewritten binding is refused');
  fs.writeFileSync(p, JSON.stringify(raw));
  check(E.get(store, id).id === id, 'STORE: the restored entry reads again');
  const { oracle, ...incomplete } = bind();
  check(throws(() => E.put(store, incomplete, 'x', 1), /lacks oracle/), 'STORE: an incomplete binding is refused');
  check(throws(() => E.put(store, bind({ env: '' }), 'x', 1), /lacks env/), 'STORE: an empty dimension is refused');
}

// RETENTION with an open mission
{
  const s2 = path.join(root, 'store2');
  const jd = path.join(root, 'journal');
  const used = E.put(s2, bind(), 'needed by the open mission', 1000);
  const spare = E.put(s2, bind({ task: 'other' }), 'nobody needs this', 1000);
  const fresh = E.put(s2, bind({ task: 'fresh' }), 'recent', Date.now() + 10 * 60_000);
  J.transact(jd, [{ type: 'approve', mission: 'm-1', goal: 'Ship it', approvedBy: 'operator' }, { type: 'transition', to: 'working' }, { type: 'evidence', id: used }]);
  const refs = () => J.openEvidence(J.readJournal(jd).state);
  check(refs().has(used) && !refs().has(spare), 'RETENTION: the open mission references exactly the evidence it recorded');
  check(throws(() => J.transact(jd, [{ type: 'evidence', id: used }]), /already referenced/), 'RETENTION: referencing the same evidence twice is refused');
  check(throws(() => J.transact(jd, [{ type: 'evidence', id: 'abc' }]), /64-hex/), 'RETENTION: only a full evidence id can be referenced');

  const r = E.retain(s2, { referenced: refs(), maxAgeMs: 0, now: Date.now() });
  check(r.removed.length === 1 && r.removed[0] === spare && r.kept.includes(used) && r.kept.includes(fresh), 'RETENTION: with a zero age limit the referenced entry survives, the unreferenced old one goes, a recent one stays', JSON.stringify(r));
  check(E.get(s2, used).id === used, 'RETENTION: the surviving entry still verifies');

  const kid = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', jd, s2], { encoding: 'utf8', timeout: 60_000 });
  let out = null; try { out = JSON.parse(kid.stdout.trim().split('\n').pop()); } catch { /* none */ }
  check(kid.status === 0 && out && out.kept.includes(used) && !out.removed.includes(used), 'RETENTION: after a restart (new process reading only the journal) the open mission still protects its evidence', kid.stdout + kid.stderr);

  fs.writeFileSync(path.join(s2, `${'f'.repeat(64)}.json`), '{not json');
  const r2 = E.retain(s2, { referenced: refs(), maxAgeMs: 0, now: Date.now() + 3_600_000 });
  check(r2.kept.includes('f'.repeat(64)) && fs.existsSync(path.join(s2, `${'f'.repeat(64)}.json`)), 'RETENTION: an unreadable entry is kept, never deleted by routine retention');

  check(throws(() => E.purge(s2, used, { referenced: refs() }), /still referenced/) && fs.existsSync(path.join(s2, `${used}.json`)), 'RETENTION: explicit purge of referenced evidence is refused without force');
  J.transact(jd, [{ type: 'evidence-release', id: used }]);
  check(!refs().has(used), 'RETENTION: releasing the reference frees the evidence');
  check(throws(() => J.transact(jd, [{ type: 'evidence-release', id: used }]), /no open evidence reference/), 'RETENTION: releasing an unreferenced id is refused');
  const r3 = E.retain(s2, { referenced: refs(), maxAgeMs: 0, now: Date.now() });
  check(r3.removed.includes(used), 'RETENTION: once released, routine retention may remove it');

  const keep = E.put(s2, bind({ task: 'forced' }), 'force me', 1000);
  J.transact(jd, [{ type: 'evidence', id: keep }]);
  E.purge(s2, keep, { referenced: refs(), force: true });
  check(!fs.existsSync(path.join(s2, `${keep}.json`)), 'RETENTION: an explicit forced delete is still possible');

  const k2 = E.put(s2, bind({ task: 'done-case' }), 'last', 1000);
  J.transact(jd, [{ type: 'evidence', id: k2 }]);
  check(refs().has(k2), 'RETENTION: referenced again while the mission is open');
  // a finished mission no longer holds evidence
  const jd2 = path.join(root, 'journal2');
  const k3 = E.put(s2, bind({ task: 'done-mission' }), 'x', 1000);
  J.transact(jd2, [{ type: 'approve', mission: 'm-2', goal: 'g', approvedBy: 'operator' }, { type: 'transition', to: 'working' }, { type: 'evidence', id: k3 }, { type: 'transition', to: 'verifying' }]);
  check(J.openEvidence(J.readJournal(jd2).state).has(k3), 'RETENTION: a mission under verification still holds its evidence');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
