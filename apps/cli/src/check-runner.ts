import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterForStep, scopeDir } from './project.js';
import { attributeFailures, npmScriptDirs, pathEntries, projectVenv, type AttributeInput, type FailureAttribution, type ToolchainSeal } from './sealed-toolchain.js';
import { type PlanStep } from './project.js';
import { ENV_POLICY, PM_NAMES, execDigest, hardenedEnv, programIdentity, programInsideRoot, resolveProgram, spawnHardened, stepCommand, stepDisplay } from './execution-environment.js';
import { type AmabieConfig, readConfig } from './local-config.js';
import { passEnvValues } from './pass-env.js';

/**
 * v1.5 BLOCKER 6 — THE OPERATOR-AUTHORIZED EXECUTABLE DIRECTORIES, AND NOTHING ELSE.
 *
 * `hardenedEnv` above is deliberately untouched: the M7 mutation pins its exact text ("merge the
 * CALLER environment under the sanitized one" must stay dead), and that rule still holds — the
 * calling PATH is NEVER consulted at verification time. What this adds is the one thing a pin cannot
 * reach: a project's own check spawning a tool TRANSITIVELY (`npm test` → `java`, `python`, `git`),
 * where the resolution happens inside the child through the PATH the child was handed.
 *
 * Authority is still a human act at the one authorizing moment (`setup --toolchain-dir`), recorded in
 * the local config; a directory the repository can write is refused outright by
 * `validateToolchainDir`, so a worker cannot authorize its own shim. A directory that has since
 * vanished is filtered out here (the spawn must not throw) and REPORTED to the attribution below,
 * which is where "Amabie's environment is the cause" is decided.
 */
export function sealedToolchainDirs(root: string): string[] {
  let cfg: AmabieConfig | 'corrupt' | null = null;
  try { cfg = readConfig(root); } catch { return []; }
  if (cfg === null || cfg === 'corrupt') return [];
  const dirs = cfg.toolchain?.dirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((d): d is string => typeof d === 'string' && d.length > 0 && isDir(d));
}

/** Operator-authorized directories that are sealed in the config but NO LONGER EXIST here. */
export function vanishedToolchainDirs(root: string): string[] {
  let cfg: AmabieConfig | 'corrupt' | null = null;
  try { cfg = readConfig(root); } catch { return []; }
  if (cfg === null || cfg === 'corrupt') return [];
  const dirs = cfg.toolchain?.dirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((d): d is string => typeof d === 'string' && d.length > 0 && !isDir(d));
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * What a failing step may be blamed on, measured — see `attributeStepFailure` for the rules. The
 * directories handed to the child are reconstructed from the SAME env door the step used (plus the
 * `node_modules/.bin` entries npm itself prepends), so "it is not in the sealed environment" is a
 * statement about the environment the check actually ran in, not about this process's PATH.
 */
export function attributeRunFailures(root: string, cfg: AmabieConfig, failed: StepResult[], plan: PlanStep[]): FailureAttribution {
  const seal: ToolchainSeal | null = cfg.toolchain ?? null;
  const sealedDirs = sealedToolchainDirs(root);
  const vanished = vanishedToolchainDirs(root);
  // The operator's live PATH: only a hint for the remediation text (see locateFor), never handed to a child.
  const operatorDirs = pathEntries(process.env);
  const inputs: AttributeInput[] = failed.map((f) => {
    const step = plan.find((s) => s.kind === f.kind && stepDisplay(cfg.pm, s) === f.display)
      ?? plan.find((s) => s.kind === f.kind);
    const cwd = step ? scopeDir(root, step) : root;
    const childPathDirs = [...pathEntries(hardenedEnv(cwd)), ...npmScriptDirs(cwd), ...sealedDirs];
    return {
      kind: f.kind, script: step?.script ?? f.display, exitCode: f.exitCode,
      output: `${f.stdout}${f.stderr}`, childPathDirs, vanishedDirs: vanished, seal, operatorDirs,
      ...(step?.argv?.[0] !== undefined ? { program: step.argv[0] } : {}), venv: projectVenv(cwd),
      ...(stepProcessFailures.has(f) ? { executionFailure: stepProcessFailures.get(f)! } : {}),
    };
  });
  return attributeFailures(inputs);
}

export interface StepResult {
  kind: string; display: string; ok: boolean; exitCode: number | null; secs: number; tail: string;
  /** M2 evidence fields — recorded, never consulted for a verdict */
  argv: string[]; cwd: string; stdout: string; stderr: string;
  /** blocker 1: what actually EXECUTED (argv[0] above is the whitelisted
   *  display form; execArgv/exec are the trusted-resolution record) */
  execArgv: string[];
  exec: { file: string; digest: string | null; via: string; policy: string };
  /** M4 provenance: wall-clock stamps around the spawn, recorded, never judged */
  startedAt: string; endedAt: string;
}

// Supervisor facts stay in memory: project output cannot forge them, and existing JSON stays unchanged.
const stepProcessFailures = new WeakMap<StepResult, string>();

/** Preserve the sealed sequence, then verify earlier tests against the final build.
 * Legacy seals remain byte-identical; every extra command is already authorized.
 * Keep initial failures: a later pass never waives a failed sealed check. */
export function planWithFreshTests(plan: PlanStep[]): PlanStep[] {
  const lastBuild = plan.reduce((last, step, index) => step.kind === 'build' ? index : last, -1);
  return [...plan, ...plan.filter((step, index) => index < lastBuild && step.kind === 'tests')];
}

/** Synthetic non-ran step for resolution failures at the one call site
 *  (setup smoke) that must report honestly instead of crashing. exitCode
 *  null = "could not run at all", the same infra truth a spawn error gives. */
export function unresolvedStep(root: string, pm: string, step: PlanStep, err: unknown): StepResult {
  const at = new Date().toISOString();
  const msg = String(err);
  // the command is usually still computable here (resolution failed, not
  // validation) — but never at the cost of throwing inside a failure reporter
  let argv: string[];
  try { argv = stepCommand(pm, step); } catch { argv = [pm, 'run', step.script]; }
  return {
    kind: step.kind, display: argv.join(' '), ok: false, exitCode: null, secs: 0,
    tail: msg, argv, cwd: scopeDir(root, step), stdout: '', stderr: msg,
    execArgv: [], exec: { file: '', digest: null, via: 'unresolved', policy: ENV_POLICY },
    startedAt: at, endedAt: at,
  };
}

/**
 * `authorityRoot` is the project whose sealed authority applies (toolchain directories, passed-through
 * variable names). It differs from `root` when the step runs in a throwaway copy of the project, such
 * as the baseline worktree, which has no `.amabie` of its own: without it the baseline would run in a
 * poorer environment than the candidate and fail for a reason that has nothing to do with the change.
 */
export function runPlanStep(root: string, pm: string, step: PlanStep, timeoutMs = 600_000, authorityRoot = root): StepResult {
  const argv = stepCommand(pm, step); // throws unless the step's command is fully validated
  const display = argv.join(' ');
  const program = argv[0] as string;
  const resolved = resolveProgram(program, step.adapter);
  if (resolved === null) {
    throw new Error(PM_NAMES.has(program)
      ? `package manager "${program}" is not resolvable in Amabie's trusted execution environment (the running Node's install dir and OS-managed dirs only — the calling PATH is deliberately ignored). Install it with corepack or into the same Node prefix, then re-run.`
      : `program "${program}" is not resolvable in Amabie's trusted execution environment (the running Node's install dir, the OS-managed dirs, and the directories the declaring project adapter names — the calling PATH is deliberately ignored). Install it in one of those locations, or seal its absolute path in the plan, then re-run.`);
  }
  // A program inside the repository (an activated virtualenv's interpreter) is writable by the worker, so it
  // runs only while it is byte-for-byte the one setup sealed; a plan that names one without a sealed identity
  // (sealed before this rule) is refused rather than trusted.
  if (path.isAbsolute(program) && (step.programId !== undefined || programInsideRoot(program, authorityRoot))) {
    if (step.programId === undefined) {
      throw new Error(`the program ${program} is inside the repository, where it can be replaced, and setup did not record its identity. Run \`amabie setup\` again from your own terminal to seal it.`);
    }
    if (programIdentity(resolved.file) !== step.programId) {
      throw new Error(`the program ${program} is not the one sealed at setup (it was replaced, moved or upgraded). If you changed it, run \`amabie setup\` again from your own terminal; if you did not, check what changed in the project directory.`);
    }
  }
  // A step runs in ITS OWN SCOPE's directory. In a nested polyglot repo the
  // scoped check is declared by `<scope>/package.json` (or `<scope>/pyproject
  // .toml`), so running it from the repository root is not merely untidy — the
  // package manager cannot find the manifest and the check fails with
  // `ENOENT ... package.json`, which the smoke caught. `scopeDir` is the same
  // function the plan problems and the sealing use, so there is one answer.
  const cwd = scopeDir(root, step);
  // The step's OWN ecosystem declares what its toolchain needs under the
  // sanitized env (e.g. Go's workspace-scoped GOCACHE/GOPATH). A legacy step has
  // no adapter and therefore no declaration — and needs none.
  const toolchain = (() => {
    try {
      const adapter = adapterForStep({}, step);
      return adapter.toolchainEnv?.({ dir: cwd, workspace: os.tmpdir() });
    } catch { return undefined; }
  })();
  const startedAt = new Date().toISOString();
  // v1.5 blocker 6: the OPERATOR-authorized executable dirs sealed in this repo's config. Resolution
  // of the plan's OWN program is untouched above (never PATH); these exist for what the project's
  // check spawns transitively.
  const r = spawnHardened(resolved, argv.slice(1), cwd, timeoutMs, toolchain, sealedToolchainDirs(authorityRoot), passEnvValues(authorityRoot));
  const stdout = r.stdout ?? '';
  const processFailure = r.error ? r.error.message : r.status === null ? 'process ended without an exit code' : undefined;
  const stderr = (r.stderr ?? '') + (processFailure ? `\nAmabie supervisor: ${processFailure}\n` : '');
  const out = `${stdout}${stderr}`;
  const result: StepResult = {
    kind: step.kind, display, ok: processFailure === undefined && r.status === 0,
    exitCode: processFailure === undefined ? r.status : null, secs: 0,
    tail: out.split(/\r?\n/).filter(Boolean).slice(-12).join('\n'),
    argv, cwd, stdout, stderr,
    execArgv: [...resolved.spawnArgv, ...argv.slice(1)],
    exec: { file: resolved.file, digest: execDigest(resolved.file), via: resolved.via, policy: ENV_POLICY },
    startedAt, endedAt: new Date().toISOString(),
  };
  if (processFailure !== undefined) stepProcessFailures.set(result, processFailure);
  return result;
}

/** A measured nonzero exit may collect further checks; an unmeasured process must halt them. */
export function runPlanSteps(root: string, pm: string, plan: readonly PlanStep[], timeoutMs = 600_000, authorityRoot = root): StepResult[] {
  const results: StepResult[] = [];
  for (const step of plan) {
    const result = runPlanStep(root, pm, step, timeoutMs, authorityRoot);
    results.push(result);
    if (result.exitCode === null) break;
  }
  return results;
}
