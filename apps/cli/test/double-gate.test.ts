import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PROMPT_EVIDENCE_SCHEMA, materialDigest, validatePromptEvidenceRequest, verifyPromptEvidence, type EvidenceDraft, type PromptEvidenceRequest, type RegisteredTask, type VerificationReport, type VerifierAdapter } from '@amabie/prompt-evidence';
import { promote, sealOutcome, type Binding } from '../src/double-gate.js';
import type { GrantPayload } from '../src/permission-contract.js';
import { admit, complete, noteRefusal, runId } from '../src/provider/production-audit.js';
import { GateRefusal, openGrants } from '../src/provider/production-grants.js';
import { continueStoppedRun, enrollReviewer, grantsDigest, incidentDigest, issueReview, newReviewerKey, subjectDigest } from '../src/provider/production-review.js';

const pem = (k: crypto.KeyObject, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString();
const ADAPTER = 'amabie.coding.sealed-plan';
const TEXT = 'Registration validates the email address.';

function adapter(ok: boolean): VerifierAdapter {
  return {
    id: ADAPTER, taskType: 'coding',
    async collect(_request, criteria) {
      const evidence: EvidenceDraft[] = criteria.map(({ requirement, criterion }) => ({ requirementId: requirement.id, criterionId: criterion.id, evidenceType: criterion.evidenceType, facts: { ok }, artifactRefs: [`amabie://run/${requirement.id}`] }));
      return { evidence };
    },
  };
}

/** A real request/report from the real P2E core; a store with signed grants, a clean run and a sealed outcome. */
async function fixture(ok = true) {
  const input: PromptEvidenceRequest = {
    schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType: 'coding', text: TEXT },
    requirements: [{ text: TEXT, sourceRef: { kind: 'goal', start: 0, end: TEXT.length, excerpt: TEXT }, clarity: 'clear', criteria: [{ statement: 'The sealed check covers it', adapterId: ADAPTER, evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }] }],
  };
  const task: RegisteredTask = { taskType: 'coding', taskDigest: materialDigest(TEXT), requirementDigests: [materialDigest(TEXT)] };
  const request = validatePromptEvidenceRequest(input, task);
  const report = await verifyPromptEvidence(request, [adapter(ok)], { runId: 'r1', attempt: 0 });
  const producer = crypto.generateKeyPairSync('ed25519');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-gate-')), store = { root }, now = Date.now(), base = runId('work-a');
  fs.writeFileSync(path.join(root, 'producer.pub'), pem(producer.publicKey, 'spki'));
  const producerKey = pem(producer.privateKey, 'pkcs8');
  const grant = (over: Partial<GrantPayload> = {}): GrantPayload => ({ grantId: 'g', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 50 }, notBefore: now - 1000, expiresAt: now + 60_000, policyGeneration: 1, prerequisites: [], ...over });
  openGrants(root, 'p', producerKey, [grant()]);
  admit(root, base, 'op-1', 'd'); complete(root, 'op-1', 'completed');
  const binding = (over: Partial<Binding> = {}): Binding => ({ taskDigest: request.goalDigest, scopeDigest: request.scopeDigest, subjectDigest: subjectDigest({ snapshot: 's1', task: 't1' }), candidateCommit: 'c'.repeat(40), candidateTree: 't'.repeat(40), policyRevision: grantsDigest(root), runBase: base, ...over });
  sealOutcome(store, 'p', report, binding());
  return { root, store, now, base, request, report, producerKey, grant, binding, input: { request, report }, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test('T28: real outcome evidence + clean execution under current grants is ELIGIBLE, bound to one candidate', async () => {
  const f = await fixture();
  try {
    const r = promote(f.store, 'p', f.input, f.binding(), f.now);
    assert.equal(r.verdict, 'ELIGIBLE', r.reasons.join('\n'));
    assert.equal(r.outcome.status, 'PASS');
    assert.equal(r.execution.status, 'COMPLIANT');
    assert.equal(r.execution.policy, 'CURRENT');
  } finally { f.rm(); }
});

test('T28: a delivered PASS/VERIFIED claim is not authority: tampered report, tampered evidence, forged verdict', async () => {
  const f = await fixture(false);
  try {
    assert.equal(f.report.verdict, 'FAIL');
    // the same evidence, re-labelled PASS, with the seal recomputed by someone who has no key: the seal is not theirs
    const lie = { ...clone(f.report), verdict: 'PASS' as const, status: 'VERIFIED' } as unknown as VerificationReport;
    const r = promote(f.store, 'p', { request: f.request, report: lie }, f.binding(), f.now);
    assert.notEqual(r.verdict, 'ELIGIBLE');
    assert.equal(r.outcome.status, 'NOT_PROVEN');
    assert.match(r.outcome.reason, /not the report that was sealed/);
    // sealed by the controller, but the sealed report claims PASS over failing evidence: recomputed from the evidence, never promoted
    sealOutcome(f.store, 'p', lie, f.binding());
    const again = promote(f.store, 'p', { request: f.request, report: lie }, f.binding(), f.now);
    assert.equal(again.outcome.status, 'NOT_PROVEN');
    assert.match(again.outcome.reason, /evidence gives FAIL/);
    assert.notEqual(again.verdict, 'ELIGIBLE');
  } finally { f.rm(); }
});

test('T28: a tampered evidence record fails its integrity check even when the report is sealed', async () => {
  const f = await fixture();
  try {
    const bad = clone(f.report);
    (bad.evidence[0]!.facts as Record<string, unknown>).ok = false;
    sealOutcome(f.store, 'p', bad, f.binding());
    const r = promote(f.store, 'p', { request: f.request, report: bad }, f.binding(), f.now);
    assert.equal(r.outcome.status, 'NOT_PROVEN');
    assert.match(r.outcome.reason, /integrity/);
    assert.equal(r.verdict, 'UNPROVEN');
  } finally { f.rm(); }
});

test('T28: every binding field must match LIVE state: another candidate, tree, snapshot, mission, criteria or policy', async () => {
  const f = await fixture();
  try {
    for (const over of [{ candidateCommit: 'd'.repeat(40) }, { candidateTree: 'e'.repeat(40) }, { subjectDigest: subjectDigest({ snapshot: 's2', task: 't1' }) }, { taskDigest: 'x' }, { scopeDigest: 'y' }, { runBase: runId('work-other') }, { policyRevision: 'z' }]) {
      const r = promote(f.store, 'p', f.input, f.binding(over), f.now);
      assert.notEqual(r.verdict, 'ELIGIBLE', JSON.stringify(over));
    }
    assert.equal(promote(f.store, 'p', f.input, f.binding(), f.now).verdict, 'ELIGIBLE'); // the right binding still works
  } finally { f.rm(); }
});

test('T28: a missing, malformed or foreign outcome seal proves nothing', async () => {
  const f = await fixture();
  try {
    assert.equal(promote(f.store, 'other-project', f.input, f.binding(), f.now).outcome.status, 'NOT_PROVEN');
    const rec = path.join(f.root, 'records', 'p', 'outcome-report.json');
    const good = fs.readFileSync(rec, 'utf8');
    fs.writeFileSync(rec, good.replace(/"reportDigest":"[0-9a-f]+"/, `"reportDigest":"${'0'.repeat(64)}"`));
    assert.equal(promote(f.store, 'p', f.input, f.binding(), f.now).outcome.status, 'NOT_PROVEN'); // edited payload: signature breaks
    fs.rmSync(rec);
    assert.equal(promote(f.store, 'p', f.input, f.binding(), f.now).outcome.status, 'NOT_PROVEN');
    assert.equal(promote(f.store, 'p', {} as never, f.binding(), f.now).verdict, 'UNPROVEN');
  } finally { f.rm(); }
});

test('T28: outcome PASS + an execution violation stays NOT_ELIGIBLE; both pillars are reported separately', async () => {
  const f = await fixture();
  try {
    noteRefusal(f.root, f.base, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
    const r = promote(f.store, 'p', f.input, f.binding(), f.now);
    assert.equal(r.outcome.status, 'PASS'); // the good result does not hide ...
    assert.equal(r.execution.status, 'VIOLATION_BLOCKED'); // ... the unauthorized attempt, and vice versa
    assert.equal(r.verdict, 'NOT_ELIGIBLE');
  } finally { f.rm(); }
});

test('T28: clean execution + failing outcome stays NOT_ELIGIBLE', async () => {
  const f = await fixture(false);
  try {
    const r = promote(f.store, 'p', f.input, f.binding(), f.now);
    assert.equal(r.execution.status, 'COMPLIANT');
    assert.equal(r.outcome.status, 'FAIL');
    assert.equal(r.verdict, 'NOT_ELIGIBLE');
  } finally { f.rm(); }
});

test('T28: a reviewed continuation is COMPLIANT for the NEW run only; the stopped predecessor stays listed', async () => {
  const f = await fixture();
  try {
    noteRefusal(f.root, f.base, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
    const reviewer = newReviewerKey();
    enrollReviewer(f.root, reviewer.publicKey);
    const live = { subject: subjectDigest({ snapshot: 's1', task: 't1' }), objective: [{ id: 'tests', met: true }] };
    const receipt = issueReview({ run: f.base, incident: incidentDigest(f.root, f.base), grants: grantsDigest(f.root), subject: live.subject, objective: ['tests'], decision: 'continue-with-new-run', expiresAt: f.now + 60_000 }, 1, 'p', reviewer.privateKey);
    const next = continueStoppedRun(f.root, 'p', receipt, live, f.now);
    const r = promote(f.store, 'p', f.input, f.binding(), f.now);
    assert.equal(r.execution.status, 'COMPLIANT');
    assert.equal(r.execution.currentRun, next);
    assert.deepEqual(r.execution.lineage.map(l => l.run), [f.base]); // nothing is retroactively compliant
    assert.match(r.execution.lineage[0]!.why, /outside-scope/);
    assert.equal(r.verdict, 'ELIGIBLE');
    noteRefusal(f.root, next, new GateRefusal('permission contract refused: write y: outside-scope (x)')); // a new attempt stops the new run too
    assert.equal(promote(f.store, 'p', f.input, f.binding(), f.now).verdict, 'NOT_ELIGIBLE');
  } finally { f.rm(); }
});

test('T28: an operation of unknown effect, a missing journal and a blocked journal are NOT_PROVEN, never COMPLIANT', async () => {
  const f = await fixture();
  try {
    admit(f.root, f.base, 'op-open', 'd'); // admitted, never completed
    assert.equal(promote(f.store, 'p', f.input, f.binding(), f.now).execution.status, 'NOT_PROVEN');
    const journal = path.join(f.root, 'audit', 'journal.jsonl');
    const good = fs.readFileSync(journal, 'utf8');
    fs.writeFileSync(journal, good.replace('"op-1"', '"op-9"')); // edited history
    const blocked = promote(f.store, 'p', f.input, f.binding(), f.now);
    assert.equal(blocked.execution.status, 'NOT_PROVEN');
    assert.match(blocked.execution.reason, /cannot be trusted/);
    fs.rmSync(journal);
    const none = promote(f.store, 'p', f.input, f.binding(), f.now);
    assert.equal(none.execution.status, 'NOT_PROVEN');
    assert.match(none.execution.reason, /no audit journal/);
    assert.equal(none.verdict, 'UNPROVEN');
  } finally { f.rm(); }
});

test('T28: policy currency: expired, revoked, older-generation, forged or changed grants are never CURRENT', async () => {
  const f = await fixture();
  try {
    const bound = f.binding(); // the revision the work was bound to, fixed before any change below
    const exec = (at = f.now) => promote(f.store, 'p', f.input, bound, at).execution;
    assert.equal(exec().policy, 'CURRENT');
    assert.equal(exec(f.now + 3_600_000).policy, 'STALE'); // expired
    assert.equal(exec(f.now - 10_000).policy, 'STALE'); // not yet valid
    const dir = path.join(f.root, 'grants');
    const policy = fs.readFileSync(path.join(dir, 'policy.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ generation: 1, revoked: ['g'], deny: [] }));
    assert.equal(exec().policy, 'STALE'); // revoked (and the digest moved)
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ generation: 2, revoked: [], deny: [] }));
    assert.equal(exec().policy, 'STALE'); // grant is from an older generation
    fs.writeFileSync(path.join(dir, 'policy.json'), policy);
    const g = fs.readFileSync(path.join(dir, 'grant-1.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'grant-1.json'), g.replace(/"expiresAt":\d+/, `"expiresAt":${f.now + 9_999_999}`));
    assert.equal(exec().policy, 'UNPROVEN'); // forged: the producer key did not sign this
    fs.writeFileSync(path.join(dir, 'grant-1.json'), g);
    assert.equal(exec().policy, 'CURRENT');
    openGrants(f.root, 'p', f.producerKey, [f.grant({ args: { maxBytes: 5000 } })]); // grants re-issued after the work was bound
    assert.equal(exec().policy, 'STALE');
  } finally { f.rm(); }
});
