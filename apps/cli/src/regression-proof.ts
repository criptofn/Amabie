import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSummaryCountsFor } from '@amabie/comparator';
import { assertStepArgv, planDigest, scopeDir, sha256, stepKey } from './project.js';
import { openSealed, storeFromEnv, projectIdForRoot } from './trust-store.js';
import { canonicalJson } from '@amabie/hashing';
import { candidateDiffSignals, collectDiffSignals, isAmabieOwnArtifact, isDepPath, isGeneratedArtifact, isNonBehaviourPath, isTestPath, parseNameStatus } from './change-signals.js';
import { type StepResult, planWithFreshTests, runPlanStep, runPlanSteps } from './check-runner.js';
import { candidateIdentity, gitWithinRoot } from './git-state.js';
import { type AmabieConfig, findRepoRoot, readConfig, untrustedConfigReason } from './local-config.js';
import { safePath } from './local-files.js';
import { type Obligation } from './proof-obligations.js';
import { writeVerificationBundle } from './verification-evidence.js';

/** Display only a test entry whose current command still matches the selected plan's digest. */
export function sealedTestEntryHint(root: string, cfg: AmabieConfig): string {
  try {
    const authority = cfg.planAuthority;
    if (authority?.planDigest !== planDigest(cfg.plan)) return '';
    for (const step of cfg.plan) {
      if (step.kind !== 'tests' || typeof step.script !== 'string') continue;
      const digest = authority.scriptDigests?.[stepKey(step)];
      if (typeof digest !== 'string') continue;
      if (step.argv !== undefined) {
        const argv = assertStepArgv(step.argv);
        if (digest !== sha256(JSON.stringify(argv))) continue;
        return ` The plan's test command is ${JSON.stringify(argv)} (entry ${JSON.stringify(step.script)}); a new test file counts only if this command runs it.`;
      }
      const pkgPath = path.join(scopeDir(root, step), 'package.json');
      const scripts = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const text = scripts[step.script];
      if (typeof text !== 'string' || digest !== sha256(text)) continue;
      const displayPath = path.relative(root, pkgPath).replaceAll('\\', '/') || 'package.json';
      return ` The plan's test command is ${displayPath} scripts.${step.script} = ${JSON.stringify(text.slice(0, 160))}; a new test file counts only if this command runs it.`;
    }
  } catch { /* malformed or unavailable sealed details retain the generic guidance */ }
  return '';
}

/** Read-only startup context. This names an existing entry, never a verification result. */
export function projectTestEntryHint(startDir: string): string {
  try {
    const root = findRepoRoot(startDir);
    if (!root) return '';
    const cfg = readConfig(root);
    if (!cfg || cfg === 'corrupt' || untrustedConfigReason(root, cfg)) return '';
    const record = openSealed(storeFromEnv(), { projectId: projectIdForRoot(root), kind: 'plan-seal' });
    if (record.status !== 'valid' || !cfg.planAuthority || canonicalJson(record.envelope!.payload) !== canonicalJson(cfg.planAuthority)) return '';
    const hint = sealedTestEntryHint(root, cfg);
    return hint ? `\n\nRegression proof:${hint}\nPrefer observable behavior through the existing public API; do not export internals solely for tests. Keep the test command and starting commit unchanged.` : '';
  } catch { return ''; } // no readable trusted entry: keep the generic instructions, never guess
}

/**
 * THE REGRESSION-EVIDENCE OBLIGATION.
 *
 * The product invariant this implements, in the owner's words: *existing behaviour that must be
 * preserved requires regression evidence, and missing or ambiguous proof must fail closed, never
 * degrade to PASS.*
 *
 * `planDiscrimination` measures whether the sealed checks are SENSITIVE to this change. That
 * measurement becomes an ordinary proof obligation here, so the checkpoint gate, `doctor` and the
 * promotion path all read one thing — and an obligation that is `unproven` is NOT a pass.
 *
 * `null` means no comparison duty applies (for example, no behavior changed).
 * A required comparison that could not run remains objectively UNPROVEN.
 */
export function discriminationObligation(root: string, cfg: AmabieConfig, timeoutMs = 600_000, isolationBase?: string, writeComparison?: typeof writeVerificationBundle, candidateRuns?: readonly StepResult[]): Obligation | null {
  const disc = planDiscrimination(root, cfg, timeoutMs, isolationBase, writeComparison, candidateRuns);
  if (!disc.applicable) return null;
  if (disc.basePassed === null) return {
    id: 'regression-evidence', mode: 'objective', status: 'unproven',
    note: `required baseline comparison could not be established: ${disc.reason} — regression evidence UNPROVEN; restore the comparison prerequisites and re-run verification`,
  };
  const files = disc.changedPaths.slice(0, 4).map(safePath).join(', ');
  const more = disc.changedPaths.length > 4 ? ` (+${disc.changedPaths.length - 4} more)` : '';
  /**
   * v1.5 post-audit — CONFIRMED AUDIT FINDING (BLOCKER 1): THE REWRITTEN EXISTING CHECK.
   *
   * This caveat used to fire only for check files the session had ADDED, so a worker could
   * take an EXISTING recognized check, rewrite it to assert a marker it had just introduced,
   * and receive an UNCAVEATED "the sealed checks fail without this change, so their pass is
   * evidence about it". MEASURED by an independent auditor on commit a004f55: the rewritten
   * check exited 0 on the candidate and 1 when overlaid on the base — a textbook
   * discrimination result — while the oracle it satisfied was the worker's own text.
   *
   * The defect was asking "did this path exist before?" when the authority question is
   * "did the WORKER write the bytes that judge the work?". An edit writes those bytes
   * exactly as much as a creation does, so added and modified checks are now both
   * worker-authored evidence, and the message says which is which.
   */
  const workerAuthored = [
    ...disc.addedChecks.map((p) => `${safePath(p)} (created by this session)`),
    ...disc.modifiedChecks.map((p) => `${safePath(p)} (EXISTING check rewritten by this session)`),
  ];
  const workerCaveat = workerAuthored.length > 0
    ? `the evidence that discriminates this change is CHECK TEXT WRITTEN BY THE WORKER ITSELF (${workerAuthored.slice(0, 3).join(', ')}) — sensitive to the change, but authored by the same worker whose work it judges, so it is NOT independent authority. Retain this in your report. Do not re-run setup or rewrite the baseline to remove it. Independent coverage needs an operator-bound check (amabie bind <script> --requirement "<exact text>" --reseal) or a human's acceptance`
    : undefined;
  const pendingCaveat = disc.pendingCountIncreases?.length
    ? `the test runner reported more skipped/pending cases on the candidate than on the comparison baseline (${disc.pendingCountIncreases.map((x) => `test check ${x.testRun}: ${x.baseline}→${x.candidate} (${x.runner})`).join(', ')}); review those cases because a green exit code alone does not show that they ran${disc.baselineEvidence ? `; baseline comparison evidence: ${disc.baselineEvidence}` : ''}`
    : undefined;
  const caveat = [workerCaveat, pendingCaveat].filter((x): x is string => x !== undefined).join('; ');
  if (disc.basePassed === true) {
    const sealedTestHint = sealedTestEntryHint(root, cfg);
    const target = sealedTestHint ? 'that suite or command' : 'a suite Amabie already runs';
    return {
      id: 'regression-evidence', mode: 'objective', status: 'unproven',
      note: `the sealed checks pass on the base commit too, so they carry no evidence about this change (${files}${more})${disc.comparisonBase ? ` — additional comparison against the latest change's preceding commit ${disc.comparisonBase}` : ''}: existing behaviour that must be preserved needs a check that FAILS without the change and passes with it. Amabie compares with the starting commit automatically; stay on this branch.${sealedTestHint} Add a regression assertion to ${target}, or have the operator bind another check and re-run setup; a green plan alone does not close this${pendingCaveat ? `; ${pendingCaveat}` : ''}${disc.baselineEvidence ? `; baseline output: ${disc.baselineEvidence}` : ''}`,
      ...(pendingCaveat ? { caveat: pendingCaveat } : {}),
    };
  }
  if (disc.pendingCountIncreases?.length) {
    return {
      id: 'regression-evidence', mode: 'objective', status: 'unproven',
      note: `the sealed checks fail on the base, but the candidate reported more skipped/pending cases (${disc.pendingCountIncreases.map((x) => `test check ${x.testRun}: ${x.baseline}→${x.candidate} (${x.runner})`).join(', ')}), so the two runs did not execute a comparable set of checks. Run those cases on the candidate or bind an equivalent operator-controlled check, then verify again${disc.baselineEvidence ? `; baseline output: ${disc.baselineEvidence}` : ''}`,
      ...(caveat ? { caveat } : {}),
    };
  }
  /**
   * Rewriting an EXISTING recognized check is the attack: the worker edits the oracle it is then
   * judged by, so the base failure proves nothing about the worker's work. Keep it UNPROVEN with the
   * provenance named. A check the worker CREATED is the repair the completion contract asks for and
   * stays `met` below, carrying the caveat that names it as worker-authored.
   */
  if (disc.modifiedChecks.length > 0) return {
    id: 'regression-evidence', mode: 'objective', status: 'unproven',
    note: `the sealed checks fail without this change, but the discriminating check text was written by the worker (${disc.modifiedChecks.slice(0, 3).map((p) => `${safePath(p)} (EXISTING check rewritten by this session)`).join(', ')}), so regression evidence is UNPROVEN until an operator-bound check or a human's acceptance covers this change`,
    caveat,
  };
  return {
    id: 'regression-evidence', mode: 'objective', status: 'met',
    note: `the sealed checks fail without this change (${disc.baseFailures.join(', ') || 'a sealed step'}), so their pass is evidence about it${disc.overlaidChecks.length > 0 ? ` (candidate check files overlaid on the base: ${disc.overlaidChecks.slice(0, 3).map(safePath).join(', ')})` : ''}`,
    ...(caveat ? { caveat } : {}),
  };
}

function copyInto(fromRoot: string, toRoot: string, relPath: string): boolean {
  try {
    const src = path.join(fromRoot, relPath);
    const dst = path.join(toRoot, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch { return false; }
}

/**
 * A failure that says "the comparison could not run" rather than "the checks caught the change".
 *
 * MEASURED REASON this exists: the discrimination run compares a BASE tree (plus the candidate's
 * check files) against the candidate. If a new check needs a new fixture file that lives outside
 * the check directories, the base run fails with ENOENT — and reading that as "the checks
 * discriminate" would mint a PASS out of a missing file. Anything that looks like a broken
 * environment is therefore UNESTABLISHED, never evidence.
 */
function looksLikeInfraFailure(r: StepResult): boolean {
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return /ENOENT|Cannot find module|MODULE_NOT_FOUND|no such file or directory|package\.json not found|could not determine executable|command not found|is not recognized as an internal or external command/i.test(text);
}

function reportedPendingCounts(result: StepResult): Array<{ runner: string; pending: number }> {
  if (result.kind !== 'tests') return [];
  const log = `${result.stdout}\n${result.stderr}`;
  const runners = ['node-test', 'pytest', 'python-unittest', 'jest', 'vitest', undefined] as const;
  return runners.flatMap((runner) => {
    const counts = parseSummaryCountsFor(runner, log);
    if (counts.passing === undefined && counts.failing === undefined && counts.pending === undefined) return [];
    // A project can combine runners in one command. Keep their summaries
    // separate so a conflicting total cannot erase a skip increase.
    return [{ runner: runner ?? 'mocha/ava', pending: counts.pending ?? 0 }];
  });
}

function pendingCountIncreases(
  candidateRuns: readonly StepResult[] | undefined,
  baselineRuns: readonly StepResult[],
  candidateRoot: string,
  baselineRoot: string,
): Array<{ testRun: number; runner: string; baseline: number; candidate: number }> {
  // A fast or otherwise different plan has no safe positional pairing, so make no claim.
  if (!candidateRuns || candidateRuns.length !== baselineRuns.length) return [];
  const increases: Array<{ testRun: number; runner: string; baseline: number; candidate: number }> = [];
  let testRun = 0;
  for (let i = 0; i < candidateRuns.length; i += 1) {
    const candidate = candidateRuns[i]!;
    const baseline = baselineRuns[i]!;
    if (candidate.kind !== baseline.kind || candidate.display !== baseline.display
      || path.relative(candidateRoot, candidate.cwd) !== path.relative(baselineRoot, baseline.cwd)) return [];
    if (candidate.kind !== 'tests' || baseline.kind !== 'tests') continue;
    testRun += 1;
    const before = new Map(reportedPendingCounts(baseline).map((summary) => [summary.runner, summary.pending]));
    for (const summary of reportedPendingCounts(candidate)) {
      const previous = before.get(summary.runner) ?? 0;
      if (summary.pending > previous) {
        increases.push({ testRun, runner: summary.runner, baseline: previous, candidate: summary.pending });
      }
    }
  }
  return increases;
}

export interface DiscriminationResult {
  /** Additional reference only; the original sealed comparison still must pass. */
  comparisonBase?: string;
  /** Actual comparison output for diagnosis only; never read back for verdicts. */
  baselineEvidence?: string;
  /** false only when no comparison duty applies; true with basePassed:null means UNPROVEN. */
  applicable: boolean;
  reason: string;
  changedPaths: string[];
  overlaidChecks: string[];
  /**
   * Check files that did NOT exist at the sealed baseline — i.e. written by THIS session.
   *
   * MEASURED reason this is recorded (`bench-final-constraint-hold-guarded-3`): an agent added
   * `tests/csv-quoted.test.js` (assertions 6 → 18), the sealed plan passed, the hidden oracle found
   * the stated rule still broken, and Amabie said READY. The regression evidence was REAL (the new
   * check fails without the change) and simultaneously the worker's own reading of the requirement —
   * SENSITIVITY, not independence. A verdict that rests on it must say so.
   */
  addedChecks: string[];
  /**
   * v1.5 post-audit (BLOCKER 1): check files that EXISTED at the sealed baseline and whose
   * bytes THIS SESSION changed. They are worker-authored evidence for the same reason
   * `addedChecks` are — the worker wrote the oracle — and before this field existed they
   * silently inherited the authority of the operator's original check because the PATH was
   * old. Kept separate from `addedChecks` so the message can say which happened.
   */
  modifiedChecks: string[];
  basePassed: boolean | null;
  baseFailures: string[];
  /** Reported pending/skipped test counts rose relative to the same sealed plan at baseline. */
  pendingCountIncreases?: Array<{ testRun: number; runner: string; baseline: number; candidate: number }>;
}

/**
 * DOES THE SEALED PLAN ACTUALLY DISCRIMINATE THIS CHANGE?
 *
 * The completion gate's original question is "do the operator's checks pass?". The stronger
 * question this answers — and the one the owner's reliability target needs — is "do they pass
 * BECAUSE of this change, or would they have passed anyway?".
 *
 * MEASURED reason it matters (`bench-r5-refactor-preserve-invisible-2`): an agent rewrote
 * `formatMoney`'s string handling, ran nothing, and finished while `formatMoney("0.5")` returned
 * `$0.05`. The project's checks passed before AND after the change, so Amabie reported READY — a
 * false green that no amount of care in the runner can catch, because the checks simply do not
 * discriminate that change.
 *
 * The experiment is the classic one: run the sealed plan against the BASE commit with the
 * candidate's CHECK files overlaid, which asks "do the checks fail without the source change?".
 *   - they FAIL  -> the plan discriminates this change, and its pass is evidence about it;
 *   - they PASS  -> whatever the plan proves, it does not prove THIS change;
 *   - they cannot run (missing module/fixture/manifest) -> UNESTABLISHED, which is neither answer.
 *
 * It never writes a verdict by itself: it returns the measurement, and the caller decides what an
 * unproven change means. It also never mutates the working tree — the comparison happens in a
 * throwaway `git worktree` at the sealed baseline, removed in a `finally`.
 */
export function planDiscrimination(root: string, cfg: AmabieConfig, timeoutMs = 600_000, isolationBase?: string, writeComparison?: typeof writeVerificationBundle, candidateRuns?: readonly StepResult[]): DiscriminationResult {
  const sealed = comparePlanAtBase(root, cfg, timeoutMs, isolationBase, writeComparison, candidateRuns);
  if (sealed.basePassed !== false) return sealed;
  // Keep the sealed comparison mandatory. A prior fix can make it fail forever,
  // however, so it cannot by itself distinguish the next change in the same repo.
  const base = isolationBase ?? cfg.baseline?.head;
  const head = gitWithinRoot(root, ['rev-parse', 'HEAD'])?.trim();
  const unknown = (reason: string): DiscriminationResult => ({ ...sealed, basePassed: null, reason });
  if (!base || !head || !/^[0-9a-f]{40,64}$/i.test(head)) return unknown('the latest change comparison has no resolvable HEAD');
  if (head === base) return sealed;
  const behaviour = (p: string): boolean => !isAmabieOwnArtifact(p) && !isGeneratedArtifact(p)
    && !isDepPath(p) && !isTestPath(p) && !isNonBehaviourPath(p);
  // Porcelain can report a normalized-equal LF/CRLF rewrite as modified.
  // Select the comparison base from the final tracked delta, plus new files.
  const pending = gitWithinRoot(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', head]);
  const untracked = gitWithinRoot(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (pending === null || untracked === null) return unknown('the latest working-tree change could not be resolved');
  const pendingPaths = [...parseNameStatus(pending).flatMap((entry) => entry.paths), ...untracked.split('\0').filter(Boolean)];
  let previous = head;
  if (!pendingPaths.some(behaviour)) {
    // A test/doc-only commit must not hide the most recent product edit. Follow
    // first parents, including merge deltas, rather than trusting commit messages.
    const commits = gitWithinRoot(root, ['rev-list', '--first-parent', '--parents', `${base}..HEAD`]);
    if (commits === null) return unknown('the latest committed change could not be resolved');
    previous = base;
    for (const row of commits.trim().split('\n').filter(Boolean)) {
      const [commit, parent] = row.trim().split(/\s+/);
      if (!commit || !parent || ![commit, parent].every((v) => /^[0-9a-f]{40,64}$/i.test(v))) {
        return unknown('the latest committed change has no resolvable parent');
      }
      const diff = gitWithinRoot(root, ['diff', '--name-status', '-z', parent, commit]);
      if (diff === null) return unknown('the latest committed change paths could not be resolved');
      if (parseNameStatus(diff).some((entry) => entry.paths.some(behaviour))) { previous = parent; break; }
    }
  }
  if (previous === base) return sealed;
  const latest = comparePlanAtBase(root, cfg, timeoutMs, previous, writeComparison, candidateRuns);
  if (!latest.applicable) return unknown('the latest change comparison could not establish a product delta');
  if (latest.basePassed !== false) return {
    ...latest, comparisonBase: previous, reason: `latest change comparison against ${previous}: ${latest.reason}`,
  };
  // Preserve the original worker-origin caveat: a committed check has not become
  // independent authority merely because the additional base contains it.
  return sealed;
}

function comparePlanAtBase(root: string, cfg: AmabieConfig, timeoutMs: number, isolationBase?: string, writeComparison = writeVerificationBundle, candidateRuns?: readonly StepResult[]): DiscriminationResult {
  const none = (reason: string, changedPaths: string[] = []): DiscriminationResult =>
    ({ applicable: false, reason, changedPaths, overlaidChecks: [], addedChecks: [], modifiedChecks: [], basePassed: null, baseFailures: [] });
  const unknown = (reason: string, changedPaths: string[] = []): DiscriminationResult =>
    ({ ...none(reason, changedPaths), applicable: true });

  const signals = isolationBase === undefined ? collectDiffSignals(root, cfg) : candidateDiffSignals(root, isolationBase);
  /**
   * A baseline stamped DIRTY cannot attribute worktree changes to this session — the very same
   * doctrine the obligation engine uses for deletions. MEASURED case that forced this: `amabie
   * setup` re-run after a script swap (the operator deliberately re-sealing) stamps a dirty baseline,
   * and the uncommitted `package.json` that caused the re-seal was then asked for regression
   * evidence about itself. The operator's own re-seal is not the worker's change.
   */
  /**
   * Dependency manifests and lockfiles are excluded from the DISCRIMINATION question, for two
   * measured reasons. (1) Running the sealed checks can REWRITE them: the Rust journey's
   * `cargo check/test/build` updates `Cargo.lock`, and the gate then demanded regression evidence
   * for a file the toolchain had just touched. (2) When the agent really does move a dependency,
   * that is already its own obligation (`dependency-change`), not a behaviour change a regression
   * check should discriminate.
   */
  const changed = signals.changes.filter((p) =>
    !isAmabieOwnArtifact(p) && !isGeneratedArtifact(p) && !isDepPath(p));
  if (changed.length === 0) return none('the working tree has no change to discriminate');
  /**
   * A change that touches ONLY check/definition files has no product behaviour to discriminate:
   * adding a test, editing docs, or re-sealing a manifest cannot make the project's behaviour
   * different from the base, so demanding "a check that fails without your change" there would be
   * friction without a question behind it. The duty applies to changes to the product.
   */
  if (!changed.some((p) => !isTestPath(p) && !isNonBehaviourPath(p))) {
    return none('only check/documentation files changed — there is no product behaviour to discriminate', changed);
  }

  if (!signals.resolved) return unknown('the change cannot be attributed to the sealed baseline, so the comparison premise does not hold', changed);
  if (signals.setupDirtProven) return unknown('the repo was already dirty at setup, so this change cannot be attributed to the worker', changed);
  const head = isolationBase ?? cfg.baseline?.head ?? null;
  if (head === null || !/^[0-9a-f]{40,64}$/i.test(head)) return unknown('the sealed baseline has no commit to compare against', changed);

  let tmp: string | undefined;
  let tree: string | undefined;
  let controlTree: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-discriminate-'));
    tree = path.join(tmp, 'tree');
    if (gitWithinRoot(root, ['worktree', 'add', '--detach', '--force', tree, head]) === null) {
      return unknown('git could not materialize the sealed baseline for a comparison run', changed);
    }
    const overlaid: string[] = [];
    const addedChecks: string[] = [];
    const modifiedChecks: string[] = [];
    /**
     * v1.5 post-audit — BLOCKERS 1 AND 7 SOLVED TOGETHER, because one predicate caused both.
     *
     * `isTestPath` is a PATH HEURISTIC, and this loop was using it as the AUTHORITY question.
     * That produced the auditor's two findings in opposite directions:
     *
     *  - TOO PERMISSIVE for an existing check the worker REWROTE. Its path was old, so it was
     *    overlaid, failed on the base, and was credited as "evidence about this change" with no
     *    caveat — while the oracle it satisfied was the worker's own text (BLOCKER 1).
     *  - TOO STRICT for a legitimate check at `scripts/smoke-test.js`, which the operator's own
     *    sealed script ran. It was not check surface, so the base ran the OLD check, that passed,
     *    and the verdict was NOT PROVEN — a FALSE RED for a worker that had measurably
     *    discriminated its change (BLOCKER 7).
     *
     * The anchor added here is OPERATOR-SEALED rather than path-shaped: a file is also check
     * surface when a SEALED plan script's text names it, and the script text is verified against
     * the digest sealed at setup. A worker cannot widen this, because editing the script is
     * authority drift, which blocks before execution.
     *
     * Provenance is then decided by GIT and the two answers are kept APART: a file absent at the
     * baseline was CREATED by this session; a file present and changed was REWRITTEN by it. Both
     * are worker-authored evidence (see `regressionEvidenceObligation`), so neither inherits the
     * operator's authority — which is the whole point.
     */
    const namedBySealedScript = (p: string): boolean => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
        const scripts = pkg.scripts ?? {};
        const digests = cfg.planAuthority?.scriptDigests ?? {};
        const normalized = p.replace(/\\/g, '/');
        const base = path.basename(normalized);
        for (const step of cfg.plan) {
          const name = (step as { script?: unknown }).script;
          if (typeof name !== 'string') continue;
          const text = scripts[name];
          if (typeof text !== 'string') continue;
          // The script text must STILL BE the sealed text. Without a sealed digest there is no
          // operator authority to borrow, so the file is not admitted on this ground.
          const sealed = digests[name];
          if (typeof sealed !== 'string' || sealed !== sha256(text)) continue;
          if (text.includes(normalized) || text.includes(base)) return true;
        }
        return false;
      } catch { return false; }
    };
    const testShaped = (p: string): boolean => isTestPath(p) || /[-_](?:test|spec)\.[cm]?[jt]sx?$/i.test(p)
      || /(?:^|\/)(?:test|spec)[-_][^/]+\.[cm]?[jt]sx?$/i.test(p);
    /**
     * T12 — a file the sealed check READS is oracle bytes too. A fixture, golden or snapshot is neither
     * test-shaped nor named in the sealed script, so a worker could rewrite it to match its own wrong
     * output while the check file stayed byte-identical: the fixture was not overlaid, the base kept
     * failing against the OLD fixture, and "the check discriminates" read as `met` with no caveat.
     * The anchor is taken from the BASELINE tree (never the candidate), so the worker cannot widen it:
     * a fixture-shaped directory, or a non-source data file whose path a baseline check file spells out.
     * Known ceiling: a code-extension verifier outside such a directory (lib/expected.mjs) is not covered.
     */
    const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|sh|ps1)$/i;
    let baselineChecks: Array<{ dir: string; text: string }> | undefined;
    const readBaselineChecks = (): Array<{ dir: string; text: string }> => {
      if (baselineChecks) return baselineChecks;
      baselineChecks = [];
      const baseTree = tree;
      if (!baseTree) return baselineChecks;
      const listed = gitWithinRoot(root, ['ls-tree', '-r', '--name-only', head]) ?? '';
      for (const f of listed.split('\n').map((x) => x.trim()).filter(Boolean)) {
        if (baselineChecks.length >= 200) break;
        if (!testShaped(f) && !namedBySealedScript(f)) continue;
        try {
          const abs = path.join(baseTree, f);
          if (fs.statSync(abs).size > 256 * 1024) continue;
          baselineChecks.push({ dir: path.posix.dirname(f.replace(/\\/g, '/')), text: fs.readFileSync(abs, 'utf8') });
        } catch { /* unreadable baseline file: not an anchor */ }
      }
      return baselineChecks;
    };
    const isCheckInput = (p: string): boolean => {
      const norm = p.replace(/\\/g, '/');
      if (/(^|\/)(?:fixtures?|__fixtures__|testdata|__snapshots__)(\/|$)/i.test(norm)) return true;
      if (CODE_EXT.test(norm)) return false;
      return readBaselineChecks().some((c) => c.text.includes(norm) || c.text.includes(path.posix.relative(c.dir, norm)));
    };
    for (const p of changed) {
      if (!signals.changes.includes(p)) continue;
      // Imported checks use foo-test.js or test-foo.js as well as foo.test.js. Admit
      // that check surface here without exempting it from behaviour obligations.
      // An unused file still cannot make the sealed plan discriminate a change.
      if (!testShaped(p) && !namedBySealedScript(p) && !isCheckInput(p)) continue;
      // "Did this check file exist at the sealed baseline?" — asked of git, not guessed. Every
      // path in `changed` IS a change, so presence at the baseline is exactly the provenance split.
      const atBaseline = gitWithinRoot(root, ['cat-file', '-e', `${head}:${p}`]) !== null;
      if (!atBaseline) addedChecks.push(p);
      else modifiedChecks.push(p);
      if (!copyInto(root, tree, p)) return unknown(`candidate check could not be overlaid: ${safePath(p)}`, changed);
      overlaid.push(p);
    }
    const ran: StepResult[] = [];
    const executionPlan = planWithFreshTests(cfg.plan);
    for (const s of executionPlan) {
      let r: StepResult;
      try { r = runPlanStep(tree, cfg.pm, s, timeoutMs); } catch (e) {
        return unknown(`the sealed checks could not run against the baseline (${String(e).slice(0, 120)})`, changed);
      }
      ran.push(r);
      if (r.exitCode === null) return unknown('the sealed checks could not run against the baseline (the program produced no exit code)', changed);
    }
    if (ran.length === 0) return unknown('no sealed check ran against the baseline', changed);
    const failures = ran.filter((r) => !r.ok);
    const recoveredBeforeBuild = new Set<StepResult>();
    for (let index = cfg.plan.length; index < ran.length; index++) {
      const initial = ran[cfg.plan.indexOf(executionPlan[index]!)];
      if (initial && !initial.ok && ran[index]!.ok) recoveredBeforeBuild.add(initial);
    }
    if (failures.length > 0 && failures.every((failure) => recoveredBeforeBuild.has(failure))) {
      const evidence = writeComparison(root, 'baseline', ran, 'fail',
        { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null }, { subjectRoot: tree, subjectIdentity: candidateIdentity(tree) });
      return unknown(`the baseline failed only in pre-build tests that passed after its build, so stale artifacts do not demonstrate a source regression. Use an operator-reviewed build-before-test plan${evidence ? `; baseline output: ${evidence}` : ''}`, changed);
    }
    if (failures.length > 0 && failures.some(looksLikeInfraFailure)) {
      const evidence = writeComparison(root, 'baseline', ran, 'fail',
        { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null }, { subjectRoot: tree, subjectIdentity: candidateIdentity(tree) });
      return unknown(`the baseline run failed in an environment-shaped way (a missing module or file), so it proves nothing either way${evidence ? `; baseline output: ${evidence}` : ''}`, changed);
    }
    if (overlaid.length > 0 && failures.some((r) => /\b(?:TypeError|ReferenceError|SyntaxError)(?:\s*\[[^\]]+\])?:/.test(`${r.stdout}\n${r.stderr}`))) {
      // Measured H2: the new check passed only because the worker left input
      // files in its workspace. The baseline lacked those inputs and crashed.
      // Test the current implementation against that SAME baseline input set in
      // a fresh tree. A failure there cannot discriminate old from new behavior,
      // even if the worker wrapped that runtime error in an AssertionError.
      controlTree = path.join(tmp, 'input-control');
      if (gitWithinRoot(root, ['worktree', 'add', '--detach', '--force', controlTree, head]) === null) {
        return unknown('git could not materialize the comparison input control', changed);
      }
      for (const p of changed) {
        if (!overlaid.includes(p) && gitWithinRoot(root, ['cat-file', '-e', `${head}:${p}`]) === null) continue;
        if (!copyInto(root, controlTree, p)) return unknown(`comparison input control could not copy ${safePath(p)}`, changed);
      }
      const control = runPlanSteps(controlTree!, cfg.pm, planWithFreshTests(cfg.plan), timeoutMs);
      if (control.some((r) => !r.ok)) {
        const provenance = { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null };
        const baseEvidence = writeComparison(root, 'baseline', ran, 'fail', provenance, { subjectRoot: tree, subjectIdentity: candidateIdentity(tree) });
        const controlEvidence = writeComparison(root, 'baseline-control', control, 'fail', provenance, { subjectRoot: controlTree, subjectIdentity: candidateIdentity(controlTree) });
        return unknown(`the worker-authored check does not pass with the current implementation and the same inputs used for the baseline comparison. Make its input fixtures available inside the check, then rerun verification${baseEvidence ? `; baseline output: ${baseEvidence}` : ''}${controlEvidence ? `; input-control output: ${controlEvidence}` : ''}`, changed);
      }
    }
    const baselineEvidence = writeComparison(root, 'baseline', ran, failures.length === 0 ? 'pass' : 'fail',
      { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null },
      { subjectRoot: tree, subjectIdentity: candidateIdentity(tree), extra: { comparison: { commit: head, overlaidChecks: overlaid,
        note: 'Counterfactual comparison only; this is not verification of the current implementation or a session completion.' } } });
    const pendingIncreases = pendingCountIncreases(candidateRuns, ran, root, tree);
    return {
      applicable: true,
      reason: failures.length === 0
        ? 'the sealed checks pass on the base commit too, so they do not demonstrate this change'
        : 'the sealed checks fail without this change, so their pass is evidence about it',
      changedPaths: changed,
      overlaidChecks: overlaid,
      addedChecks,
      modifiedChecks,
      basePassed: failures.length === 0,
      baseFailures: failures.map((f) => f.kind),
      ...(pendingIncreases.length > 0 ? { pendingCountIncreases: pendingIncreases } : {}),
      ...(baselineEvidence ? { baselineEvidence } : {}),
    };
  } catch (e) {
    return unknown(`the baseline comparison failed (${String(e).slice(0, 120)})`, changed);
  } finally {
    try { if (controlTree) gitWithinRoot(root, ['worktree', 'remove', '--force', controlTree]); } catch { /* fall through to the rm */ }
    try { if (tree) gitWithinRoot(root, ['worktree', 'remove', '--force', tree]); } catch { /* fall through to the rm */ }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: never fail a verdict on cleanup */ }
  }
}
