import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { admit, noteRefusal, readAudit, resolveRun, runId } from '../src/provider/production-audit.js';
import { GateRefusal, openGrants } from '../src/provider/production-grants.js';
import { continueStoppedRun, enrollReviewer, grantsDigest, incidentDigest, issueReview, newReviewerKey, subjectDigest, type LiveEvidence, type ReviewPayload } from '../src/provider/production-review.js';

const pem = (k: crypto.KeyObject, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString();
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });

/** A store with a producer key and open grants, one run already stopped by an unauthorized attempt, and a reviewer. */
function fixture() {
  const producer = crypto.generateKeyPairSync('ed25519');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-review-'));
  const store = path.join(root, 'store'), run = runId('work-a'), now = Date.now();
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'producer.pub'), pem(producer.publicKey, 'spki'));
  const open = (generation: number) => openGrants(store, 'p', pem(producer.privateKey, 'pkcs8'), [{ grantId: 'g', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 50 }, notBefore: now - 1000, expiresAt: now + 60_000, policyGeneration: generation, prerequisites: [] }]);
  open(1);
  noteRefusal(store, run, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
  const reviewer = newReviewerKey();
  enrollReviewer(store, reviewer.publicKey);
  const live: LiveEvidence = { subject: subjectDigest({ snapshot: 's1', task: 't1' }), objective: [{ id: 'tests', met: true }] };
  const payload = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({ run, incident: incidentDigest(store, run), grants: grantsDigest(store), subject: live.subject, objective: ['tests'], decision: 'continue-with-new-run', expiresAt: now + 60_000, ...over });
  const review = (over: Partial<ReviewPayload> = {}, key = reviewer.privateKey) => issueReview(payload(over), 1, 'p', key);
  return { root, store, run, reviewer, producer, live, review, producerKey: pem(producer.privateKey, 'pkcs8') };
}

test('T27: an independent review continues a stopped run as a NEW run; the stopped run stays stopped', () => {
  const f = fixture();
  try {
    assert.equal(resolveRun(f.store, f.run), f.run);
    const next = continueStoppedRun(f.store, 'p', f.review(), f.live);
    assert.notEqual(next, f.run);
    assert.equal(resolveRun(f.store, f.run), next); // the worker's workspace now acts as the new run
    const a = readAudit(f.store).state;
    assert.equal(a.stopped.has(f.run), true); // history is not rewritten, nothing is retroactively compliant
    assert.equal(a.successor.get(f.run), next);
    admit(f.store, next, crypto.randomUUID(), 'd'); // the new run can act ...
    assert.throws(() => admit(f.store, f.run, crypto.randomUUID(), 'd'), /stopped/); // ... the old one still cannot
    noteRefusal(f.store, next, new GateRefusal('permission contract refused: write y: outside-scope (x)'));
    assert.equal(readAudit(f.store).state.stopped.has(next), true); // a new attempt is a separate incident
    assert.equal(resolveRun(f.store, f.run), next);
  } finally { rm(f.root); }
});

test('T27: a forged, producer-signed or foreign receipt is refused and changes nothing', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(path.join(f.store, 'audit', 'journal.jsonl'), 'utf8');
    const stranger = newReviewerKey();
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review({}, stranger.privateKey), f.live), /not signed by the enrolled reviewer/);
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review({}, f.producerKey), f.live), /not signed by the enrolled reviewer/); // the worker/producer side cannot self-grant
    const tampered = f.review();
    (tampered.payload as ReviewPayload).run = 'another-run';
    assert.throws(() => continueStoppedRun(f.store, 'p', tampered, f.live), /not signed by the enrolled reviewer/);
    assert.throws(() => continueStoppedRun(f.store, 'other-project', f.review(), f.live), /not a review for this project/);
    assert.throws(() => continueStoppedRun(f.store, 'p', { not: 'an envelope' }, f.live), /not a review/);
    assert.equal(fs.readFileSync(path.join(f.store, 'audit', 'journal.jsonl'), 'utf8'), before);
  } finally { rm(f.root); }
});

test('T27: the reviewer key must differ from the producer key and is enrolled once', () => {
  const f = fixture();
  try {
    assert.throws(() => enrollReviewer(f.store, newReviewerKey().publicKey), /EEXIST/); // second enrollment
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-review-'));
    try {
      fs.writeFileSync(path.join(root2, 'producer.pub'), pem(f.producer.publicKey, 'spki'));
      assert.throws(() => enrollReviewer(root2, pem(f.producer.publicKey, 'spki')), /distinct keys/);
      assert.throws(() => enrollReviewer(root2, pem(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey, 'spki')), /Ed25519/);
    } finally { rm(root2); }
  } finally { rm(f.root); }
});

test('T27: a hand-appended continuation without the reviewer\'s receipt blocks the journal', () => {
  const f = fixture();
  try {
    const journal = path.join(f.store, 'audit', 'journal.jsonl');
    const good = fs.readFileSync(journal, 'utf8');
    for (const receipt of [{ not: 'a receipt' }, f.review({}, f.producerKey)]) {
      const a = readAudit(f.store);
      const body = JSON.stringify({ seq: a.seq + 1, prev: a.lastSum, events: [{ t: 'continued', from: f.run, to: 'self-granted', review: 'x', receipt, at: new Date().toISOString() }] });
      fs.appendFileSync(journal, `${crypto.createHash('sha256').update(body).digest('hex')} ${body}\n`);
      assert.equal(readAudit(f.store).status, 'blocked');
      fs.writeFileSync(journal, good);
    }
    assert.equal(readAudit(f.store).status, 'ok');
  } finally { rm(f.root); }
});

test('T27: a review is single-use: replaying it is refused, and so is a second review for the same stop', () => {
  const f = fixture();
  try {
    const r = f.review();
    continueStoppedRun(f.store, 'p', r, f.live);
    assert.throws(() => continueStoppedRun(f.store, 'p', r, f.live), /already continued/);
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review({ expiresAt: Date.now() + 120_000 }), f.live), /already continued/);
  } finally { rm(f.root); }
});

test('T27: changed snapshot/task/policy bytes or changed grants make the old receipt stale', () => {
  const f = fixture();
  try {
    const r = f.review();
    const moved: LiveEvidence = { ...f.live, subject: subjectDigest({ snapshot: 's2', task: 't1' }) };
    assert.throws(() => continueStoppedRun(f.store, 'p', r, moved), /stale review: the snapshot, task or policy/);
    fs.writeFileSync(path.join(f.store, 'grants', 'grant-99.json'), '{}'); // a grant appears after the review
    assert.throws(() => continueStoppedRun(f.store, 'p', r, f.live), /stale review: the grants changed/);
    assert.equal(readAudit(f.store).state.successor.size, 0);
  } finally { rm(f.root); }
});

test('T27: an expired receipt, or one for a run with no recorded incident, is refused', () => {
  const f = fixture();
  try {
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review(), f.live, Date.now() + 3_600_000), /expired/);
    assert.throws(() => incidentDigest(f.store, runId('never-stopped')), /no recorded incident/);
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review({ run: runId('never-stopped'), incident: 'x' }), f.live), /does not match the recorded incident|no recorded incident/);
  } finally { rm(f.root); }
});

test('T27: a red or missing objective check is never waived by a signed review', () => {
  const f = fixture();
  try {
    const r = f.review();
    assert.throws(() => continueStoppedRun(f.store, 'p', r, { ...f.live, objective: [{ id: 'tests', met: false }] }), /red or missing/);
    assert.throws(() => continueStoppedRun(f.store, 'p', r, { ...f.live, objective: [] }), /red or missing/);
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review({ objective: ['lint'] }), f.live), /not part of the live evidence/);
    assert.throws(() => continueStoppedRun(f.store, 'p', f.review({ objective: [] }), f.live), /not part of the live evidence/);
    assert.equal(readAudit(f.store).state.successor.size, 0);
    continueStoppedRun(f.store, 'p', r, f.live); // the same receipt works once the objective is green
  } finally { rm(f.root); }
});

test('T27: an unknown-effect operation of the stopped run must be reconciled before a continuation', () => {
  const f = fixture();
  try {
    // an operation that was admitted before the stop and never completed
    const store = f.store, run = runId('work-b');
    admit(store, run, 'op-open', 'd');
    noteRefusal(store, run, new GateRefusal('permission contract refused: write y: outside-scope (x)'));
    const r = issueReview({ run, incident: incidentDigest(store, run), grants: grantsDigest(store), subject: f.live.subject, objective: ['tests'], decision: 'continue-with-new-run', expiresAt: Date.now() + 60_000 }, 2, 'p', f.reviewer.privateKey);
    assert.throws(() => continueStoppedRun(store, 'p', r, f.live), /reconcile it first/);
  } finally { rm(f.root); }
});
