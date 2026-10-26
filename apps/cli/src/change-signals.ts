import { type TaskKind } from './authorization.js';
import { ADAPTERS, LOCKFILES } from './project.js';
import { gitWithinRoot } from './git-state.js';
import { CODEX_DIR } from './harness-hooks.js';
import { type AmabieConfig, CONFIG_DIR } from './local-config.js';
import { safePath } from './local-files.js';
import { MCP_CONFIG_BASENAME } from './mcp-registration.js';

// ---------- M6 (spec M5): orchestrate the right proof for the task ----------
/**
 * Beyond "run whatever npm test exists": each task kind carries PROOF
 * OBLIGATIONS evaluated against what Amabie itself observed (sealed-plan
 * execution + contained git diffs), not against what the worker says.
 *
 * Direction of travel is one-way (this is what keeps the hint honest):
 * classification can only ADD obligations — the sealed plan (M5) is the floor
 * no declaration lifts, and no task kind can excuse a failing check. A worker
 * who declares "ui" still gets diff-implied coverage obligations; a worker who
 * declares nothing still gets the diff-implied ones. `amabie task` is
 * AGENT_REPORTED — same zero-authority plumbing as `amabie claim`.
 *
 * Statuses: `met` (Amabie observed it this invocation), `unproven` (obligation
 * stands, no objective proof available — allowed through WITH an honest
 * systemMessage, never a silent fake-complete), `unmet` (objectively violated
 * — blocks). Per spec: do not pretend subjective requirements have
 * deterministic truth; prove every objective part; mark what remains unproven;
 * ask the human one concise question only when necessary (the multi-part
 * enumeration hint) — inference first, question last.
 *
 * Attribution honesty: only deletions Amabie can ATTRIBUTE block — COMMITTED
 * ones (baseline..HEAD is post-baseline by construction) and STAGED/WORKTREE
 * ones when setup stamped the tree CLEAN. The index is never snapshotted at
 * setup, so pre-existing staged residue is the same epistemic class as worktree
 * dirt: a repo that was already dirty (or whose state Amabie never proved)
 * cannot have its pre-existing state blamed on the agent (M4). Unattributable
 * signals inform notes, never verdicts.
 */

const KIND_PATTERNS: Array<[RegExp, TaskKind]> = [
  /**
   * v1.3 — the ORDINARY ways a developer states a defect, not only the jargon.
   *
   * MEASURED (tooling/probes/v13-journey-baseline.mjs; and this repository's own benchmark fixture
   * `bug-sum`, whose task statement is "This small Node project has a test suite (npm test) that is
   * currently failing."): the previous vocabulary — bug/fix/broken/crash/regress/defect — inferred
   * NOTHING from the most common way a failing task is described. `work` then froze an EMPTY kind set
   * and `finish` refused a correct, tested, discriminating fix with `task-authority UNPROVEN`, after
   * the whole session had been spent. Amabie knew at handoff; this is the cheap half of the repair.
   *
   * The words added here all ASSERT brokenness rather than mention a topic. That distinction is the
   * whole safety argument: a `bugfix` kind adds ONE duty — a measured base-vs-candidate discrimination
   * — and unlike "error handling" (a feature that merely contains the word "error"), every phrase
   * below describes behaviour that is wrong, so the duty it adds is one the change can discharge.
   * A mislabel still only ever ADDS work; nothing here can remove a duty.
   */
  [/\b(bug|fix|broken|crash|regress\w*|defect|wrong|incorrect|failing|fails?|misbehav\w*)\b/i, 'bugfix'],
  [/\b(?:does\s?n[o']?t|do(?:es)?\s+not|don'?t|not|never)\s+work(?:ing|s|ed)?\b/i, 'bugfix'],
  [/\b(refactor\w*|restructure|extract (a |the )?(method|function|class)|clean[- ]up)\b/i, 'refactor'],
  [/\b(dependenc\w+|lockfile|upgrade .{0,20}package|bump .{0,20}version|npm (install|update|add))\b/i, 'dependency'],
  [/\b(performance|benchmark|faster|slower|latency|throughput|speed up|slow\w* down|memory usage|optimi[sz]\w+)\b/i, 'performance'],
  // blocker 3: SUBJECTIVE aesthetic language is a ui duty — "make it
  // prettier" must infer, never fall through to taskless. Deterministic
  // markers only: this is a floor, not a language-understanding subsystem.
  [/\b(prett\w*|prettif\w+|beautif\w+|polish\w*|styli[sz]\w*|stylish|visual\w*|aesthetic\w*|ux|look and feel|make it pop)\b/i, 'ui'],
  // blocker 3: a MEASURABLE target is a performance duty even when the word
  // "performance" is absent — "< 2 seconds", "under 500ms", "at least 60fps".
  [/<\s*\d+(\.\d+)?\s*(ms|msecs?|secs?|seconds?|minutes?|mb|gb|kb|fps|%)/i, 'performance'],
  [/\bunder \d+(\.\d+)?\s*(ms|secs?|seconds?|minutes?|mb|gb|fps|%)\b/i, 'performance'],
  [/\bat least \d+(\.\d+)?\s*(fps|mb|gb|%)\b/i, 'performance'],
  [/\b(ui|interface|screen|render|component|css|button|dialog|page|browser|e2e|accessibility)\b/i, 'ui'],
  [/\b(multi[- ]?part|several requirements|requirements? (below|listed|following)|each (of the )?(parts|requirements|items))\b/i, 'multi'],
];

/** Collect every kind a prose hint suggests (union — a mislabel adds work, never removes it). */
export function inferTaskKinds(text: string): TaskKind[] {
  const found = new Set<TaskKind>();
  for (const [re, kind] of KIND_PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}

const isTestDirPath = (p: string): boolean =>
  /(^|[\\/])(tests?|__tests__|spec[s]?)([\\/]|$)/i.test(p);

export const isTestPath = (p: string): boolean =>
  isTestDirPath(p)
  || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p)   // node: *.test.ts / *.spec.js
  || /(^|[\\/])test_[^\\/]*\.py$/i.test(p)     // python: test_*.py
  || /_test\.py$/i.test(p)                     // python: *_test.py
  || /_test\.go$/i.test(p)                     // go: *_test.go
  || /_test\.rs$/i.test(p);

// rust: *_test.rs
// Lockfiles ONLY: package.json edits are authority moves (script text — M5's
// sealed turf), not dependency-graph evidence, and blaming them here made
// every setup-repair story trip the dep obligation. A deps bump without a
// lockfile change is still caught one-way by `amabie task --kind dependency`.
// 1.1: every REGISTERED adapter's declared manifests count as well, so a
// python/rust/go lockfile change is dependency evidence through the same one
// predicate — never guessed from a file extension.
export const isDepPath = (p: string): boolean => {
  const base = p.split(/[\\/]/).pop() ?? '';
  if (LOCKFILES.some(([f]) => base === f)) return true;
  return Object.values(ADAPTERS).some((a) => a.dependencyPaths.includes(base));
};

export function formatPaths(list: string[]): string {
  const head = list.slice(0, 8).map(safePath).join(', ');
  return list.length > 8 ? `${head} (+${list.length - 8} more)` : head;
}

/** One parsed change entry from git name-status / porcelain output. */
export interface ChangeEntry { st: 'add' | 'mod' | 'del' | 'ren'; paths: string[] }

const NAME_ST: Record<string, ChangeEntry['st']> = { A: 'add', M: 'mod', D: 'del', R: 'ren', C: 'ren', T: 'mod', U: 'mod' };

/** `git diff --name-status -z` output: NUL-separated status + 1-2 RAW paths.
 *  -z is what makes classification trustworthy: git C-quotes (wraps in `"` and
 *  octal-escapes) any non-ASCII/quote/backslash path in line mode, and the
 *  quote characters silently defeated isTestPath/isDepPath at both ends — a
 *  committed deletion of tests/ünï.test.js went SILENT (M6 review #1, major:
 *  one non-ASCII character evaded the coverage-loss gate). Raw -z bytes have
 *  no quoting to outsmart. Unknown status codes degrade to mod, never crash. */
export function parseNameStatus(out: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const stRaw = toks[i]!;
    if (!stRaw) continue;
    const st = NAME_ST[stRaw.charAt(0)] ?? 'mod';
    if (st === 'ren') {
      const old = toks[++i]; const nw = toks[++i];
      if (old !== undefined && nw !== undefined) entries.push({ st, paths: [old, nw] });
    } else {
      const p = toks[++i];
      if (p !== undefined) entries.push({ st, paths: [p] });
    }
  }
  return entries;
}

/** `git status --porcelain -z` output: each entry is "XY path" NUL-terminated;
 *  R/C entries are followed by a second NUL-terminated path (the NEW name).
 *  In -z mode git never quotes and never joins renames with ' -> ', so a real
 *  filename containing ' -> ' or `"` cannot mis-split old/new sides either.
 *  `??` is untracked = add-shaped. */
export function parsePorcelain(out: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const line = toks[i]!;
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const body = line.slice(3);
    if (xy === '??') { entries.push({ st: 'add', paths: [body] }); continue; }
    if (xy.includes('R') || xy.includes('C')) {
      const nw = toks[++i];
      if (nw !== undefined) entries.push({ st: 'ren', paths: [body, nw] });
      continue;
    }
    let st: ChangeEntry['st'] = 'mod';
    if (xy[0] === 'A') st = 'add';
    if (xy.includes('D')) st = 'del';
    entries.push({ st, paths: [body] });
  }
  return entries;
}

/** Deletion-shaped paths: plain deletes, plus renames whose NEW side escaped
 *  test shape — either entirely (git mv tests/x.test.js docs/x.md) or out of
 *  the test DIRECTORY while keeping a .test.js suffix (tests/x.test.js →
 *  src/x.test.js: most runners' include scope is directory-shaped, so the
 *  moved file silently stops executing while the suffix pretends coverage
 *  survived). A move that keeps the directory shape (tests/a → tests/sub/a)
 *  is intact; suffix-only repos (old never dir-matched) are not touched —
 *  their scope is unknowable without reading runner config, which is NOT
 *  sealed (stated ceiling, final report). Exported for contract pins (#5). */
export const delPaths = (entries: ChangeEntry[]): string[] =>
  entries.flatMap((e) => (e.st === 'del' ? e.paths : e.st === 'ren' && (!isTestPath(e.paths[1]!) || (isTestDirPath(e.paths[0]!) && !isTestDirPath(e.paths[1]!))) ? [e.paths[0]!] : []));

export interface DiffSignals {
  /** at least one attributable git source answered (committed or staged diff) */
  resolved: boolean;
  /** every touched path from any source (committed + staged + worktree) */
  touched: string[];
  /** touched EXCLUDING deletion paths — renames count by their NEW side only.
   *  Regression evidence is "a test was added/changed", never "a test vanished"
   *  (review #4). depTouched still keys off `touched`: a deleted lockfile is a
   *  dependency change. */
  changes: string[];
  /** deletions of test-shaped paths Amabie can attribute to this session — the BLOCK signal */
  deletedTestsAttributable: string[];
  /** test deletions it cannot attribute (staged/worktree on a non-clean baseline) — note material only */
  deletedTestsUnattributable: string[];
  /** the baseline stamp PROVED dirt at setup; false also covers "never stamped /
   *  unresolved / probe failed", where the note must not claim otherwise (review #6) */
  setupDirtProven: boolean;
  depTouched: boolean;
}

/** Shared core of the diff-signal collection: three -z git outputs in,
 *  attribution out. blameClean = "the tree AND index provably matched HEAD at
 *  the baseline, so staged/worktree deletions cannot be pre-existing dirt".
 *  Both callers below answer that question from a DIFFERENT premise. */
function diffSignalsFrom(committed: string | null, staged: string | null, worktree: string | null, blameClean: boolean, setupDirtProven: boolean): DiffSignals {
  if (committed === null && staged === null && worktree === null) {
    return { resolved: false, touched: [], changes: [], deletedTestsAttributable: [], deletedTestsUnattributable: [], setupDirtProven, depTouched: false };
  }
  const fromCommitted = committed !== null ? parseNameStatus(committed) : [];
  const fromStaged = staged !== null ? parseNameStatus(staged) : [];
  const fromWorktree = worktree !== null ? parsePorcelain(worktree) : [];
  // Attribution: a baseline Amabie stamped CLEAN proves the tree AND index
  // matched HEAD at setup, so deletions seen now — staged or unstaged —
  // CANNOT be pre-existing dirt; they are the agent's. Without that proof
  // (dirty or unknown baseline) both classes stay note-material only: the
  // index is never snapshotted, so pre-existing staged residue is epistemically
  // the worktree case, not the committed case (review #3 — design (c) blesses
  // baseline..HEAD alone, which is post-baseline by construction).
  const attributable = blameClean ? [...fromCommitted, ...fromStaged] : fromCommitted;
  const wtOnlyDel = blameClean
    ? delPaths(fromWorktree).filter((p) => !attributable.some((e) => e.paths.includes(p)))
    : [];
  const attrDel = [...delPaths(attributable), ...(blameClean ? wtOnlyDel : [])];
  const residDel = [...delPaths(fromStaged), ...delPaths(fromWorktree)].filter((p) => !attrDel.includes(p));
  const touched = [...new Set([...attributable, ...fromStaged, ...fromWorktree].flatMap((e) => e.paths))];
  const changes = [...new Set([...attributable, ...fromStaged, ...fromWorktree].flatMap((e) =>
    e.st === 'del' ? [] : e.st === 'ren' ? [e.paths[1]!] : e.paths))];
  return {
    // "resolved" = the candidate-vs-BASELINE story is knowable: either git
    // answered the sealed baseline directly, or a clean baseline makes the
    // worktree diff that story. Staged-only answers do not count.
    resolved: blameClean || committed !== null,
    touched,
    changes,
    deletedTestsAttributable: [...new Set(attrDel)].filter(isTestPath),
    deletedTestsUnattributable: [...new Set(residDel)].filter(isTestPath),
    setupDirtProven,
    depTouched: touched.some(isDepPath),
  };
}

/** Read-only contained git probes (gitWithinRoot — the parent repo never answers
 *  for the candidate). A malformed baseline head from a hand-edited config is
 *  dropped rather than interpolated: defense-in-depth below the distrust gate. */
export function collectDiffSignals(root: string, cfg: AmabieConfig): DiffSignals {
  const baselineHead = cfg.baseline?.head ?? null;
  // -z everywhere classification reads: line mode C-quotes non-ASCII/quote/
  // backslash paths and silently defeats isTestPath/isDepPath (review #1).
  const committed = cfg.baseline?.resolved && baselineHead !== null && /^[0-9a-f]{40,64}$/i.test(baselineHead)
    ? gitWithinRoot(root, ['diff', '--name-status', '-z', baselineHead, 'HEAD']) : null;
  const staged = gitWithinRoot(root, ['diff', '--name-status', '-z', '--cached']);
  // Enumerate new files: a collapsed "scripts/" entry cannot be overlaid as a check.
  const worktree = gitWithinRoot(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return diffSignalsFrom(committed, staged, worktree,
    cfg.baseline !== undefined && cfg.baseline.resolved && cfg.baseline.dirty === false,
    cfg.baseline?.dirty === true);
}

/** M10 (directive §10) — the same signals for a CANDIDATE worktree, diffed
 *  against the record's frozen baseHead (conflating cfg.baseline here would
 *  blame the base's own post-setup commits on the worker). The attribution
 *  premise differs from collectDiffSignals and is PROVEN, not stamped:
 *  `git worktree add --detach` checks out exactly the resolved commit and
 *  isolateCreate post-verifies HEAD before registering — the candidate began
 *  provably clean, so every deletion seen now is the candidate's. If the
 *  baseHead..HEAD probe cannot answer (pruned object? fake git?), the premise
 *  is moot: blameClean drops to false and deletions land UNATTRIBUTABLE —
 *  fail-safe to UNPROVEN, never a false `met`. */
export function candidateDiffSignals(root: string, baseHead: string): DiffSignals {
  const committed = /^[0-9a-f]{40,64}$/i.test(baseHead)
    ? gitWithinRoot(root, ['diff', '--name-status', '-z', baseHead, 'HEAD']) : null;
  const staged = gitWithinRoot(root, ['diff', '--name-status', '-z', '--cached']);
  const worktree = gitWithinRoot(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return diffSignalsFrom(committed, staged, worktree, committed !== null, false);
}

/**
 * Amabie's OWN wiring is not the product under test.
 *
 * MEASURED: `setup` installs the Stop hook into `.claude/settings.json` and writes `.amabie/`
 * AFTER the baseline commit, so a repository with no code change at all still showed those paths as
 * "the candidate's change" — and the regression-evidence question, correctly asked, then reported
 * NOT PROVEN for a project nobody had touched (the probe's case D). Counting the verifier's own
 * files as the change is a measurement error, not a strict rule.
 */
export const isAmabieOwnArtifact = (p: string): boolean =>
  p === '.claude' || p.startsWith('.claude/')
  || p === CONFIG_DIR || p.startsWith(`${CONFIG_DIR}/`)
  // v1.3 §C: setup now writes the MCP server entry itself. Without this the freshly written
  // `.mcp.json` would count as "the change", `planDiscrimination` would find the sealed checks green
  // on the base too, and EVERY repo would report NOT PROVEN the moment it was wired — the verifier's
  // own file mistaken for the author's work, which is the same measurement error this list exists for.
  || p === MCP_CONFIG_BASENAME
  /**
   * v1.4 §C: setup now writes `.codex/hooks.json` as well, and MEASURED with git here: while that
   * file is the only untracked thing in the layer, `git status --porcelain` collapses the entry to
   * `?? .codex/` — the same shape `.claude` has. So the Codex layer is excluded the same way and for
   * the same measured reason (a freshly wired repository must not read as "the agent changed
   * something" just because Amabie wrote its hook). The ceiling is the one `.claude` already carries:
   * an edit a worker makes INSIDE the harness layer is harness configuration, not product behaviour,
   * and it is not counted here.
   */
  || p === CODEX_DIR || p.startsWith(`${CODEX_DIR}/`);

/**
 * Paths whose change cannot alter the product's BEHAVIOUR, so there is nothing for a regression check
 * to discriminate: prose, licences, ignore files. Manifests are deliberately NOT here — a version or
 * script change in `package.json` is behaviour a user sees, and it is exactly what a bump task must
 * prove.
 */
export const isNonBehaviourPath = (p: string): boolean =>
  /\.(md|markdown|txt|rst)$/i.test(p)
  || /(^|[\\/])(docs?|licen[cs]e|changelog|news|contributing|code_of_conduct)([\\/.]|$)/i.test(p)
  || /(^|[\\/])\.gitignore$/i.test(p);

/**
 * Generated and cached files are not the candidate's change.
 *
 * MEASURED false positive: the documented Python journey runs `setup` then `doctor` with NO edit at
 * all, and the second `doctor` reported NOT PROVEN — because running the sealed checks had created
 * `__pycache__/*.pyc` inside the repository, which git reports as an untracked change. Anything the
 * toolchain generates belongs to the run, not to the author, and asking for regression evidence
 * about a byte-compiled cache file is an invented duty.
 */
export const isGeneratedArtifact = (p: string): boolean =>
  /(^|[\\/])__pycache__([\\/]|$)/.test(p)
  || /(^|[\\/])(node_modules|\.venv|venv|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.cache|target|out|coverage|\.nyc_output|\.next|\.turbo|obj|bin)([\\/]|$)/.test(p)
  || /\.(pyc|pyo|pyd|class|o|obj|log|tmp|temp|bak|swp)$/i.test(p)
  || /(^|[\\/])\.coverage$/i.test(p)
  || /\.egg-info([\\/]|$)/.test(p);
