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
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
};

const THIRD = 'the parser keeps line endings';

function validated(texts = [FIRST, SECOND], unclear = []) {
  const GOAL = texts.join('\n');
  let cursor = 0;
  const requirements = texts.map(text => {
    const start = GOAL.indexOf(text, cursor);
    cursor = start + text.length + 1;
    return {
      text,
      sourceRef: { kind: 'goal', start, end: start + text.length, excerpt: text },
      clarity: unclear.includes(text) ? 'unclear' : 'clear',
      criteria: unclear.includes(text) ? [] : [{
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
    requirementDigests: texts.map(text => materialDigest(text)),
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

async function verify(proofBindings, plan, resultsByScript, { texts, unclear, refused = [] } = {}) {
  const adapter = createCodingSealedPlanAdapter({
    plan,
    proofBindings,
    resultsByScript: new Map(Object.entries(resultsByScript)),
    refusedScripts: new Set(refused),
    planDigest: 'a'.repeat(64),
    baselineDigest: null,
  });
  return verifyPromptEvidence(validated(texts, unclear), [adapter], { runId: 'granularity-probe', attempt: 0 });
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

{
  // T14: a positive single check and a MISSING single piece of evidence in the same report.
  const report = await verify({ [materialDigest(FIRST)]: 'first' }, [{ kind: 'tests', script: 'first' }], { first: [result(true)] });
  check('positive single check: the bound requirement is MET', statusOf(report, FIRST) === 'met', `status ${statusOf(report, FIRST)}`);
  check('missing single evidence: the unbound requirement stays UNPROVEN, not met and not refuted', statusOf(report, SECOND) === 'unproven', `status ${statusOf(report, SECOND)}`);
  check('one proven + one missing: the verdict is NOT PROVEN, never PASS', report.verdict === 'NOT PROVEN', `verdict ${report.verdict}`);
}

{
  // A binding that does not resolve to the sealed plan, and a refused script, are BLOCKED and stay visible.
  const unresolved = await verify({ [materialDigest(FIRST)]: 'first', [materialDigest(SECOND)]: 'ghost' }, [{ kind: 'tests', script: 'first' }], { first: [result(true)] });
  check('unresolvable binding: that requirement is BLOCKED', statusOf(unresolved, SECOND) === 'blocked', `status ${statusOf(unresolved, SECOND)}`);
  check('unresolvable binding: the other requirement keeps its own MET', statusOf(unresolved, FIRST) === 'met', `status ${statusOf(unresolved, FIRST)}`);
  check('unresolvable binding: the verdict is BLOCKED', unresolved.verdict === 'BLOCKED', `verdict ${unresolved.verdict}`);
  const refusedRun = await verify({ [materialDigest(FIRST)]: 'first' }, [{ kind: 'tests', script: 'first' }], {}, { refused: ['first'] });
  check('refused script: the requirement is BLOCKED, not PASS', statusOf(refusedRun, FIRST) === 'blocked' && refusedRun.verdict === 'BLOCKED', `status ${statusOf(refusedRun, FIRST)} verdict ${refusedRun.verdict}`);
}

{
  // A requirement whose meaning is unresolved (subjective) is never provable by a sealed check.
  const report = await verify({ [materialDigest(FIRST)]: 'first' }, [{ kind: 'tests', script: 'first' }], { first: [result(true)] }, { texts: [FIRST, THIRD], unclear: [THIRD] });
  check('unclear requirement: UNPROVEN, kept visible next to the proven one', statusOf(report, THIRD) === 'unproven' && statusOf(report, FIRST) === 'met', `third ${statusOf(report, THIRD)} first ${statusOf(report, FIRST)}`);
  check('unclear requirement: the verdict is not PASS', report.verdict !== 'PASS', `verdict ${report.verdict}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} P1:23 requirement result granularity — a shared failure does not refute each bound requirement`);
process.exitCode = failures === 0 ? 0 : 1;
