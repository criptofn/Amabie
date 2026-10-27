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
export function discriminationObligation(root: string, cfg: AmabieConfig, timeoutMs = 600_000, isolationBase?: string, writeComparison?: typeof writeVerificationBundle, candidateRuns?: readonly StepResult[], taskStartHead?: string, authorityRoot = root): Obligation | null {
  const disc = planDiscrimination(root, cfg, timeoutMs, isolationBase, writeComparison, candidateRuns, authorityRoot);
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
  /**
   * Follow-up tasks that began on a DIRTY tree (a clean one is judged from its own start by the caller,
   * and never reaches this): the sealed baseline stays at setup, so a check an EARLIER task added (and the
   * human kept) is still "added since the baseline". It is not this session's work, and only a
   * human re-running setup adopts it into the baseline; an agent edit never does. A file this task
   * has not touched since it started is therefore reported as earlier work, not as created now.
   */
  const earlier = new Set(taskStartHead === undefined ? [] : disc.addedChecks.filter((p) => unchangedSince(root, taskStartHead, p)));
  const workerAuthored = [
    ...disc.addedChecks.filter((p) => !earlier.has(p)).map((p) => `${safePath(p)} (created by this session)`),
    ...disc.modifiedChecks.map((p) => `${safePath(p)} (EXISTING check rewritten by this session)`),
  ];
  const earlierCaveat = earlier.size > 0
    ? `${[...earlier].slice(0, 3).map(safePath).join(', ')} was added after the sealed baseline and before this task, so it is earlier unadopted work, not independent authority; this request began with uncommitted changes, so Amabie cannot separate it from earlier work: commit it before the next request and that request is judged only on its own change (or, to adopt it into the baseline, run amabie setup in your own terminal)`
    : undefined;
  const workerCaveat = workerAuthored.length === 0 ? earlierCaveat : workerAuthored.length > 0
    ? `the evidence that discriminates this change is CHECK TEXT WRITTEN BY THE WORKER ITSELF (${workerAuthored.slice(0, 3).join(', ')}) — sensitive to the change, but authored by the same worker whose work it judges, so it is NOT independent authority. Retain this in your report. Do not re-run setup or rewrite the baseline to remove it. Independent coverage needs an operator-bound check (amabie bind <script> --requirement "<exact text>" --reseal) or a human's acceptance${earlierCaveat === undefined ? '' : `; ${earlierCaveat}`}`
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
    note: `with the worker's check files overlaid, the sealed plan fails on the base commit, but the discriminating check text was written by the worker (${disc.modifiedChecks.slice(0, 3).map((p) => `${safePath(p)} (EXISTING check rewritten by this session)`).join(', ')}), so that failure shows only that the REWRITTEN check is sensitive to the change; it does not show that the original checks fail without it, so regression evidence is UNPROVEN until an operator-bound check or a human's acceptance covers this change. For ordinary feature work, keep existing checks intact and add a separate regression test file executed by the sealed command. For independent evidence, have the human review a failing test before the agent starts.`,
    caveat,
  };
  return {
    id: 'regression-evidence', mode: 'objective', status: 'met',
    note: `the sealed checks fail without this change (${disc.baseFailures.join(', ') || 'a sealed step'}), so their pass is evidence about it${disc.overlaidChecks.length > 0 ? ` (measured with the candidate's check files overlaid on the base: ${disc.overlaidChecks.slice(0, 3).map(safePath).join(', ')}, so the base's own unmodified checks are not shown to fail)` : ''}`,
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
 *
 * The second MEASURED case (Express: `npm test` → `sh: 1: mocha: not found`, exit 127): a baseline
 * tree without installed dependencies "failed" because the TEST RUNNER was absent, and that failure
 * was counted as the checks catching the change. A command that could not execute (126/127, a shell
 * "not found"), or that confirmably ran zero tests, says nothing about the code. The cause is returned
 * so the message can name it. An unfamiliar reporter with no summary is NOT read as zero tests.
 */
function infraFailureCause(r: StepResult): string | undefined {
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.exitCode === 126 || r.exitCode === 127) return `the command could not be executed (exit ${r.exitCode})`;
  const missing = /^[\w./-]*sh: (?:line \d+: |\d+: )?([^\s:]+): (?:command )?not found\s*$/m.exec(text);
  if (missing) return `"${missing[1]}" was not found`;
  if (/ENOENT|Cannot find module|MODULE_NOT_FOUND|no such file or directory|package\.json not found|could not determine executable|command not found|is not recognized as an internal or external command|No module named '?(?:pytest|unittest2?|nose2?)\b/i.test(text)) {
    return 'a program, module or file was missing';
  }
  if (r.kind === 'tests' && ranNoTests(text)) return 'no tests were executed';
  return undefined;
}

/** True only for a recognised "nothing ran" statement; an unrecognised reporter proves nothing either way. */
function ranNoTests(text: string): boolean {
  if (/\bno test files? found\b|\bno tests? found\b|\bno tests ran\b|\bcollected 0 items\b/i.test(text)) return true;
  const summaries = (['node-test', 'pytest', 'python-unittest', 'jest', 'vitest', undefined] as const)
    .map((runner) => parseSummaryCountsFor(runner, text))
    .filter((c) => c.passing !== undefined || c.failing !== undefined);
  return summaries.length > 0 && summaries.every((c) => (c.passing ?? 0) === 0 && (c.failing ?? 0) === 0);
}

/**
 * Untracked dependency directories (`node_modules`) do not ride a git checkout, so a baseline tree has
 * no installed executables. Give each throwaway tree a PRIVATE copy of them: a link would let a check
 * running there write the live dependencies, and a workspace link would resolve into candidate source.
 *
 * Every link inside a dependency directory is re-created, never copied verbatim: a link whose target is
 * inside the project (a workspace member or sibling package, spelled as a relative path, an absolute
 * path or a Windows junction) is rebased onto the SAME path in the throwaway tree, so the comparison
 * runs the base commit's own files. A link that leaves the project (a shared or global package store)
 * cannot be made private and is not followed: the comparison is INCONCLUSIVE with the way out, never a
 * run against live files.
 * shortcut: Python virtualenvs are not copied (their interpreter comes from the sealed toolchain
 * directories); when that matters, materialize through the package manager instead.
 */
class DependencyLayoutError extends Error {}

/** The path of `child` below `parent`, or null when it is not inside (case-folded on Windows). */
function relativeInside(parent: string, child: string): string | null {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : null;
}

function rebaseDependencyLink(root: string, realRoot: string, tree: string, from: string, dest: string): void {
  let text = fs.readlinkSync(from).replace(/^\\\\\?\\/, '');
  if (text.length > 1) text = text.replace(/[\\/]+$/, '');
  const lexical = path.resolve(path.dirname(from), text);
  let target = lexical;
  let rel: string | null;
  try {
    target = fs.realpathSync.native(lexical);
    // Resolved: where it really lands decides. A spelling inside the project that lands outside (a chain
    // through another link) is outside; the spelling is never consulted once the target is established.
    rel = relativeInside(realRoot, target);
  } catch {
    // Dangling: nothing to resolve, so judge the spelling, but through the deepest part that does exist.
    rel = danglingInside(root, realRoot, lexical);
  }
  if (rel === null) {
    throw new DependencyLayoutError(`the dependency link ${path.relative(root, from).split(path.sep).join('/')} points outside the project (${text.slice(0, 80)}), so a private baseline copy cannot be made; install the dependencies inside the project (for example a project-local package store), then run again`);
  }
  const rebased = path.join(tree, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (process.platform === 'win32') {
    let isDir = true;
    try { isDir = fs.statSync(target).isDirectory(); } catch { /* dangling: keep the directory shape */ }
    fs.symlinkSync(rebased, dest, isDir ? 'junction' : 'file');
  } else {
    fs.symlinkSync(path.relative(path.dirname(dest), rebased) || '.', dest);
  }
  // The throwaway tree has its own tracked links: neither the new link nor what it points at may reach
  // outside the tree through one of them.
  for (const probe of [path.dirname(dest), rebased]) {
    if (!deepestRealInside(tree, probe)) {
      throw new DependencyLayoutError(`the dependency link ${path.relative(root, from).split(path.sep).join('/')} would reach outside the baseline copy through a link in the project (${text.slice(0, 80)}), so a private baseline copy cannot be made; install the dependencies inside the project (for example a project-local package store), then run again`);
    }
  }
}

/** The real path of `p` or, if it does not exist, of its deepest existing ancestor with the rest appended. */
function realOfDeepest(p: string): string {
  const rest: string[] = [];
  for (let at = p; ; at = path.dirname(at)) {
    try { return path.join(fs.realpathSync.native(at), ...rest.reverse()); } catch { /* go up */ }
    if (path.dirname(at) === at) return p;
    rest.push(path.basename(at));
  }
}

/** True when `p`, with every link on the way resolved, lies inside `parent` (itself resolved). */
function deepestRealInside(parent: string, p: string): boolean {
  return relativeInside(fs.realpathSync.native(parent), realOfDeepest(p)) !== null;
}

/** A dangling link's target below the project's real root, resolving the part of the path that exists. */
function danglingInside(root: string, realRoot: string, lexical: string): string | null {
  return relativeInside(root, lexical) === null ? null : relativeInside(realRoot, realOfDeepest(lexical));
}

function copyDependencyDirs(root: string, tree: string): string[] {
  const listed = gitWithinRoot(root, ['ls-files', '-z', '--others', '--directory']);
  if (listed === null) throw new Error('untracked dependency directories could not be listed');
  const copied: string[] = [];
  for (const entry of listed.split('\0').filter(Boolean)) {
    const rel = entry.replace(/\/$/, '');
    if (!entry.endsWith('/') || path.posix.basename(rel) !== 'node_modules') continue;
    const from = path.join(root, rel);
    if (fs.lstatSync(from).isSymbolicLink()) throw new Error(`${rel} is a link, so a private copy cannot be made`);
    const links: string[] = [];
    fs.cpSync(from, path.join(tree, rel), {
      recursive: true,
      filter: (src) => {
        if (!fs.lstatSync(src).isSymbolicLink()) return true;
        links.push(src);
        return false;
      },
    });
    const realRoot = fs.realpathSync.native(root);
    for (const link of links) rebaseDependencyLink(root, realRoot, tree, link, path.join(tree, path.relative(root, link)));
    copied.push(rel);
  }
  return copied;
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
export function planDiscrimination(root: string, cfg: AmabieConfig, timeoutMs = 600_000, isolationBase?: string, writeComparison?: typeof writeVerificationBundle, candidateRuns?: readonly StepResult[], authorityRoot = root): DiscriminationResult {
  const sealed = comparePlanAtBase(root, cfg, timeoutMs, isolationBase, writeComparison, candidateRuns, authorityRoot);
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
  const latest = comparePlanAtBase(root, cfg, timeoutMs, previous, writeComparison, candidateRuns, authorityRoot);
  if (!latest.applicable) return unknown('the latest change comparison could not establish a product delta');
  if (latest.basePassed !== false) return {
    ...latest, comparisonBase: previous, reason: `latest change comparison against ${previous}: ${latest.reason}`,
  };
  // Preserve the original worker-origin caveat: a committed check has not become
  // independent authority merely because the additional base contains it.
  return sealed;
}

/**
 * A refactor is SUPPOSED to pass on the base too, so "add a check that fails without the change" is
 * the wrong repair for it. Name the real limit instead, and keep the status: Amabie runs the sealed
 * checks but cannot measure that they execute the lines that moved (no per-line coverage mapping
 * across runners), so preservation is UNPROVEN, not failed, and the proof floor is unchanged.
 */
export function refactorPreservationLimit(regression: Obligation | null, kinds: readonly string[]): Obligation | null {
  if (regression === null || !kinds.includes('refactor') || regression.status !== 'unproven'
    || !/pass on the base commit too/.test(regression.note)) return regression;
  return { ...regression, note: 'refactor: the sealed checks pass on the base commit and on this change, which is what preserved behaviour looks like, but Amabie does not measure that those checks execute the lines you touched (it has no per-line coverage mapping across test runners), so preservation is UNPROVEN, not failed. Do not add a test that fails without a refactor. Close it by a human review of the diff, or have the operator bind a coverage-threshold check (amabie bind <script> --reseal).' };
}

/** True when the working-tree file is byte-identical to the one committed at `head` (the task started with it). */
function unchangedSince(root: string, head: string, file: string): boolean {
  if (!/^[0-9a-f]{40,64}$/i.test(head)) return false;
  const committed = gitWithinRoot(root, ['rev-parse', '--verify', '--quiet', `${head}:${file}`])?.trim();
  const current = gitWithinRoot(root, ['hash-object', '--', file])?.trim();
  return committed !== undefined && committed !== '' && committed === current;
}

function comparePlanAtBase(root: string, cfg: AmabieConfig, timeoutMs: number, isolationBase?: string, writeComparison = writeVerificationBundle, candidateRuns?: readonly StepResult[], authorityRoot = root): DiscriminationResult {
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
    const dependencyDirs = copyDependencyDirs(root, tree);
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
      try { r = runPlanStep(tree, cfg.pm, s, timeoutMs, authorityRoot); } catch (e) {
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
    const infraCause = failures.map(infraFailureCause).find((cause) => cause !== undefined);
    if (infraCause !== undefined) {
      const evidence = writeComparison(root, 'baseline', ran, 'fail',
        { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null }, { subjectRoot: tree, subjectIdentity: candidateIdentity(tree) });
      return unknown(`the baseline run could not execute its checks (${infraCause}), so it proves nothing either way; make the project's dependencies available in the repository and re-run${evidence ? `; baseline output: ${evidence}` : ''}`, changed);
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
      copyDependencyDirs(root, controlTree);
      for (const p of changed) {
        if (!overlaid.includes(p) && gitWithinRoot(root, ['cat-file', '-e', `${head}:${p}`]) === null) continue;
        if (!copyInto(root, controlTree, p)) return unknown(`comparison input control could not copy ${safePath(p)}`, changed);
      }
      const control = runPlanSteps(controlTree!, cfg.pm, planWithFreshTests(cfg.plan), timeoutMs, authorityRoot);
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
        note: 'Counterfactual comparison only; this is not verification of the current implementation or a session completion.', dependencyDirs } } });
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
    if (e instanceof DependencyLayoutError) return unknown(e.message, changed);
    return unknown(`the baseline comparison failed (${String(e).slice(0, 120)})`, changed);
  } finally {
    try { if (controlTree) gitWithinRoot(root, ['worktree', 'remove', '--force', controlTree]); } catch { /* fall through to the rm */ }
    try { if (tree) gitWithinRoot(root, ['worktree', 'remove', '--force', tree]); } catch { /* fall through to the rm */ }
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: never fail a verdict on cleanup */ }
  }
}
