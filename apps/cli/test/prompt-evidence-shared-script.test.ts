/**
 * ONE SEALED CHECK, SEVERAL REQUIREMENTS — a shared failure must not refute each of them.
 *
 * A sealed check run returns one outcome for the whole script. When two requirements are bound to the
 * same script and it fails, that outcome cannot say which requirement failed. Marking both `unmet`
 * declares a requirement refuted that the evidence may well support, so the adapter reports them
 * `unproven` with a group reason instead. A requirement with its own check keeps its own result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROMPT_EVIDENCE_SCHEMA,
  materialDigest,
  validatePromptEvidenceRequest,
  verifyPromptEvidence,
  type PromptEvidenceRequest,
  type RegisteredTask,
  type RequirementStatus,
} from '@amabie/prompt-evidence';

import { CODING_SEALED_PLAN_ADAPTER, createCodingSealedPlanAdapter, type SealedStepResult } from '../src/prompt-evidence.js';

const FIRST = 'the parser rejects empty input';
const SECOND = 'the parser reports the byte offset of an error';
const GOAL = `${FIRST}\n${SECOND}`;

function validated() {
  let cursor = 0;
  const requirements = [FIRST, SECOND].map(text => {
    const start = GOAL.indexOf(text, cursor);
    cursor = start + text.length + 1;
    return {
      text,
      sourceRef: { kind: 'goal' as const, start, end: start + text.length, excerpt: text },
      clarity: 'clear' as const,
      criteria: [{
        statement: `The sealed check covers: ${text}`,
        adapterId: CODING_SEALED_PLAN_ADAPTER,
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    };
  });
  const input: PromptEvidenceRequest = { schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType: 'coding', text: GOAL }, requirements };
  const task: RegisteredTask = {
    taskType: 'coding',
    taskDigest: materialDigest(GOAL),
    requirementDigests: [FIRST, SECOND].map(text => materialDigest(text)),
  };
  return validatePromptEvidenceRequest(input, task);
}

const result = (ok: boolean): SealedStepResult => ({
  ok,
  exitCode: ok ? 0 : 1,
  startedAt: '2026-10-19T00:00:00.000Z',
  endedAt: '2026-10-19T00:00:01.000Z',
  execDigest: 'c'.repeat(64),
  stdout: '',
  stderr: ok ? '' : 'failed',
});

async function verify(
  proofBindings: Record<string, string>,
  plan: Array<{ kind: string; script: string }>,
  resultsByScript: Record<string, SealedStepResult[]>,
) {
  const adapter = createCodingSealedPlanAdapter({
    plan,
    proofBindings,
    resultsByScript: new Map(Object.entries(resultsByScript)),
    refusedScripts: new Set(),
    planDigest: 'a'.repeat(64),
    baselineDigest: null,
  });
  return verifyPromptEvidence(validated(), [adapter], { runId: 'shared-script-test', attempt: 0 });
}

const statusOf = (report: Awaited<ReturnType<typeof verify>>, text: string): RequirementStatus | undefined =>
  report.requirements.find(requirement => requirement.text === text)?.status;

const shared = { [materialDigest(FIRST)]: 'shared', [materialDigest(SECOND)]: 'shared' };
const sharedPlan = [{ kind: 'tests', script: 'shared' }];

test('a failing check shared by two requirements is UNPROVEN for both, never UNMET', async () => {
  const report = await verify(shared, sharedPlan, { shared: [result(false)] });
  assert.equal(statusOf(report, FIRST), 'unproven');
  assert.equal(statusOf(report, SECOND), 'unproven');
  assert.notEqual(report.verdict, 'FAIL', 'a shared failure must not be reported as a refutation of either requirement');
});

test('a passing check shared by two requirements is MET for both', async () => {
  const report = await verify(shared, sharedPlan, { shared: [result(true)] });
  assert.equal(statusOf(report, FIRST), 'met');
  assert.equal(statusOf(report, SECOND), 'met');
  assert.equal(report.verdict, 'PASS');
});

test('a failing check bound to ONE requirement is still UNMET (the group rule does not apply)', async () => {
  const report = await verify({ [materialDigest(FIRST)]: 'only' }, [{ kind: 'tests', script: 'only' }], { only: [result(false)] });
  assert.equal(statusOf(report, FIRST), 'unmet');
  assert.equal(statusOf(report, SECOND), 'unproven');
  assert.equal(report.verdict, 'FAIL');
});

test('dedicated checks keep their own individual results', async () => {
  const bindings = { [materialDigest(FIRST)]: 'first', [materialDigest(SECOND)]: 'second' };
  const plan = [{ kind: 'tests', script: 'first' }, { kind: 'tests', script: 'second' }];
  const report = await verify(bindings, plan, { first: [result(true)], second: [result(false)] });
  assert.equal(statusOf(report, FIRST), 'met');
  assert.equal(statusOf(report, SECOND), 'unmet');
});
