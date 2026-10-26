import { type TaskKind, type TaskIdentity } from './authorization.js';
import { type ProtocolProof } from './protocol.js';
import { type PlanAuthority, type PlanStep } from './project.js';
import { type DiffSignals, formatPaths, isDepPath, isTestPath } from './change-signals.js';
import { readTaskRecord } from './task-state.js';

export interface Obligation { id: string; mode: 'objective' | 'non-objective'; status: 'met' | 'unproven' | 'unmet'; note: string;
  /** A MET obligation whose evidence is weaker than the word "met" suggests — said plainly, never hidden. */
  caveat?: string }

export function proofSummary(registeredRequirements: number, obligations: Obligation[]): ProtocolProof {
  return { registeredRequirements, obligations: obligations.map(({ id, mode, status, caveat }) => ({
    id, mode, status, ...(caveat !== undefined ? { caveat } : {}),
  })) };
}

export function proofScopeLine(proof: ProtocolProof): string {
  const count = (status: 'met' | 'unproven' | 'unmet') => proof.obligations.filter((ob) => ob.status === status).length;
  return `${proof.registeredRequirements} registered requirement(s); obligations: ${count('met')} met, ${count('unproven')} unproven, ${count('unmet')} unmet`
    + (proof.registeredRequirements === 0 ? '; task acceptance criteria were not registered' : '');
}

/** The obligation engine: pure over (kinds, signals, sealed-plan kinds, requirement count).
 *  `planKinds` comes from the SEALED plan — an obligation is only satisfiable
 *  by a command actually sealed at setup; Amabie never executes an unsealed
 *  "benchmark" just because the task mentioned one. */
/** `baseline` names the premise the signals were collected against: 'setup'
 *  for the checkpoint/doctor path, 'isolation' at the candidate boundary —
 *  where the state WAS proven clean at registration (isolate post-check), so
 *  an unattributable deletion means the baseHead..HEAD diff cannot be read,
 *  not that the baseline was never established. Default keeps every pre-M10
 *  note byte-identical (m6 contract pins depend on it). */
export function obligationsFor(
  kinds: TaskKind[], sig: DiffSignals, planKinds: Set<string>, requirementCount: number,
  baseline: 'setup' | 'isolation' = 'setup',
  task?: TaskIdentity | null,
  authority?: { plan: PlanStep[]; planAuthority?: PlanAuthority },
): Obligation[] {
  const out: Obligation[] = [];
  const add = (o: Obligation) => { if (!out.some((x) => x.id === o.id)) out.push(o); };
  const has = (k: string) => planKinds.has(k);

  if (kinds.includes('bugfix')) {
    const testTouched = sig.changes.some(isTestPath); // deletions are coverage LOSS, never regression evidence (review #4)
    add(testTouched
      ? { id: 'regression-evidence', mode: 'objective', status: 'unproven', note: 'test files were added/modified, but a changed filename is not regression proof — a measured baseline comparison must establish discrimination' }
      : { id: 'regression-evidence', mode: 'objective', status: 'unproven', note: `no test file was added or changed since ${baseline} — regression evidence UNPROVEN (an old suite can stay green while the bug survives). Add a test that reproduces the fixed bug.` });
  }
  if (kinds.includes('refactor') || has('tests')) {
    add(has('tests')
      ? { id: 'tests-green', mode: 'objective', status: 'met', note: 'the sealed test run passed against the candidate' }
      : { id: 'tests-green', mode: 'objective', status: 'unproven', note: 'this project\'s sealed plan has no tests step — behavior preservation is UNPROVEN' });
  }
  if (sig.deletedTestsAttributable.length > 0) {
    add({ id: 'coverage-loss', mode: 'objective', status: 'unmet', note: `verification coverage removed by candidate — deleted test files: ${formatPaths(sig.deletedTestsAttributable)}` });
  } else if (sig.deletedTestsUnattributable.length > 0) {
    // the premise must match what Amabie actually PROVED (review #6): the stamp
    // saying "dirty" is a different fact from "never established the state".
    // At the candidate boundary the baseline WAS proven clean (isolate
    // post-check), so unattributable means the committed-diff probe went
    // silent — a different honest sentence (correctness review #5).
    const premise = baseline === 'isolation'
      ? 'the candidate-vs-isolation-base committed diff cannot be resolved'
      : sig.setupDirtProven
      ? 'the repo was already dirty at setup'
      : "Amabie cannot establish the repo's state at setup";
    add({ id: 'coverage-loss-unattributable', mode: 'objective', status: 'unproven', note: `test files are missing from the working tree but ${premise}, so the deletion cannot be attributed to this session: ${formatPaths(sig.deletedTestsUnattributable)} — whether coverage was lost is UNPROVEN` });
  } else if (kinds.includes('refactor')) {
    add(sig.resolved
      ? { id: 'coverage-loss', mode: 'objective', status: 'met', note: 'no test file was deleted in the candidate diff — verification coverage intact' }
      : { id: 'coverage-loss', mode: 'objective', status: 'unproven', note: 'candidate-vs-baseline diff unresolvable — lost verification coverage cannot be ruled out (UNPROVEN)' });
  }
  if (kinds.includes('dependency') || sig.depTouched) {
    // blocker 2: a duty must name its REAL completion path. Observed dep
    // evidence is listed (meaningful evidence, not mere declaration); a
    // declared-but-unobserved dependency task says so honestly instead of
    // claiming a change it cannot see. Both close via an interactive-terminal
    // acceptance —
    // never auto-met, never a dead end.
    const depFiles = sig.touched.filter(isDepPath);
    add(!sig.depTouched
      ? { id: 'dependency-change', mode: 'non-objective', status: 'unproven', note: 'the task declares dependency work but the candidate diff touches no dependency file — nothing observed to compare, nothing observed to accept; UNPROVEN. Land the change, or accept the candidate as-is from an interactive terminal: amabie accept <candidate>' }
      : { id: 'dependency-change', mode: 'non-objective', status: 'unproven', note: sig.resolved
        ? `dependency change observed (${formatPaths(depFiles)}): the sealed plan re-ran against the new graph, but downstream behavior needs a trusted baseline/candidate comparison — UNPROVEN. Closes after review from an interactive terminal: amabie accept <candidate>`
        : 'dependency change observed against an unresolvable baseline — comparison UNPROVEN. It can still be closed after review from an interactive terminal: amabie accept <candidate>' });
  }
  const numericPerformance = task?.objectiveTargets.some(t => t.kind === 'bench') ?? false;
  const numericUi = task?.objectiveTargets.some(t => t.kind === 'e2e') ?? false;
  if (kinds.includes('performance') && !numericPerformance) {
    add(has('bench') && !task?.subjectivePerformance
      ? { id: 'performance-proof', mode: 'objective', status: 'met', note: 'the sealed benchmark ran and passed (its exit code is the threshold sealed at setup)' }
      : { id: 'performance-proof', mode: 'non-objective', status: 'unproven', note: task?.subjectivePerformance
        ? 'subjective performance feel requires human judgment even when a benchmark passes — UNPROVEN. Review the exact committed candidate and accept from an interactive terminal: amabie accept <candidate>'
        : 'a performance obligation needs a repeatable benchmark with a defined threshold; the sealed plan has none — UNPROVEN. Paths to close it: add a bench script and re-run amabie setup (seals + smokes it), or accept the measured judgment from an interactive terminal: amabie accept <candidate>' });
  }
  if (kinds.includes('ui') && !numericUi && !numericPerformance) {
    add(has('e2e')
      ? { id: 'ui-proof', mode: 'objective', status: 'met', note: 'the sealed e2e/browser proof ran and passed' }
      : { id: 'ui-proof', mode: 'non-objective', status: 'unproven', note: 'no browser/e2e/accessibility proof is available in the sealed plan — UI behavior UNPROVEN (visual truth is not pretend-deterministic). Closes only by judgment from an interactive terminal: amabie accept <candidate>' });
  }
  if (task?.subjectiveVisual) add({ id: 'subjective-visual-acceptance', mode: 'non-objective', status: 'unproven',
    note: 'aesthetic satisfaction requires judgment from an interactive terminal; a generic e2e check cannot establish it' });
  for (const target of task?.objectiveTargets ?? []) {
    const script = authority?.planAuthority?.proofBindings?.[target.digest];
    const bound = script !== undefined && authority!.plan.some(s => s.script === script && s.kind === target.kind);
    add({ id: `target-${target.kind}-${target.digest}`, mode: 'objective', status: bound ? 'met' : 'unproven',
      note: bound ? `sealed ${script} checks target ${target.digest}; its successful exit is required independently`
        : `objective target ${target.digest} has no sealed ${target.kind} proof binding. The operator can run amabie bind <sealed ${target.kind} script> --requirement "<exact task or requirement text>" --reseal; acceptance cannot replace measurement.` });
  }
  /**
   * PER-REQUIREMENT COVERAGE, and the binding path that makes it attainable.
   *
   * The invariant: every objective requirement must have a FROZEN proof obligation or remain NOT
   * PROVEN. A requirement is covered when it is either a frozen objective target (a numeric
   * bench/e2e target, bound above) or directly bound in `package.json` `amabie.proofs` to a script
   * the sealed plan actually runs — that script's exit code is then the measurement.
   *
   * MEASURED gap this closes: the binding map accepted any requirement digest, but only plans whose
   * requirements happened to LOOK numeric could be covered, and nothing ever printed the digest an
   * operator would need — so the only reachable end state was human acceptance, and "bind it to a
   * sealed check" was advice with no way to follow it.
   */
  const boundScriptFor = (d: string): string | null => {
    const script = authority?.planAuthority?.proofBindings?.[d];
    return script !== undefined && authority!.plan.some(s => s.script === script) ? script : null;
  };
  const digests = task?.requirementDigests ?? [];
  const taskIdentityMatchesCount = task !== null && task !== undefined && task.requirementCount === requirementCount;
  const subjectiveDigests = new Set(task?.subjectiveRequirementDigests ?? []);
  const uncovered = digests.filter(d => !task!.objectiveTargets.some(t => t.digest === d) && boundScriptFor(d) === null);
  const uncoveredObjective = uncovered.filter(d => !subjectiveDigests.has(d));
  const uncoveredSubjective = uncovered.filter(d => subjectiveDigests.has(d));
  if (digests.length > 0 && uncovered.length === 0) {
    const bound = digests.map(d => boundScriptFor(d)).filter((s): s is string => s !== null);
    add({ id: 'per-requirement', mode: 'objective', status: 'met',
      note: `every one of the ${digests.length} registered requirement(s) is covered: ${bound.length > 0 ? `sealed proof script(s) ${[...new Set(bound)].join(', ')}` : 'frozen objective targets'} whose exit codes the sealed plan produces` });
  } else if ((kinds.includes('multi') || requirementCount > 0) && (!task || requirementCount === 0 || uncovered.length > 0)) {
    /**
     * THE CLASSIFICATION MUST NOT CONTRADICT ITS OWN NOTE (v1.2 fix).
     *
     * MEASURED BUG this replaces: the duty was ALWAYS `mode: 'non-objective'`, i.e. closable by a
     * human `amabie accept`, while its own note said "acceptance cannot replace measurement for an
     * objective requirement". The consequence was the opposite of the intent: an operator could
     * close an unbound OBJECTIVE requirement with a TTY signature, and — because the Stop hook
     * routes non-objective duties down its operator-only branch — a worker facing it was told
     * "none of them is yours to close" and left to loop. Benchmarked at 1.5-1.85M tokens.
     *
     * Subjective eligibility is attached to each requirement digest, never inferred from another
     * part of the task. A mixed task stays objective while any uncovered objective requirement is
     * open; subjective parts retain their separate human-judgment path.
     */
    const completionPath = !taskIdentityMatchesCount
      ? 'register each exact requirement with amabie task before isolation'
      : uncoveredObjective.length > 0
        ? 'the operator can bind each uncovered requirement with amabie bind <sealed script> --requirement "<exact text>" --reseal'
        : 'review and accept the subjective result from an interactive terminal (amabie accept <candidate>)';
    add({ id: 'per-requirement', mode: !taskIdentityMatchesCount || uncoveredObjective.length > 0 || requirementCount === 0 ? 'objective' : 'non-objective', status: 'unproven', note: requirementCount > 0
      ? `multi-part task: ${requirementCount} registered requirement(s), ${uncoveredObjective.length} objective part(s) with NO sealed proof${uncoveredSubjective.length ? `, ${uncoveredSubjective.length} subjective part(s) waiting for human judgment` : ''} — a green plan proves the plan, NOT each objective part. ${completionPath} — until then UNPROVEN, never permanently dead`
      : 'multi-part task detected but requirements were never enumerated — ask the human ONCE which parts must be proven separately, or register them: amabie task "..." --requirement "..." per part (BEFORE isolation), or accept the candidate as-is from an interactive terminal: amabie accept <candidate>' });
  }
  return out;
}

/** One requirement or objective target that lacks a matching sealed proof. */
export interface UnboundCriterion {
  digest: string;
  /** Distinct plan scripts that do NOT already carry a binding — the candidate proof targets. */
  candidateScripts: string[];
  source: 'requirement' | 'objective-target';
  targetKind?: 'bench' | 'e2e';
}

/** Registered criteria a matching frozen check does not cover. */
export interface UnboundReport {
  /** Requirement and objective-target digests without a valid plan binding. */
  unbound: UnboundCriterion[];
  /** True only when every unbound criterion can be closed by human judgment. */
  subjective: boolean;
  /** Every script the sealed plan will run, so a suggestion is always actionable. */
  planScripts: string[];
}

/**
 * INSPECT A REGISTRATION BEFORE A WORKER IS HANDED ANYTHING (v1.2, Mission 2).
 *
 * WHY THIS EXISTS AS A SEPARATE, PRE-HANDOFF QUESTION: v1.1 could only discover an unbound
 * requirement or numeric target at the END of a worker's session — at the Stop hook or at `finish` — after the model
 * had already spent its budget trying to close a duty that was never its to close. Measured at
 * 1.5-1.85M tokens for a five-requirement task. The information needed to prevent that is
 * available the moment the task is registered, so it is answered here and consumed by the
 * handoff, rather than rediscovered a million tokens later.
 *
 * It reports facts only: which requirement or target digests are uncovered, and which plan scripts
 * are available. It never decides a verdict and never mints a binding.
 */
export function unboundRequirements(
  root: string,
  cfg: { plan: PlanStep[]; planAuthority?: PlanAuthority } | null,
): UnboundReport {
  const task = readTaskRecord(root);
  if (!task || cfg === null || (task.requirementDigests.length === 0 && task.objectiveTargets.length === 0)) {
    return { unbound: [], subjective: false, planScripts: cfg?.plan.map((s) => s.script) ?? [] };
  }
  const bindings = cfg.planAuthority?.proofBindings ?? {};
  const targets = new Map(task.objectiveTargets.map((target) => [target.digest, target]));
  const requirements = new Set(task.requirementDigests);
  const digests = [...new Set([...task.requirementDigests, ...targets.keys()])];
  const boundScript = (digest: string): string | null => {
    const script = bindings[digest];
    const target = targets.get(digest);
    return script !== undefined && cfg.plan.some((step) => step.script === script && (!target || step.kind === target.kind))
      ? script : null;
  };

  // An inferred numeric target is only covered by a check of its matching kind.
  const usedByThisRegistration = new Set(digests.map(boundScript).filter((script): script is string => script !== null));
  const candidateScripts = [...new Set(cfg.plan.map((s) => s.script))].filter((s) => !usedByThisRegistration.has(s));
  const unbound: UnboundCriterion[] = digests.flatMap((digest) => {
    if (boundScript(digest) !== null) return [];
    const target = targets.get(digest);
    return [{
      digest, candidateScripts,
      source: requirements.has(digest) ? 'requirement' : 'objective-target',
      ...(target ? { targetKind: target.kind } : {}),
    }];
  });

  return {
    unbound,
    subjective: unbound.length > 0 && unbound.every(({ digest, targetKind }) =>
      targetKind === undefined && task.subjectiveRequirementDigests.includes(digest)),
    planScripts: cfg.plan.map((s) => s.script),
  };
}
