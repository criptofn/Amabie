import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { controllerExecution } from './provider/execution.js';
import { resolveNpmCli, sanitizedEnv, sweepDescendants, runWindowsProcessSync } from '@amabie/support';
import { adapterFor, adapterForStep, assertStepArgv, stepArgv } from './project.js';
import { type PlanStep } from './project.js';

// ---------- execution (PRE-1.0 blocker 1: hardened) ----------
// RULE: an untrusted CALLER ENVIRONMENT must never control proof-authoritative
// execution. EVERY subprocess whose result can move READY / PASS / FAIL /
// BLOCKED / NOT PROVEN / PROMOTABLE / ACCEPTED goes through this section:
//   - fully REPLACED deny-by-omission environment (sanitizedEnv — the caller's
//     PATH, NODE_OPTIONS, NODE_PATH, npm_config_*, GIT_* simply do not exist
//     for the child; there is deliberately no merge option, support F9);
//   - executable resolved WITHOUT any caller-controlled path: the running
//     Node's own install dir (where corepack/npm-bundled tools live) plus
//     fixed OS-managed (root/admin-owned) directories. git gets the same
//     treatment from literal candidates, never %SystemRoot%- or PATH-derived;
//   - shell:false everywhere — the win32 .cmd shim problem is solved by
//     running the CLI ENTRY SCRIPTS under node, not by handing cmd.exe a PATH.
// Each bundle step records WHAT RAN (resolved file + digest + policy), so
// evidence names the actual bytes instead of an argv that could describe a
// different binary. Same-UID total forgery (swapping the node binary itself,
// pre-planting files in these directories) remains the documented ceiling (M2).

const NODE_DIR = path.dirname(process.execPath);

export const ENV_POLICY = 'amabie-sanitized/1';

/** The literal absolute candidates Amabie will execute git from. Never
 *  PATH-derived: a PATH or %SystemRoot% shim must not be able to become git. */
const gitCandidates = (): string[] => process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    'C:\\Windows\\System32\\git.exe', path.join(NODE_DIR, 'git.exe')]
  : ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];

/**
 * The directories Amabie is willing to execute from.
 *
 * EXPORTED because a probe asserts that every executed file lies inside this
 * set, and until this function was exported that probe kept a hardcoded MIRROR
 * of it — so the assertion that is supposed to police the trust set silently
 * desynchronised whenever the set changed (which is exactly what happened on
 * win32: `gitExe()` executes git from a literal Git install directory that this
 * list did not contain, and the probe failed on the contradiction).
 *
 * The rule the list encodes: a directory Amabie will EXECUTE from is trusted by
 * construction, so the declared set must contain every candidate the product
 * resolves to — see `gitCandidates` below. Adding these directories cannot widen
 * what a PROJECT can make Amabie run: they are fixed literals, not search paths.
 */
export function trustedDirs(): string[] {
  const base = process.platform === 'win32'
    ? [NODE_DIR, 'C:\\Windows\\System32', 'C:\\Windows']
    : [NODE_DIR, '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set([...base, ...gitCandidates().map((c) => path.dirname(c))])];
}

// ws.root doubles as the child's isolated HOME/TMP base. It is os.tmpdir(),
// which the caller can steer — but every dir a steered TEMP points at is
// already fully attacker-writable at this UID, so pre-planting there grants
// nothing the same-UID ceiling does not already cover. What matters (and what
// this closes) is that env-var INJECTION can no longer steer resolution.
export const hardenedEnv = (fixture: string): NodeJS.ProcessEnv =>
  sanitizedEnv({ ws: { root: os.tmpdir(), fixture }, nodeDir: NODE_DIR });

/**
 * The SAME environment door, plus the toolchain variables the step's own
 * ecosystem declared (`ProjectAdapter.toolchainEnv`).
 *
 * A second function rather than a wider signature on purpose: the two lines above
 * are the anchor the master-pass M7 mutation pins ("merge the CALLER environment
 * under the sanitized one" must stay dead), and widening that expression would
 * have moved the anchor for no gain. This door adds only what an adapter
 * declared, and `sanitizedEnv` still enforces the key allowlist and workspace
 * containment on every value.
 */
const hardenedEnvWithToolchain = (fixture: string, toolchain: Record<string, string>): NodeJS.ProcessEnv =>
  sanitizedEnv({ ws: { root: os.tmpdir(), fixture }, nodeDir: NODE_DIR, toolchain: { env: toolchain } });

/** Compact executable identity for evidence: sha256 where cheap, size where not. */
export function execDigest(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > 8 * 1024 * 1024) return `size:${st.size}`;
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch { return null; }
}

let gitExeCache: string | null | undefined;

/** Fixed literal candidates — a PATH or %SystemRoot% shim cannot become git. */
export function gitExe(): string | null {
  if (gitExeCache !== undefined) return gitExeCache;
  gitExeCache = gitCandidates().find((c) => fs.existsSync(c)) ?? null;
  return gitExeCache;
}

/** One hardened raw git call — the ONLY way product code spawns git.
 *  null = git is not resolvable in the trusted environment: fail closed. */
export interface GitResult {
  status: number | null; stdout: string; stderr: string; error?: Error | undefined;
  pid?: number; signal?: NodeJS.Signals | null; errorCode?: string | undefined;
  durationMs?: number; startedAt?: string; finishedAt?: string;
}

export function gitCommand(root: string, args: string[], timeoutMs = 15_000): GitResult | null {
  const exe = gitExe();
  if (exe === null) return null;
  const controller = controllerExecution.getStore();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const r = spawnSync(exe, [...(controller ? ['-c', `core.hooksPath=${controller.hooksDirectory}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'] : []), '-C', root, ...args], {
    // 32MB maxBuffer: the 1MB default would turn a large repo's `ls-tree -r`
    // (M7's submodule probe) into a spurious null.
    cwd: root, encoding: 'utf8', timeout: timeoutMs,
    env: { ...sanitizedEnv({ ws: { root: os.tmpdir(), fixture: root }, nodeDir: NODE_DIR, materialize: false }),
      ...(controller ? { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } : {}) }, shell: false, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error,
    pid: r.pid, signal: r.signal, errorCode: (r.error as NodeJS.ErrnoException | undefined)?.code,
    durationMs: performance.now() - started, startedAt, finishedAt: new Date().toISOString(),
  };
}

/** Resolve the package manager to TRUSTED bytes — PATH is never consulted.
 *  Order: (1) the CLI entry script bundled inside the running Node's install
 *  (npm/pnpm/yarn run under node itself — no .cmd shim, no lookup; npm uses
 *  the single canonical resolveNpmCli from @amabie/support for probe
 *  parity); (2) an absolute executable found in a trusted directory, win32
 *  .cmd/.bat only through the literal-system cmd.exe. null = unresolvable. */
export interface ResolvedPm { spawnArgv: [string, ...string[]]; file: string; via: string }

const PM_ENTRIES: Record<string, string> = { npm: 'npm/bin/npm-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', yarn: 'yarn/bin/yarn.js' };

export function resolvePm(pm: string): ResolvedPm | null {
  const entry = Object.hasOwn(PM_ENTRIES, pm) ? PM_ENTRIES[pm] : undefined;
  if (entry !== undefined) {
    const hit = pm === 'npm' ? resolveNpmCli()
      : [path.join(NODE_DIR, 'node_modules'), path.join(NODE_DIR, '..', 'lib', 'node_modules')]
        .map((d) => path.join(d, entry)).find((c) => fs.existsSync(c));
    if (hit) return { spawnArgv: [process.execPath, hit], file: hit, via: 'node-entry' };
  }
  const names = process.platform === 'win32' ? [`${pm}.exe`, `${pm}.cmd`, `${pm}.bat`] : [pm];
  for (const dir of trustedDirs()) {
    for (const n of names) {
      const abs = path.join(dir, n);
      if (!fs.existsSync(abs)) continue;
      if (/\.(cmd|bat)$/i.test(abs)) {
        // literal, never %ComSpec%: the caller owns that env var
        const cmdExe = 'C:\\Windows\\System32\\cmd.exe';
        if (!fs.existsSync(cmdExe)) continue;
        return { spawnArgv: [cmdExe, '/d', '/s', '/c', abs], file: abs, via: 'trusted-cmd' };
      }
      return { spawnArgv: [abs], file: abs, via: 'trusted-path' };
    }
  }
  return null;
}

export const PM_NAMES = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Resolve one program to TRUSTED bytes for a step's argv[0].
 *
 * Package managers keep their existing resolution exactly (this is the same
 * resolvePm the doctor liveness probe uses, so plan and probe still consult one
 * door). Any OTHER program — an interpreter or toolchain a non-script ecosystem
 * declares — is looked for in the baseline trusted dirs plus the declaring
 * adapter's conventional dirs. PATH is still never consulted, so a candidate
 * cannot plant a `python` ahead of the sealed one and have Amabie spawn it as
 * sealed authority. An ABSOLUTE program path is accepted as the authority the
 * seal already covers (setup sealed the argv that names it) and is still
 * digest-recorded for evidence. null = unresolvable: callers fail closed.
 */
export function resolveProgram(program: string, adapterId?: string): ResolvedPm | null {
  const asPm = resolvePm(program);
  if (asPm !== null) return asPm;
  const dirs: string[] = [...trustedDirs()];
  try { dirs.push(...adapterFor(adapterId === undefined ? {} : { project: adapterId }).trustedProgramDirs); }
  catch { /* unregistered adapter id: baseline dirs only, and the step will refuse below */ }
  const names = path.isAbsolute(program)
    ? [program]
    : process.platform === 'win32' ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program] : [program];
  for (const n of names) {
    const candidates = path.isAbsolute(n) ? [n] : dirs.map((d) => path.join(d, n));
    for (const abs of candidates) {
      if (!fs.existsSync(abs)) continue;
      if (/\.(cmd|bat)$/i.test(abs)) {
        // literal, never %ComSpec%: the caller owns that env var (same rule as resolvePm)
        const cmdExe = 'C:\\Windows\\System32\\cmd.exe';
        if (!fs.existsSync(cmdExe)) continue;
        return { spawnArgv: [cmdExe, '/d', '/s', '/c', abs], file: abs, via: 'trusted-cmd' };
      }
      return { spawnArgv: [abs], file: abs, via: 'trusted-path' };
    }
  }
  return null;
}

/** The exact command a step will run, from whichever authority owns it: an
 *  explicit sealed argv (a non-script ecosystem), or the validated
 *  `<pm> run <script>` shape (Node). Throws on anything it cannot validate — a
 *  step that cannot be validated is never run anyway. */
export function stepCommand(pm: string, step: PlanStep): string[] {
  // A 1.1 scoped step names its own scope's package manager (sealed with the
  // step); `pm` is the repository-level fallback for 1.0 steps.
  return step.argv !== undefined ? assertStepArgv(step.argv) : stepArgv(step.pm ?? pm, step.script);
}

/** How a step is shown to a human: the argv for an explicit step, the 1.0
 *  `<pm> run <script>` wording for a script step (unchanged output), and the
 *  step's OWN scope's pm when it carries one — a nested `web/` step shown as
 *  `python run test` would be a lie about what will execute. */
export function stepDisplay(pm: string, step: PlanStep): string {
  const scoped = step.scope ? `${step.scope}: ` : '';
  return step.argv !== undefined ? `${scoped}${assertStepArgv(step.argv).join(' ')}` : `${scoped}${step.pm ?? pm} run ${step.script}`;
}

/**
 * Pin every program an explicit-argv step names to an ABSOLUTE path, and seal
 * that path.
 *
 * This is the ONLY place Amabie consults PATH, and it is the one moment a human
 * authorizes the plan: `setup`. What gets sealed is the absolute path; every
 * later verification resolves that path and nothing else (resolveProgram), so a
 * candidate cannot plant a program earlier on a search path and have Amabie
 * spawn it as sealed authority — the thing `resolvePm` has always refused for
 * package managers, now extended to interpreters and toolchains.
 *
 * Returns the pinned plan and one problem per program that could not be pinned;
 * a step whose program cannot be found is never silently dropped.
 */
export function pinPlanPrograms(plan: PlanStep[]): { plan: PlanStep[]; problems: string[] } {
  const problems: string[] = [];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const cache = new Map<string, string | null>();
  const resolveOnPath = (program: string): string | null => {
    if (cache.has(program)) return cache.get(program) ?? null;
    // Most Linux hosts ship only `python3`, and the python checks invoke `python`. On non-Windows hosts a
    // `python` miss may pin the `python3` on PATH; the pinned absolute path is what runs. Windows keeps
    // `python` alone because a `python3.exe` there can be an app-store stub.
    const programs = process.platform !== 'win32' && program === 'python' ? ['python', 'python3'] : [program];
    let found: string | null = null;
    for (const candidate of programs) {
      const names = process.platform === 'win32'
        ? [`${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`, candidate]
        : [candidate];
      for (const d of pathDirs) {
        for (const n of names) {
          const abs = path.join(d, n);
          if (fs.existsSync(abs)) { found = abs; break; }
        }
        if (found !== null) break;
      }
      if (found !== null) break;
    }
    cache.set(program, found);
    return found;
  };
  const out: PlanStep[] = plan.map((step) => {
    if (step.argv === undefined) return step; // script steps keep `<pm> run <script>`
    const argv = assertStepArgv(step.argv);
    const head = argv[0] as string;
    if (path.isAbsolute(head)) return { ...step, argv };
    // ADAPTER-DECLARED DIRECTORIES COME FIRST (v1.1). For most ecosystems they are
    // empty and this is a no-op. For Rust they are the point: rustup installs a
    // PATH PROXY at `~/.cargo/bin/cargo`, and the proxy cannot run under Amabie's
    // sanitized environment (RUSTUP_HOME/HOME are redirected), while the REAL
    // toolchain binary at `<rustup>/toolchains/<tc>/bin/cargo` runs fine — measured
    // in tooling/probes/runner-channels-rust-go.mjs. Sealing the proxy would seal a
    // step that can never execute, so a reviewed, literal adapter directory is
    // preferred over whatever PATH happens to resolve to.
    const abs = resolveFromAdapterDirs(step, head) ?? resolveOnPath(head);
    if (abs === null) {
      problems.push(`"${head}" (needed by the ${step.kind} check "${step.script}") was not found on PATH at setup time`);
      return { ...step, argv };
    }
    return { ...step, argv: [abs, ...argv.slice(1)] };
  });
  return { plan: out, problems };
}

/** Try the step's own adapter's declared program directories, in order. */
function resolveFromAdapterDirs(step: PlanStep, program: string): string | null {
  let dirs: readonly string[] = [];
  try { dirs = adapterForStep({}, step).trustedProgramDirs; } catch { return null; }
  const names = process.platform === 'win32'
    ? [`${program}.exe`, `${program}.cmd`, `${program}.bat`, program]
    : [program];
  for (const d of dirs) {
    for (const n of names) {
      const abs = path.join(d, n);
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Shared spawn for a resolved pm: the plan runner and doctor's liveness
 *  probe must consult the SAME bytes, so they share this one door. */
export function spawnHardened(resolved: ResolvedPm, args: string[], cwd: string, timeoutMs: number, toolchain?: Record<string, string>, toolchainDirs?: readonly string[], operatorEnv?: Record<string, string>) {
  const controller = controllerExecution.getStore();
  if (controller) return controller.run([...resolved.spawnArgv, ...args], cwd, timeoutMs);
  // v1.5 blocker 6: the operator-authorized dirs are appended to the SAME sanitized env amabie has
  // always built — never merged from the caller. With no authorized dirs the expression below is the
  // unchanged one (`hardenedEnv` / `hardenedEnvWithToolchain`), so a config without `toolchain`
  // produces byte-identical children.
  const dirs = toolchainDirs ?? [];
  const passed = operatorEnv !== undefined && Object.keys(operatorEnv).length > 0 ? operatorEnv : undefined;
  const env = dirs.length === 0 && passed === undefined
    ? (toolchain !== undefined && Object.keys(toolchain).length > 0 ? hardenedEnvWithToolchain(cwd, toolchain) : hardenedEnv(cwd))
    : sanitizedEnv({
      ws: { root: os.tmpdir(), fixture: cwd }, nodeDir: NODE_DIR, extraPathDirs: dirs,
      ...(passed !== undefined ? { operatorEnv: passed } : {}),
      ...(toolchain !== undefined && Object.keys(toolchain).length > 0 ? { toolchain: { env: toolchain } } : {}),
    });
  const spawnedAtMs = Date.now();
  const spawnOptions = {
    cwd, encoding: 'utf8' as const, timeout: timeoutMs,
    env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32',
    maxBuffer: 32 * 1024 * 1024,
  };
  const result = process.platform === 'win32'
    ? runWindowsProcessSync(resolved.spawnArgv[0], [...resolved.spawnArgv.slice(1), ...args], spawnOptions)
    : spawnSync(resolved.spawnArgv[0], [...resolved.spawnArgv.slice(1), ...args], spawnOptions);
  if (process.platform !== 'win32' && result.pid > 0 && sweepDescendants(result.pid, spawnedAtMs).failed) {
    result.error ??= new Error('post-run containment sweep could not confirm zero surviving descendants');
  }
  return result;
}
