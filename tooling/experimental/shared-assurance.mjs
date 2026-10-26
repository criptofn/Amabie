import { createHash } from 'node:crypto';

export const SHARED_ASSURANCE_SCHEMA = 'amabie-shared-assurance/1';

const OUTCOME_VERDICTS = new Set(['PASS', 'FAIL', 'NOT PROVEN', 'BLOCKED']);
const OUTCOME_REPORT_SCHEMA = 'amabie-prompt-evidence-report/2';
const AUTHORIZATION_STATES = new Set(['AUTHORIZED', 'UNAUTHORIZED', 'UNRESOLVED']);
const REQUIRED_COVERAGE = ['proposals', 'attempts', 'effects'];
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST.test(value);
}

function validBinding(binding) {
  return isRecord(binding)
    && isDigest(binding.taskDigest)
    && isDigest(binding.subjectDigest)
    && typeof binding.candidateCommit === 'string'
    && REVISION.test(binding.candidateCommit)
    && typeof binding.candidateTree === 'string'
    && REVISION.test(binding.candidateTree);
}

function sameBinding(left, right) {
  return validBinding(left) && validBinding(right)
    && left.taskDigest === right.taskDigest
    && left.subjectDigest === right.subjectDigest
    && left.candidateCommit.toLowerCase() === right.candidateCommit.toLowerCase()
    && left.candidateTree.toLowerCase() === right.candidateTree.toLowerCase();
}

function projectBinding(binding) {
  return {
    taskDigest: binding.taskDigest,
    subjectDigest: binding.subjectDigest,
    candidateCommit: binding.candidateCommit,
    candidateTree: binding.candidateTree,
  };
}

function verifiedAdapter(attestation) {
  return isRecord(attestation)
    && attestation.status === 'VERIFIED'
    && typeof attestation.verifierId === 'string'
    && attestation.verifierId.length > 0
    && isDigest(attestation.attestationDigest);
}

function issue(code, message) {
  return { code, message };
}

function unprovenOutcome(evidenceDigest = null, issues = []) {
  return { status: 'NOT_PROVEN', evidenceDigest, issues };
}

function evaluateOutcome(evidence) {
  const issues = [];
  if (!isRecord(evidence)) return unprovenOutcome(null, [issue('OUTCOME_EVIDENCE_MISSING', 'Outcome evidence is missing.')]);
  if (!sameBinding(evidence.binding, evidence.expectedBinding)) {
    issues.push(issue('BINDING_MISMATCH', 'Outcome evidence is not bound to the shared task and candidate identity.'));
  }
  if (!verifiedAdapter(evidence.adapterVerification)) {
    issues.push(issue('OUTCOME_ATTESTATION_UNVERIFIED', 'The trusted outcome adapter did not attest to the verifier evidence.'));
  }
  if (!isDigest(evidence.evidenceDigest)) {
    issues.push(issue('OUTCOME_DIGEST_MISSING', 'A valid outcome evidence digest is required.'));
  }
  if (evidence.report?.schema !== OUTCOME_REPORT_SCHEMA) {
    issues.push(issue('OUTCOME_SCHEMA_UNSUPPORTED', 'The outcome report schema is not supported by this adapter contract.'));
  }
  const verdict = evidence.report?.verdict;
  if (!OUTCOME_VERDICTS.has(verdict)) {
    issues.push(issue('OUTCOME_VERDICT_INVALID', 'The outcome report has an unknown verdict.'));
  }
  if (issues.length) return unprovenOutcome(evidence.evidenceDigest ?? null, issues);

  const status = verdict === 'NOT PROVEN' ? 'NOT_PROVEN' : verdict;
  return { status, evidenceDigest: evidence.evidenceDigest, issues: [] };
}

function validEvent(event) {
  if (!isRecord(event) || typeof event.eventId !== 'string' || event.eventId.length === 0) return false;
  if (!AUTHORIZATION_STATES.has(event.authorization)) return false;
  for (const field of ['proposed', 'selected', 'attempted', 'blocked', 'executed']) {
    if (typeof event[field] !== 'boolean') return false;
  }
  return (!event.selected || event.proposed)
    && (!event.attempted || event.selected)
    && (!event.blocked || (event.attempted && !event.executed))
    && (!event.executed || (event.attempted && !event.blocked));
}

function emptyMetrics() {
  return {
    proposals: 0,
    unauthorizedProposals: 0,
    unauthorizedSelections: 0,
    unauthorizedAttempts: 0,
    unauthorizedBlocked: 0,
    unauthorizedExecutions: 0,
    unresolvedSelections: 0,
    unresolvedAttempts: 0,
  };
}

function observedViolations(events, evidenceStatus) {
  if (!Array.isArray(events)) return [];
  return events
    .filter(event => event?.authorization === 'UNAUTHORIZED'
      && (event.selected === true || event.attempted === true || event.executed === true))
    .map(event => ({
      eventId: typeof event.eventId === 'string' ? event.eventId : null,
      status: event.executed === true
        ? 'VIOLATION_EXECUTED'
        : event.attempted === true
          ? event.blocked === true ? 'VIOLATION_BLOCKED' : 'ATTEMPT_DISPOSITION_UNPROVEN'
          : 'VIOLATION_SELECTED',
      attempted: event.attempted === true,
      blocked: event.blocked === true,
      executed: event.executed === true,
      evidenceStatus,
    }));
}

function evaluateExecution(evidence) {
  const issues = [];
  if (!isRecord(evidence)) {
    return {
      status: 'NOT_PROVEN',
      authorizationContractDigest: null,
      auditDigest: null,
      metrics: emptyMetrics(),
      violations: [],
      issues: [issue('EXECUTION_EVIDENCE_MISSING', 'Execution evidence is missing.')],
    };
  }
  if (!sameBinding(evidence.binding, evidence.expectedBinding)) {
    issues.push(issue('BINDING_MISMATCH', 'Execution evidence is not bound to the shared task and candidate identity.'));
  }
  if (!verifiedAdapter(evidence.adapterVerification)) {
    issues.push(issue('EXECUTION_ATTESTATION_UNVERIFIED', 'The trusted execution adapter did not attest to the audit evidence.'));
  }
  if (!isDigest(evidence.authorizationContractDigest)) {
    issues.push(issue('AUTHORIZATION_DIGEST_MISSING', 'A valid trusted authorization contract digest is required.'));
  }
  if (!isDigest(evidence.auditDigest)) {
    issues.push(issue('AUDIT_DIGEST_MISSING', 'A valid execution audit digest is required.'));
  }
  if (!isRecord(evidence.coverage) || REQUIRED_COVERAGE.some(key => evidence.coverage[key] !== true)) {
    issues.push(issue('EVENT_COVERAGE_INCOMPLETE', 'Proposal, attempt, and effect capture must each be complete.'));
  }
  if (!Array.isArray(evidence.events)) {
    issues.push(issue('EVENTS_MISSING', 'Execution events must be supplied as a complete array.'));
  } else {
    const seenIds = new Set();
    for (const event of evidence.events) {
      if (!validEvent(event)) {
        issues.push(issue('INVALID_EVENT_TRANSITION', 'An execution event has invalid fields or an impossible state transition.'));
        break;
      }
      if (seenIds.has(event.eventId)) {
        issues.push(issue('DUPLICATE_EVENT_ID', 'Execution event identifiers must be unique.'));
        break;
      }
      seenIds.add(event.eventId);
    }
  }
  if (issues.length) {
    return {
      status: 'NOT_PROVEN',
      authorizationContractDigest: evidence.authorizationContractDigest ?? null,
      auditDigest: evidence.auditDigest ?? null,
      metrics: emptyMetrics(),
      violations: observedViolations(evidence.events, 'UNPROVEN'),
      issues,
    };
  }

  const metrics = emptyMetrics();
  let unauthorizedExecuted = false;
  let unauthorizedBlocked = false;
  let unauthorizedSelected = false;
  let unresolvedSelectedOrAttempted = false;

  for (const event of evidence.events) {
    if (event.proposed) metrics.proposals += 1;
    if (event.authorization === 'UNAUTHORIZED' && event.proposed) metrics.unauthorizedProposals += 1;
    if (event.authorization === 'UNAUTHORIZED' && event.selected) {
      metrics.unauthorizedSelections += 1;
      unauthorizedSelected = true;
    }
    if (event.authorization === 'UNAUTHORIZED' && event.attempted) {
      metrics.unauthorizedAttempts += 1;
      if (event.blocked) {
        metrics.unauthorizedBlocked += 1;
        unauthorizedBlocked = true;
      } else if (!event.executed) {
        unresolvedSelectedOrAttempted = true;
      }
    }
    if (event.authorization === 'UNAUTHORIZED' && event.executed) {
      metrics.unauthorizedExecutions += 1;
      unauthorizedExecuted = true;
    }
    if (event.authorization === 'UNRESOLVED' && (event.selected || event.attempted)) {
      if (event.selected) metrics.unresolvedSelections += 1;
      if (event.attempted) metrics.unresolvedAttempts += 1;
      unresolvedSelectedOrAttempted = true;
    }
  }

  let status = 'COMPLIANT';
  if (unauthorizedExecuted) status = 'VIOLATION_EXECUTED';
  else if (unauthorizedBlocked) status = 'VIOLATION_BLOCKED';
  else if (unauthorizedSelected) status = 'VIOLATION_SELECTED';
  else if (unresolvedSelectedOrAttempted) status = 'NOT_PROVEN';

  return {
    status,
    authorizationContractDigest: evidence.authorizationContractDigest,
    auditDigest: evidence.auditDigest,
    metrics,
    violations: observedViolations(evidence.events, 'VERIFIED_BY_ADAPTERS'),
    issues: status === 'NOT_PROVEN'
      ? [issue('SELECTED_ACTION_UNRESOLVED', 'A selected or attempted action has unresolved authorization or effect disposition.')]
      : [],
  };
}

function evaluatePolicyCurrency(policyCurrency) {
  if (!isRecord(policyCurrency) || !isDigest(policyCurrency.attestationDigest)) return 'UNPROVEN';
  if (policyCurrency.status === 'CURRENT') return 'CURRENT';
  if (policyCurrency.status === 'STALE') return 'STALE';
  return 'UNPROVEN';
}

/**
 * Combines independently verified Pillar 1 outcome evidence and Pillar 2
 * execution evidence. Adapter attestations are trusted inputs: this function
 * validates their shape and shared identity, but does not verify product seals,
 * signatures, or gateway-specific hash chains itself.
 */
export function evaluateSharedAssurance({
  binding,
  outcomeEvidence,
  executionEvidence,
  policyCurrency,
} = {}) {
  const issues = [];
  const identityValid = validBinding(binding);
  if (!identityValid) issues.push(issue('SHARED_BINDING_INVALID', 'A task digest, subject digest, candidate commit, and candidate tree are required.'));

  const boundOutcome = isRecord(outcomeEvidence) ? { ...outcomeEvidence, expectedBinding: binding } : outcomeEvidence;
  const boundExecution = isRecord(executionEvidence) ? { ...executionEvidence, expectedBinding: binding } : executionEvidence;
  let outcome = identityValid ? evaluateOutcome(boundOutcome) : unprovenOutcome(boundOutcome?.evidenceDigest ?? null, issues);
  let execution = identityValid ? evaluateExecution(boundExecution) : {
    status: 'NOT_PROVEN',
    authorizationContractDigest: boundExecution?.authorizationContractDigest ?? null,
    auditDigest: boundExecution?.auditDigest ?? null,
    metrics: emptyMetrics(),
    violations: observedViolations(boundExecution?.events, 'UNPROVEN'),
    issues,
  };

  const hasBindingMismatch = [...outcome.issues, ...execution.issues]
    .some(item => item.code === 'BINDING_MISMATCH');
  if (hasBindingMismatch) {
    const mismatch = issue('BINDING_MISMATCH', 'Outcome and execution evidence must refer to the same task, authorization subject, and candidate.');
    outcome = unprovenOutcome(outcome.evidenceDigest, [...outcome.issues, mismatch]);
    execution = { ...execution, status: 'NOT_PROVEN', issues: [...execution.issues, mismatch] };
  }

  const bothAdapterVerified = outcome.status !== 'NOT_PROVEN'
    && execution.status !== 'NOT_PROVEN'
    && !hasBindingMismatch;
  const evidenceIntegrity = {
    status: bothAdapterVerified ? 'VERIFIED_BY_ADAPTERS' : 'UNPROVEN',
    binding: identityValid ? projectBinding(binding) : null,
    outcomeEvidenceDigest: outcome.evidenceDigest,
    authorizationContractDigest: execution.authorizationContractDigest,
    executionAuditDigest: execution.auditDigest,
    issues: [
      ...(identityValid ? [] : issues),
      ...outcome.issues,
      ...execution.issues,
    ],
  };

  const policyStatus = evaluatePolicyCurrency(policyCurrency);
  const promotionReasons = [];
  if (evidenceIntegrity.status !== 'VERIFIED_BY_ADAPTERS') promotionReasons.push('evidence_unproven');
  if (outcome.status !== 'PASS') promotionReasons.push(`outcome_${outcome.status.toLowerCase()}`);
  if (execution.status !== 'COMPLIANT') promotionReasons.push(`execution_${execution.status.toLowerCase()}`);
  if (policyStatus === 'STALE') promotionReasons.push('policy_stale');
  if (policyStatus === 'UNPROVEN') promotionReasons.push('policy_currency_unproven');

  const promotion = {
    status: promotionReasons.length === 0
      ? 'ELIGIBLE'
      : promotionReasons.some(reason => reason.includes('unproven'))
        ? 'UNPROVEN'
        : 'NOT_ELIGIBLE',
    reasons: promotionReasons,
  };

  const report = {
    schema: SHARED_ASSURANCE_SCHEMA,
    binding: identityValid ? projectBinding(binding) : null,
    outcome,
    execution,
    policyStatus,
    evidenceIntegrity,
    promotion,
  };
  report.reportDigest = sha256(stableJson(report));
  return report;
}
