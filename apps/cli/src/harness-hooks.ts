import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonOrNull } from './project.js';
import { trustedDirs } from './execution-environment.js';
import { type AmabieConfig, type TouchedFile } from './local-config.js';
import { assertPlainTarget, containedRealPath, rel, writeFileAtomic } from './local-files.js';
import { pruneOwnedMcp } from './mcp-registration.js';
import { CLAUDE_TASK_TOOL } from './task-state.js';

/**
 * v1.4 Gap C — the project-local Codex hook layer.
 *
 * The vendor reference (learn.chatgpt.com/docs/hooks, read 2026-09-20) documents hooks at
 * `<repo>/.codex/hooks.json` (or inline `[hooks]` in `<repo>/.codex/config.toml`), with the SAME
 * three-level shape Claude Code uses (event → matcher group → handlers) and the SAME `Stop`
 * contract Amabie already implements: JSON on stdout, `{"decision":"block","reason"}` keeps the
 * agent going, exit 0 with no output is success, and `stop_hook_active` says whether this turn was
 * already continued. So the wiring — not the verification — is what this adds.
 */
export const CODEX_DIR = '.codex';

const CODEX_HOOKS_FILE = 'hooks.json';

/** Codex shows this while the hook runs; it must say what is happening in plain words. */
const CODEX_STATUS_MESSAGE = "Amabie is running this project's sealed checks";

/** Same 30-minute ceiling as the Claude Code Stop hook: a slow project suite must not be cut off. */
const CODEX_HOOK_TIMEOUT_SECONDS = 1800;

export interface HarnessInfo { name: string; label: string; supported: boolean; action: string }

export function detectHarnesses(root: string): { found: HarnessInfo[]; integrable: HarnessInfo | null; integrables: HarnessInfo[] } {
  const found: HarnessInfo[] = [];
  const claudeDir = fs.existsSync(path.join(root, '.claude')) || fs.existsSync(path.join(os.homedir(), '.claude'));
  if (claudeDir) {
    found.push({ name: 'claude-code', label: 'Claude Code', supported: true, action: 'hook installed into this project' });
  }
  /**
   * v1.4 Gap C — CODEX IS A REAL GATING ADAPTER NOW, and this line used to say the opposite.
   *
   * MEASURED (this host, 2026-09-20): `codex --version` → `codex-cli 0.154.0`; `codex features list`
   * → `hooks  stable  true`; the CLI exposes `--dangerously-bypass-hook-trust`; and the vendor's hook
   * reference documents a `Stop` event whose contract is the SAME one Amabie already implements for
   * Claude Code — JSON on stdout, `exit 0` with no output means "continue", `{"decision":"block",
   * "reason":…}` makes the harness CONTINUE the turn with that reason as the next prompt, and
   * `stop_hook_active` says whether this turn was already continued by `Stop` (the loop guard).
   * The previous wording here ("no reliable blocking hook exists yet") was therefore stale prose, and
   * a stale apology is just as wrong as an overclaim: it hid a mechanism that exists.
   *
   * Detection: the user layer (`~/.codex`), the CLI on a trusted directory, or a PROJECT `.codex/`
   * layer — the last one is exactly the "project-local hooks" source the vendor documents, and it is
   * what makes a fixture with a `.codex/hooks.json` a Codex project on ANY host.
   *
   * The action string carries the one thing a user must know BEFORE trusting the word "gated":
   * Codex runs a non-managed hook only after that exact hook definition has been reviewed and
   * trusted (`/hooks`), so a freshly written hook gates nothing until then.
   */
  const codex = fs.existsSync(path.join(root, CODEX_DIR)) || fs.existsSync(path.join(os.homedir(), '.codex')) || hasExe('codex');
  if (codex) {
    found.push({
      name: 'codex', label: 'OpenAI Codex CLI', supported: true,
      action: `Stop hook installed into this project (${CODEX_DIR}/${CODEX_HOOKS_FILE}) — Codex runs a project hook only after you review and trust it once (/hooks), so an untrusted hook gates nothing`,
    });
  }
  // v1.3 §E: Cursor is DETECTED so the capability table can report it honestly. `supported: false`
  // because nothing about it is measured here — Cursor documents importing Claude Code hooks, which
  // would make the hook Amabie installs effective, and documents no way to remove its native tools.
  // Detection is not a claim; the table entry carries what is and is not known.
  const cursor = fs.existsSync(path.join(root, '.cursor')) || hasExe('cursor');
  if (cursor) {
    found.push({ name: 'cursor', label: 'Cursor', supported: false, action: 'detected, completion-gate mechanism documented by the vendor but UNMEASURED by Amabie' });
  }
  const cc = found.find((h) => h.name === 'claude-code') ?? null;
  const cx = found.find((h) => h.name === 'codex') ?? null;
  // `integrable` stays the FIRST gating-capable harness (Claude Code preferred) so every existing
  // caller keeps its meaning; `integrables` is the full set, which is what setup needs when both
  // harnesses are present (`setup` wires every one of them, and says so).
  return { found, integrable: cc ?? cx, integrables: [cc, cx].filter((h): h is HarnessInfo => h !== null) };
}

function hasExe(name: string): boolean {
  // Trusted-dir scan, zero spawn (blocker 1): a which/where probe under the
  // caller's PATH would let a shim decide which harnesses Amabie reports.
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  return trustedDirs().some((d) => names.some((n) => fs.existsSync(path.join(d, n))));
}

export function settingsPath(root: string): string { return path.join(root, '.claude', 'settings.json'); }

/** Remove exact owned commands from one named hook event, preserving other events. */
function pruneOwned(doc: Record<string, unknown>, ownedCommands: Set<string>, event = 'Stop'): number {
  const hooks = doc.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || !Array.isArray(hooks[event])) return 0;
  let removed = 0;
  const kept: unknown[] = [];
  for (const group of hooks[event] as Array<{ hooks?: unknown[] }>) {
    if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
    const inner = group.hooks.filter((h) => {
      const mine = !!h && typeof h === 'object' && ownedCommands.has(String((h as { command?: unknown }).command ?? ''));
      if (mine) removed++;
      return !mine;
    });
    if (inner.length) kept.push({ ...group, hooks: inner });
  }
  if (kept.length) hooks[event] = kept; else delete hooks[event];
  if (!Object.keys(hooks).length) delete doc.hooks;
  return removed;
}

/**
 * Install the Claude completion, per-turn task-intake and optional startup hooks.
 * Preflight parses (refuses on malformed); backs up before any write; prunes
 * previously-owned entries first (idempotent, no stacking); records backups in
 * .amabie/backups/. Returns the touched-file record for uninstall.
 */
const PRE_TOOL_USE_MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Workflow|mcp__.*';

const POST_TOOL_USE_MATCHER = CLAUDE_TASK_TOOL;

export function installClaudeHooks(
  root: string, command: string, priorCommands: Set<string>, backupsDir: string, dryRun = false,
  priorStartupCommands?: Set<string>,
): { ok: boolean; touched?: TouchedFile; problem?: string } {
  const file = settingsPath(root);
  try { assertPlainTarget(file); } catch {
    return { ok: false, problem: `${rel(root, file)} is a symbolic link — Amabie will not write through links. Replace it with a real file, then run setup again. Nothing was changed.` };
  }
  const existed = fs.existsSync(file);
  let doc: Record<string, unknown> = {};
  if (existed) {
    const parsed = parseJsonOrNull(file);
    if (!parsed) return { ok: false, problem: `${rel(root, file)} is not valid JSON — fix it and re-run setup. Nothing was changed.` };
    doc = parsed;
  }
  const owned = new Set([command, ...priorCommands]);
  pruneOwned(doc, owned);
  pruneOwned(doc, owned, 'PreToolUse');
  pruneOwned(doc, owned, 'UserPromptSubmit');
  pruneOwned(doc, owned, 'PostToolUse');
  pruneOwned(doc, owned, 'SessionEnd');
  // valid JSON, but an unexpected hooks/Stop shape (string/object instead of
  // list) is unmergeable — refuse in plain words like a parse failure (S5),
  // never crash with an internal TypeError.
  if (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks))) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks" section that is not a settings object — fix it and re-run setup. Nothing was changed.` };
  }
  if (doc.hooks !== undefined && (doc.hooks as Record<string, unknown>).Stop !== undefined && !Array.isArray((doc.hooks as Record<string, unknown>).Stop)) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks.Stop" that is not a list of hook groups — fix it and re-run setup. Nothing was changed.` };
  }
  if (doc.hooks !== undefined && (doc.hooks as Record<string, unknown>).PreToolUse !== undefined && !Array.isArray((doc.hooks as Record<string, unknown>).PreToolUse)) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks.PreToolUse" that is not a list of hook groups — fix it and re-run setup. Nothing was changed.` };
  }
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
    if (doc.hooks !== undefined && (doc.hooks as Record<string, unknown>)[event] !== undefined && !Array.isArray((doc.hooks as Record<string, unknown>)[event])) {
      return { ok: false, problem: `${rel(root, file)} has a "hooks.${event}" that is not a list of hook groups — fix it and re-run setup. Nothing was changed.` };
    }
  }
  if (priorStartupCommands && doc.hooks !== undefined && (doc.hooks as Record<string, unknown>).SessionStart !== undefined && !Array.isArray((doc.hooks as Record<string, unknown>).SessionStart)) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks.SessionStart" that is not a list — fix it and re-run setup. Nothing was changed.` };
  }
  if (priorStartupCommands) pruneOwned(doc, new Set([`${command} --session-start`, ...priorStartupCommands]), 'SessionStart');
  const hooks = (doc.hooks ??= {}) as Record<string, unknown[]>;
  const stop = (hooks.Stop ??= []) as Array<{ hooks: unknown[] }>;
  stop.push({ hooks: [{ type: 'command', command, timeout: 1800 }] });
  const preToolUse = (hooks.PreToolUse ??= []) as Array<{ matcher?: string; hooks: unknown[] }>;
  preToolUse.push({ matcher: PRE_TOOL_USE_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] });
  (hooks.UserPromptSubmit ??= []).push({ hooks: [{ type: 'command', command, timeout: 10 }] });
  (hooks.PostToolUse ??= []).push({ matcher: POST_TOOL_USE_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] });
  (hooks.SessionEnd ??= []).push({ hooks: [{ type: 'command', command, timeout: 10 }] });
  if (priorStartupCommands) {
    const startup = (hooks.SessionStart ??= []) as Array<{ hooks: unknown[] }>;
    startup.push({ hooks: [{ type: 'command', command: `${command} --session-start`, timeout: 10 }] });
  }

  if (dryRun) return { ok: true, touched: { path: file, created: !existed } };

  if (existed) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `${stamp}-settings.json`);
    try { assertPlainTarget(dest); fs.copyFileSync(file, dest); } catch (e) {
      return { ok: false, problem: `could not back up ${rel(root, file)} (${String(e).slice(0, 140)}) — nothing was changed.` };
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  try {
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n'); // harness settings: an interrupted write must not leave broken JSON
  } catch (e) {
    // rename can fail transiently on Windows (AV/indexer holds the target);
    // the atomic path guarantees the original bytes are untouched — say so.
    return { ok: false, problem: `could not update ${rel(root, file)} (${String(e).slice(0, 140)}) — ${existed ? 'your file was left exactly as it was, and the backup is in place' : 'nothing was created'}; a momentarily locked file (AV/indexer) is the usual cause. Re-run setup.` };
  }
  return { ok: true, touched: { path: file, created: !existed } };
}

/** True when one named event still contains an exact command we installed. */
export function hasAmabieEntry(doc: Record<string, unknown>, owned: Set<string>, event = 'Stop'): boolean {
  const groups = (doc.hooks as Record<string, unknown> | undefined)?.[event];
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => Array.isArray((g as { hooks?: unknown })?.hooks)
    && (event !== 'PreToolUse' || (g as { matcher?: unknown }).matcher === PRE_TOOL_USE_MATCHER)
    && (event !== 'PostToolUse' || (g as { matcher?: unknown }).matcher === POST_TOOL_USE_MATCHER)
    && (g as { hooks: Array<{ command?: string }> }).hooks.some((h) => owned.has(String(h?.command ?? ''))));
}

function isAmabieCheckpointCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  // Match Amabie entry paths, not arbitrary user scripts whose command happens to say checkpoint.
  return /\bcheckpoint(?:\s|$)/.test(normalized)
    && (normalized.includes('/@amabie/cli/dist/main.js')
      || normalized.includes('/apps/cli/dist/src/main.js')
      || /(?:^|[\/\s"'])amabie(?:\.cmd|\.exe)?\s+checkpoint(?:\s|$)/.test(normalized));
}

export function findUnownedAmabieHookEntries(
  root: string,
  file: string,
  ownedByEvent: Readonly<Record<string, ReadonlySet<string>>>,
): string[] {
  if (!fs.existsSync(file) || containedRealPath(root, file) === null) return [];
  try { assertPlainTarget(file); } catch { return []; }
  const doc = parseJsonOrNull(file);
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];

  const found: string[] = [];
  for (const [event, owned] of Object.entries(ownedByEvent)) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = group && typeof group === 'object'
        ? (group as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command = handler && typeof handler === 'object'
          ? (handler as { command?: unknown }).command : undefined;
        if (typeof command === 'string' && isAmabieCheckpointCommand(command) && !owned.has(command)) {
          found.push(rel(root, file) + ' (' + event + '): ' + command);
        }
      }
    }
  }
  return found;
}

export function findForeignAmabieHooks(
  root: string,
  command: string,
  claude: boolean,
  codex: boolean,
  priorClaudeCommands: ReadonlySet<string>,
  priorStartupCommands: ReadonlySet<string>,
  priorCodexCommands: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  if (claude) {
    found.push(...findUnownedAmabieHookEntries(root, settingsPath(root), {
      Stop: new Set([command, ...priorClaudeCommands]),
      PreToolUse: new Set([command, ...priorClaudeCommands]),
      UserPromptSubmit: new Set([command, ...priorClaudeCommands]),
      PostToolUse: new Set([command, ...priorClaudeCommands]),
      SessionEnd: new Set([command, ...priorClaudeCommands]),
      SessionStart: new Set([command + ' --session-start', ...priorStartupCommands]),
    }));
  }
  if (codex) {
    found.push(...findUnownedAmabieHookEntries(root, codexHooksPath(root), {
      Stop: new Set([command, ...priorCodexCommands]),
    }));
  }
  return found;
}

// ---------- v1.4 §C: OpenAI Codex CLI, a SECOND measured completion gate ----------
//
// WHY THIS FILE IS WRITTEN AND NOT MERELY DESCRIBED. `apps/cli/src/agents.ts` said Codex was
// advisory because "no completion hook exists to gate". MEASURED on this host (codex-cli 0.154.0,
// `codex features list` → `hooks  stable  true`): that is false. Codex's `Stop` hook takes the SAME
// contract Amabie already implements for Claude Code — one JSON object on stdin (`cwd`,
// `stop_hook_active`, `hook_event_name: "Stop"`, …), JSON on stdout, `{"decision":"block","reason"}`
// to keep the agent going, exit 0 with no output to let it stop. So this is WIRING, not a second
// verification implementation: it runs the SAME `checkpoint` entry point, built by the SAME
// `buildHookCommand`, and it grants no new authority — `cmdCheckpoint` can only report.
//
// The same discipline as `installClaudeHooks`, plus two things that file does not need:
//   - the PROJECT LAYER is containment-checked, not only the file: a linked `.codex/` directory
//     would otherwise be a landing pad that writes `hooks.json` outside the repository;
//   - the handler carries a `statusMessage`, because Codex shows one in its UI while a hook runs.
//
// TRUST IS THE HARNESS'S, AND AMABIE DOES NOT PRETEND TO OWN IT. Codex runs a non-managed hook only
// after that exact definition has been reviewed and trusted (`/hooks`), and it records trust against
// the hook's current hash. Amabie cannot mint that trust and does not try; `setup` and `amabie
// agents` say so in plain words, because a written-but-untrusted hook gates nothing.

export function codexHooksPath(root: string): string { return path.join(root, CODEX_DIR, CODEX_HOOKS_FILE); }

/**
 * Install the Stop hook into <root>/.codex/hooks.json.
 *
 * Merge, never overwrite: every other event, matcher group, handler and top-level key a user already
 * has is preserved, and only Amabie's OWN previously-recorded commands are pruned first (so a re-run
 * is idempotent and never stacks). Backs up before any write; refuses on a symlinked file, a linked
 * project layer, a non-directory `.codex`, invalid JSON, or an unmergeable `hooks` shape — in every
 * case with the file byte-unchanged.
 */
export function installCodexStopHook(
  root: string, command: string, priorCommands: Set<string>, backupsDir: string, dryRun = false,
): { ok: boolean; touched?: TouchedFile; problem?: string } {
  const dir = path.join(root, CODEX_DIR);
  // The file is not the whole story: `.codex` itself can be a junction/symlink to somewhere else.
  if (containedRealPath(root, dir) === null) {
    return { ok: false, problem: `${rel(root, dir)} resolves outside this repository (a link?) — Amabie will not write the Codex hook through it. Nothing was changed.` };
  }
  try {
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
      return { ok: false, problem: `${rel(root, dir)} exists but is not a directory — Amabie will not replace it. Nothing was changed.` };
    }
  } catch (e) {
    return { ok: false, problem: `could not examine ${rel(root, dir)} (${String(e).slice(0, 140)}) — nothing was changed.` };
  }
  const file = codexHooksPath(root);
  try { assertPlainTarget(file); } catch {
    return { ok: false, problem: `${rel(root, file)} is a symbolic link — Amabie will not write through links. Replace it with a real file, then run setup again. Nothing was changed.` };
  }
  const existed = fs.existsSync(file);
  let doc: Record<string, unknown> = {};
  if (existed) {
    const parsed = parseJsonOrNull(file);
    if (!parsed) return { ok: false, problem: `${rel(root, file)} is not valid JSON — fix it and re-run setup. Nothing was changed.` };
    doc = parsed;
  }
  pruneOwned(doc, new Set([command, ...priorCommands]));
  // Same refusals as the Claude path: valid JSON with an unmergeable shape is reported in plain
  // words, never overwritten and never a TypeError.
  if (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks))) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks" section that is not an object — fix it and re-run setup. Nothing was changed.` };
  }
  if (doc.hooks !== undefined && (doc.hooks as Record<string, unknown>).Stop !== undefined && !Array.isArray((doc.hooks as Record<string, unknown>).Stop)) {
    return { ok: false, problem: `${rel(root, file)} has a "hooks.Stop" that is not a list of hook groups — fix it and re-run setup. Nothing was changed.` };
  }
  const hooks = (doc.hooks ??= {}) as Record<string, unknown[]>;
  const stop = (hooks.Stop ??= []) as Array<{ hooks: unknown[] }>;
  // `timeout` is SECONDS in Codex's schema (default 600). No `matcher`: the vendor ignores one on
  // `Stop`, and writing a field that means nothing would be decoration.
  stop.push({ hooks: [{ type: 'command', command, timeout: CODEX_HOOK_TIMEOUT_SECONDS, statusMessage: CODEX_STATUS_MESSAGE }] });

  if (dryRun) return { ok: true, touched: { path: file, created: !existed, kind: 'codex-hooks' } };

  if (existed) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `${stamp}-${CODEX_HOOKS_FILE}`);
    try { assertPlainTarget(dest); fs.copyFileSync(file, dest); } catch (e) {
      return { ok: false, problem: `could not back up ${rel(root, file)} (${String(e).slice(0, 140)}) — nothing was changed.` };
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    return { ok: false, problem: `could not update ${rel(root, file)} (${String(e).slice(0, 140)}) — ${existed ? 'your file was left exactly as it was, and the backup is in place' : 'nothing was created'}; a momentarily locked file (AV/indexer) is the usual cause. Re-run setup.` };
  }
  return { ok: true, touched: { path: file, created: !existed, kind: 'codex-hooks' } };
}

/** The command strings Amabie owns in ONE kind of hooks file.
 *
 *  Two harnesses, two files, two records: `.claude/settings.json` is pruned by the Claude ownership
 *  list and `.codex/hooks.json` by the Codex one, so a file is only ever stripped of commands this
 *  installation recorded for THAT file. `hookCommand` (singular) is the pre-`hookCommands` legacy
 *  field; an MCP entry is owned by its argv signature instead and never reaches here. */
export function ownedCommandsFor(cfg: AmabieConfig, kind: TouchedFile['kind']): Set<string> {
  if (kind === 'codex-hooks') return new Set(cfg.codexHookCommands ?? []);
  return new Set(cfg.hookCommands.length ? cfg.hookCommands : [cfg.hookCommand]);
}

/** Remove Amabie entries from every touched settings file. Returns problems[]. */
export function uninstallHooks(root: string, cfg: AmabieConfig): { removed: number; problems: string[] } {
  const ownedMcp = new Set(cfg.mcpArgSignatures ?? []);
  const problems: string[] = [];
  let removed = 0;
  for (const t of cfg.touched) {
    if (!fs.existsSync(t.path)) continue;
    // A config (even a valid-shape one) can name paths outside the repo — the
    // S1 vector. No touched entry may resolve outside root; refuse it loudly
    // instead of rewriting or deleting a stranger's settings file.
    if (containedRealPath(root, t.path) === null) {
      problems.push(`${t.path} resolves outside this repository — Amabie never modifies files outside the repo it was set up in. Left untouched.`);
      continue;
    }
    const doc = parseJsonOrNull(t.path);
    if (!doc) { problems.push(`${rel(root, t.path)} is not valid JSON — left untouched. Repair it, then re-run uninstall.`); continue; }
    let pruned = 0;
    try {
      // v1.3 §C: an MCP entry is owned by its argv signature, not by a command string, so the two
      // kinds prune differently. v1.4 §C: a Codex hooks file has the Claude SHAPE but its own
      // ownership list. A legacy touched entry (no kind) is a Claude Code hooks file by construction.
      pruned = t.kind === 'mcp' ? pruneOwnedMcp(doc, ownedMcp) : pruneOwned(doc, ownedCommandsFor(cfg, t.kind));
      if (t.kind !== 'mcp' && t.kind !== 'codex-hooks') {
        pruned += pruneOwned(doc, ownedCommandsFor(cfg, t.kind), 'PreToolUse');
        pruned += pruneOwned(doc, ownedCommandsFor(cfg, t.kind), 'UserPromptSubmit');
        pruned += pruneOwned(doc, ownedCommandsFor(cfg, t.kind), 'PostToolUse');
        pruned += pruneOwned(doc, ownedCommandsFor(cfg, t.kind), 'SessionEnd');
        pruned += pruneOwned(doc, new Set(cfg.sessionStartCommands ?? []), 'SessionStart');
      }
      if (fs.existsSync(t.path)) {
        // Deleted only when Amabie's entry was the LAST thing in a file Amabie created. A file the
        // user already had — even one that held nothing but our handler — keeps its place on disk.
        if (Object.keys(doc).length === 0 && t.created) fs.rmSync(t.path);
        else writeFileAtomic(t.path, JSON.stringify(doc, null, 2) + '\n');
      }
    } catch (e) {
      // write/delete failed — the on-disk file was NOT changed, so the
      // pruned entries must not be counted and the file must be reported.
      problems.push(`${rel(root, t.path)} could not be updated (${String(e).slice(0, 140)}) — left untouched; re-run uninstall once the file lock clears.`);
      continue;
    }
    removed += pruned;
  }
  return { removed, problems };
}
