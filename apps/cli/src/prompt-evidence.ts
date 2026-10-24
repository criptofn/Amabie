import { createHash } from 'node:crypto';
import {
  materialDigest,
  type EvidenceDraft,
  type ValidatedPromptEvidenceRequest,
  type VerifierAdapter,
} from '@amabie/prompt-evidence';

export const CODING_SEALED_PLAN_ADAPTER = 'amabie.coding.sealed-plan';
export const SEALED_CHECK_EVIDENCE = 'sealed-check-run';

export interface SealedPlanStep {
  kind: string;
  script: string;
}

export interface SealedStepResult {
  ok: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  execDigest: string | null;
  stdout: string;
  stderr: string;
}

export interface CodingPlanAdapterInput {
  plan: readonly SealedPlanStep[];
  proofBindings: Readonly<Record<string, string>>;
  resultsByScript: ReadonlyMap<string, readonly SealedStepResult[]>;
  refusedScripts: ReadonlySet<string>;
  planDigest: string;
  baselineDigest: string | null;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Adapts only the current, in-memory results of Amabie's freshly executed sealed plan.
 * It never reads verification bundles back and never turns agent output into evidence.
 */
export function createCodingSealedPlanAdapter(input: CodingPlanAdapterInput): VerifierAdapter {
  return {
    id: CODING_SEALED_PLAN_ADAPTER,
    taskType: 'coding',
    async collect(request: ValidatedPromptEvidenceRequest, criteria, context) {
      const evidence: EvidenceDraft[] = [];
      const blocked: Array<{ criterionId: string; reason: string }> = [];
      const unproven: Array<{ criterionId: string; reason: string }> = [];
      // One sealed check run reports one outcome for every requirement bound to it, so a shared failure cannot say which requirement failed.
      const requirementsPerScript = new Map<string, number>();
      for (const requirement of request.requirements) {
        const script = input.proofBindings[materialDigest(requirement.text)];
        if (script) requirementsPerScript.set(script, (requirementsPerScript.get(script) ?? 0) + 1);
      }
      for (const { requirement, criterion } of criteria) {
        if (criterion.evidenceType !== SEALED_CHECK_EVIDENCE || criterion.predicate.path !== '/ok' || criterion.predicate.equals !== true) {
          blocked.push({ criterionId: criterion.id, reason: 'the coding adapter currently supports only a successful sealed-check predicate (/ok equals true)' });
          continue;
        }
        if (context.runId.length === 0 || !Number.isSafeInteger(context.attempt) || context.attempt < 0) {
          blocked.push({ criterionId: criterion.id, reason: 'coding evidence must be attached to a fresh sealed-plan run' });
          continue;
        }
        const script = input.proofBindings[materialDigest(requirement.text)];
        if (!script) { unproven.push({ criterionId: criterion.id, reason: 'no operator-sealed proof binding exists for this exact requirement' }); continue; }
        const matchingPlan = input.plan.filter(step => step.script === script);
        if (matchingPlan.length === 0) {
          blocked.push({ criterionId: criterion.id, reason: 'the saved requirement binding does not resolve to a check in the sealed plan' });
          continue;
        }
        if (input.refusedScripts.has(script)) {
          blocked.push({ criterionId: criterion.id, reason: 'the bound sealed check was refused before execution' });
          continue;
        }
        const results = input.resultsByScript.get(script) ?? [];
        if (results.length < matchingPlan.length) { unproven.push({ criterionId: criterion.id, reason: 'the bound sealed check has no complete fresh execution result' }); continue; }
        const steps = results.map(result => ({
          ok: result.ok,
          exitCode: result.exitCode,
          executionDigest: result.execDigest,
          stdoutDigest: digest(result.stdout),
          stderrDigest: digest(result.stderr),
          startedAt: result.startedAt,
          endedAt: result.endedAt,
        }));
        const ok = results.length > 0 && results.every(result => result.ok);
        const sharedBy = requirementsPerScript.get(script) ?? 0;
        if (!ok && sharedBy > 1) {
          unproven.push({ criterionId: criterion.id, reason: `the bound sealed check ${script} failed, but ${sharedBy} requirements share it and it reports no per-requirement result; no requirement is refuted individually` });
          continue;
        }
        evidence.push({
          requirementId: requirement.id,
          criterionId: criterion.id,
          evidenceType: SEALED_CHECK_EVIDENCE,
          facts: {
            ok,
            checkId: script,
            checkCount: results.length,
            planDigest: input.planDigest,
            baselineDigest: input.baselineDigest,
            runId: context.runId,
            steps,
          },
          artifactRefs: [],
        });
      }
      return { evidence, blocked, unproven };
    },
  };
}
