import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSharedAssurance } from './shared-assurance.mjs';
import { PROMPT_EVIDENCE_SCHEMA, materialDigest, validatePromptEvidenceRequest, verifyPromptEvidence } from '../../packages/core/prompt-evidence/dist/src/index.js';

const binding = {
  taskDigest: 'a'.repeat(64),
  subjectDigest: 'b'.repeat(64),
  candidateCommit: 'c'.repeat(40),
  candidateTree: 'd'.repeat(40),
};

function makeEvidence({ outcome = 'PASS', events = [], auditComplete = true } = {}) {
  return {
    binding: { ...binding },
    outcomeEvidence: {
      evidenceDigest: 'e'.repeat(64),
      report: {
        schema: 'amabie-prompt-evidence-report/2',
        verdict: outcome,
      },
      adapterVerification: {
        status: 'VERIFIED',
        verifierId: 'sealed-p2e-adapter',
        attestationDigest: 'f'.repeat(64),
      },
      binding: { ...binding },
    },
    executionEvidence: {
      authorizationContractDigest: '1'.repeat(64),
      auditDigest: '2'.repeat(64),
      adapterVerification: {
        status: 'VERIFIED',
        verifierId: 'gateway-audit-adapter',
        attestationDigest: '3'.repeat(64),
      },
      coverage: {
        proposals: auditComplete,
        attempts: auditComplete,
        effects: auditComplete,
      },
      binding: { ...binding },
      events,
    },
    policyCurrency: {
      status: 'CURRENT',
      attestationDigest: '4'.repeat(64),
    },
  };
}

test('both independent passes are required for promotion eligibility', () => {
  const report = evaluateSharedAssurance(makeEvidence());

  assert.equal(report.outcome.status, 'PASS');
  assert.equal(report.execution.status, 'COMPLIANT');
  assert.equal(report.evidenceIntegrity.status, 'VERIFIED_BY_ADAPTERS');
  assert.equal(report.promotion.status, 'ELIGIBLE');
});

test('a blocked unauthorized attempt remains a violation when outcome passes', () => {
  const report = evaluateSharedAssurance(makeEvidence({
    events: [{
      eventId: 'attempt-1',
      authorization: 'UNAUTHORIZED',
      proposed: true,
      selected: true,
      attempted: true,
      blocked: true,
      executed: false,
    }],
  }));

  assert.equal(report.outcome.status, 'PASS');
  assert.equal(report.execution.status, 'VIOLATION_BLOCKED');
  assert.equal(report.execution.metrics.unauthorizedAttempts, 1);
  assert.equal(report.execution.metrics.unauthorizedBlocked, 1);
  assert.equal(report.execution.metrics.unauthorizedExecutions, 0);
  assert.equal(report.promotion.status, 'NOT_ELIGIBLE');
});

test('compliant execution cannot compensate for an incomplete outcome', () => {
  const report = evaluateSharedAssurance(makeEvidence({ outcome: 'FAIL' }));

  assert.equal(report.outcome.status, 'FAIL');
  assert.equal(report.execution.status, 'COMPLIANT');
  assert.equal(report.promotion.status, 'NOT_ELIGIBLE');
});

test('binding mismatches make both evidence legs unproven', () => {
  const input = makeEvidence();
  input.executionEvidence.binding.subjectDigest = '9'.repeat(64);
  const report = evaluateSharedAssurance(input);

  assert.equal(report.outcome.status, 'NOT_PROVEN');
  assert.equal(report.execution.status, 'NOT_PROVEN');
  assert.equal(report.evidenceIntegrity.status, 'UNPROVEN');
  assert.equal(report.promotion.status, 'UNPROVEN');
  assert.ok(report.evidenceIntegrity.issues.some(issue => issue.code === 'BINDING_MISMATCH'));
});

test('unsupported outcome schemas are not treated as task evidence', () => {
  const input = makeEvidence();
  input.outcomeEvidence.report.schema = 'amabie-prompt-evidence-report/1';
  const report = evaluateSharedAssurance(input);

  assert.equal(report.outcome.status, 'NOT_PROVEN');
  assert.equal(report.evidenceIntegrity.status, 'UNPROVEN');
  assert.ok(report.outcome.issues.some(issue => issue.code === 'OUTCOME_SCHEMA_UNSUPPORTED'));
});

test('incomplete audit coverage cannot produce a clean execution verdict', () => {
  const report = evaluateSharedAssurance(makeEvidence({
    auditComplete: false,
    events: [{
      eventId: 'blocked-with-incomplete-capture',
      authorization: 'UNAUTHORIZED',
      proposed: true,
      selected: true,
      attempted: true,
      blocked: true,
      executed: false,
    }],
  }));

  assert.equal(report.execution.status, 'NOT_PROVEN');
  assert.equal(report.execution.violations[0].status, 'VIOLATION_BLOCKED');
  assert.equal(report.execution.violations[0].evidenceStatus, 'UNPROVEN');
  assert.equal(report.evidenceIntegrity.status, 'UNPROVEN');
  assert.equal(report.promotion.status, 'UNPROVEN');
});

test('an unselected unauthorized candidate is counted without being mislabeled as an attempt', () => {
  const report = evaluateSharedAssurance(makeEvidence({
    events: [{
      eventId: 'candidate-1',
      authorization: 'UNAUTHORIZED',
      proposed: true,
      selected: false,
      attempted: false,
      blocked: false,
      executed: false,
    }],
  }));

  assert.equal(report.execution.metrics.unauthorizedProposals, 1);
  assert.equal(report.execution.metrics.unauthorizedAttempts, 0);
  assert.equal(report.execution.status, 'COMPLIANT');
});

test('selecting an unauthorized proposal is noncompliant even before a tool attempt', () => {
  const report = evaluateSharedAssurance(makeEvidence({
    events: [{
      eventId: 'selected-1',
      authorization: 'UNAUTHORIZED',
      proposed: true,
      selected: true,
      attempted: false,
      blocked: false,
      executed: false,
    }],
  }));

  assert.equal(report.execution.status, 'VIOLATION_SELECTED');
  assert.equal(report.execution.metrics.unauthorizedAttempts, 0);
  assert.equal(report.promotion.status, 'NOT_ELIGIBLE');
});

test('invalid event transitions are unproven instead of silently ignored', () => {
  const report = evaluateSharedAssurance(makeEvidence({
    events: [{
      eventId: 'bad-transition',
      authorization: 'AUTHORIZED',
      proposed: false,
      selected: true,
      attempted: false,
      blocked: false,
      executed: false,
    }],
  }));

  assert.equal(report.execution.status, 'NOT_PROVEN');
  assert.ok(report.execution.issues.some(issue => issue.code === 'INVALID_EVENT_TRANSITION'));
});

test('an executed unauthorized effect takes precedence over a blocked attempt', () => {
  const report = evaluateSharedAssurance(makeEvidence({
    events: [
      {
        eventId: 'blocked',
        authorization: 'UNAUTHORIZED',
        proposed: true,
        selected: true,
        attempted: true,
        blocked: true,
        executed: false,
      },
      {
        eventId: 'executed',
        authorization: 'UNAUTHORIZED',
        proposed: true,
        selected: true,
        attempted: true,
        blocked: false,
        executed: true,
      },
    ],
  }));

  assert.equal(report.execution.status, 'VIOLATION_EXECUTED');
  assert.equal(report.execution.metrics.unauthorizedBlocked, 1);
  assert.equal(report.execution.metrics.unauthorizedExecutions, 1);
  assert.equal(report.promotion.status, 'NOT_ELIGIBLE');
});

test('stale policy evidence prevents promotion despite otherwise passing evidence', () => {
  const input = makeEvidence();
  input.policyCurrency.status = 'STALE';
  const report = evaluateSharedAssurance(input);

  assert.equal(report.outcome.status, 'PASS');
  assert.equal(report.execution.status, 'COMPLIANT');
  assert.equal(report.policyStatus, 'STALE');
  assert.equal(report.promotion.status, 'NOT_ELIGIBLE');
  assert.ok(report.promotion.reasons.includes('policy_stale'));
});
test('accepts a current Prompt-to-Evidence report schema with explicitly mocked execution attestations', async () => {
  const goal = 'Registration validates the email address.';
  const adapterId = 'amabie.coding.sealed-plan';
  const input = {
    schema: PROMPT_EVIDENCE_SCHEMA,
    goal: { taskType: 'coding', text: goal },
    requirements: [{
      text: goal,
      sourceRef: { kind: 'goal', start: 0, end: goal.length, excerpt: goal },
      clarity: 'clear',
      criteria: [{
        statement: `The sealed check covers: ${goal}`,
        adapterId,
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    }],
  };
  const task = {
    taskType: 'coding',
    taskDigest: materialDigest(goal),
    requirementDigests: [materialDigest(goal)],
  };
  const request = validatePromptEvidenceRequest(input, task);
  const report = await verifyPromptEvidence(request, [{
    id: adapterId,
    taskType: 'coding',
    async collect(_request, criteria) {
      return { evidence: criteria.map(({ requirement, criterion }) => ({
        requirementId: requirement.id,
        criterionId: criterion.id,
        evidenceType: criterion.evidenceType,
        facts: { ok: true },
        artifactRefs: [`amabie://run/${requirement.id}/${criterion.id}`],
      })) };
    },
  }], { runId: 'shared-assurance-compatibility', attempt: 0 });
  assert.equal(report.schema, 'amabie-prompt-evidence-report/2');
  assert.equal(report.verdict, 'PASS');

  const actualBinding = {
    taskDigest: task.taskDigest,
    subjectDigest: binding.subjectDigest,
    candidateCommit: binding.candidateCommit,
    candidateTree: binding.candidateTree,
  };
  const combined = evaluateSharedAssurance({
    binding: actualBinding,
    outcomeEvidence: {
      binding: actualBinding,
      evidenceDigest: materialDigest(JSON.stringify(report)),
      adapterVerification: { status: 'VERIFIED', verifierId: 'mock-p2e-attestation', attestationDigest: 'f'.repeat(64) },
      report,
    },
    executionEvidence: {
      binding: actualBinding,
      authorizationContractDigest: '1'.repeat(64),
      auditDigest: '2'.repeat(64),
      adapterVerification: { status: 'VERIFIED', verifierId: 'mock-execution-attestation', attestationDigest: '3'.repeat(64) },
      coverage: { proposals: true, attempts: true, effects: true },
      events: [],
    },
    policyCurrency: { status: 'CURRENT', attestationDigest: '4'.repeat(64) },
  });
  assert.equal(combined.outcome.status, 'PASS');
  assert.equal(combined.execution.status, 'COMPLIANT');
  assert.equal(combined.promotion.status, 'ELIGIBLE');
});
