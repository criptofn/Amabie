// T28 — the real double gate, measured on a real store on disk with the real P2E core.
//
//   A. real outcome evidence + a clean run under current grants is ELIGIBLE, bound to one candidate;
//   B. a delivered PASS / VERIFIED claim, a digest-shaped lie, tampered evidence or a foreign seal is never authority;
//   C. the pillars stay separate: PASS + stopped run, and clean run + FAIL, are both NOT_ELIGIBLE (I04);
//   D. policy currency and every binding field are checked against LIVE state;
//   E. cross-check: the experimental aggregator, fed the facts the adapters VERIFIED, reaches the same decision, and
//      fed the same facts as an unverified claim it would have said ELIGIBLE where the real gate says no (the gap T28 closes).
// Throw-away keys, temp dir only, `amabie accept` is never run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { PROMPT_EVIDENCE_SCHEMA, materialDigest, validatePromptEvidenceRequest, verifyPromptEvidence } from '@amabie/prompt-evidence';
import { promote, sealOutcome } from '../../apps/cli/dist/src/double-gate.js';
import { admit, complete, noteRefusal, runId } from '../../apps/cli/dist/src/provider/production-audit.js';
import { GateRefusal, openGrants } from '../../apps/cli/dist/src/provider/production-grants.js';
import { continueStoppedRun, enrollReviewer, grantsDigest, incidentDigest, issueReview, newReviewerKey, subjectDigest } from '../../apps/cli/dist/src/provider/production-review.js';
import { evaluateSharedAssurance } from '../experimental/shared-assurance.mjs';

const pem = (k, type) => k.export({ type, format: 'pem' }).toString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const ADAPTER = 'amabie.coding.sealed-plan';
const TEXT = 'Registration validates the email address.';
let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};

const adapter = (ok) => ({
  id: ADAPTER, taskType: 'coding',
  async collect(_request, criteria) {
    return { evidence: criteria.map(({ requirement, criterion }) => ({ requirementId: requirement.id, criterionId: criterion.id, evidenceType: criterion.evidenceType, facts: { ok }, artifactRefs: [`amabie://run/${requirement.id}`] })) };
  },
});

async function fixture(ok = true) {
  const input = {
    schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType: 'coding', text: TEXT },
    requirements: [{ text: TEXT, sourceRef: { kind: 'goal', start: 0, end: TEXT.length, excerpt: TEXT }, clarity: 'clear', criteria: [{ statement: 'The sealed check covers it', adapterId: ADAPTER, evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }] }],
  };
  const request = validatePromptEvidenceRequest(input, { taskType: 'coding', taskDigest: materialDigest(TEXT), requirementDigests: [materialDigest(TEXT)] });
  const report = await verifyPromptEvidence(request, [adapter(ok)], { runId: 'r1', attempt: 0 });
  const producer = crypto.generateKeyPairSync('ed25519');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t28-')), store = { root }, now = Date.now(), base = runId('work-a');
  fs.writeFileSync(path.join(root, 'producer.pub'), pem(producer.publicKey, 'spki'));
  const producerKey = pem(producer.privateKey, 'pkcs8');
  openGrants(root, 'p', producerKey, [{ grantId: 'g', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 50 }, notBefore: now - 1000, expiresAt: now + 60_000, policyGeneration: 1, prerequisites: [] }]);
  admit(root, base, 'op-1', 'd'); complete(root, 'op-1', 'completed');
  const binding = (over = {}) => ({ taskDigest: request.goalDigest, scopeDigest: request.scopeDigest, subjectDigest: subjectDigest({ snapshot: 's1', task: 't1' }), candidateCommit: 'c'.repeat(40), candidateTree: 'a'.repeat(40), policyRevision: grantsDigest(root), runBase: base, ...over });
  const bound = binding();
  sealOutcome(store, 'p', report, bound);
  return { root, store, now, base, request, report, binding: bound, input: { request, report }, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** What the aggregator would be handed. `verified` = the gate's own findings; otherwise a bare claim. */
const aggregate = (b, outcome, execution, verified) => evaluateSharedAssurance({
  binding: b,
  outcomeEvidence: { binding: b, adapterVerification: { status: 'VERIFIED', verifierId: verified ? 'real-adapter' : 'claim', attestationDigest: sha('a') }, evidenceDigest: sha('o'), report: { schema: 'amabie-prompt-evidence-report/2', verdict: outcome } },
  executionEvidence: { binding: b, adapterVerification: { status: 'VERIFIED', verifierId: 'claim', attestationDigest: sha('b') }, authorizationContractDigest: sha('c'), auditDigest: sha('d'), coverage: { proposals: true, attempts: true, effects: true }, events: execution === 'COMPLIANT' ? [] : [{ eventId: 'e1', authorization: 'UNAUTHORIZED', proposed: true, selected: true, attempted: true, blocked: true, executed: false }] },
  policyCurrency: { status: 'CURRENT', attestationDigest: sha('p') },
});
const asAggregatorBinding = (b) => ({ taskDigest: b.taskDigest, subjectDigest: sha(b.subjectDigest), candidateCommit: b.candidateCommit, candidateTree: b.candidateTree });

const nodes = [];
try {
  const f = await fixture(); nodes.push(f);

  await check('A1. real evidence + clean run + current grants is ELIGIBLE and bound to the candidate', () => {
    const r = promote(f.store, 'p', f.input, f.binding, f.now);
    assert.equal(r.verdict, 'ELIGIBLE', r.reasons.join('\n'));
    assert.equal(r.outcome.status, 'PASS'); assert.equal(r.execution.status, 'COMPLIANT'); assert.equal(r.execution.policy, 'CURRENT');
    assert.deepEqual(r.binding, f.binding);
  });

  await check('B1. a PASS/VERIFIED relabel of FAIL evidence is not authority (unsealed, then sealed by the controller)', async () => {
    const bad = await fixture(false); nodes.push(bad);
    assert.equal(bad.report.verdict, 'FAIL');
    const lie = { ...clone(bad.report), verdict: 'PASS', status: 'VERIFIED' };
    const r1 = promote(bad.store, 'p', { request: bad.request, report: lie }, bad.binding, bad.now);
    assert.notEqual(r1.verdict, 'ELIGIBLE'); assert.match(r1.outcome.reason, /not the report that was sealed/);
    sealOutcome(bad.store, 'p', lie, bad.binding);
    const r2 = promote(bad.store, 'p', { request: bad.request, report: lie }, bad.binding, bad.now);
    assert.notEqual(r2.verdict, 'ELIGIBLE'); assert.match(r2.outcome.reason, /evidence gives FAIL/);
  });

  await check('B2. tampered evidence fails its integrity check even when sealed; a foreign project has no seal', () => {
    const bad = clone(f.report); bad.evidence[0].facts.ok = false;
    const g = { ...f.store, root: f.root };
    sealOutcome(g, 'q', bad, f.binding);
    const r = promote(g, 'q', { request: f.request, report: bad }, f.binding, f.now);
    assert.match(r.outcome.reason, /integrity/); assert.notEqual(r.verdict, 'ELIGIBLE');
    assert.equal(promote(f.store, 'nobody', f.input, f.binding, f.now).outcome.status, 'NOT_PROVEN');
  });

  await check('C1. PASS + a stopped run is NOT_ELIGIBLE; the positive pillar is reported, not overwritten (I04)', async () => {
    const v = await fixture(); nodes.push(v);
    noteRefusal(v.root, v.base, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
    const r = promote(v.store, 'p', v.input, v.binding, v.now);
    assert.equal(r.outcome.status, 'PASS'); assert.equal(r.execution.status, 'VIOLATION_BLOCKED'); assert.equal(r.verdict, 'NOT_ELIGIBLE');
  });

  await check('C2. clean run + FAIL outcome is NOT_ELIGIBLE', async () => {
    const x = await fixture(false); nodes.push(x);
    const r = promote(x.store, 'p', x.input, x.binding, x.now);
    assert.equal(r.execution.status, 'COMPLIANT'); assert.equal(r.outcome.status, 'FAIL'); assert.equal(r.verdict, 'NOT_ELIGIBLE');
  });

  await check('C3. a reviewed continuation is COMPLIANT for the NEW run only, predecessor stays in lineage; a new refusal blocks again (D03)', async () => {
    const v = await fixture(); nodes.push(v);
    noteRefusal(v.root, v.base, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
    const reviewer = newReviewerKey(); enrollReviewer(v.root, reviewer.publicKey);
    const live = { subject: v.binding.subjectDigest, objective: [{ id: 'tests', met: true }] };
    const receipt = issueReview({ run: v.base, incident: incidentDigest(v.root, v.base), grants: grantsDigest(v.root), subject: live.subject, objective: ['tests'], decision: 'continue-with-new-run', expiresAt: v.now + 60_000 }, 1, 'p', reviewer.privateKey);
    const next = continueStoppedRun(v.root, 'p', receipt, live);
    const ok = promote(v.store, 'p', v.input, v.binding, v.now);
    assert.equal(ok.verdict, 'ELIGIBLE', ok.reasons.join('\n')); assert.equal(ok.execution.currentRun, next);
    assert.deepEqual(ok.execution.lineage.map(l => l.run), [v.base]);
    noteRefusal(v.root, next, new GateRefusal('permission contract refused: write y: outside-scope (x)'));
    assert.equal(promote(v.store, 'p', v.input, v.binding, v.now).verdict, 'NOT_ELIGIBLE');
  });

  await check('D1. every live binding field must match: another candidate, tree, snapshot, mission, criteria, run or policy', () => {
    for (const over of [{ candidateCommit: 'd'.repeat(40) }, { candidateTree: 'e'.repeat(40) }, { subjectDigest: subjectDigest({ snapshot: 's2', task: 't1' }) }, { taskDigest: 'x' }, { scopeDigest: 'y' }, { runBase: runId('other') }, { policyRevision: 'z' }]) {
      assert.notEqual(promote(f.store, 'p', f.input, { ...f.binding, ...over }, f.now).verdict, 'ELIGIBLE', JSON.stringify(over));
    }
  });

  await check('D2. policy currency: expired grants and a hand-edited journal are never ELIGIBLE', async () => {
    assert.notEqual(promote(f.store, 'p', f.input, f.binding, f.now + 3_600_000).verdict, 'ELIGIBLE');
    const e = await fixture(); nodes.push(e);
    const j = path.join(e.root, 'audit', 'journal.jsonl');
    fs.writeFileSync(j, fs.readFileSync(j, 'utf8').replace(/"op-1"/, '"op-X"'));
    const r = promote(e.store, 'p', e.input, e.binding, e.now);
    assert.equal(r.execution.status, 'NOT_PROVEN'); assert.notEqual(r.verdict, 'ELIGIBLE');
  });

  await check('E1. the aggregator agrees with the real gate when fed the gate\'s findings, and says ELIGIBLE for a bare claim the gate refuses', async () => {
    const b = asAggregatorBinding(f.binding);
    assert.equal(aggregate(b, 'PASS', 'COMPLIANT', true).promotion.status, 'ELIGIBLE');
    assert.equal(promote(f.store, 'p', f.input, f.binding, f.now).verdict, 'ELIGIBLE');
    const v = await fixture(); nodes.push(v);
    noteRefusal(v.root, v.base, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
    const real = promote(v.store, 'p', v.input, v.binding, v.now).verdict;
    const viaFindings = aggregate(asAggregatorBinding(v.binding), 'PASS', 'VIOLATION_BLOCKED', true).promotion.status;
    assert.equal(real, 'NOT_ELIGIBLE'); assert.equal(viaFindings, 'NOT_ELIGIBLE');
    // the gap: the aggregator trusts a bare VERIFIED string; the real gate re-derives it from the evidence
    const bad = await fixture(false); nodes.push(bad);
    const lie = { ...clone(bad.report), verdict: 'PASS', status: 'VERIFIED' };
    assert.equal(aggregate(asAggregatorBinding(bad.binding), 'PASS', 'COMPLIANT', false).promotion.status, 'ELIGIBLE');
    assert.notEqual(promote(bad.store, 'p', { request: bad.request, report: lie }, bad.binding, bad.now).verdict, 'ELIGIBLE');
  });
} catch (e) {
  failed++; console.log(`FAIL setup\n     ${String(e?.stack ?? e)}`);
} finally {
  for (const n of nodes) n.rm();
}
console.log(`${failed ? 'FAIL' : 'PASS'} ${passed} passed, ${failed} failed (level LOCAL)`);
process.exit(failed ? 1 : 0);
