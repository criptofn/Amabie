import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMPT_EVIDENCE_SCHEMA,
  correctionReportFor,
  draftPromptEvidence,
  evidenceIntegrityValid,
  materialDigest,
  runBoundedCorrectionLoop,
  validatePromptEvidenceRequest,
  verifyPromptEvidence,
  type EvidenceDraft,
  type PromptEvidenceRequest,
  type RegisteredTask,
  type VerifierAdapter,
} from '../src/index.js';

const ADAPTER = 'amabie.coding.sealed-plan';
const CHECK = 'npm test';

function makeRequest(
  items: Array<{ text: string; clarity?: 'clear' | 'unclear'; check?: string }>,
  taskType = 'coding',
): { input: PromptEvidenceRequest; task: RegisteredTask; request: ReturnType<typeof validatePromptEvidenceRequest> } {
  const goalText = items.length > 0 ? items.map(item => item.text).join('\n') : 'No requirements were declared.';
  let cursor = 0;
  const requirements = items.map(item => {
    const start = goalText.indexOf(item.text, cursor);
    const end = start + item.text.length;
    cursor = end + 1;
    return {
      text: item.text,
      sourceRef: { kind: 'goal' as const, start, end, excerpt: item.text },
      clarity: item.clarity ?? 'clear' as const,
      criteria: item.check === '' ? [] : [{
        statement: `The sealed check covers: ${item.text}`,
        adapterId: ADAPTER,
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    };
  });
  const input: PromptEvidenceRequest = { schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType, text: goalText }, requirements };
  const task: RegisteredTask = { taskType, taskDigest: materialDigest(goalText), requirementDigests: items.map(item => materialDigest(item.text)) };
  return { input, task, request: validatePromptEvidenceRequest(input, task) };
}

function adapterFor(getFacts: (requirementText: string, criterionId: string) => unknown): VerifierAdapter {
  return {
    id: ADAPTER,
    taskType: 'coding',
    async collect(request, criteria) {
      const evidence: EvidenceDraft[] = [];
      for (const { requirement, criterion } of criteria) {
        const facts = getFacts(requirement.text, criterion.id);
        if (facts !== undefined) evidence.push({
          requirementId: requirement.id,
          criterionId: criterion.id,
          evidenceType: criterion.evidenceType,
          facts: facts as EvidenceDraft['facts'],
          artifactRefs: [`amabie://run/${requirement.id}/${criterion.id}`],
        });
      }
      return { evidence };
    },
  };
}

const registration = 'Registration validates the email address.';
const password = 'Passwords are stored using an approved hash.';

test('prompt intake drafts source-linked unresolved requirements without claiming semantic completeness', () => {
  const goal = 'Implement registration:\r\n- Validate email input.\r\n2. Hash passwords.\r\n3) Add tests.';
  const draft = draftPromptEvidence(goal);
  assert.equal(draft.schema, 'amabie-prompt-evidence-draft/1');
  assert.equal(draft.reviewRequired, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Implement registration:', 'Validate email input.', 'Hash passwords.', 'Add tests.',
  ]);
  assert.equal(draft.request.goal.text, goal);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.sourceCoverage.nonWhitespaceCharacters, draft.sourceCoverage.mappedNonWhitespaceCharacters);
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  for (const requirement of draft.request.requirements) {
    assert.equal(goal.slice(requirement.sourceRef.start, requirement.sourceRef.end), requirement.sourceRef.excerpt);
  }
  const registeredTask: RegisteredTask = {
    taskType: 'coding',
    taskDigest: materialDigest(goal),
    requirementDigests: draft.request.requirements.map(requirement => materialDigest(requirement.text)),
  };
  const validated = validatePromptEvidenceRequest(draft.request, registeredTask);
  assert.deepEqual(draft.candidates.map(candidate => candidate.id), validated.requirements.map(requirement => requirement.id));
  assert.deepEqual(draft.candidates.map(candidate => candidate.id), draftPromptEvidence(goal).candidates.map(candidate => candidate.id));
});

test('a one-line compound task remains one unclear draft instead of invented subrequirements', () => {
  const goal = 'Implement registration, validate input, hash passwords, and add tests.';
  const draft = draftPromptEvidence(goal);
  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [goal]);
  assert.equal(draft.request.requirements[0]!.clarity, 'unclear');
  assert.equal(draft.request.requirements[0]!.criteria.length, 0);
  assert.match(draft.notes.join(' '), /split compound requests/u);
});

test('request validation binds exact goal and a multiset of exact declared requirements', () => {
  const data = makeRequest([{ text: registration }, { text: password }]);
  assert.equal(data.request.requirements.length, 2);
  assert.match(data.request.requirements[0]!.id, /^req_[0-9a-f]{20}$/u);
  assert.notEqual(data.request.requirements[0]!.id, data.request.requirements[1]!.id);
  assert.throws(() => validatePromptEvidenceRequest({ ...data.input, requirements: data.input.requirements.slice(0, 1) }, data.task), /every registered requirement exactly once/u);
  assert.throws(() => validatePromptEvidenceRequest({ ...data.input, goal: { ...data.input.goal, text: 'a different task' } }, data.task), /does not match the task registered/u);
  const altered = structuredClone(data.input) as PromptEvidenceRequest;
  altered.requirements[0]!.sourceRef.excerpt = 'x'.repeat(altered.requirements[0]!.sourceRef.excerpt.length);
  assert.throws(() => validatePromptEvidenceRequest(altered, data.task), /does not quote the original goal/u);
});

test('registered task type is bound to the request and correction scope', () => {
  const coding = makeRequest([{ text: registration }], 'coding');
  const document = makeRequest([{ text: registration }], 'document');
  const wrongRegistration = Object.assign({}, coding.task, { taskType: 'document' });

  assert.throws(() => validatePromptEvidenceRequest(coding.input, wrongRegistration), /task type does not match/u);
  assert.notEqual(coding.request.scopeDigest, document.request.scopeDigest);
});

test('an empty requirement set or a requirement without criteria cannot produce PASS', async () => {
  const empty = makeRequest([]);
  const emptyReport = await verifyPromptEvidence(empty.request, [], { runId: 'empty-scope', attempt: 0 });
  assert.equal(emptyReport.verdict, 'NOT PROVEN');
  assert.deepEqual(emptyReport.coverage, { total: 0, met: 0, unmet: 0, unproven: 0, blocked: 0 });

  const noCriteria = makeRequest([{ text: registration, check: '' }]);
  const noCriteriaReport = await verifyPromptEvidence(noCriteria.request, [], { runId: 'no-criteria', attempt: 0 });
  assert.equal(noCriteriaReport.verdict, 'NOT PROVEN');
  assert.equal(noCriteriaReport.requirements[0]?.status, 'unproven');
  assert.match(noCriteriaReport.requirements[0]?.note ?? '', /no machine-verifiable criterion/u);
});

test('Scenario A: every declared requirement has fresh independent evidence', async () => {
  const data = makeRequest([{ text: registration }, { text: password }]);
  const report = await verifyPromptEvidence(data.request, [adapterFor(() => ({ ok: true, exitCode: 0 }))], { runId: 'scenario-a', attempt: 0 });
  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(report.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  assert.equal(report.evidence.every(e => evidenceIntegrityValid(e) && e.provenance === 'verifier-collected'), true);
});

test('Scenario B: an omitted requirement stays NOT PROVEN even if the build check passes', async () => {
  const data = makeRequest([{ text: registration }, { text: password }]);
  const report = await verifyPromptEvidence(data.request, [adapterFor((text) => text === registration ? { ok: true } : undefined)], { runId: 'scenario-b', attempt: 0 });
  assert.equal(report.verdict, 'NOT PROVEN');
  assert.equal(report.requirements.find(r => r.text === registration)?.status, 'met');
  assert.equal(report.requirements.find(r => r.text === password)?.status, 'unproven');
});

test('Scenario C: an agent success claim cannot replace missing verifier evidence', async () => {
  const data = makeRequest([{ text: registration }]);
  const claimed = { ...data.input, agentClaim: 'All requirements are done.' } as PromptEvidenceRequest;
  const request = validatePromptEvidenceRequest(claimed, data.task);
  const report = await verifyPromptEvidence(request, [adapterFor(() => undefined)], { runId: 'scenario-c', attempt: 0 });
  assert.equal(report.verdict, 'NOT PROVEN');
  assert.equal(report.evidence.length, 0);
});

test('Scenario D: reproducible failing evidence marks the requirement unmet', async () => {
  const data = makeRequest([{ text: registration }]);
  const report = await verifyPromptEvidence(data.request, [adapterFor(() => ({ ok: false, exitCode: 1 }))], { runId: 'scenario-d', attempt: 0 });
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.requirements[0]!.status, 'unmet');
  assert.match(report.requirements[0]!.criteria[0]!.note, /contradicts/u);
});

test('Scenario E: failing security evidence and absent security evidence remain distinct', async () => {
  const data = makeRequest([{ text: 'The password hashing check passes.' }]);
  const failed = await verifyPromptEvidence(data.request, [adapterFor(() => ({ ok: false }))], { runId: 'scenario-e-fail', attempt: 0 });
  const absent = await verifyPromptEvidence(data.request, [adapterFor(() => undefined)], { runId: 'scenario-e-absent', attempt: 0 });
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.requirements[0]!.status, 'unmet');
  assert.equal(absent.verdict, 'NOT PROVEN');
  assert.equal(absent.requirements[0]!.status, 'unproven');
});

test('tampered evidence cannot verify a requirement', async () => {
  const data = makeRequest([{ text: registration }]);
  const report = await verifyPromptEvidence(data.request, [adapterFor(() => ({ ok: true }))], { runId: 'tamper', attempt: 0 });
  const changed = structuredClone(report.evidence[0]!);
  changed.facts = { ok: false };
  assert.equal(evidenceIntegrityValid(changed), false);
  const reevaluated = (await import('../src/index.js')).evaluatePromptEvidence(data.request, [changed], new Map(), [], { runId: 'tamper', attempt: 0 });
  assert.equal(reevaluated.verdict, 'NOT PROVEN');
});

test('unsupported domain is BLOCKED instead of silently treated as unproven success', async () => {
  const data = makeRequest([{ text: registration }]);
  const report = await verifyPromptEvidence(data.request, [], { runId: 'unsupported', attempt: 0 });
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(report.requirements[0]!.status, 'blocked');
});

test('malformed verifier output is reported as BLOCKED instead of escaping evaluation', async () => {
  const data = makeRequest([{ text: registration }]);
  const malformedAdapter = {
    id: ADAPTER,
    taskType: 'coding',
    async collect() { return { evidence: [null] }; },
  } as unknown as VerifierAdapter;
  const report = await verifyPromptEvidence(data.request, [malformedAdapter], { runId: 'malformed-adapter', attempt: 0 });
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(report.requirements[0]!.status, 'blocked');
  assert.match(report.issues.join(' '), /invalid|malformed/u);
});

test('Scenario F: structured correction report is followed by fresh verification, with a hard three-cycle limit', async () => {
  const data = makeRequest([{ text: registration }]);
  let fixed = false;
  let verifications = 0;
  const adapter: VerifierAdapter = {
    id: ADAPTER,
    taskType: 'coding',
    async collect(request, criteria) {
      verifications += 1;
      return { evidence: criteria.map(({ requirement, criterion }) => ({
        requirementId: requirement.id,
        criterionId: criterion.id,
        evidenceType: criterion.evidenceType,
        facts: { ok: fixed },
      })) };
    },
  };
  const result = await runBoundedCorrectionLoop({
    request: data.request,
    adapters: [adapter],
    authorized: true,
    makeRunId: (() => { let n = 0; return () => `loop-${n++}`; })(),
    async correct({ report, cycle }) {
      assert.equal(report.unresolved[0]!.requirementId, data.request.requirements[0]!.id);
      assert.equal(report.scopeDigest, data.request.scopeDigest);
      assert.equal(cycle, 1);
      fixed = true;
      return { outcome: 'applied', scopeDigest: data.request.scopeDigest };
    },
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.correctionAttempts, 1);
  assert.equal(result.verification.attempt, 1);
  assert.equal(verifications, 2);

  const stuckAdapter: VerifierAdapter = { ...adapter, async collect(request, criteria) {
    return { evidence: criteria.map(({ requirement, criterion }) => ({ requirementId: requirement.id, criterionId: criterion.id, evidenceType: criterion.evidenceType, facts: { ok: false } })) };
  } };
  const stuck = await runBoundedCorrectionLoop({
    request: data.request,
    adapters: [stuckAdapter],
    authorized: true,
    makeRunId: (() => { let n = 0; return () => `stuck-${n++}`; })(),
    async correct({ cycle }) {
      assert.equal(cycle <= 3, true);
      return { outcome: 'applied', scopeDigest: data.request.scopeDigest };
    },
  });
  assert.equal(stuck.status, 'limit-reached');
  assert.equal(stuck.correctionAttempts, 3);
  assert.equal(stuck.verification.verdict, 'FAIL');
  assert.equal(correctionReportFor(stuck.verification).unresolved.length, 1);
});

test('a correction that reports changed scope is stopped before another verification', async () => {
  const data = makeRequest([{ text: registration }]);
  let calls = 0;
  const result = await runBoundedCorrectionLoop({
    request: data.request,
    adapters: [adapterFor(() => undefined)],
    authorized: true,
    async correct() { calls += 1; return { outcome: 'applied', scopeDigest: 'different' }; },
  });
  assert.equal(result.status, 'scope-change-blocked');
  assert.equal(calls, 1);
  assert.equal(result.verification.attempt, 0);
});

test('a malformed correction callback result stops the loop with a controlled failure', async () => {
  const data = makeRequest([{ text: registration }]);
  const result = await runBoundedCorrectionLoop({
    request: data.request,
    adapters: [adapterFor(() => undefined)],
    authorized: true,
    async correct() { return null as never; },
  });
  assert.equal(result.status, 'correction-blocked');
  assert.equal(result.correctionAttempts, 1);
  assert.equal(result.verification.verdict, 'NOT PROVEN');
  assert.match(result.stopReason ?? '', /invalid correction response/u);
});

test('the same core accepts a non-coding document verifier adapter', async () => {
  const data = makeRequest([{ text: 'The report includes an executive summary.' }], 'documents');
  const documentAdapter: VerifierAdapter = {
    id: 'mock.document.structure',
    taskType: 'documents',
    async collect(request, criteria) {
      return { evidence: criteria.map(({ requirement, criterion }) => ({
        requirementId: requirement.id,
        criterionId: criterion.id,
        evidenceType: criterion.evidenceType,
        facts: { sections: ['executive summary', 'analysis', 'appendix'], complete: true },
      })) };
    },
  };
  const input: PromptEvidenceRequest = {
    ...data.input,
    requirements: [{
      ...data.input.requirements[0]!,
      criteria: [{
        statement: 'A parsed document structure contains the requested section.',
        adapterId: 'mock.document.structure',
        evidenceType: 'mock-document-outline',
        predicate: { path: '/complete', equals: true },
      }],
    }],
  };
  const request = validatePromptEvidenceRequest(input, data.task);
  const report = await verifyPromptEvidence(request, [documentAdapter], { runId: 'mock-document', attempt: 0 });
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.evidence[0]!.taskType, 'documents');
});
test('unclear requirements remain unproven even when their proposed check is green', async () => {
  const data = makeRequest([{ text: registration, clarity: 'unclear' }]);
  const report = await verifyPromptEvidence(data.request, [adapterFor(() => ({ ok: true }))], { runId: 'unclear', attempt: 0 });
  assert.equal(report.verdict, 'NOT PROVEN');
  assert.equal(report.requirements[0]!.status, 'unproven');
  assert.equal(report.requirements[0]!.clarity, 'unclear');
  assert.match(report.requirements[0]!.note, /clarity is unresolved/u);
  assert.equal(report.requirements[0]!.criteria[0]!.status, 'unproven');
});

test('requirements that cover only part of the original prompt cannot PASS and do not start code correction', async () => {
  const goalText = 'Implement registration.\nValidate email input.\nAdd tests.';
  const requirementText = 'Implement registration.';
  const input: PromptEvidenceRequest = {
    schema: PROMPT_EVIDENCE_SCHEMA,
    goal: { taskType: 'coding', text: goalText },
    requirements: [{
      text: requirementText,
      sourceRef: { kind: 'goal', start: 0, end: requirementText.length, excerpt: requirementText },
      clarity: 'clear',
      criteria: [{
        statement: 'A sealed check proves registration is implemented.',
        adapterId: ADAPTER,
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    }],
  };
  const task: RegisteredTask = {
    taskType: 'coding',
    taskDigest: materialDigest(goalText),
    requirementDigests: [materialDigest(requirementText)],
  };
  const request = validatePromptEvidenceRequest(input, task);
  const adapter = adapterFor(() => ({ ok: true }));
  const forgedCoverageRequest = {
    ...request,
    sourceCoverage: { ...request.sourceCoverage, mappedNonWhitespaceCharacters: request.sourceCoverage.nonWhitespaceCharacters, complete: true },
  };
  const report = await verifyPromptEvidence(forgedCoverageRequest, [adapter], { runId: 'uncovered-goal', attempt: 0 });
  assert.equal(report.verdict, 'NOT PROVEN');
  assert.equal(report.schema, 'amabie-prompt-evidence-report/2');
  assert.equal((report as unknown as { sourceCoverage?: { complete: boolean } }).sourceCoverage?.complete, false);
  assert.match(report.issues.join(' '), /original goal.*uncovered/u);

  let correctionCalled = false;
  const loop = await runBoundedCorrectionLoop({
    request,
    adapters: [adapter],
    authorized: true,
    async correct() { correctionCalled = true; return { outcome: 'applied', scopeDigest: request.scopeDigest }; },
  });
  assert.equal(loop.status as string, 'scope-incomplete');
  assert.equal(correctionCalled, false);
  assert.equal(loop.correctionReport?.schema, 'amabie-correction-report/2');
  assert.ok((loop.correctionReport as unknown as { scopeGaps?: string[] } | null)?.scopeGaps?.length);
});

test('a paraphrased requirement cannot mark its quoted source text clear without review', async () => {
  const goalText = 'Validate email input.';
  const requirementText = 'Email validation is implemented.';
  const input: PromptEvidenceRequest = {
    schema: PROMPT_EVIDENCE_SCHEMA,
    goal: { taskType: 'coding', text: goalText },
    requirements: [{
      text: requirementText,
      sourceRef: { kind: 'goal', start: 0, end: goalText.length, excerpt: goalText },
      clarity: 'clear',
      criteria: [{
        statement: 'A sealed check proves email validation.',
        adapterId: ADAPTER,
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    }],
  };
  const task: RegisteredTask = {
    taskType: 'coding',
    taskDigest: materialDigest(goalText),
    requirementDigests: [materialDigest(requirementText)],
  };
  const request = validatePromptEvidenceRequest(input, task);
  assert.equal(request.requirements[0]!.clarity, 'unclear');
  assert.equal(request.sourceCoverage.unmatchedSourceReferences, 1);
  const report = await verifyPromptEvidence(request, [adapterFor(() => ({ ok: true }))], { runId: 'paraphrase', attempt: 0 });
  assert.equal(report.verdict, 'NOT PROVEN');
  assert.match(report.issues.join(' '), /source reference.*do not match/u);
});
