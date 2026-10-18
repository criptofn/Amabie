import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMPT_EVIDENCE_SCHEMA,
  correctionReportFor,
  draftPromptEvidence,
  draftPromptEvidenceFromQuotes,
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

test('free-form compound prompts produce deterministic, exact-span candidates that remain review-only', () => {
  const goal = 'Implement account creation, reject invalid email, and hash passwords. Preserve existing login behavior.';
  const draft = draftPromptEvidence(goal);
  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Implement account creation',
    'reject invalid email',
    'hash passwords.',
    'Preserve existing login behavior.',
  ]);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.equal(draft.sourceCoverage.complete, true);
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  const refs = draft.request.requirements.map(requirement => requirement.sourceRef);
  assert.equal(refs[0]!.start, 0);
  assert.equal(refs.at(-1)!.end, goal.length);
  for (const [index, requirement] of draft.request.requirements.entries()) {
    const ref = requirement.sourceRef;
    assert.equal(goal.slice(ref.start, ref.end), ref.excerpt);
    assert.equal(goal.slice(ref.focusStart!, ref.focusEnd!), requirement.text);
    if (index > 0) assert.equal(refs[index - 1]!.end, ref.start, 'source ranges partition the original prompt without gaps or overlaps');
  }
  assert.deepEqual(draft.candidates.map(candidate => candidate.id), draftPromptEvidence(goal).candidates.map(candidate => candidate.id));

  const finalList = draftPromptEvidence('Add input validation, tests and safe password storage.');
  assert.deepEqual(finalList.request.requirements.map(requirement => requirement.text), [
    'Add input validation, tests and safe password storage.',
  ]);
  assert.equal(finalList.sourceCoverage.complete, true);
});

test('natural prompts preserve comma-separated values and conditional clauses', () => {
  const goal = 'Build a CSV importer and exporter for transaction records. Accept UTF-8 CSV with date, merchant, amount, and currency headers. Reject files larger than 1 MiB. If any row is invalid, save no rows. Validate every date and amount. Escape formulas in CSV exports by prefixing values beginning with =, +, -, or @. Preserve existing export behavior. Add tests for valid imports, malformed rows, the size limit, and formula escaping. Document the command and its exit codes.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Build a CSV importer and exporter for transaction records.',
    'Accept UTF-8 CSV with date, merchant, amount, and currency headers.',
    'Reject files larger than 1 MiB.',
    'If any row is invalid, save no rows.',
    'Validate every date and amount.',
    'Escape formulas in CSV exports by prefixing values beginning with =, +, -, or @.',
    'Preserve existing export behavior.',
    'Add tests for valid imports, malformed rows, the size limit, and formula escaping.',
    'Document the command and its exit codes.',
  ]);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.equal(draft.sourceCoverage.complete, true);
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
});

test('free prose splits common inflected actions and action gerunds into source-linked review candidates', () => {
  const goal = 'Build a CSV transaction importer that returns accepted rows and structured errors, requires id, date, amount, and description headers, accepts a UTF-8 BOM, parses quoted commas and escaped double quotes, rejects missing or blank ids, rejects missing, non-numeric, NaN, or infinite amounts, reports original one-based physical line numbers across quoted newlines, keeps the first valid row for duplicate IDs, totals only accepted signed amounts, and exports correctly quoted CSV while neutralizing spreadsheet formulas. Preserve existing signed-total behavior, and include tests.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Build a CSV transaction importer that returns accepted rows and structured errors',
    'requires id, date, amount, and description headers',
    'accepts a UTF-8 BOM',
    'parses quoted commas and escaped double quotes',
    'rejects missing or blank ids',
    'rejects missing, non-numeric, NaN, or infinite amounts',
    'reports original one-based physical line numbers across quoted newlines',
    'keeps the first valid row for duplicate IDs',
    'totals only accepted signed amounts',
    'exports correctly quoted CSV',
    'neutralizing spreadsheet formulas.',
    'Preserve existing signed-total behavior',
    'include tests.',
  ]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  for (const requirement of draft.request.requirements) {
    const ref = requirement.sourceRef;
    assert.equal(goal.slice(ref.focusStart!, ref.focusEnd!), requirement.text);
  }
});

test('free prose separates coordinated declarative actions without proving them', () => {
  const goal = 'The signed balance must remain negative when expenses outweigh credits, and export must quote CSV fields while neutralizing formula-leading cells.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'The signed balance must remain negative when expenses outweigh credits',
    'export must quote CSV fields',
    'neutralizing formula-leading cells.',
  ]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));

  const conditional = draftPromptEvidence('Keep a session active while the user is logged in.');
  assert.deepEqual(conditional.request.requirements.map(requirement => requirement.text), [
    'Keep a session active while the user is logged in.',
  ]);
});

test('deterministic extraction splits coordinated action clauses with attach', () => {
  const goal = 'Parse quoted fields containing commas and escaped quotes, and attach each rejection to its original physical line number.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Parse quoted fields containing commas and escaped quotes',
    'attach each rejection to its original physical line number.',
  ]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
});

test('free prose separates an independent preservation obligation joined with but', () => {
  const goal = 'Add CSV import but preserve the existing signed-total behavior.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Add CSV import',
    'preserve the existing signed-total behavior.',
  ]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
});

test('common in-sentence abbreviations do not fragment one requirement into false candidates', () => {
  for (const goal of [
    'Set a cache lifetime, e.g. 30 seconds, i.e. half a minute.',
    'Compare HTTP vs. HTTPS defaults.',
  ]) {
    const draft = draftPromptEvidence(goal);
    assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [goal]);
    assert.equal(draft.sourceCoverage.complete, true);
    assert.equal(draft.verdict, 'NOT PROVEN');
    assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  }
});

test('extractor-proposed quotes are exact, ordered, source-mapped, and still require review', () => {
  const goal = 'Create accounts, reject invalid email, and hash passwords.';
  const draft = draftPromptEvidenceFromQuotes(goal, [
    'Create accounts',
    'reject invalid email',
    'hash passwords.',
  ]);
  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'Create accounts', 'reject invalid email', 'hash passwords.',
  ]);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.equal(draft.sourceCoverage.complete, true);
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  for (const [index, requirement] of draft.request.requirements.entries()) {
    assert.equal(goal.slice(requirement.sourceRef.focusStart!, requirement.sourceRef.focusEnd!), requirement.text);
    if (index > 0) assert.equal(draft.request.requirements[index - 1]!.sourceRef.end, requirement.sourceRef.start);
  }
});

test('an omitted clause stays visible in its source span and cannot turn an extraction draft into PASS', () => {
  const goal = 'Implement account registration, validate email addresses, hash passwords with Argon2, preserve existing login behavior, and add tests.';
  const draft = draftPromptEvidenceFromQuotes(goal, [
    'Implement account registration',
    'validate email addresses',
    'hash passwords with Argon2',
    'add tests.',
  ]);

  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.equal(draft.reviewRequired, true);
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  const narrowCandidate = draft.request.requirements[2]!;
  assert.equal(goal.slice(narrowCandidate.sourceRef.focusStart!, narrowCandidate.sourceRef.focusEnd!), narrowCandidate.text);
  const recoveredCandidate = draft.request.requirements.find(requirement => requirement.text === 'preserve existing login behavior');
  assert.ok(recoveredCandidate);
  assert.equal(goal.slice(recoveredCandidate.sourceRef.focusStart!, recoveredCandidate.sourceRef.focusEnd!), recoveredCandidate.text);
  assert.ok(draft.request.requirements.some(requirement => requirement.text.includes('add tests.')));
  assert.match(draft.notes.join(' '), /lexical, not semantic completeness/u);
  assert.match(draft.notes.join(' '), /unquoted prompt text.*preserved as additional unresolved candidates.*preserve existing login behavior/iu);
});

test('extraction review surfaces omitted text at the prompt edges and ignores connective-only gaps', () => {
  const leadingGoal = 'Create accounts, validate email addresses, and add tests.';
  const leading = draftPromptEvidenceFromQuotes(leadingGoal, ['validate email addresses', 'add tests.']);
  assert.ok(leading.request.requirements.some(requirement => requirement.text.includes('Create accounts')));
  assert.match(leading.notes.join(' '), /not covered by the extractor's exact quotes.*Create accounts/iu);

  const trailingGoal = 'Create accounts, validate email addresses, and add tests.';
  const trailing = draftPromptEvidenceFromQuotes(trailingGoal, ['Create accounts', 'validate email addresses']);
  assert.ok(trailing.request.requirements.some(requirement => requirement.text.includes('add tests')));
  assert.match(trailing.notes.join(' '), /not covered by the extractor's exact quotes.*add tests/iu);

  const connectiveGoal = 'Create accounts, and add tests.';
  const connectiveOnly = draftPromptEvidenceFromQuotes(connectiveGoal, ['Create accounts', 'add tests.']);
  assert.equal(connectiveOnly.notes.some(note => /unquoted prompt text/iu.test(note)), false);
  assert.equal(connectiveOnly.verdict, 'NOT PROVEN');

  const numberedGoal = '1. Create accounts\n2. Add tests.';
  const numbered = draftPromptEvidenceFromQuotes(numberedGoal, ['Create accounts', 'Add tests.']);
  assert.deepEqual(numbered.request.requirements.map(requirement => requirement.text), ['Create accounts', 'Add tests.']);
  assert.equal(numbered.notes.some(note => /unquoted prompt text/iu.test(note)), false);
});

test('a polite request opener does not look like an omitted requirement', () => {
  const draft = draftPromptEvidenceFromQuotes('Please add tests.', ['add tests.']);

  assert.equal(draft.notes.some(note => /unquoted prompt text/iu.test(note)), false);
  assert.equal(draft.verdict, 'NOT PROVEN');
});

test('extractor-proposed quotes reject paraphrases, ambiguous repetitions, overlaps, and empty output', () => {
  assert.throws(() => draftPromptEvidenceFromQuotes('Add email validation.', ['Validate the email.']), /not an exact source quote/u);
  assert.throws(() => draftPromptEvidenceFromQuotes('Test twice. Test twice.', ['Test twice.']), /ambiguous because it occurs more than once/u);
  assert.throws(() => draftPromptEvidenceFromQuotes('Validate email input.', ['Validate email', 'email input']), /overlap/u);
  assert.throws(() => draftPromptEvidenceFromQuotes('Add tests.', []), /at least one exact source quote/u);
});

test('extractor-proposed quotes map repeated requirements only when every exact occurrence is represented', () => {
  const goal = 'Test twice. Test twice.';
  const draft = draftPromptEvidenceFromQuotes(goal, ['Test twice.', 'Test twice.']);
  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), ['Test twice.', 'Test twice.']);
  assert.deepEqual(draft.request.requirements.map(requirement => [requirement.sourceRef.focusStart, requirement.sourceRef.focusEnd]), [[0, 11], [12, 23]]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.throws(() => draftPromptEvidenceFromQuotes(goal, ['Test twice.', 'Test twice.', 'Test twice.']), /occurrence count does not match/u);
});

test('an ambiguous coordinated noun phrase stays a single unclear candidate', () => {
  const goal = 'Implement registration with email and password checks.';
  const draft = draftPromptEvidence(goal);
  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [goal]);
  assert.equal(draft.request.requirements[0]!.clarity, 'unclear');
  assert.equal(draft.request.requirements[0]!.criteria.length, 0);
});

test('request validation rejects forged focus offsets even when the broader source quote is intact', () => {
  const draft = draftPromptEvidence('Implement account creation, then add tests.');
  const input = structuredClone(draft.request) as PromptEvidenceRequest;
  const first = input.requirements[0]!;
  first.sourceRef.focusStart = first.sourceRef.focusStart! + 1;
  const task: RegisteredTask = {
    taskType: 'coding',
    taskDigest: materialDigest(draft.request.goal.text),
    requirementDigests: draft.request.requirements.map(requirement => materialDigest(requirement.text)),
  };
  assert.throws(() => validatePromptEvidenceRequest(input, task), /focus offsets do not quote the exact candidate text/u);
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
  assert.equal(correctionReportFor(stuck.verification, data.request).unresolved.length, 1);
});

test('the correction loop can enforce a smaller per-run cap without exceeding the hard three-cycle ceiling', async () => {
  const data = makeRequest([{ text: registration }]);
  let calls = 0;
  const result = await runBoundedCorrectionLoop({
    request: data.request,
    adapters: [adapterFor(() => undefined)],
    authorized: true,
    maxAttempts: 1,
    async correct() { calls += 1; return { outcome: 'applied', scopeDigest: data.request.scopeDigest }; },
  });
  assert.equal(result.status, 'limit-reached');
  assert.equal(result.correctionAttempts, 1);
  assert.equal(calls, 1);
  assert.match(result.stopReason ?? '', /1-cycle correction limit/u);

  await assert.rejects(() => runBoundedCorrectionLoop({
    request: data.request,
    adapters: [adapterFor(() => undefined)],
    authorized: true,
    maxAttempts: 4,
  }), /maxAttempts must be an integer from 1 to 3/u);
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
  assert.equal(loop.correctionReport?.schema, 'amabie-correction-report/3');
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

test('correction reports include the unresolved criterion contract for the executing agent', async () => {
  const data = makeRequest([{ text: registration }]);
  const verification = await verifyPromptEvidence(data.request, [adapterFor(() => ({ ok: false }))], {
    runId: 'correction-context',
    attempt: 0,
  });

  const correction = correctionReportFor(verification, data.request);
  assert.equal(correction.schema, 'amabie-correction-report/3');
  assert.equal(correction.unresolved.length, 1);
  assert.deepEqual(correction.unresolved[0]?.criteria, [{
    criterionId: data.request.requirements[0]!.criteria[0]!.id,
    statement: `The sealed check covers: ${registration}`,
    adapterId: ADAPTER,
    evidenceType: 'sealed-check-run',
    predicate: { path: '/ok', equals: true },
    status: 'unmet',
    gap: verification.requirements[0]!.criteria[0]!.note,
  }]);
  assert.equal(Object.hasOwn(correction.unresolved[0]!.criteria[0]!, 'evidence'), false);
  assert.equal(Object.hasOwn(correction.unresolved[0]!.criteria[0]!, 'facts'), false);
});

test('correction reports reject a verification report for a different sealed request', async () => {
  const first = makeRequest([{ text: registration }]);
  const second = makeRequest([{ text: registration }, { text: 'Preserve existing login behavior.' }]);
  const verification = await verifyPromptEvidence(first.request, [adapterFor(() => ({ ok: false }))], {
    runId: 'correction-context-mismatch',
    attempt: 0,
  });

  assert.throws(() => correctionReportFor(verification, second.request), /does not match the verified request/u);

  const mismatchedRequirement = {
    ...verification,
    requirements: verification.requirements.map(requirement => ({ ...requirement, text: `${requirement.text} changed` })),
  };
  assert.throws(() => correctionReportFor(mismatchedRequirement, first.request), /does not match the verified request/u);

  const mismatchedCriterion = {
    ...verification,
    requirements: verification.requirements.map(requirement => ({
      ...requirement,
      criteria: requirement.criteria.map(criterion => ({ ...criterion, criterionId: 'unknown-criterion' })),
    })),
  };
  assert.throws(() => correctionReportFor(mismatchedCriterion, first.request), /does not match the verified request/u);

  assert.throws(() => correctionReportFor({ ...verification, requirements: [] }, first.request), /does not match the verified request/u);
  const missingCriterion = {
    ...verification,
    requirements: verification.requirements.map(requirement => ({ ...requirement, criteria: [] })),
  };
  assert.throws(() => correctionReportFor(missingCriterion, first.request), /does not match the verified request/u);
});

test('free prose splits a coordinated subject-modal action into unresolved source-linked candidates', () => {
  const goal = 'The invite expires after 24 hours, and existing users can accept an invitation without creating duplicate accounts.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [
    'The invite expires after 24 hours',
    'existing users can accept an invitation without creating duplicate accounts.',
  ]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  for (const requirement of draft.request.requirements) {
    const ref = requirement.sourceRef;
    assert.equal(goal.slice(ref.focusStart!, ref.focusEnd!), requirement.text);
  }
});
test('free-prose subject-modal boundaries do not split a dependent only-when clause', () => {
  const goal = 'Show a warning, but only when an administrator can approve it.';
  const draft = draftPromptEvidence(goal);

  assert.deepEqual(draft.request.requirements.map(requirement => requirement.text), [goal]);
  assert.equal(draft.sourceCoverage.complete, true);
  assert.equal(draft.verdict, 'NOT PROVEN');
  assert.ok(draft.request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
});
