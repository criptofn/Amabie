#!/usr/bin/env node
/**
 * P1:23 — ONE SEALED CHECK, SEVERAL REQUIREMENTS: does a shared failure refute each of them?
 *
 * A sealed check run yields one outcome for its whole script. Two requirements bound to the same
 * script therefore share that outcome. Before this fix a failing shared run marked EVERY bound
 * requirement `unmet`, which declared a requirement refuted even when the evidence could not show that.
 * After the fix a shared failure is `unproven` for each of them, and a requirement with its own check
 * keeps its own individual result.
 *
 * Usage: node tooling/probes/requirement-result-granularity.mjs
 * Exit: 0 only when every case passes; 1 otherwise.
 */
import {
  PROMPT_EVIDENCE_SCHEMA,
  materialDigest,
  validatePromptEvidenceRequest,
  verifyPromptEvidence,
} from '../../packages/core/prompt-evidence/dist/src/index.js';
import { CODING_SEALED_PLAN_ADAPTER, createCodingSealedPlanAdapter } from '../../apps/cli/dist/src/prompt-evidence.js';

const FIRST = 'the parser rejects empty input';
const SECOND = 'the parser reports the byte offset of an error';
const GOAL = `${FIRST}\n${SECOND}`;
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
};

function validated() {
  let cursor = 0;
  const requirements = [FIRST, SECOND].map(text => {
    const start = GOAL.indexOf(text, cursor);
    cursor = start + text.length + 1;
    return {
      text,
      sourceRef: { kind: 'goal', start, end: start + text.length, excerpt: text },
      clarity: 'clear',
      criteria: [{
        statement: `The sealed check covers: ${text}`,
        adapterId: CODING_SEALED_PLAN_ADAPTER,
        evidenceType: 'sealed-check-run',
        predicate: { path: '/ok', equals: true },
      }],
    };
  });
  const input = { schema: PROMPT_EVIDENCE_SCHEMA, goal: { taskType: 'coding', text: GOAL }, requirements };
  const task = {
    taskType: 'coding',
    taskDigest: materialDigest(GOAL),
    requirementDigests: [FIRST, SECOND].map(text => materialDigest(text)),
  };
  return validatePromptEvidenceRequest(input, task);
}

const result = ok => ({
  ok,
  exitCode: ok ? 0 : 1,
  startedAt: '2026-10-19T00:00:00.000Z',
  endedAt: '2026-10-19T00:00:01.000Z',
  execDigest: 'c'.repeat(64),
  stdout: '',
  stderr: ok ? '' : 'failed',
});

async function verify(proofBindings, plan, resultsByScript) {
  const adapter = createCodingSealedPlanAdapter({
    plan,
    proofBindings,
    resultsByScript: new Map(Object.entries(resultsByScript)),
    refusedScripts: new Set(),
    planDigest: 'a'.repeat(64),
    baselineDigest: null,
  });
  return verifyPromptEvidence(validated(), [adapter], { runId: 'granularity-probe', attempt: 0 });
}

const statusOf = (report, text) => report.requirements.find(requirement => requirement.text === text)?.status;
const shared = { [materialDigest(FIRST)]: 'shared', [materialDigest(SECOND)]: 'shared' };
const sharedPlan = [{ kind: 'tests', script: 'shared' }];

{
  const report = await verify(shared, sharedPlan, { shared: [result(false)] });
  const statuses = [statusOf(report, FIRST), statusOf(report, SECOND)];
  check('shared FAILING check: neither requirement is UNMET', statuses.every(status => status !== 'unmet'), `statuses ${statuses.join(',')}`);
  check('shared FAILING check: the verdict is not a refutation', report.verdict !== 'FAIL', `verdict ${report.verdict}`);
}

{
  const report = await verify(shared, sharedPlan, { shared: [result(true)] });
  const statuses = [statusOf(report, FIRST), statusOf(report, SECOND)];
  check('shared PASSING check: both requirements are MET', statuses.every(status => status === 'met'), `statuses ${statuses.join(',')}`);
  check('shared PASSING check: the verdict is PASS', report.verdict === 'PASS', `verdict ${report.verdict}`);
}

{
  const report = await verify({ [materialDigest(FIRST)]: 'only' }, [{ kind: 'tests', script: 'only' }], { only: [result(false)] });
  check('a failing check bound to ONE requirement is still UNMET', statusOf(report, FIRST) === 'unmet', `status ${statusOf(report, FIRST)}`);
}

{
  const bindings = { [materialDigest(FIRST)]: 'first', [materialDigest(SECOND)]: 'second' };
  const plan = [{ kind: 'tests', script: 'first' }, { kind: 'tests', script: 'second' }];
  const report = await verify(bindings, plan, { first: [result(true)], second: [result(false)] });
  check('dedicated checks: the passing requirement stays MET', statusOf(report, FIRST) === 'met', `status ${statusOf(report, FIRST)}`);
  check('dedicated checks: the failing requirement is UNMET', statusOf(report, SECOND) === 'unmet', `status ${statusOf(report, SECOND)}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} P1:23 requirement result granularity — a shared failure does not refute each bound requirement`);
process.exitCode = failures === 0 ? 0 : 1;
