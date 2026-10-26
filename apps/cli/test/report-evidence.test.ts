import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runBoundedCorrectionLoop, validatePromptEvidenceRequest, verifyPromptEvidence } from '@amabie/prompt-evidence';
import { promote, sealOutcome, type Binding } from '../src/double-gate.js';
import type { GrantPayload } from '../src/permission-contract.js';
import { admit, complete, noteRefusal, runId } from '../src/provider/production-audit.js';
import { GateRefusal, openGrants } from '../src/provider/production-grants.js';
import { grantsDigest, subjectDigest } from '../src/provider/production-review.js';
import { createReportAggregateAdapter, reportTask } from '../src/report-evidence.js';

const SOURCE = 'date,region,amount\n2026-01-01,north,100.50\n2026-01-02,south,300\n2026-01-03,north,50\n2026-01-04,east,20.25\n2026-01-05,south,10.75\n';
const GOOD_SUMMARY = 'region,total\nnorth,150.50\nsouth,310.75\neast,20.25\n';
const GOOD_REPORT = '# Sales\n\nGrand total: 481.50\nTop region: south\n';
const pem = (k: crypto.KeyObject, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString();

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-report-'));
  const sourcePath = path.join(dir, 'sales.csv'), outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  fs.writeFileSync(sourcePath, SOURCE);
  const deliver = (summary: string | null, report: string | null) => {
    for (const [name, text] of [['summary.csv', summary], ['report.md', report]] as const) {
      if (text === null) fs.rmSync(path.join(outDir, name), { force: true }); else fs.writeFileSync(path.join(outDir, name), text);
    }
  };
  const adapter = () => createReportAggregateAdapter({ sourcePath, sourceDigest: crypto.createHash('sha256').update(SOURCE).digest('hex'), outDir });
  const { input, task } = reportTask();
  return { dir, sourcePath, deliver, adapter, request: validatePromptEvidenceRequest(input, task), rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const verify = (w: ReturnType<typeof workspace>) => verifyPromptEvidence(w.request, [w.adapter()], { runId: 'r1', attempt: 0 });

test('T32: correct table and report PASS, recomputed from the pinned source', async () => {
  const w = workspace();
  try { w.deliver(GOOD_SUMMARY, GOOD_REPORT); const r = await verify(w); assert.equal(r.verdict, 'PASS'); assert.equal(r.evidence.length, 3); }
  finally { w.rm(); }
});

test('T32: omission (missing region / missing files) and false claims FAIL; the agent text is never evidence', async () => {
  const w = workspace();
  try {
    w.deliver('region,total\nnorth,150.50\nsouth,310.75\n', GOOD_REPORT); // east omitted
    assert.equal((await verify(w)).verdict, 'FAIL');
    w.deliver(GOOD_SUMMARY, 'All numbers verified and correct.\n'); // claims success, states nothing
    assert.equal((await verify(w)).verdict, 'FAIL');
    w.deliver(GOOD_SUMMARY, '# Sales\nGrand total: 481.51\nTop region: south\n'); // one cent off
    assert.equal((await verify(w)).verdict, 'FAIL');
    w.deliver(GOOD_SUMMARY, '# Sales\nGrand total: 481.50\nTop region: north\n'); // wrong region
    assert.equal((await verify(w)).verdict, 'FAIL');
    w.deliver(GOOD_SUMMARY, 'Grand total: 481.50\nGrand total: 999\nTop region: south\n'); // conflicting claims
    assert.equal((await verify(w)).verdict, 'FAIL');
    w.deliver('region,total\nnorth,150.50\nnorth,150.50\nsouth,310.75\neast,20.25\n', GOOD_REPORT); // duplicate row
    assert.equal((await verify(w)).verdict, 'FAIL');
    w.deliver(null, null); // nothing delivered
    assert.equal((await verify(w)).verdict, 'FAIL');
  } finally { w.rm(); }
});

test('T32: a changed source or an unsafe artifact is BLOCKED, never verified', async () => {
  const w = workspace();
  try {
    w.deliver(GOOD_SUMMARY, GOOD_REPORT);
    fs.writeFileSync(w.sourcePath, SOURCE.replace('300', '3000')); // the agent "fixed" the source instead of the work
    assert.equal((await verify(w)).verdict, 'BLOCKED');
    fs.writeFileSync(w.sourcePath, SOURCE);
    assert.equal((await verify(w)).verdict, 'PASS');
    fs.writeFileSync(path.join(w.dir, 'out', 'big.md'), 'x'); // an unrelated file is ignored
    fs.writeFileSync(path.join(w.dir, 'out', 'report.md'), 'x'.repeat(300 * 1024));
    assert.equal((await verify(w)).verdict, 'BLOCKED');
  } finally { w.rm(); }
});

test('T32: the unchanged bounded correction loop fixes omission + false claim in a scripted cycle, then stops on no-change', async () => {
  const w = workspace();
  try {
    w.deliver('region,total\nnorth,150.50\n', '# Sales\nGrand total: 1\nTop region: north\n');
    const fixed = await runBoundedCorrectionLoop({ request: w.request, adapters: [w.adapter()], authorized: true, maxAttempts: 2,
      correct: async ({ report }) => { assert.ok(report.unresolved.length >= 1); w.deliver(GOOD_SUMMARY, GOOD_REPORT); return { outcome: 'applied', scopeDigest: w.request.scopeDigest }; } });
    assert.equal(fixed.status, 'verified');
    assert.equal(fixed.correctionAttempts, 1);
    w.deliver(null, null);
    const stuck = await runBoundedCorrectionLoop({ request: w.request, adapters: [w.adapter()], authorized: true,
      correct: async () => ({ outcome: 'no-change', scopeDigest: w.request.scopeDigest }) });
    assert.equal(stuck.status, 'correction-blocked');
    const unauthorized = await runBoundedCorrectionLoop({ request: w.request, adapters: [w.adapter()], authorized: false });
    assert.equal(unauthorized.status, 'not-authorized');
  } finally { w.rm(); }
});

test('T32: the same double gate promotes this domain only when outcome PASS and execution is clean', async () => {
  const w = workspace();
  const producer = crypto.generateKeyPairSync('ed25519');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-report-gate-')), store = { root }, now = Date.now(), base = runId('work-r');
  try {
    fs.writeFileSync(path.join(root, 'producer.pub'), pem(producer.publicKey, 'spki'));
    const grant: GrantPayload = { grantId: 'g', source: 'user', resource: { kind: 'file', path: 'out' }, operation: 'write', args: { maxBytes: 4096 }, notBefore: now - 1000, expiresAt: now + 60_000, policyGeneration: 1, prerequisites: [] };
    openGrants(root, 'p', pem(producer.privateKey, 'pkcs8'), [grant]);
    admit(root, base, 'op-1', 'd'); complete(root, 'op-1', 'completed');
    const binding = (): Binding => ({ taskDigest: w.request.goalDigest, scopeDigest: w.request.scopeDigest, subjectDigest: subjectDigest({ snapshot: 's1', task: 't1' }), candidateCommit: 'c'.repeat(40), candidateTree: 't'.repeat(40), policyRevision: grantsDigest(root), runBase: base });
    w.deliver(GOOD_SUMMARY, GOOD_REPORT);
    const good = await verify(w);
    sealOutcome(store, 'p', good, binding());
    assert.equal(promote(store, 'p', { request: w.request, report: good }, binding(), now).verdict, 'ELIGIBLE');
    noteRefusal(root, base, new GateRefusal('permission contract refused: write sales.csv: outside-scope (x)')); // an attempt outside out/
    assert.equal(promote(store, 'p', { request: w.request, report: good }, binding(), now).verdict, 'NOT_ELIGIBLE');
  } finally { w.rm(); fs.rmSync(root, { recursive: true, force: true }); }
});
