/**
 * T28 — the real double gate: two adapters check ORIGINAL evidence, a promoter needs both.
 *
 *   outcome adapter    re-evaluates the delivered P2E report from its raw evidence records and demands that the report
 *                      is the one the trust store sealed for exactly this mission, scope, snapshot, candidate commit
 *                      and tree, and policy revision;
 *   execution adapter  reads the hash-chained audit journal (T26/T27) and the signed grants: was the work done by a
 *                      run that never made an unauthorized attempt (D03), with no operation of unknown effect, under
 *                      grants that are still current;
 *   promoter           ELIGIBLE only when both are positive AND bound to the same thing. A positive pillar never
 *                      overwrites a negative one; each is reported next to the other.
 *
 * Nothing delivered counts as authority: a `VERIFIED` string, a well-formed digest, a report that says PASS or an
 * aggregator input are all just claims. The binding the caller passes in (`expected`) must come from LIVE state
 * (git, the registered task, the grants on disk), not from the report. Signatures establish which key sealed what,
 * not freshness or a human: the `now` and the live binding are the controller's.
 *
 * Honest limits (LOCAL): the trust-store key and the producer/reviewer public keys are trusted as enrolled; a
 * same-user process that can write the store can forge any of it. A stopped run is never promotable; a reviewed
 * successor is COMPLIANT for the NEW run only and the stopped predecessors stay listed in `lineage`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { evaluatePromptEvidence, evidenceIntegrityValid, type ValidatedPromptEvidenceRequest, type VerificationReport } from '@amabie/prompt-evidence';
import { authorityJson, isEnvelope, verifySeal } from './authority-envelope.js';
import { openSealed, sealRecord, type TrustStore } from './trust-store.js';
import { readAudit } from './provider/production-audit.js';
import { grantsDigest } from './provider/production-review.js';

export const ASSURANCE_SCHEMA = 'amabie-shared-assurance/1';
export const OUTCOME_KIND = 'outcome-report';

export interface Binding {
  /** the registered mission: P2E goalDigest */
  taskDigest: string;
  /** the criteria revision: P2E scopeDigest */
  scopeDigest: string;
  /** subjectDigest of the snapshot/task/policy bytes the work was judged on */
  subjectDigest: string;
  candidateCommit: string;
  candidateTree: string;
  /** grantsDigest of the grant policy the execution ran under */
  policyRevision: string;
  /** the run id the work started as; later runs are reached through reviewed successors */
  runBase: string;
}
export interface OutcomeInput { request: ValidatedPromptEvidenceRequest; report: VerificationReport }
export interface OutcomeFinding { status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_PROVEN'; reason: string }
export interface ExecutionFinding {
  status: 'COMPLIANT' | 'VIOLATION_BLOCKED' | 'NOT_PROVEN';
  reason: string;
  /** the run that carries the work now (after reviewed continuations) */
  currentRun: string;
  /** stopped predecessors: they stay violations, nothing is retroactively compliant */
  lineage: Array<{ run: string; why: string; next: string }>;
  policy: 'CURRENT' | 'STALE' | 'UNPROVEN';
}
export interface AssuranceReport {
  schema: typeof ASSURANCE_SCHEMA;
  binding: Binding;
  outcome: OutcomeFinding;
  execution: ExecutionFinding;
  verdict: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNPROVEN';
  reasons: string[];
  reportDigest: string;
}

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const BINDING_FIELDS: Array<keyof Binding> = ['taskDigest', 'scopeDigest', 'subjectDigest', 'candidateCommit', 'candidateTree', 'policyRevision', 'runBase'];
const same = (a: unknown, b: unknown): boolean => authorityJson(a) === authorityJson(b);
const notProven = (reason: string): OutcomeFinding => ({ status: 'NOT_PROVEN', reason });

/** Controller-side: seal the report together with the binding it was produced for. The latest seal per project wins. */
export function sealOutcome(store: TrustStore, projectId: string, report: VerificationReport, binding: Binding, amabieVersion = '2'): void {
  sealRecord(store, { projectId, kind: OUTCOME_KIND, payload: { binding, reportDigest: sha(authorityJson(report)) }, amabieVersion });
}

/** Does this delivered report prove the outcome for `expected`? Everything but the live binding is derived. */
export function outcomeAdapter(store: TrustStore, projectId: string, input: OutcomeInput, expected: Binding): OutcomeFinding {
  const { request, report } = input ?? {} as Partial<OutcomeInput>;
  if (!request || !report || !Array.isArray(report.evidence)) return notProven('no request/report delivered');
  const sealed = openSealed(store, { projectId, kind: OUTCOME_KIND });
  if (sealed.status !== 'valid' || !sealed.envelope) return notProven(`no valid sealed outcome record (${sealed.status}: ${sealed.reason})`);
  const p = sealed.envelope.payload as { binding?: Binding; reportDigest?: unknown };
  for (const f of BINDING_FIELDS) if (!p?.binding || !same(p.binding[f], expected[f])) return notProven(`the sealed outcome is bound to a different ${f}`);
  if (p.reportDigest !== sha(authorityJson(report))) return notProven('the delivered report is not the report that was sealed');
  if (report.goalDigest !== request.goalDigest || request.goalDigest !== expected.taskDigest) return notProven('the report belongs to a different mission');
  if (report.scopeDigest !== request.scopeDigest || request.scopeDigest !== expected.scopeDigest) return notProven('the report belongs to a different criteria revision');
  if (!report.evidence.every(evidenceIntegrityValid)) return notProven('an evidence record fails its integrity check');
  const again = evaluatePromptEvidence(request, report.evidence, new Map(), [], { runId: report.runId, attempt: report.attempt }).verdict;
  if (report.verdict === 'PASS') return again === 'PASS' ? { status: 'PASS', reason: 'reported PASS reproduced from the original evidence' } : notProven(`reported PASS, but the evidence gives ${again}`);
  if (report.verdict === 'FAIL' || again === 'FAIL') return { status: 'FAIL', reason: 'an unmet requirement' };
  if (report.verdict === 'BLOCKED') return { status: 'BLOCKED', reason: 'a check could not run' };
  return notProven(`reported ${report.verdict}, recomputed ${again}`);
}

/** The signed grants on disk are the policy; return whether they are all genuine and at least one is live. */
function policyOf(store: TrustStore, projectId: string, expected: Binding, now: number): { state: ExecutionFinding['policy']; why: string } {
  const dir = path.join(store.root, 'grants');
  try {
    const pub = fs.readFileSync(path.join(store.root, 'producer.pub'), 'utf8');
    const policy = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')) as { generation: number; revoked: string[] };
    const files = fs.readdirSync(dir).filter(f => /^grant-\d+\.json$/.test(f));
    let live = 0;
    for (const f of files) {
      const env: unknown = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!isEnvelope(env) || env.projectId !== projectId || !verifySeal(env, pub)) return { state: 'UNPROVEN', why: `${f} is not a genuine grant for this project` };
      const g = env.payload as { grantId?: string; notBefore?: number; expiresAt?: number; policyGeneration?: number };
      if (!policy.revoked.includes(String(g.grantId)) && Number(g.policyGeneration) >= policy.generation && Number(g.notBefore) <= now && now < Number(g.expiresAt)) live++;
    }
    if (!live) return { state: 'STALE', why: 'no grant is live (expired, revoked, older generation or not yet valid)' };
    if (grantsDigest(store.root) !== expected.policyRevision) return { state: 'STALE', why: 'the grants changed since the work was bound to them' };
    return { state: 'CURRENT', why: 'grants genuine and live' };
  } catch (e) { return { state: 'UNPROVEN', why: `the grants cannot be read: ${(e as Error).message}` }; }
}

/** Was the work done without an unauthorized attempt, with no unknown effect, under current grants? */
export function executionAdapter(store: TrustStore, projectId: string, expected: Binding, now = Date.now()): ExecutionFinding {
  const out = (status: ExecutionFinding['status'], reason: string, currentRun = expected.runBase, lineage: ExecutionFinding['lineage'] = [], policy: ExecutionFinding['policy'] = 'UNPROVEN'): ExecutionFinding => ({ status, reason, currentRun, lineage, policy });
  const a = readAudit(store.root);
  if (a.status !== 'ok') return out('NOT_PROVEN', `the audit journal cannot be trusted: ${a.reason}`);
  if (a.seq === 0) return out('NOT_PROVEN', 'there is no audit journal: nothing shows that the gate ran');
  const lineage: ExecutionFinding['lineage'] = [];
  let run = expected.runBase;
  for (let hop = 0; a.state.successor.has(run); hop++) {
    if (hop >= 1000) return out('NOT_PROVEN', 'the successor chain is implausibly long');
    const next = a.state.successor.get(run)!;
    lineage.push({ run, why: a.state.stopped.get(run) ?? '', next });
    run = next;
  }
  if (a.state.stopped.has(run)) return out('VIOLATION_BLOCKED', `run ${run} was stopped after an unauthorized attempt: ${a.state.stopped.get(run)}`, run, lineage);
  if ([...a.state.pending.values()].some(r => r === run || lineage.some(l => l.run === r))) return out('NOT_PROVEN', 'an operation has an unknown effect; reconcile it first', run, lineage);
  const pol = policyOf(store, projectId, expected, now);
  if (pol.state !== 'CURRENT') return out('NOT_PROVEN', `policy ${pol.state}: ${pol.why}`, run, lineage, pol.state);
  return out('COMPLIANT', lineage.length ? `run ${run} is a reviewed continuation; ${lineage.length} stopped predecessor(s) stay violations` : `run ${run} made no unauthorized attempt`, run, lineage, 'CURRENT');
}

/** Both pillars, side by side. Any adapter exception is NOT_PROVEN: the gate fails closed. */
export function promote(store: TrustStore, projectId: string, input: OutcomeInput, expected: Binding, now = Date.now()): AssuranceReport {
  const guard = <T>(fn: () => T, bad: (m: string) => T): T => { try { return fn(); } catch (e) { return bad(`adapter failed: ${(e as Error).message}`); } };
  const outcome = guard(() => outcomeAdapter(store, projectId, input, expected), notProven);
  const execution = guard(() => executionAdapter(store, projectId, expected, now), m => ({ status: 'NOT_PROVEN' as const, reason: m, currentRun: expected.runBase, lineage: [], policy: 'UNPROVEN' as const }));
  const reasons = [`outcome ${outcome.status}: ${outcome.reason}`, `execution ${execution.status}: ${execution.reason}`];
  const verdict = outcome.status === 'PASS' && execution.status === 'COMPLIANT' ? 'ELIGIBLE'
    : outcome.status === 'FAIL' || outcome.status === 'BLOCKED' || execution.status === 'VIOLATION_BLOCKED' ? 'NOT_ELIGIBLE' : 'UNPROVEN';
  const body = { schema: ASSURANCE_SCHEMA, binding: expected, outcome, execution, verdict, reasons } as const;
  return { ...body, reportDigest: sha(authorityJson(body)) };
}
