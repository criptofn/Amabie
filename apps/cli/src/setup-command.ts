import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { canonicalPath } from '@amabie/support';
import { QUARANTINE_FILE } from './authority.js';
import { composePlan, parseJsonOrNull, planDigest, planForScope, planScriptTexts, SCOPES_FILE, SCOPES_SCHEMA, sealPlanAuthority, stepKey } from './project.js';
import { readUniversalManifest } from './universal.js';
import { inventoryOperatorToolchain, TOOLCHAIN_CANDIDATES, validateToolchainDir, type ToolchainSeal } from './sealed-toolchain.js';
import { PROTOCOL_SETUP_CHECK } from './protocol.js';
import { type PlanAuthority } from './project.js';
import { probeTrustLevel, sealRecord, storeFromEnv, projectIdForRoot } from './trust-store.js';
import { AMABIE_VERSION } from './pipeline.js';
import { type StepResult, attributeRunFailures, planWithFreshTests, runPlanStep, unresolvedStep } from './check-runner.js';
import { Out, dirArg, parseGlobals, takePassEnv, takeToolchainDirs } from './cli-output.js';
import { CLI_ENTRY, buildHookCommand } from './cli-runtime.js';
import { pinPlanPrograms, stepDisplay } from './execution-environment.js';
import { candidateIdentity, gitWithinRoot } from './git-state.js';
import { codexHooksPath, detectHarnesses, findForeignAmabieHooks, installClaudeHooks, installCodexStopHook, machineFilesNote, settingsPath } from './harness-hooks.js';
import { type AmabieConfig, CHECKPOINT_FILE, CONFIG_DIR, configPath, configTracked, ensureAmabieSelfIgnore, findRepoRoot, readConfig, retiredPackageCliPath, untrustedConfigReason, writeConfig } from './local-config.js';
import { sealPassEnvNames, sealedPassEnvNames } from './pass-env.js';
import { assertPlainTarget, containedRealPath, isRecord, rel, writeFileAtomic } from './local-files.js';
import { type McpProfile, installMcpServer, mcpArgSignature, mcpConfigPath, mcpServerArgs } from './mcp-registration.js';
import { unboundRequirements } from './proof-obligations.js';
import { readTaskRecord } from './task-state.js';
import { writeCheckpoint, writeVerificationBundle } from './verification-evidence.js';

interface SetupFileSnapshot { file: string; before: Buffer | null; after?: Buffer; parent: string; parentExisted: boolean }

function snapshotSetupFile(snapshots: Map<string, SetupFileSnapshot>, file: string): void {
  if (snapshots.has(file)) return;
  const parent = path.dirname(file);
  snapshots.set(file, {
    file,
    before: fs.existsSync(file) ? fs.readFileSync(file) : null,
    parent,
    parentExisted: fs.existsSync(parent),
  });
}

function rememberSetupWrite(snapshots: Map<string, SetupFileSnapshot>, file: string | undefined): void {
  if (file === undefined) return;
  const snapshot = snapshots.get(file);
  if (!snapshot) throw new Error(`setup wrote an unexpected settings path: ${file}`);
  const after = fs.readFileSync(file);
  if (snapshot.before?.equals(after)) return;
  snapshot.after = after;
}

/** Restore only settings files that still contain the exact bytes setup wrote. */
function rollbackSetupWrites(snapshots: Map<string, SetupFileSnapshot>): string[] {
  const problems: string[] = [];
  for (const snapshot of [...snapshots.values()].reverse()) {
    if (snapshot.after === undefined) continue;
    try {
      assertPlainTarget(snapshot.file);
      if (!fs.existsSync(snapshot.file)) {
        if (snapshot.before === null) continue;
        problems.push(`${snapshot.file} disappeared during setup; left it untouched`);
        continue;
      }
      if (!fs.readFileSync(snapshot.file).equals(snapshot.after)) {
        problems.push(`${snapshot.file} changed after setup wrote it; left it untouched`);
        continue;
      }
      if (snapshot.before === null) fs.rmSync(snapshot.file);
      else writeFileAtomic(snapshot.file, snapshot.before.toString('utf8'));
      if (!snapshot.parentExisted) {
        try { fs.rmdirSync(snapshot.parent); } catch { /* preserve a non-empty directory */ }
      }
    } catch (e) {
      problems.push(`${snapshot.file} could not be restored (${String(e).slice(0, 140)})`);
    }
  }
  return problems;
}

function setupRollbackNote(snapshots: Map<string, SetupFileSnapshot>): string {
  const changed = [...snapshots.values()].some((snapshot) => snapshot.after !== undefined);
  if (!changed) return 'No hook or MCP files from this attempt needed rollback.';
  const problems = rollbackSetupWrites(snapshots);
  return problems.length
    ? `Rollback needs attention: ${problems.join('; ')}.`
    : 'Amabie restored the hook and MCP files changed by this setup attempt.';
}

function takeSetupOptions(args: string[]): { rest: string[]; check: boolean; profile?: McpProfile; problems: string[] } {
  const rest: string[] = [];
  const problems: string[] = [];
  let check = false;
  let profile: McpProfile | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--check') { check = true; continue; }
    if (arg === '--mcp-profile') {
      const value = args[++i];
      if (value !== 'everyday' && value !== 'expert') problems.push('--mcp-profile must be everyday or expert');
      else if (profile !== undefined && profile !== value) problems.push('conflicting --mcp-profile values were provided');
      else profile = value;
      continue;
    }
    if (arg.startsWith('--mcp-profile=')) {
      const value = arg.slice('--mcp-profile='.length);
      if (value !== 'everyday' && value !== 'expert') problems.push('--mcp-profile must be everyday or expert');
      else if (profile !== undefined && profile !== value) problems.push('conflicting --mcp-profile values were provided');
      else profile = value;
      continue;
    }
    rest.push(arg);
  }
  return { rest, check, ...(profile ? { profile } : {}), problems };
}

/**
 * What to do when a project declares no check at all: a real build or typecheck its files already point
 * to, otherwise one first smoke test that imports the code and checks one result. Amabie never writes that
 * test itself: a generated test that cannot fail would be a false proof.
 */
export function starterPath(root: string, adapters: string[]): string {
  const ids = new Set(adapters);
  const options: string[] = [];
  if (ids.has('node')) {
    options.push(fs.existsSync(path.join(root, 'tsconfig.json'))
      ? 'add "typecheck": "tsc --noEmit" to the scripts in package.json (it checks your types for real)'
      : 'add a "test" script to package.json that runs one real test, for example "test": "node --test" with one *.test.js file that imports your code and checks one result');
  }
  if (ids.has('python')) options.push('write one test that imports your package and checks one result (unittest or pytest), or configure mypy, pyright or ruff');
  if (options.length === 0) options.push('add the build or typecheck command your stack already has, or one small test that imports your code and checks one result');
  return `${options.join('; or ')}. Amabie does not generate tests for you, because a test that cannot fail proves nothing`;
}

function setupCheckResult(
  o: Out,
  root: string,
  plan: Array<{ kind: string; display: string; executable: string }>,
  harnesses: Array<{ name: string; supported: boolean }>,
  problems: string[],
  next: string,
): number {
  const inventory = inventoryOperatorToolchain(process.env.PATH ?? '');
  const relevant = new Set(['python', 'python3', 'pytest', 'java', 'javac', 'gradle', 'mvn', 'go', 'cargo', 'rustc', 'dotnet', 'git']);
  const availableToolchains = TOOLCHAIN_CANDIDATES
    .filter((name) => relevant.has(name) && inventory[name] !== null)
    .map((name) => ({ name, path: inventory[name]!, authorized: false as const }));
  const setupCheck = {
    plan,
    availableToolchains,
    harnesses,
    limitations: [
      'No project command was run; the setup smoke test is still required.',
      'Tools launched inside project scripts cannot all be discovered before those scripts run.',
      'Tool paths found in the shell remain unauthorized until explicitly added with --toolchain <name> or --toolchain-dir.',
      'Harness approval and trust-store write access are confirmed only during setup.',
    ],
  };
  const exitCode = problems.length === 0 ? 0 : 2;
  o.context({ command: 'setup', schema: PROTOCOL_SETUP_CHECK, root, setupCheck, ...(problems.length ? { problems } : {}), next, exitCode });
  o.say(`repo: ${root}`);
  o.say('setup plan (read-only; project commands were not run):');
  for (const step of plan) o.say(`  ✓ ${step.kind}: ${step.display} [${step.executable}]`);
  if (availableToolchains.length) {
    o.say('toolchains found on the shell PATH (not authorized):');
    for (const tool of availableToolchains) o.say(`  · ${tool.name}: ${tool.path}`);
  }
  for (const harness of harnesses) o.say(`harness: ${harness.name} — ${harness.supported ? 'supported' : 'not supported'}`);
  for (const limitation of setupCheck.limitations) o.say(`note: ${limitation}`);
  for (const problem of problems) o.say(`  - ${problem}`);
  o.verdict(exitCode === 0 ? 'SETUP ELIGIBLE' : 'SETUP NEEDS ATTENTION',
    exitCode === 0 ? 'the declared checks and managed files can be prepared on this host' : 'setup has the listed blockers', next);
  return exitCode;
}

export async function cmdSetup(rawArgs: string[]): Promise<number> {
  const setupArgs = takeSetupOptions(rawArgs);
  const { opts, rest } = parseGlobals(setupArgs.rest);
  const o = new Out(opts.verbose, opts.json);
  if (setupArgs.problems.length > 0 || (setupArgs.check && opts.yes)) {
    o.say(`REFUSED — ${setupArgs.problems.join('; ') || '--check cannot be combined with --yes'}. Nothing was changed.`);
    return 3;
  }
  const passArgs = takePassEnv(rest);
  const toolchainArgs = takeToolchainDirs(passArgs.rest);
  const root = findRepoRoot(dirArg(toolchainArgs.rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'this folder is not inside a git repository.', 'cd into your project and try again'); return 2; }
  if (passArgs.problems.length > 0) {
    o.verdict('NEEDS ATTENTION', `Amabie will not pass that variable to your checks: ${passArgs.problems.join('; ')}.`, 'name a variable that only carries data for your tests (a token or a URL), then run setup again — nothing was changed');
    return 2;
  }
  // The authorization is validated BEFORE anything is written: a directory inside the repository is
  // refused, because the tree the worker under verification can write is not a source of authority.
  const inventory = toolchainArgs.tools.length > 0 ? inventoryOperatorToolchain(process.env.PATH ?? '') : {};
  const missingTools = toolchainArgs.tools.filter((name) => !inventory[name]);
  const namedDirs = toolchainArgs.tools.flatMap((name) => inventory[name] ? [path.dirname(inventory[name]!)] : []);
  const checkedDirs = [...toolchainArgs.dirs, ...namedDirs].map((d) => validateToolchainDir(root, d));
  const refusedDirs = [...toolchainArgs.problems, ...missingTools.map((name) => `${name} was not found on your shell PATH; install it or use --toolchain-dir with its executable directory`), ...checkedDirs.flatMap((c) => (c.ok ? [] : [c.problem]))];
  if (refusedDirs.length > 0) {
    o.verdict('NEEDS ATTENTION', `Amabie will not authorize that toolchain directory: ${refusedDirs.join('; ')}.`, 'name an absolute directory OUTSIDE this repository that contains the executable (for example the JDK\'s bin), then run setup again — nothing was changed');
    return 2;
  }
  const toolchainDirs = [...new Set(checkedDirs.flatMap((c) => (c.ok ? [c.dir] : [])))];
  // 1.1 §12–17: the project is whatever the registered adapters declare, not
  // "a repo with a package.json". A present package.json is still validated
  // exactly as before (1.0 message, 1.0 fail-closed), but its ABSENCE is no
  // longer UNSUPPORTED by itself — the composite discovery below decides, and a
  // repo that declares nothing is UNSUPPORTED there, never guessed at here.
  const pkgFile = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgFile) ? parseJsonOrNull(pkgFile) : null;
  if (fs.existsSync(pkgFile) && !pkg) {
    o.verdict('UNSUPPORTED', 'package.json is not valid JSON — Amabie cannot read your project.', 'fix package.json, then run setup again'); return 2;
  }

  // local-state integrity BEFORE any write: a tracked .amabie config arrived
  // from someone else's clone (S1/S2), and a linked .amabie/.claude would send
  // Amabie's writes outside the repo (S3) — refuse both without touching bytes.
  if (fs.existsSync(configPath(root)) && configTracked(root) === true) {
    o.verdict('NEEDS ATTENTION', "Amabie's local config (.amabie/amabie.local.json) is tracked in git — committed Amabie state comes from a clone and cannot be trusted as this machine's own.", 'run: git rm -r --cached .amabie, then run setup again'); return 2;
  }
  // one rule for every path Amabie owns: never write through a link (live,
  // dangling, or inside-pointing) — lstat sees what existsSync cannot.
  for (const d of [path.join(root, CONFIG_DIR), path.join(root, '.claude')]) {
    let isLink = false;
    try { isLink = fs.lstatSync(d).isSymbolicLink(); } catch { /* absent: fine */ }
    if (isLink || (fs.existsSync(d) && containedRealPath(root, d) === null)) {
      o.verdict('NEEDS ATTENTION', `${rel(root, d)} is a link — Amabie will not write through links (a committed link can send Amabie's files outside the repo).`, 'replace it with a real folder inside the repo, then run setup again'); return 2;
    }
  }
  for (const f of [configPath(root), path.join(root, CONFIG_DIR, '.gitignore'), path.join(root, CONFIG_DIR, CHECKPOINT_FILE), settingsPath(root)]) {
    try {
      if (fs.lstatSync(f).isSymbolicLink()) {
        o.verdict('NEEDS ATTENTION', `${rel(root, f)} is a link — Amabie will not write through links.`, 'replace it with a real file inside the repo, then run setup again'); return 2;
      }
    } catch { /* absent: fine */ }
  }

  // 1.1 §12–17 — discovery and sealing run through the project adapters: EVERY
  // ecosystem that declares checks at the repo root contributes to ONE plan.
  // Node steps retain their 1.0 shape; new discovery builds before tests.
  // Existing stored plans keep their sealed order. The empty
  // plan stays a complete answer that becomes NEEDS ATTENTION, never READY.
  const composed = composePlan(root);
  // §B: a scope declaration Amabie cannot honour stops setup. It is never
  // partially applied, and never quietly reduced to the scopes that happened to
  // be fine — the human asked for these checks, so shipping a plan without them
  // silently would be exactly the failure this feature exists to prevent.
  if (composed.problems.length) {
    if (setupArgs.check) return setupCheckResult(o, root, [], detectHarnesses(root).found.map((h) => ({ name: h.name, supported: h.supported })), composed.problems, 'fix the scope declaration, then rerun: amabie setup --check');
    o.verdict('NEEDS ATTENTION', `the nested-scope declaration (${SCOPES_FILE}) is not usable: ${composed.problems.join('; ')}.`, `fix ${SCOPES_FILE} (or delete it to go back to root-only discovery), then run setup again`);
    return 2;
  }
  if (composed.scopes.length === 0) {
    if (setupArgs.check) return setupCheckResult(o, root, [], detectHarnesses(root).found.map((h) => ({ name: h.name, supported: h.supported })), ['no supported project declaration was found'], 'declare a supported project check, then rerun: amabie setup --check');
    o.verdict('UNSUPPORTED', `${root} is a git repo, but Amabie found no project it can model at its root (looked for package.json, pyproject.toml / setup.py / tox.ini, Cargo.toml, go.mod / go.work).`, `if your checks live in subdirectories, declare them in ${SCOPES_FILE} (e.g. { "schema": "${SCOPES_SCHEMA}", "scopes": [{ "path": "web", "ecosystem": "node" }] }), then run setup again`);
    return 2;
  }
  const rootScope = composed.scopes.find((s) => s.scope === '');
  const rootDisc = rootScope ? planForScope(root, rootScope) : null;
  // pinning happens HERE, at the human-authorized moment, and what gets sealed
  // is the absolute path — never a name that a later PATH could re-point
  const pin = pinPlanPrograms(composed.plan, root);
  if (pin.problems.length) {
    if (setupArgs.check) return setupCheckResult(o, root, [], detectHarnesses(root).found.map((h) => ({ name: h.name, supported: h.supported })), pin.problems, 'install or explicitly locate the required program, then rerun: amabie setup --check');
    o.verdict('NEEDS ATTENTION', `Amabie could not pin a program these checks need: ${pin.problems.join('; ')}.`, 'install it (or declare its absolute path in the project), then run setup again'); return 2;
  }
  const plan = pin.plan;
  const pm = rootDisc?.pm ?? composed.scopes[0]!.adapter.id;
  const note = rootDisc?.note ?? composed.notes.join('; ');
  const prev = readConfig(root);
  const prevUsable = !!prev && prev !== 'corrupt' && (
    !untrustedConfigReason(root, prev)
    || (retiredPackageCliPath(prev.cliPath) && configTracked(root) !== true)
  );
  const setupPrevCfg = prevUsable ? prev as AmabieConfig : null;
  const mcpProfile: McpProfile = setupArgs.profile ?? setupPrevCfg?.mcpProfile ?? 'everyday';
  const hookPreflightHarnesses = detectHarnesses(root);
  const hookPreflightCommand = buildHookCommand(CLI_ENTRY);
  const priorClaudeHooks = new Set<string>(setupPrevCfg ? [...setupPrevCfg.hookCommands, setupPrevCfg.hookCommand] : []);
  const priorStartupHooks = new Set<string>(setupPrevCfg?.sessionStartCommands ?? []);
  const priorCodexHooks = new Set<string>(setupPrevCfg?.codexHookCommands ?? []);
  const foreignHooks = hookPreflightCommand
    ? findForeignAmabieHooks(
      root,
      hookPreflightCommand,
      hookPreflightHarnesses.integrables.some((h) => h.name === 'claude-code'),
      hookPreflightHarnesses.integrables.some((h) => h.name === 'codex'),
      priorClaudeHooks,
      priorStartupHooks,
      priorCodexHooks,
    )
    : [];
  let seal: PlanAuthority;
  try {
    // Validate the same declarations for --check and the actual setup. A Node
    // root must not hide the universal manifest that bind writes alongside it.
    const universal = readUniversalManifest(root);
    if (universal.problems.length) throw new Error(universal.problems.join('; '));
    const amabieBlock = rootDisc?.source.amabie as { proofs?: unknown; paths?: unknown } | undefined;
    const proofs: Record<string, unknown> = Object.create(null);
    for (const declared of [amabieBlock?.proofs, universal.manifest?.proofs]) {
      if (declared === undefined) continue;
      if (!isRecord(declared)) throw new Error('proofs must be an object mapping requirement digests to checks');
      for (const [digest, check] of Object.entries(declared)) {
        if (Object.hasOwn(proofs, digest) && proofs[digest] !== check) {
          throw new Error(`conflicting proof bindings for requirement ${digest}`);
        }
        proofs[digest] = check;
      }
    }
    // One seal and its existing validation still cover the complete plan;
    // neither a duplicate declaration nor a declaration alone grants authority.
    seal = sealPlanAuthority(plan, planScriptTexts(root, plan, (rootDisc?.source.scripts ?? {}) as Record<string, unknown>),
      proofs, amabieBlock?.paths);
  } catch (e) {
    const problem = (e as Error).message;
    if (setupArgs.check) return setupCheckResult(o, root, [], detectHarnesses(root).found.map((h) => ({ name: h.name, supported: h.supported })),
      [problem], 'fix the proof or check declaration, then rerun: amabie setup --check');
    o.detail(`the declaration was refused: ${problem}`);
    o.verdict('NEEDS ATTENTION', 'Amabie could not record which checks to run here, so it will not wire this repository. Nothing was changed.', 'run: amabie setup --verbose to see the exact declaration that was refused'); return 2;
  }
  if (setupArgs.check) {
    const harnesses = detectHarnesses(root);
    const issues: string[] = [];
    if (plan.length === 0) issues.push('no executable verification checks were discovered');
    if (!harnesses.integrable) issues.push('no supported agent harness was detected');
    const hookCommand = buildHookCommand(CLI_ENTRY);
    if (hookCommand === null && harnesses.integrables.some((h) => h.name === 'claude-code' || h.name === 'codex')) {
      issues.push('Amabie cannot safely embed this CLI path in a hook command; move the installation to a path without shell expansion characters');
    }
    if (foreignHooks.length) issues.push('Amabie hooks from another installation are already present: ' + foreignHooks.join('; '));
    if (hookCommand && harnesses.integrables.some((h) => h.name === 'claude-code')) {
      const checkHook = installClaudeHooks(root, hookCommand, new Set(setupPrevCfg?.hookCommands ?? []), path.join(root, CONFIG_DIR, 'backups'), true, new Set(setupPrevCfg?.sessionStartCommands ?? []));
      if (!checkHook.ok) issues.push(`Claude Code hook: ${checkHook.problem}`);
    }
    if (hookCommand && harnesses.integrables.some((h) => h.name === 'codex')) {
      const checkHook = installCodexStopHook(root, hookCommand, new Set(setupPrevCfg?.codexHookCommands ?? []), path.join(root, CONFIG_DIR, 'backups'), true);
      if (!checkHook.ok) issues.push(`Codex hook: ${checkHook.problem}`);
    }
    const checkMcp = installMcpServer(root, CLI_ENTRY, new Set(setupPrevCfg?.mcpArgSignatures ?? []), path.join(root, CONFIG_DIR, 'backups'), mcpProfile, true);
    if (!checkMcp.ok) issues.push(`MCP tools: ${checkMcp.problem}`);
    const planRows = plan.map((step, index) => ({
      kind: step.kind,
      display: stepDisplay(pm, step),
      executable: pin.plan[index]!.argv?.[0] ?? pm,
    }));
    return setupCheckResult(o, root, planRows, harnesses.found.map((h) => ({ name: h.name, supported: h.supported })), issues,
      issues.length ? 'resolve the listed setup issue, then rerun: amabie setup --check' : `to install and run these checks: amabie setup --mcp-profile ${mcpProfile}`);
  }

  o.say(`repo: ${root}`);
  o.say(`package manager: ${pm} (${note})`);
  if (!plan.length) {
    // v1.4 §D — TWO fixes here, both disclosure, neither discovery.
    //
    // (1) The old message listed only Node/Python/Rust/Go and so UNDERSTATED what Amabie reads:
    //     the universal contract (Makefile / Taskfile / Justfile target, a shipped gradlew or
    //     mvnw wrapper, a configured CMake / Meson / Zig / Swift / Elixir / Crystal / Rake /
    //     Composer / PHPUnit project, or a check the project's CI already runs) is real
    //     discovery (universal.ts:404-565). A repository using it must not be told it declares
    //     nothing recognizable.
    //
    // (2) When the universal adapter finds two EQUALLY-anchored checks for one kind it returns
    //     ZERO checks plus the single line that resolves the situation — it refuses to choose
    //     (universal.ts:554). That line arrives here as `composed.empty`, and this early return
    //     used to discard it, leaving the user with a generic refusal and no way to act. It is
    //     printed first now. Nothing about discovery or authority changes: this only says out
    //     loud what Amabie already knew.
    for (const e of composed.empty) o.say(`  · declared no checks — ${e}`);
    o.verdict('NEEDS ATTENTION',
      'this project declares no check Amabie recognizes — a statement about what is DECLARED here, not about your stack. Amabie reads: Node package.json scripts (test / typecheck / type-check / build / bench / benchmark / e2e / test:e2e); Python (pytest, tox, unittest, or mypy / pyright / ruff); Rust (Cargo.toml); Go (go.mod / go.work); and the universal contract — a Makefile, Taskfile or Justfile target, a shipped gradlew or mvnw wrapper, a configured CMake, Meson, Zig, Swift, Elixir, Crystal, Rake, Composer or PHPUnit project, or a check your CI configuration already runs.',
      `${starterPath(root, composed.scopes.map((s) => s.adapter.id))}; then run: amabie setup`); return 2;
  }
  o.say('verification plan (from what this project already declares — Amabie runs only your own checks; change them in their own files):');
  for (const s of plan) o.say(`  ✓ [${stepKey(s)}] ${s.kind}: ${stepDisplay(pm, s)}`);
  for (const e of composed.empty) o.say(`  · declared no checks — ${e}`);

  const { found, integrable, integrables } = detectHarnesses(root);
  for (const h of found) o.say(`harness: ${h.label} — ${h.action}`);
  if (!integrable) {
    o.verdict('NEEDS ATTENTION', 'no supported AI harness detected (Claude Code and OpenAI Codex CLI are supported today; others get an explicit message, not a fake integration).', 'install Claude Code or OpenAI Codex CLI (or open the project inside one), then run setup again'); return 2;
  }
  // v1.4 §C: EVERY integrable harness present is wired, not just the first. Both of them run the
  // same `checkpoint`, so this is two pieces of wiring over one verification implementation.
  const wantsClaude = integrables.some((h) => h.name === 'claude-code');
  const wantsCodex = integrables.some((h) => h.name === 'codex');

  const hookCommand = buildHookCommand(CLI_ENTRY);
  if (!hookCommand) {
    o.verdict('NEEDS ATTENTION', 'the Amabie installation path contains characters a hook shell could expand or execute.', 'reinstall Amabie to a path without quotes, line breaks or shell expansion characters, then run setup again'); return 2;
  }
  if (foreignHooks.length) {
    o.verdict('NEEDS ATTENTION',
      'a hook from another Amabie installation is already present. Setup will not stack another completion hook or rewrite an entry this installation does not own.',
      "the entry most likely came from another machine's committed copy of this file (it records that machine's absolute path): remove that exact entry, or remove the hook with the installation that wrote it, then run amabie setup again. Keep these files out of git so it does not return (.git/info/exclude)");
    for (const entry of foreignHooks) o.say('  - ' + entry);
    return 2;
  }

  // read prior config (self-heal: reuse recorded hook commands for dedupe)
  // `prev` was read before the no-write setup check above; use that same snapshot.
  if (prev === 'corrupt') o.detail('previous .amabie config was unreadable — it will be rewritten');
  // only THIS installation's own record may seed hook-command dedupe — a cloned
  // config must never teach setup which user entries to strip (S1)
  const priorCommands = new Set<string>(prevUsable ? [...(prev as AmabieConfig).hookCommands, (prev as AmabieConfig).hookCommand] : []);
  const priorStartupCommands = new Set<string>(prevUsable ? ((prev as AmabieConfig).sessionStartCommands ?? []) : []);
  // The Codex ownership record is separate on purpose: `.codex/hooks.json` may only be pruned by
  // the commands this installation recorded for THAT file.
  const priorCodexCommands = new Set<string>(prevUsable ? ((prev as AmabieConfig).codexHookCommands ?? []) : []);
  // Preflight every target before the first hook is written. A malformed later
  // config must not leave an earlier harness wired without a usable Amabie config.
  const backupsDir = path.join(root, CONFIG_DIR, 'backups');
  const priorMcp = new Set<string>(prevUsable ? ((prev as AmabieConfig).mcpArgSignatures ?? []) : []);
  const preflight = [
    ...(wantsClaude ? [installClaudeHooks(root, hookCommand, priorCommands, backupsDir, true, priorStartupCommands)] : []),
    ...(wantsCodex ? [installCodexStopHook(root, hookCommand, priorCodexCommands, backupsDir, true)] : []),
    installMcpServer(root, CLI_ENTRY, priorMcp, backupsDir, mcpProfile, true),
  ].find((result) => !result.ok);
  if (preflight) {
    o.verdict('NEEDS ATTENTION', `setup could not prepare every hook and MCP file: ${preflight.problem}`, 'resolve the listed file issue, then run setup again; no harness settings were changed');
    return 2;
  }
  try { ensureAmabieSelfIgnore(root); } catch (e) {
    o.verdict('NEEDS ATTENTION', `could not prepare Amabie's local state (${String(e).slice(0, 140)}). This run verified NOTHING: no project checks were run.`, 'make .amabie writable, then run setup again; no harness settings were changed');
    return 2;
  }
  const setupSnapshots = new Map<string, SetupFileSnapshot>();

  if (wantsClaude) snapshotSetupFile(setupSnapshots, settingsPath(root));
  const res = wantsClaude ? installClaudeHooks(root, hookCommand, priorCommands, backupsDir, false, priorStartupCommands) : null;
  if (res && !res.ok) { o.verdict('NEEDS ATTENTION', `could not configure Claude Code safely: ${res.problem} ${setupRollbackNote(setupSnapshots)}`, 'fix that file, then run setup again'); return 2; }
  rememberSetupWrite(setupSnapshots, res?.touched?.path);
  if (wantsCodex) snapshotSetupFile(setupSnapshots, codexHooksPath(root));
  const codex = wantsCodex ? installCodexStopHook(root, hookCommand, priorCodexCommands, backupsDir) : null;
  if (codex && !codex.ok) { o.verdict('NEEDS ATTENTION', `could not configure OpenAI Codex CLI safely: ${codex.problem} ${setupRollbackNote(setupSnapshots)}`, 'fix that file, then run setup again'); return 2; }
  rememberSetupWrite(setupSnapshots, codex?.touched?.path);
  // v1.3 §C: the same agent should be able to ASK Amabie instead of guessing. This is what turns
  // "the gate speaks at the end" into "the agent can check while it works", with the same write
  // discipline as the hook above and no new authority (mcp.ts exposes only request tools).
  snapshotSetupFile(setupSnapshots, mcpConfigPath(root));
  const mcp = installMcpServer(root, CLI_ENTRY, priorMcp, backupsDir, mcpProfile);
  if (!mcp.ok) { o.verdict('NEEDS ATTENTION', `could not register Amabie's tools for your agent safely: ${mcp.problem} ${setupRollbackNote(setupSnapshots)}`, 'fix that file, then run setup again'); return 2; }
  rememberSetupWrite(setupSnapshots, mcp.touched?.path);
  // M4 baseline: stamped NOW by Amabie's own probes. Honest label — "state when
  // Amabie was wired", not a claim about the agent's past. `dirty` measures
  // WORKER residue, so the one file Amabie itself just wrote (its managed
  // settings entry) is excluded from THIS stamp: setup's own wiring must not
  // permanently blind the repo to blame for later uncommitted deletions — M6
  // attribution relies on a clean baseline actually being reachable. candidate-
  // Identity itself stays untouched (M4-pinned semantics for bundles).
  const baselineId = candidateIdentity(root);
  const ownSettings = rel(root, settingsPath(root)).split(path.sep).join('/');
  const ownMcp = rel(root, mcpConfigPath(root)).split(path.sep).join('/');
  // v1.4 §C: a Codex hook file Amabie just wrote is Amabie's own wiring too, so it is excluded from
  // the stamp for exactly the same reason — otherwise wiring a second harness would mark every repo
  // dirty at setup and permanently blind the later deletion blame. Excluded only when it was written
  // in THIS run: a `.codex/hooks.json` the user authored is theirs, and the stamp must see it.
  const baselineExcludes = [
    `:(exclude)${ownSettings}`, `:(exclude)${ownMcp}`,
    ...(codex?.touched ? [`:(exclude)${rel(root, codexHooksPath(root)).split(path.sep).join('/')}`] : []),
  ];
  const baselineStatus = gitWithinRoot(root, ['status', '--porcelain', '--', '.', ...baselineExcludes]);
  // M5: whatever plan and script texts are on disk RIGHT NOW are what the
  // setup run is now sealing — they become the sealed authority.

  // A re-setup under byte-identical authority keeps the ORIGINAL stamps:
  // installedAt and planAuthority.at record WHEN THESE BYTES WERE LAST
  // GENUINELY RE-SEALED by a setup run,
  // not when the command was last typed — so re-running setup on a connected
  // repo is CORE-state idempotent (no spurious config churn for re-entry).
  // Any real change (plan shape, script text, HEAD) re-stamps honestly, which
  // is what a genuine re-seal means. prevUsable already proved this config is
  // this installation's own trust, so reusing its fields is self-reference,
  // never a clone's word.
  const prevCfg = prevUsable && prev ? prev as AmabieConfig : null;
  const prevAuth = prevCfg?.planAuthority;
  const reuse = prevCfg && prevAuth && prevCfg.pm === pm
    && prevAuth.planDigest === seal.planDigest
    && JSON.stringify(prevAuth.scriptDigests) === JSON.stringify(seal.scriptDigests)
    && JSON.stringify(prevAuth.proofBindings ?? {}) === JSON.stringify(seal.proofBindings ?? {})
    && prevCfg.baseline?.head === baselineId.head ? prevCfg : null;
  const cfg: AmabieConfig = {
    version: 'product-0.1', installedAt: reuse?.installedAt ?? new Date().toISOString(), pm, plan,
    baseline: {
      at: reuse?.baseline?.at ?? new Date().toISOString(), ...baselineId,
      dirty: baselineStatus === null ? baselineId.dirty : baselineStatus.trim().length > 0,
    },
    planAuthority: reuse?.planAuthority ?? seal,
    /**
     * v1.5 BLOCKER 6. `dirs` is AUTHORITY (only what the operator named, sealed so a later ambient
     * PATH edit changes nothing); `found` is EVIDENCE — where THIS machine's PATH resolved each common
     * toolchain program at this moment, which is what lets a later failure say "your environment had
     * git at C:\...\cmd when Amabie was set up — authorize that directory" instead of a bare command
     * the operator has to finish themselves. Nothing is ever executed from `found`.
     *
     * The record is REUSED byte-for-byte when the authorized set did not change, the same idempotence
     * rule `planAuthority` follows above: re-running setup on a connected repo must not churn the
     * config. `--clear-toolchain-dirs` is the explicit revocation (silently dropping authority a human
     * granted is the failure this repository treats as worse than a refusal).
     */
    toolchain: ((): ToolchainSeal => {
      const prevSeal = prevCfg?.toolchain;
      const dirs = toolchainArgs.clear
        ? toolchainDirs
        : (toolchainDirs.length > 0 ? toolchainDirs : (prevSeal?.dirs ?? []));
      if (prevSeal !== undefined && JSON.stringify(prevSeal.dirs) === JSON.stringify(dirs)) return prevSeal;
      return { dirs, found: inventoryOperatorToolchain(process.env.PATH ?? ''), at: new Date().toISOString() };
    })(),
    cliPath: CLI_ENTRY, hookCommand,
    hookCommands: [...new Set([hookCommand, ...priorCommands])],
    ...(res?.touched ? { sessionStartCommands: [...new Set([`${hookCommand} --session-start`, ...priorStartupCommands])] } : {}),
    // Absent when Codex is not wired here, so a Claude-only setup keeps writing byte-identical config.
    ...(codex?.touched ? { codexHookCommands: [...new Set([hookCommand, ...priorCodexCommands])] } : {}),
    mcpProfile,
    mcpArgSignatures: [...new Set([mcpArgSignature(mcpServerArgs(CLI_ENTRY, mcpProfile)), ...priorMcp])],
    touched: [...(res?.touched ? [res.touched] : []), ...(codex?.touched ? [codex.touched] : []), mcp.touched!],
  };
  // 1.1 P0 — the authority gets a SEALED COPY outside the repo before any repo
  // write of this run lands: a store that cannot mint means no config, so the
  // project is never left with in-repo-only authority that silently looks
  // sealed. Every setup re-seals (the store's seq ledger advances); the in-repo
  // bytes stay byte-identical to v1.0 — the store is a mirror that DETECTS
  // divergence, and probeTrustLevel says its level honestly below.
  const store = storeFromEnv();
  const projectId = projectIdForRoot(root);
  try {
    sealRecord(store, { projectId, kind: 'registration', amabieVersion: AMABIE_VERSION, payload: { root: canonicalPath(root), pm, adapter: composed.scopes.map((s) => s.adapter.id).join('+') } });
    sealRecord(store, { projectId, kind: 'plan-seal', amabieVersion: AMABIE_VERSION, payload: cfg.planAuthority });
    // Names only, outside the repo; `--clear-pass-env` is the revocation and a plain re-run keeps what a human allowed.
    if (passArgs.clear || passArgs.names.length > 0) sealPassEnvNames(root, passArgs.clear ? passArgs.names : [...sealedPassEnvNames(root), ...passArgs.names], store);
  } catch (e) {
    // v1.4 §E — translated for the everyday path. Same refusal, same exit code, same actionable
    // next step; the ordinary user is no longer asked to know what "sealing authority" means.
    // The raw reason moves behind --verbose, where the detail belongs.
    o.detail(`the trust store refused the record: ${String((e as Error).message ?? e).slice(0, 140)}`);
    o.verdict('NEEDS ATTENTION', `Amabie could not store its verification record on this machine, so it will not finish setting this repository up. This run verified NOTHING: no project checks were run. ${setupRollbackNote(setupSnapshots)}`, `make ${store.root} writable by you (or point AMABIE_TRUST_STORE at an empty directory), then run setup again`);
    return 2;
  }
  try {
    writeConfig(root, cfg);
  } catch (e) {
    // An installed hook without its config would leave this repo wired but
    // unprotected. Restore the exact prior settings bytes before reporting it.
    o.verdict('NEEDS ATTENTION', `could not write the .amabie config (${String(e).slice(0, 140)}). This run verified NOTHING: no project checks were run. ${setupRollbackNote(setupSnapshots)}`, 'close whatever holds the file, then run setup again');
    return 2;
  }
  // M9 §9.5 — a deliberate setup re-run IS the clearing act. A caught
  // in-window tampering quarantines the base (verify/promote refuse until
  // re-seal); a fresh writeConfig + re-installed hook means these bytes were
  // deliberately re-sealed, so the marker's debt is paid. Cleared only on success: if the
  // config write threw above, quarantine stands (fail-closed).
  try { fs.rmSync(path.join(root, CONFIG_DIR, QUARANTINE_FILE), { force: true }); } catch { /* absent is the common case */ }
  if (wantsClaude) o.say(`Claude Code will run Amabie automatically when the agent finishes a turn here.${prev && prev !== 'corrupt' ? ' (re-run: existing Amabie hook refreshed, no duplicates)' : ''}`);
  o.say(`MCP tools: ${mcpProfile} profile (${mcpProfile === 'everyday' ? '4 everyday tools' : '4 everyday tools plus 3 expert tools: agents, work, finish'}).`);
  if (codex?.touched) {
    /**
     * v1.4 §C — THE TRUST REQUIREMENT IS SAID OUT LOUD, because it is the difference between a file
     * that gates and a file that sits there. Codex runs a non-managed hook only after the exact hook
     * definition has been reviewed and trusted (`/hooks`), and it records that trust against the
     * hook's current hash — so a freshly written hook does NOT gate anything yet, and Amabie cannot
     * take that step for the user. Saying nothing here would let "setup succeeded" read as
     * "completions are gated in Codex", which is exactly the overclaim this project exists to prevent.
     */
    o.say(`OpenAI Codex CLI will run Amabie when a turn ends here — the Stop hook is in ${rel(root, codexHooksPath(root))}.`);
    o.say('  Codex will NOT run it until you review and trust it once: run `codex` in this project, then `/hooks`, and trust the Amabie Stop hook. Until you do, a Codex completion is NOT gated.');
    // v1.5 §4B: the old line said WHAT to type and nothing else. A user approving a hook that can
    // interrupt their agent is owed the three remaining answers — what exactly is being approved,
    // what Amabie does and does not touch, and how to undo it — in the same breath as the ask.
    o.say('  What you are trusting is one command: `amabie checkpoint` — it runs the project checks listed above, and on a failure it can only send the agent back once to repair it; it never edits your files, never widens a permission, and touches no other Codex setting.');
    o.say('  Undo it any time with `amabie uninstall` (it removes exactly Amabie\'s own entries and keeps your own hooks).');
  }
  if (wantsClaude && codex?.touched) o.say('both harnesses are wired here: Claude Code gates completions as soon as this setup ends; Codex gates them once you trust the hook above.');
  // v1.3 §C: say plainly that a SECOND file was written, and what the agent gets from it. Silence
  // about a file Amabie just added to someone's repository would be the wrong kind of invisible.
  o.say(`agent tools: registered in ${rel(root, mcpConfigPath(root))} — your agent can now ask Amabie whether it is done, instead of guessing. Your other MCP servers are untouched; \`amabie uninstall\` removes exactly this entry.`);
  // v1.5 §4C — IS THIS SHARED, OR MINE? MEASURED in the clean-room first run: setup writes three
  // files that `git status` reports as TRACKED PROJECT files (a clone carries them), and one
  // directory that self-ignores. Nothing user-facing said which was which, and the recorded hook
  // command names an ABSOLUTE path on THIS machine — so a teammate receiving the entry verbatim
  // gets a command their machine cannot run — so they are per-machine, not for committing. One sentence.
  o.say(`  ${machineFilesNote(`${rel(root, mcpConfigPath(root))} and the harness hook files`)}`);
  // v1.3 §E, MEASURED with the real agent CLI (`claude mcp list` reports our entry as
  // "Pending approval"): the harness holds a project-scoped MCP server until a human approves it once.
  // That is one interactive step Amabie cannot take for you, so it is named here rather than left to
  // look like a broken integration.
  o.say(`  Claude Code asks you to approve a project's MCP server once — run \`claude\` there and approve it; until then the server is listed but its tools are not available.`);
  o.say('  If MCP approval is pending, the request hook supplies: amabie task "<intent>" --session <id>. Include each stated criterion with --requirement. No MCP approval is needed for this registration path.');
  o.detail('authority sealed: candidate edits to the verification surface block completion. Claude hooks protect operator commands and direct authority writes; CLI operator actions refuse known agent execution and require human terminal confirmation while a session is open. LOCAL still shares one OS user and cannot prevent arbitrary same-user bypasses. HARDENED is not installed here.');
  const level = probeTrustLevel(store);
  o.detail(`sealed authority copy: ${store.root} (project ${projectId}) — level ${level.level}: ${level.reasons.join(' ')}`);

  // smoke = run the plan for real (this is the proof the wiring works)
  const interactive = process.stdin.isTTY === true;
  if (!opts.yes && interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nRun these ${plan.length} project command(s) now as a smoke test? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (answer && answer !== 'y' && answer !== 'yes') {
      o.verdict('NEEDS ATTENTION', 'Amabie is installed here but was never executed — protection is wired, NOT yet verified.', 'run: amabie setup --yes (or: amabie doctor — it runs the checks)'); return 2;
    }
  }
  if (!opts.yes && !interactive) {
    // This branch used to write all of setup's state, then exit 2 demanding a
    // memorized "--yes" — installed-yet-unproven, every agent re-typed the flag.
    // It guards no real authority: whoever can invoke `amabie setup` can invoke
    // `amabie doctor`, which runs the SAME plan unasked and unconditionally
    // (READY is earned there, not from a handshake). Running the project's own
    // sealed checks now proves the wiring instead of demanding consent that the
    // command invocation already gave. A TTY is still asked first, above.
    o.detail('unattended (no TTY, no --yes): running the smoke test directly — wiring without execution would prove nothing.');
  }
  // v1.5 blocker 6: authority a human granted is authority the human is SHOWN, in the default output
  // and before the smoke test runs under it. (Deliberately not Amabie's internals vocabulary here —
  // the everyday path's word budget is a ratchet, see tooling/probes/v13-everyday-vocabulary.mjs.)
  const effectiveToolchainDirs = cfg.toolchain?.dirs ?? [];
  if (effectiveToolchainDirs.length > 0) {
    o.say(`toolchain: ${effectiveToolchainDirs.length} executable director${effectiveToolchainDirs.length === 1 ? 'y' : 'ies'} you authorized${toolchainDirs.length > 0 ? '' : ' (kept from the previous setup)'} — appended AFTER Amabie's own trusted directories, never your shell's PATH:`);
    for (const d of effectiveToolchainDirs) o.say(`  + ${d}`);
    o.say('  the plan\'s own program is still pinned to an absolute path; these directories exist for what your check spawns itself. Revoke with: amabie setup --clear-toolchain-dirs');
  }
  const passedNames = sealedPassEnvNames(root);
  if (passedNames.length > 0) {
    o.say(`environment: ${passedNames.length} variable${passedNames.length === 1 ? '' : 's'} you allowed reach${passedNames.length === 1 ? 'es' : ''} your checks by name (${passedNames.join(', ')}); only the names are stored; values are read from your shell when checks run, and an exact copy of a value (6+ characters) that a check prints is masked in Amabie's log and evidence. Revoke with: amabie setup --clear-pass-env`);
  }
  o.say('\nsmoke test (running your own project scripts):');
  let allOk = true;
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  for (const s of planWithFreshTests(plan)) {
    // A pm that cannot be resolved in the TRUSTED environment is an
    // environment truth, not a project failure — report it as a step that
    // could not run (exitCode null) instead of crashing the whole setup.
    let r: StepResult;
    try { r = runPlanStep(root, pm, s); } catch (e) { r = unresolvedStep(root, pm, s, e); }
    ran.push(r);
    o.step(r);
    if (!r.ok) { allOk = false; failed.push(r); }
    if (r.exitCode === null) break;
  }
  const setupEvidence = writeVerificationBundle(root, 'setup', ran, allOk ? 'pass' : 'fail', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null });
  writeCheckpoint(root, allOk ? 'pass' : 'fail', failed.map((f) => f.kind), 'setup', {
    checks: ran, hookResponse: 'not-applicable', evidencePath: setupEvidence ?? undefined,
  });
  if (allOk) {
    /**
     * A GREEN PLAN IS NOT A PROVEN TASK — DO NOT SAY READY WHILE A REGISTERED REQUIREMENT IS UNBOUND.
     *
     * MEASURED friction this closes (v1.2 recon): `setup` never evaluated obligations, so it could
     * print READY on a repository where `doctor` — seconds later, same bytes — printed NOT PROVEN.
     * An operator reading READY reasonably concludes the task is covered, and the contradiction is
     * then discovered at the END of a worker's session, which is where the measured 1.5-1.85M-token
     * loops came from.
     *
     * The honest ending depends on what is registered: with no outstanding duty the wiring really is
     * fresh and READY is right; with requirements that no sealed check measures, saying so HERE costs
     * one sentence and saves the whole loop. Exit stays 0 — this IS a successful setup, and the
     * requirement state is reported rather than turned into a failure.
    */
    const unbound = unboundRequirements(root, cfg);
    const unboundRequirementCount = unbound.unbound.filter((item) => item.source === 'requirement').length;
    const unboundTargetCount = unbound.unbound.length - unboundRequirementCount;
    if (unbound.unbound.length > 0 && !unbound.subjective) {
      // v1.4 §E — the summary sentence is translated for the everyday path (same fact, same exit
      // code 0, same operator decision). The two lines BELOW it are left byte-exact on purpose:
      // `unbound: <digest>` and `available to bind:` are parsed by
      // tooling/probes/v12-requirement-unbound.mjs, and a message an operator workflow reads is a
      // contract, not prose.
      const missing = [
        ...(unboundRequirementCount ? [`you registered ${unboundRequirementCount} requirement(s) that no check here measures yet`] : []),
        ...(unboundTargetCount ? [`${unboundTargetCount} objective target(s) lack a matching sealed proof`] : []),
      ];
      o.say(`note: ${missing.join('; ')}, so finishing will be reported as NOT PROVEN until each is covered.`);
      for (const item of unbound.unbound) {
        o.say(item.source === 'requirement' ? `  unbound: ${item.digest}` : `  unbound objective target (${item.targetKind}): ${item.digest}`);
      }
      o.say(`  sealed plan script(s) available to bind: ${unbound.planScripts.length > 0 ? unbound.planScripts.join(', ') : '(none)'}`);
      o.say('  the wiring here is ready, but the TASK is not: the operator can run amabie bind <matching sealed script> --requirement "<exact task or requirement text>" --reseal. Until then `amabie doctor` will say NOT PROVEN — that is the same fact, not a second problem.');
    } else if (unbound.unbound.length > 0) {
      // v1.5 §4D — MEASURED (clean-room first run, requirement on a subjective intent): the branch
      // above is suppressed when Amabie reads the requirement as SUBJECTIVE, because its "reported
      // as NOT PROVEN until one does" clause would be false there. The side effect was that setup
      // ended in READY with an open registered duty and NO mention of it, while the very next
      // `amabie doctor` answered NOT PROVEN — the user met the block with no warning. This says the
      // fact that is true in that case and names where the exact next step is printed. No exit code,
      // no verdict and no gate changes; READY still means what it meant.
      o.say(`note: you registered ${unbound.unbound.length} requirement(s) that no machine check here measures — a completion cannot be reported as PROVEN on those; the exact next step for each is printed by: amabie doctor`);
    } else if ((readTaskRecord(root)?.requirementCount ?? 0) === 0) {
      // READY means the harness and its sealed checks work. Without this note, the
      // first-run summary can sound like Amabie also assessed acceptance criteria
      // that were never supplied.
      o.say('note: no task acceptance criteria are registered. READY means these checks and hooks are set up; Amabie cannot assess requirements it was never given.');
      o.say('  for task checks, add measurable requirements with `amabie task --requirement "<behavior>"`, then bind them to an existing check with `amabie bind <script> --requirement "<same>" --reseal` (commits and reruns setup).');
    }
    o.verdict('READY', 'Amabie is active here: it will run these checks whenever the AI agent says it is done, and will interrupt the human only when something needs them.', `try it: break a test on purpose and let the agent finish — Amabie will say so. doctor: amabie doctor`);
    return 0;
  }
  // v1.5 BLOCKER 6 — WHO IS ACTUALLY AT FAULT, MEASURED RATHER THAN ASSUMED.
  //
  // This line used to say "That is your project talking, not Amabie." whenever no step had exited
  // `null`, and the auditor reproduced exactly what that costs: on the audited commit a clean project
  // whose check is `npm test` → `java -version` passes OUTSIDE Amabie and fails INSIDE it, because a
  // step child gets PATH = the Node install dir + the OS dirs (12 entries against the shell's 41,
  // `java`/`python`/`git` invisible, JAVA_HOME absent). The attribution was FALSE, and a false
  // attribution is worse than a vague one: it sent the operator to fix a project that was fine.
  //
  // The two outcomes now have different words, and the environment one is only ever printed when the
  // environment was MEASURED to be missing the program the child named (see attributeStepFailure).
  // The verdict, the exit code and the checkpoint are unchanged: a failing check still fails.
  const attribution = attributeRunFailures(root, cfg, failed, plan);
  o.verdict('NEEDS ATTENTION', attribution.reason,
    `${attribution.next}${setupEvidence ? `; full output: ${setupEvidence}` : ''}`);
  return 2;
}
