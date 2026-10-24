// T29 (offline half) — the negative run stays negative: race, scope change, open duties and earlier unauthorized
// attempts cannot be removed from the history by a later success, and no automatic correction/resume path exists.
// Real double gate, real store on disk, real concurrent processes (this file re-invokes itself as the child).
// The real-provider rehearsals of T29 (both agents, real correction/restart) need their own approval and are NOT run here.
// Throw-away keys, temp dir only, `amabie accept` is never run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROMPT_EVIDENCE_SCHEMA, materialDigest, validatePromptEvidenceRequest, verifyPromptEvidence } from '@amabie/prompt-evidence';
import { promote, sealOutcome } from '../../apps/cli/dist/src/double-gate.js';
import { admit, complete, noteRefusal, readAudit, reconcile, resolveRun, runId } from '../../apps/cli/dist/src/provider/production-audit.js';
import { GateRefusal, openGrants } from '../../apps/cli/dist/src/provider/production-grants.js';
import { continueStoppedRun, enrollReviewer, grantsDigest, incidentDigest, issueReview, newReviewerKey, subjectDigest } from '../../apps/cli/dist/src/provider/production-review.js';

const SELF = fileURLToPath(import.meta.url);
const REFUSAL = () => new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)');

if (process.argv[2] === 'child') { // child <store> <run> <role> <i>: one clean operation, or one unauthorized attempt
  const [, , , store, run, role, i] = process.argv;
  if (role === 'attacker') noteRefusal(store, run, REFUSAL());
  else { try { admit(store, run, `op-${i}`, 'd'); complete(store, `op-${i}`, 'completed'); } catch { /* refused by the stop: expected after the attempt */ } }
  process.exit(0);
}

const pem = (k, type) => k.export({ type, format: 'pem' }).toString();
const TEXT = 'Registration validates the email address.';
const ADAPTER = 'amabie.coding.sealed-plan';
let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const child = (root, run, role, i) => new Promise((res, rej) => {
  const c = spawn(process.execPath, [SELF, 'child', root, run, role, String(i)], { stdio: 'ignore' });
  c.on('exit', code => code === 0 ? res() : rej(new Error(`child ${role}${i} exited ${code}`))); c.on('error', rej);
});

async function fixture() {
  const input = { schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType: 'coding', text: TEXT }, requirements: [{ text: TEXT, sourceRef: { kind: 'goal', start: 0, end: TEXT.length, excerpt: TEXT }, clarity: 'clear', criteria: [{ statement: 'The sealed check covers it', adapterId: ADAPTER, evidenceType: 'sealed-check-run', predicate: { path: '/ok', equals: true } }] }] };
  const request = validatePromptEvidenceRequest(input, { taskType: 'coding', taskDigest: materialDigest(TEXT), requirementDigests: [materialDigest(TEXT)] });
  const adapter = { id: ADAPTER, taskType: 'coding', async collect(_r, criteria) { return { evidence: criteria.map(({ requirement, criterion }) => ({ requirementId: requirement.id, criterionId: criterion.id, evidenceType: criterion.evidenceType, facts: { ok: true }, artifactRefs: [`amabie://run/${requirement.id}`] })) }; } };
  const report = await verifyPromptEvidence(request, [adapter], { runId: 'r1', attempt: 0 });
  const producer = crypto.generateKeyPairSync('ed25519');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t29-')), store = { root }, now = Date.now(), base = runId('work-a');
  fs.writeFileSync(path.join(root, 'producer.pub'), pem(producer.publicKey, 'spki'));
  const producerKey = pem(producer.privateKey, 'pkcs8');
  openGrants(root, 'p', producerKey, [{ grantId: 'g', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 50 }, notBefore: now - 1000, expiresAt: now + 60_000, policyGeneration: 1, prerequisites: [] }]);
  const binding = { taskDigest: request.goalDigest, scopeDigest: request.scopeDigest, subjectDigest: subjectDigest({ snapshot: 's1', task: 't1' }), candidateCommit: 'c'.repeat(40), candidateTree: 'a'.repeat(40), policyRevision: grantsDigest(root), runBase: base };
  sealOutcome(store, 'p', report, binding);
  return { root, store, now, base, binding, producerKey, input: { request, report }, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const nodes = [];
try {
  await check('R1. race: one unauthorized attempt among many clean concurrent workers leaves a valid journal and a stopped run', async () => {
    const f = await fixture(); nodes.push(f);
    await Promise.all([...Array.from({ length: 6 }, (_, i) => child(f.root, f.base, 'worker', i)), child(f.root, f.base, 'attacker', 0)]);
    const a = readAudit(f.root);
    assert.equal(a.status, 'ok', a.reason);
    assert.equal(a.state.stopped.has(f.base), true);
    assert.equal(a.state.pending.size, 0); // every admitted operation was completed: no half-open effect hides in the race
    const r = promote(f.store, 'p', f.input, f.binding, f.now);
    assert.equal(r.outcome.status, 'PASS'); assert.equal(r.verdict, 'NOT_ELIGIBLE'); // good outcome does not buy the attempt back
  });

  await check('H1. a later success cannot remove the earlier attempt: more clean work is refused, the stop is first in the journal, history edits block', async () => {
    const f = await fixture(); nodes.push(f);
    noteRefusal(f.root, f.base, REFUSAL());
    assert.throws(() => admit(f.root, f.base, 'later-ok', 'd'), /stopped/);
    await child(f.root, f.base, 'worker', 9); // a fresh process with only the disk: refused as well
    assert.equal(readAudit(f.root).state.ops.has('op-9'), false);
    const j = path.join(f.root, 'audit', 'journal.jsonl'), good = fs.readFileSync(j, 'utf8');
    const lines = good.trim().split('\n');
    const stopAt = lines.findIndex(l => l.includes('"t":"stop"'));
    assert.ok(stopAt >= 0);
    for (const edited of [lines.filter((_, i) => i !== stopAt), lines.map((l, i) => i === stopAt ? l.replace('"t":"stop"', '"t":"refused"') : l)]) {
      fs.writeFileSync(j, edited.join('\n') + '\n');
      assert.equal(readAudit(f.root).status, 'blocked'); // dropping or renaming the stop breaks the chain; it is never read as clean
      assert.notEqual(promote(f.store, 'p', f.input, f.binding, f.now).verdict, 'ELIGIBLE');
    }
    fs.writeFileSync(j, good);
    assert.equal(promote(f.store, 'p', f.input, f.binding, f.now).verdict, 'NOT_ELIGIBLE');
  });

  await check('S1. scope change: the sealed outcome belongs to its criteria revision; another scope, mission or candidate is never ELIGIBLE', async () => {
    const f = await fixture(); nodes.push(f);
    admit(f.root, f.base, 'op-1', 'd'); complete(f.root, 'op-1', 'completed'); // a clean run, so only the binding can differ
    assert.equal(promote(f.store, 'p', f.input, f.binding, f.now).verdict, 'ELIGIBLE');
    for (const over of [{ scopeDigest: 'widened' }, { taskDigest: 'other-mission' }, { candidateCommit: 'd'.repeat(40) }]) {
      assert.notEqual(promote(f.store, 'p', f.input, { ...f.binding, ...over }, f.now).verdict, 'ELIGIBLE', JSON.stringify(over));
    }
  });

  await check('O1. open duty: an operation with an unknown effect blocks promotion; reconcile clears it on a clean run but never lifts a stop', async () => {
    const f = await fixture(); nodes.push(f);
    admit(f.root, f.base, 'open-op', 'd'); // intent without outcome
    assert.equal(promote(f.store, 'p', f.input, f.binding, f.now).execution.status, 'NOT_PROVEN');
    reconcile(f.root, 'open-op', 'effect-observed', 'checked by controller');
    assert.equal(promote(f.store, 'p', f.input, f.binding, f.now).verdict, 'ELIGIBLE');
    const g = await fixture(); nodes.push(g);
    admit(g.root, g.base, 'open-op', 'd');
    noteRefusal(g.root, g.base, REFUSAL());
    reconcile(g.root, 'open-op', 'effect-observed', 'checked by controller');
    assert.equal(promote(g.store, 'p', g.input, g.binding, g.now).verdict, 'NOT_ELIGIBLE');
    assert.throws(() => admit(g.root, g.base, 'next', 'd'), /stopped/);
  });

  await check('N1. no automatic correction/resume path: producer/worker-signed or replayed reviews are refused, the stopped run never resolves to itself again', async () => {
    const f = await fixture(); nodes.push(f);
    noteRefusal(f.root, f.base, REFUSAL());
    const reviewer = newReviewerKey(); enrollReviewer(f.root, reviewer.publicKey);
    const live = { subject: f.binding.subjectDigest, objective: [{ id: 'tests', met: true }] };
    const review = (key) => issueReview({ run: f.base, incident: incidentDigest(f.root, f.base), grants: grantsDigest(f.root), subject: live.subject, objective: ['tests'], decision: 'continue-with-new-run', expiresAt: f.now + 60_000 }, 1, 'p', key);
    assert.throws(() => continueStoppedRun(f.root, 'p', review(f.producerKey), live), /not signed by the enrolled reviewer/); // self-grant
    assert.equal(resolveRun(f.root, f.base), f.base); assert.equal(readAudit(f.root).state.successor.size, 0);
    const good = review(reviewer.privateKey);
    const next = continueStoppedRun(f.root, 'p', good, live);
    assert.throws(() => continueStoppedRun(f.root, 'p', good, live), /already continued/); // single use
    assert.throws(() => admit(f.root, f.base, 'old-run', 'd'), /stopped/); // the old run is still dead
    admit(f.root, next, 'new-run-op', 'd'); complete(f.root, 'new-run-op', 'completed');
    const r = promote(f.store, 'p', f.input, f.binding, f.now);
    assert.equal(r.verdict, 'ELIGIBLE', r.reasons.join('\n')); assert.deepEqual(r.execution.lineage.map(l => l.run), [f.base]); // success is only the NEW run's, the stop stays listed
  });
} catch (e) {
  failed++; console.log(`FAIL setup\n     ${String(e?.stack ?? e)}`);
} finally {
  for (const n of nodes) n.rm();
}
console.log(`${failed ? 'FAIL' : 'PASS'} ${passed} passed, ${failed} failed (level LOCAL)`);
process.exit(failed ? 1 : 0);
