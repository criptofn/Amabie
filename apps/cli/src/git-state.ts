import { gitCommand } from './execution-environment.js';
import { containedRealPath } from './local-files.js';

// ---------- M2 evidence: claims are not evidence ----------

/** M4 identity shape: candidate and baseline share it. `tree` is the git TREE
 *  (content) identity, distinct from the commit — two commits with the same
 *  tree verify the same bytes. */
export interface Identity { resolved: boolean; head: string | null; tree: string | null; dirty: boolean | null }

/** M4 baseline: who the repo was AT THE MOMENT AMABIE WAS WIRED, stamped by
 *  Amabie's own read-only probes. The honest anchor the onboarding path has:
 *  setup sees the present, never the agent's past — `at` names when the
 *  stamp was taken, so no bundle claims to know pre-agent state it cannot. */
export interface BaselineStamp extends Identity { at: string }

/** Read-only, fixed-argv git probes (same spawn pattern as configTracked).
 *  A fake .git dir that cannot answer is recorded as UNIDENTIFIED — the
 *  evidence bundle never upgrades an unknown candidate into a known one.
 *  Containment, not just answers: git discovery walks UP, so when root/.git
 *  is absent or invalid and some ANCESTOR is a real repo, `status` exits 0
 *  with the PARENT's file list while `HEAD` may fail outright — reporting
 *  that as this candidate's identity is a misattribution (found by the
 *  2026-09-07 environment: a stray zero-commit repo under %TEMP%'s home).
 *  The toplevel must resolve to root itself — linked worktrees and
 *  submodules do; a parent repo does not — or everything is UNIDENTIFIED. */
/** One containment gate for EVERY read-only git probe Amabie makes: fixed
 *  argv, run under `-C root`, and the answer must be ABOUT root — git
 *  discovery walks up, so a parent repo answering for a fake/absent .git
 *  is a misattribution, not information (see candidateIdentity's history:
 *  found via a stray zero-commit repo under the home dir). M6's diff
 *  signals and M7's protected-surface reads share this one door. */
const withinRootGate = new Map<string, boolean>();

export function gitWithinRoot(root: string, args: string[]): string | null {
  const run = (a: string[]): string | null => {
    // hardened env + trusted git binary (blocker 1): GIT_*/NODE_OPTIONS/PATH
    // shims can no longer forge the identity or diffs that feed verdicts.
    const r = gitCommand(root, a);
    return r !== null && r.status === 0 ? r.stdout : null;
  };
  // The gate is a fact about this process's filesystem ("is root its own git
  // toplevel"), so it is computed ONCE per real path — one verify ran ~17
  // identical `rev-parse --show-toplevel` children. What the memo NEVER caches
  // is a probe's answer: every real query below still runs live, so a repo
  // that vanished or was swapped mid-process fails its own probe (null =
  // fail-closed) no matter what the gate remembers.
  const rootReal = containedRealPath(root, root);
  if (rootReal === null) return null; // root itself unresolvable — the same refusal as a failed gate
  let gated = withinRootGate.get(rootReal);
  if (gated === undefined) {
    const top = run(['rev-parse', '--show-toplevel']);
    const topReal = top === null ? null : (top.trim() ? containedRealPath(root, top.trim()) : null);
    gated = top !== null && topReal !== null && topReal === rootReal;
    withinRootGate.set(rootReal, gated);
  }
  if (!gated) return null; // not a repo at all — or answered about an ancestor, not about root
  return run(args);
}

export function candidateIdentity(root: string): Identity {
  const unidentified: Identity = { resolved: false, head: null, tree: null, dirty: null };
  const head = gitWithinRoot(root, ['rev-parse', 'HEAD']);
  if (head === null || head.trim().length === 0) return unidentified;
  const tree = gitWithinRoot(root, ['rev-parse', 'HEAD^{tree}']);
  const status = gitWithinRoot(root, ['status', '--porcelain']);
  // The index can be made to LIE about dirtiness: --assume-unchanged prints a
  // lowercase status letter and --skip-worktree prints 'S' in `ls-files -v`,
  // and both hide a tracked edit from `git status` entirely. That lie is
  // precisely what promotion must never eat: the verdict would judge working-
  // tree bytes while the ff-only apply fast-forwards different COMMITTED
  // bytes, and gate 2's dirty refusal would read "clean". Treat any flagged
  // entry as dirty (fail-closed; ls-files silent = unknowable, do not guess).
  const flags = gitWithinRoot(root, ['ls-files', '-v']);
  const sneaky = status === null ? false : flags !== null && /^(?:[a-z]|S) /m.test(flags);
  return {
    resolved: true,
    head: head.trim(),
    tree: tree?.trim() ?? null,
    dirty: status === null || flags === null ? null : status.trim().length > 0 || sneaky,
  };
}
