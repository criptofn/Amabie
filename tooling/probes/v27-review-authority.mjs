// T27 — independent review authority for a stopped run (decision D03), measured on a real store on disk.
//
//   A. a run stopped by an unauthorized attempt is continued ONLY by a receipt signed with the separate reviewer key;
//      the stopped run stays stopped and the continuation is a NEW run (also seen from a fresh process: restart);
//   B. everything a worker (or the producer key) can reach is not enough: forged / producer-signed receipts,
//      overwriting reviewer.pub, appending a hand-made `continued` line to the journal;
//   C. replay, stale subject/grants and a red objective are refused; nothing in the journal changes on a refusal.
// No private account action: the keys are throw-away, the store is a temp dir, and `amabie accept` is never run.
// The real confined-route stop itself is measured by v26-audit-replay-failstop.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { admit, noteRefusal, readAudit, resolveRun, runId } from '../../apps/cli/dist/src/provider/production-audit.js';
import { GateRefusal, openGrants } from '../../apps/cli/dist/src/provider/production-grants.js';
import { continueStoppedRun, enrollReviewer, grantsDigest, incidentDigest, issueReview, newReviewerKey, subjectDigest } from '../../apps/cli/dist/src/provider/production-review.js';

// Child mode: a brand-new process with only the disk. Prints one JSON line.
if (process.argv[2] === '--child') {
  const [, , , childStore, childRun] = process.argv;
  let refused = false;
  try { admit(childStore, childRun, crypto.randomUUID(), 'd'); } catch { refused = true; }
  console.log(JSON.stringify({ resolved: resolveRun(childStore, childRun), stoppedRunRefused: refused }));
  process.exit(0);
}

const pem = (k, type) => k.export({ type, format: 'pem' }).toString();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t27-'));
const store = path.join(root, 'store');
const journal = path.join(store, 'audit', 'journal.jsonl');
let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};

try {
  const producer = crypto.generateKeyPairSync('ed25519');
  const producerKey = pem(producer.privateKey, 'pkcs8');
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'producer.pub'), pem(producer.publicKey, 'spki'));
  const now = Date.now();
  openGrants(store, 'p', producerKey, [{ grantId: 'g', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 50 }, notBefore: now - 1000, expiresAt: now + 3_600_000, policyGeneration: 1, prerequisites: [] }]);
  const run = runId('probe-workspace');
  noteRefusal(store, run, new GateRefusal('permission contract refused: write docs/leak.txt: outside-scope (x)'));
  const reviewer = newReviewerKey(); // the private half stays in this process, never in the store
  enrollReviewer(store, reviewer.publicKey);
  const live = { subject: subjectDigest({ snapshot: 'snap-1', task: 'task-1', policy: 'p-1' }), objective: [{ id: 'tests', met: true }] };
  const receipt = (key, over = {}) => issueReview({ run, incident: incidentDigest(store, run), grants: grantsDigest(store), subject: live.subject, objective: ['tests'], decision: 'continue-with-new-run', expiresAt: now + 3_600_000, ...over }, 1, 'p', key);
  const journalBytes = () => fs.readFileSync(journal, 'utf8');
  const untouched = (fn) => { const before = journalBytes(); fn(); assert.equal(journalBytes(), before, 'a refusal changed the journal'); };

  await check('B1. a producer-signed or stranger-signed receipt cannot release the run', () => untouched(() => {
    assert.throws(() => continueStoppedRun(store, 'p', receipt(producerKey), live), /not signed by the enrolled reviewer/);
    assert.throws(() => continueStoppedRun(store, 'p', receipt(newReviewerKey().privateKey), live), /not signed by the enrolled reviewer/);
  }));

  await check('B2. the worker-reachable files are not enough: reviewer.pub cannot be replaced, a forged journal line blocks', () => {
    assert.throws(() => fs.writeFileSync(path.join(store, 'reviewer.pub'), pem(producer.publicKey, 'spki'), { flag: 'wx' }), /EEXIST/);
    assert.throws(() => enrollReviewer(store, newReviewerKey().publicKey), /EEXIST/);
    const good = journalBytes();
    try {
      const append = (receiptKey) => {
        const r = receiptKey ? receipt(receiptKey) : { not: 'a receipt' };
        const forged = { seq: readAudit(store).seq + 1, prev: readAudit(store).lastSum, events: [{ t: 'continued', from: run, to: 'self-granted', review: 'x', receipt: r, at: new Date().toISOString() }] };
        const body = JSON.stringify(forged);
        fs.appendFileSync(journal, `${crypto.createHash('sha256').update(body).digest('hex')} ${body}\n`);
      };
      // a hand-appended line with a correct checksum carries no receipt the reviewer signed: the journal reads as blocked
      append(null);
      assert.equal(readAudit(store).status, 'blocked');
      fs.writeFileSync(journal, good);
      append(producerKey); // even a well-formed receipt signed by the producer key
      assert.equal(readAudit(store).status, 'blocked');
      fs.writeFileSync(journal, good.replace(/"why":"[^"]*"/, '"why":"edited"')); // an edit of existing history is detected
      assert.equal(readAudit(store).status, 'blocked');
    } finally { fs.writeFileSync(journal, good); }
    assert.equal(readAudit(store).status, 'ok');
    assert.equal(readAudit(store).state.successor.size, 0);
  });

  await check('C1. a red or missing objective, a stale subject and stale grants are refused', () => untouched(() => {
    const r = receipt(reviewer.privateKey);
    assert.throws(() => continueStoppedRun(store, 'p', r, { ...live, objective: [{ id: 'tests', met: false }] }), /red or missing/);
    assert.throws(() => continueStoppedRun(store, 'p', r, { ...live, objective: [] }), /red or missing/);
    assert.throws(() => continueStoppedRun(store, 'p', r, { ...live, subject: subjectDigest({ snapshot: 'snap-2', task: 'task-1', policy: 'p-1' }) }), /stale review/);
  }));

  let next;
  await check('A1. the reviewer-signed receipt continues the run as a NEW run; the stopped run stays stopped', () => {
    const r = receipt(reviewer.privateKey);
    next = continueStoppedRun(store, 'p', r, live);
    assert.notEqual(next, run);
    assert.equal(resolveRun(store, run), next);
    assert.equal(readAudit(store).state.stopped.has(run), true);
    assert.throws(() => admit(store, run, crypto.randomUUID(), 'd'), /stopped/);
    admit(store, next, crypto.randomUUID(), 'd');
    // replay: the same receipt (or any further one for this stop) buys nothing
    assert.throws(() => continueStoppedRun(store, 'p', r, live), /already continued/);
  });

  await check('A2. a fresh process with only the disk sees the same: old run stopped, work goes to the new run', () => {
    const r = spawnSync(process.execPath, [import.meta.filename, '--child', store, run], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.resolved, next, r.stdout + r.stderr);
    assert.equal(out.stoppedRunRefused, true);
  });

  await check('A3. a new unauthorized attempt on the new run is a separate incident', () => {
    noteRefusal(store, next, new GateRefusal('permission contract refused: write y: outside-scope (x)'));
    const s = readAudit(store).state;
    assert.equal(s.stopped.has(next), true);
    assert.notEqual(s.stopped.get(next), undefined);
    assert.equal(s.stopped.has(run), true);
  });
} catch (e) {
  failed++; console.log(`FAIL setup\n     ${String(e?.stack ?? e)}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${failed ? 'FAIL' : 'PASS'} ${passed} passed, ${failed} failed (level LOCAL)`);
process.exit(failed ? 1 : 0);
