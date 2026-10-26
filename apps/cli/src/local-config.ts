import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS } from './project.js';
import { type ToolchainSeal } from './sealed-toolchain.js';
import { type PlanAuthority, type PlanStep } from './project.js';
import { CLI_ENTRY } from './cli-runtime.js';
import { gitCommand } from './execution-environment.js';
import { type BaselineStamp } from './git-state.js';
import { samePath, writeFileAtomic } from './local-files.js';

export const CONFIG_DIR = '.amabie';

const CONFIG_FILE = 'amabie.local.json';

export const CHECKPOINT_FILE = 'last-checkpoint.json';

/** M9: exported for the authority fingerprint set — task intent is protected
 *  authority bytes (directive §9), even while it carries zero verdict weight. */
export const TASK_FILE = path.join('task', 'current.json');

/** A file Amabie wrote into the repository, and WHICH KIND of entry it owns there. The kind decides
 *  how uninstall prunes it: hook entries are matched by command string, MCP server entries by their
 *  argv signature, and a Codex hook by the command strings recorded for ITS file specifically.
 *  Legacy configs carry no kind and are Claude Code hooks by construction. */
export interface TouchedFile { path: string; created: boolean; kind?: 'hooks' | 'mcp' | 'codex-hooks' }

export interface AmabieConfig {
  version: string; installedAt: string; pm: string; plan: PlanStep[];
  cliPath: string; hookCommand: string;
  /** every command string ever installed here — uninstall matches exactly these */
  hookCommands: string[];
  /** Exact Claude SessionStart commands owned by this installation, separate from Stop. */
  sessionStartCommands?: string[];
  /** v1.4 §C: every command string ever installed into THIS project's `.codex/hooks.json`.
   *  Deliberately a SEPARATE list from `hookCommands`: the two harnesses are wired into two
   *  different files, and a file may only be pruned by the record that names it. Absent on configs
   *  written before v1.4, which simply means "no Codex entry is owned here". */
  codexHookCommands?: string[];
  /** v1.3: every MCP server argv signature ever written here, serialized — uninstall and re-setup
   *  match exactly these, so a key Amabie did not write is never pruned or replaced. Absent on
   *  configs written before v1.3, which simply means "no MCP entry is owned here". */
  mcpArgSignatures?: string[];
  /** MCP tool profile written by setup. Older configs upgrade to everyday. */
  mcpProfile?: 'everyday' | 'expert';
  touched: TouchedFile[];
  /** M4 baseline: repo identity stamped by Amabie at setup time — "state when
   *  Amabie was wired". Optional: configs written before M4 have no provable
   *  baseline, and bundles say `baseline: null` rather than invent one. */
  baseline?: BaselineStamp;
  /** M5 trusted verification plan: the plan AND the exact script TEXTS that a
   *  human set up. Verified before every execution; drift blocks. Optional:
   *  configs written before M5 have no seal and verify exactly as before. */
  planAuthority?: PlanAuthority;
  /** 1.1 §1: which project adapter owns this repo. Absent = 'node' — every
   *  config written before 1.1 describes a Node project, and setup keeps that
   *  byte shape until detection can legitimately name another ecosystem. */
  project?: string;
  /** v1.5 blocker 6: the executable directories the OPERATOR authorized at setup
   *  (`--toolchain-dir`), sealed here so a later ambient PATH edit changes nothing.
   *  Absent = the step environment is exactly what it always was (Node install dir
   *  + OS dirs), and the block below never runs. */
  toolchain?: ToolchainSeal;
}

// ---------- detection (pure, testable) ----------

export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------- config + settings.json plumbing ----------

export function configPath(root: string): string {
  return path.join(root, CONFIG_DIR, CONFIG_FILE);
}

export function retiredPackageCliPath(cliPath: string): boolean {
  return cliPath.replaceAll('\\', '/').toLowerCase().includes('/@canary-rn/cli/');
}

/** Shape validation: a parseable-but-wrong-shape file is 'corrupt' (S7 — the
 *  documented self-heal path must fire instead of exit-3 TypeErrors). */
function validConfigShape(v: unknown): v is AmabieConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  const isStr = (x: unknown): boolean => typeof x === 'string';
  return isStr(c.version) && isStr(c.installedAt) && isStr(c.pm) && isStr(c.cliPath) && isStr(c.hookCommand)
    && (c.mcpProfile === undefined || c.mcpProfile === 'everyday' || c.mcpProfile === 'expert')
    // 1.1: a step's optional fields are shape-checked HERE, so a hand-edited
    // config with a malformed argv is 'corrupt' (documented self-heal) rather
    // than a runtime throw at execution time. An empty argv can never execute,
    // so it is corrupt too — refusing early beats discovering it mid-plan.
    && Array.isArray(c.plan) && c.plan.every((s) => {
      if (!s || typeof s !== 'object') return false;
      const p = s as PlanStep;
      if (!isStr(p.kind) || !isStr(p.script)) return false;
      if (p.adapter !== undefined && !isStr(p.adapter)) return false;
      if (p.scope !== undefined && !isStr(p.scope)) return false;
      if (p.argv !== undefined && (!Array.isArray(p.argv) || p.argv.length === 0 || !p.argv.every(isStr))) return false;
      return true;
    })
    && Array.isArray(c.hookCommands) && c.hookCommands.every(isStr)
    && (c.sessionStartCommands === undefined || (Array.isArray(c.sessionStartCommands) && c.sessionStartCommands.every(isStr)))
    // v1.4 §C: the Codex ownership record is shape-checked here too, so a hand-edited config with a
    // malformed list is 'corrupt' (the documented self-heal path) rather than a TypeError mid-uninstall.
    && (c.codexHookCommands === undefined || (Array.isArray(c.codexHookCommands) && c.codexHookCommands.every(isStr)))
    && Array.isArray(c.touched) && c.touched.every((t) => t && typeof t === 'object' && isStr((t as TouchedFile).path) && typeof (t as TouchedFile).created === 'boolean'
      // v1.3 §C: the kind decides HOW uninstall prunes. An unrecognised value is corrupt rather than
      // silently treated as 'hooks' — pruning the wrong way could leave an entry behind while
      // reporting success, which is the one outcome uninstall may never produce.
      && ((t as TouchedFile).kind === undefined || (t as TouchedFile).kind === 'hooks' || (t as TouchedFile).kind === 'mcp' || (t as TouchedFile).kind === 'codex-hooks')
      && (c.touched as TouchedFile[]).filter((x) => x.kind === 'mcp').length <= 1
      // one Codex hooks file per repository, for the same reason: a second record would be a file
      // that setup never wrote, and uninstall must not be talked into pruning an unowned one.
      && (c.touched as TouchedFile[]).filter((x) => x.kind === 'codex-hooks').length <= 1)
    // 1.1 §1: a config may only name a REGISTERED adapter — an unknown id is
    // 'corrupt' (the documented self-heal path fires), never a silent fallback
    // that would run the Node pipeline against a foreign project.
    && (c.project === undefined || (typeof c.project === 'string' && Object.hasOwn(ADAPTERS, c.project)));
}

export function readConfig(root: string): AmabieConfig | null | 'corrupt' {
  const p = configPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return validConfigShape(v) ? v : 'corrupt';
  } catch { return 'corrupt'; }
}

/** true = the config file is tracked in git (arrives from a clone — someone
 *  else's local state). false = not tracked. null = git cannot answer. */
const configTrackedMemo = new Map<string, boolean | null>();

export function configTracked(root: string): boolean | null {
  // Once per process per root: cmdSetup asks twice (the pre-write tracked-config
  // refusal and the prevUsable dedupe seed) and nothing in-process commits
  // .amabie between the two. Both non-false answers are refusals, so a
  // remembered answer can only ever refuse as much as a re-ask would.
  const seen = configTrackedMemo.get(root);
  if (seen !== undefined) return seen;
  const gr = gitCommand(root, ['ls-files', '--', path.relative(root, configPath(root)).split(path.sep).join('/')]);
  const out = !gr || gr.status !== 0 ? null : gr.stdout.trim().length > 0;
  configTrackedMemo.set(root, out);
  return out;
}

/** Why this config must not be honored as "our own local state" — or null.
 *  cliPath binding catches configs written by another installation (the S2
 *  cloned-repo vector: a bogus cliPath is the attacker's unavoidable
 *  footprint; a same-path guess additionally needs the committed settings.json
 *  to pass Claude Code's own project-settings approval). The tracked check
 *  closes the same-install-path case: to reach a victim, the config must be
 *  committed, and committed Amabie state is exactly what must never be trusted. */
export function untrustedConfigReason(root: string, cfg: AmabieConfig): string | null {
  if (!samePath(path.normalize(cfg.cliPath), CLI_ENTRY)) return `it was written by a different Amabie installation ("${cfg.cliPath}")`;
  if (configTracked(root) === true) return 'it is committed to this repo — Amabie state must stay local (.amabie self-ignores); a cloned config is not yours';
  return null;
}

/** Make .amabie self-ignoring BEFORE Amabie's first repo write. installClaudeHooks
 *  drops a settings backup under .amabie/backups, and the baseline dirty-stamp
 *  runs after that — if the self-ignore only arrives with writeConfig, Amabie's
 *  own backup stamps the baseline dirty and permanently blinds worktree-deletion
 *  blame in the common "repo tracks .claude/settings.json" setup (review #2). */
export function ensureAmabieSelfIgnore(root: string): void {
  const dir = path.join(root, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) writeFileAtomic(gi, '*\n');
}

export function writeConfig(root: string, cfg: AmabieConfig): void {
  const dir = path.join(root, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, '.gitignore'), '*\n'); // self-ignoring; never dirties the user repo
  writeFileAtomic(path.join(dir, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n');
}
