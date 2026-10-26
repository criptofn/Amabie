import fs from 'node:fs';
import path from 'node:path';
import { adapterForStep, parseJsonOrNull, planAuthorityDrift, planProblemsForConfig } from './project.js';
import { openSealed, probeTrustLevelReadOnly, storeFromEnv, projectIdForRoot } from './trust-store.js';
import { providerConfigured } from './provider/boundary.js';
import { providerStatus } from './provider/service.js';
import { measuredCapabilities } from './platform-boundary.js';
import { canonicalJson } from '@amabie/hashing';
import { vanishedToolchainDirs } from './check-runner.js';
import { resolvePm, spawnHardened } from './execution-environment.js';
import { detectHarnesses, hasAmabieEntry, ownedCommandsFor } from './harness-hooks.js';
import { type AmabieConfig, readConfig, untrustedConfigReason } from './local-config.js';
import { rel } from './local-files.js';
import { hasMcpEntry } from './mcp-registration.js';

// The config-trust checks doctor performs BEFORE it spends anything on a plan
// run. Extracted verbatim (single owner) so `amabie status` can answer "is
// this repo's wiring sound?" with zero PROJECT commands executed and zero
// writes (a couple of read-only git metadata probes are still made — that is
// the honest measured shape; see the usage text).
// livePmProbe=false (status) SKIPS the pm liveness check entirely: it is a
// statement about state, and liveness is only worth a spawn to whoever is
// about to EXECUTE (doctor). The probe that doctor does make is the SAME
// hardened resolution+environment the plan itself will run under — never a
// PATH lookup the old inherited-env `--version` allowed to be a liar shim.
export function packageManagerProbeProblem(runner: string, probeError?: Error | null): string {
  if (probeError?.message === 'post-run containment sweep could not confirm zero surviving descendants') {
    return `Amabie could not confirm descendant cleanup after probing "${runner}"; it rejected the probe result`;
  }
  return `package manager "${runner}" is not runnable in Amabie's trusted environment (running Node's install dir, corepack, or OS-managed dirs only — the calling PATH is deliberately ignored)`;
}

export function readOnlyProblems(root: string, cfg: AmabieConfig, livePmProbe: boolean): string[] {
  const problems: string[] = [];
  if (!Array.isArray(cfg.plan) || cfg.plan.length === 0) problems.push('the verification plan is empty — Amabie would have nothing to check (a pass here would be fake)');
  // v1.5 blocker 6: an operator-authorized toolchain directory that has since vanished is an
  // ENVIRONMENT fact Amabie must report before it executes anything — and it is named as Amabie's
  // own restriction, never as a project problem.
  for (const gone of vanishedToolchainDirs(root)) {
    problems.push(`the toolchain directory sealed at setup is gone: ${gone} — your checks run with the directories Amabie sealed (never your shell's PATH), so anything that lived there cannot resolve. Re-authorize it: amabie setup --toolchain-dir "<where it is now>"`);
  }
  // 1.1 §12–17 — each step is answered for by its OWN adapter in its OWN scope,
  // so a Python step is never judged against package.json. For a 1.0 config
  // every step resolves to the Node adapter and this yields the same list.
  const envSeen = new Set<string>();
  for (const step of cfg.plan) {
    const stepAdapter = adapterForStep(cfg, step);
    const runner = step.argv !== undefined ? stepAdapter.id : (step.pm ?? cfg.pm);
    const key = `${stepAdapter.id}:${runner}`;
    if (envSeen.has(key)) continue;
    envSeen.add(key);
    const envProblem = stepAdapter.validateEnvironment(runner);
    if (envProblem) problems.push(envProblem);
  }
  if (livePmProbe) {
    // A script step is proved live exactly as the plan will run it (resolved
    // package manager, one hardened spawn). An explicit step is proved live by
    // its sealed ABSOLUTE program existing. Neither is a PATH lookup.
    const legacyRunners = new Set(cfg.plan.filter((s) => s.argv === undefined).map((s) => s.pm ?? cfg.pm));
    for (const runner of legacyRunners) {
      const resolved = resolvePm(runner);
      const probe = resolved ? spawnHardened(resolved, ['--version'], root, 30_000) : null;
      if (probe === null || probe.status !== 0 || probe.error) {
        problems.push(packageManagerProbeProblem(runner, probe?.error));
      }
    }
    for (const step of cfg.plan) {
      if (step.argv === undefined) continue;
      const program = step.argv[0] as string;
      if (!path.isAbsolute(program)) {
        problems.push(`the sealed check "${step.script}" names "${program}" instead of an absolute path — re-run setup so the toolchain is pinned (Amabie never resolves a verification program through PATH)`);
      } else if (!fs.existsSync(program)) {
        problems.push(`the sealed program for "${step.script}" is missing here: ${program} — install it, or re-run setup`);
      }
    }
  }
  // 1.1 §1 — the plan-existence and authority-drift questions are adapter
  // questions (same strings, live-disk reads; a swapped manifest between the
  // two reads can only ever ADD problems, never certify).
  problems.push(...planProblemsForConfig(root, cfg, cfg.plan));
  // M5: a sealed authority that drifted is a problem REGARDLESS of whether the
  // current commands pass — doctor must not certify READY on proof it never sealed.
  const drift = planAuthorityDrift(root, cfg);
  if (drift) problems.push(`verification authority changed since setup — ${drift}; restore the sealed checks, or re-run setup to re-seal deliberately`);
  if (!fs.existsSync(cfg.cliPath)) problems.push('the Amabie command files moved or were removed — reinstall, then re-run setup');
  for (const t of cfg.touched) {
    if (!fs.existsSync(t.path)) { problems.push(`${rel(root, t.path)} is missing — the harness hook is NOT registered, so nothing runs automatically`); continue; }
    const doc = parseJsonOrNull(t.path);
    if (!doc) { problems.push(`${rel(root, t.path)} is not valid JSON — fix it`); continue; }
    // v1.3 §C: an MCP entry is ours by argv signature, not by a command string; a file that is fine
    // for the hook check is not evidence about the server entry, so each kind asks its own question.
    // v1.4 §C: the Codex hooks file has the same SHAPE as the Claude one but its own ownership list.
    const owned = ownedCommandsFor(cfg, t.kind);
    const stopPresent = t.kind !== 'mcp' && hasAmabieEntry(doc, owned);
    const preToolPresent = t.kind !== 'mcp' && t.kind !== 'codex-hooks' && hasAmabieEntry(doc, owned, 'PreToolUse');
    const promptPresent = t.kind !== 'mcp' && t.kind !== 'codex-hooks' && hasAmabieEntry(doc, owned, 'UserPromptSubmit');
    const postToolPresent = t.kind !== 'mcp' && t.kind !== 'codex-hooks' && hasAmabieEntry(doc, owned, 'PostToolUse');
    const sessionEndPresent = t.kind !== 'mcp' && t.kind !== 'codex-hooks' && hasAmabieEntry(doc, owned, 'SessionEnd');
    const present = t.kind === 'mcp'
      ? hasMcpEntry(doc, new Set(cfg.mcpArgSignatures ?? []))
      : t.kind === 'codex-hooks' ? stopPresent : stopPresent && preToolPresent && promptPresent && postToolPresent && sessionEndPresent;
    if (!present) {
      problems.push(t.kind === 'mcp'
        ? `Amabie's agent tools are no longer registered in ${rel(root, t.path)} — the agent cannot ask Amabie whether it is done; re-run: amabie setup`
        : t.kind === 'codex-hooks'
          ? `Amabie's Codex Stop hook is no longer registered in ${rel(root, t.path)} — Codex completions are not gated; re-run: amabie setup`
          : !stopPresent
            ? `Amabie's Stop hook is no longer registered in ${rel(root, t.path)} — completions are not gated; re-run: amabie setup`
            : !preToolPresent
              ? `Amabie's PreToolUse task-intake guard is no longer registered in ${rel(root, t.path)} — project changes can proceed without a registered task; re-run: amabie setup`
              : !promptPresent
                ? `Amabie's UserPromptSubmit turn reset is no longer registered in ${rel(root, t.path)} — a previous task can satisfy the next request; re-run: amabie setup`
                : !postToolPresent
                  ? `Amabie's PostToolUse task registration is no longer registered in ${rel(root, t.path)} — current-request task registration cannot be confirmed; re-run: amabie setup`
                  : `Amabie's SessionEnd cleanup is no longer registered in ${rel(root, t.path)} — task-session state may remain on disk; re-run: amabie setup`);
    }
  }
  return problems;
}

/**
 * 1.1 P0 — the sealed-copy report, for `status` and `doctor` (verbose detail
 * lines). READ-ONLY and REPORT-ONLY by design: no verdict in this build
 * consumes it, so v1.0 outcomes are unchanged (gate K) — but a human who asks
 * "is what the repo claims also what the store sealed?" gets the measured
 * truth, including "there is no sealed copy yet" for legacy projects.
 */
/**
 * 1.1 §5/§21 — the measured custody level and the real harness capability, as
 * data. Both are REPORTED, never inferred: `probeTrustLevel` measures whether
 * this process can write the store (a same-uid writer means LOCAL, and
 * HARDENED is unreachable without a broker of a different identity), and a
 * harness that cannot gate is reported as not gating rather than as protection.
 */
export function securityCapability(): { level: 'HARDENED' | 'LOCAL' | 'ADVISORY' | 'UNSUPPORTED'; reasons: string[] } {
  try {
    // READ-ONLY: this feeds `status`, `result` and `agents`, all of which promise
    // to write nothing. The write-measuring probe belongs to setup/doctor, where
    // writing is already part of the job.
    const store = storeFromEnv();
    // v1.1 Phase 3 / v1.2 Mission 3: when a provider is CONFIGURED, the level is
    // the MEASURED one — HARDENED becomes reachable exactly when every boundary
    // control is derived from a fresh, signed, complete confined-caller
    // deployment measurement, and never because a provider is merely present.
    // With no provider installed this branch is skipped entirely, so the ordinary
    // answer stays byte-identical and costs no extra process spawns.
    if (providerConfigured(store)) {
      const status = providerStatus(store);
      const measured = measuredCapabilities(status.boundary);
      if (measured.level === 'HARDENED') {
        return {
          level: 'HARDENED',
          reasons: [
            `a confined-caller deployment was measured on ${status.boundary.platform} and every boundary control is present: `
            + `package ${status.confinement?.kind === 'win32-appcontainer-restricted-low' ? status.confinement.package : 'n/a'}, measured ${status.confinement?.kind === 'win32-appcontainer-restricted-low' ? status.confinement.measuredAt : 'n/a'}, `
            + `custody signature verified, all six controls with an unrestricted positive control and a real restricted attack`,
          ],
        };
      }
      return { level: measured.level, reasons: status.unavailable };
    }
    return probeTrustLevelReadOnly(store);
  } catch (e) {
    return { level: 'UNSUPPORTED', reasons: [`the trust store could not be examined: ${String((e as Error).message ?? e)}`] };
  }
}

/** Which harnesses are present here, and whether each can actually gate an
 *  agent's completion. `gated: false` is a fact an agent must not misread. */
export function agentCapability(root: string): { harnesses: Array<{ id: string; label: string; gated: boolean; reason: string }>; hooked: boolean } {
  const { found, integrable } = detectHarnesses(root);
  return {
    harnesses: found.map((h) => ({ id: h.name, label: h.label, gated: h.supported, reason: h.action })),
    // v1.3, slice 1: `hooked` means A HOOK IS INSTALLED HERE — not "an agent we could hook is present".
    // Detection is a different question and it was answering this one; see gatingHookInstalled.
    hooked: integrable !== null && gatingHookInstalled(root),
  };
}

/**
 * v1.3, slice 1 — IS THE COMPLETION HOOK ACTUALLY INSTALLED IN THIS REPOSITORY?
 *
 * MEASURED (tooling/probes/v13-journey-baseline.mjs): on a repository whose `.claude/` directory held
 * nothing but a skill file — no `settings.json`, no hook — `amabie agents` printed
 * "CONNECTED — Claude Code can gate completions here." and exited 0, while `amabie status` on the
 * SAME bytes said "NOT CONNECTED … no config, no hooks, no proof" and exited 2. Two commands
 * contradicted each other, and the optimistic one was the successful one.
 *
 * The cause is a question substitution: detection answers "is this agent present?", for which
 * `.claude/` existing is enough — and on any machine with Claude Code installed, `~/.claude` exists,
 * so it is effectively always true — while the verdict was phrased as a claim that a completion can be
 * BLOCKED. Only the second question is a protection claim, and it has a definite answer that
 * `status`/`readOnlyProblems` already compute from the config and the settings files.
 *
 * This is that same evidence, exposed for the callers that phrase a verdict. It is READ-ONLY: no
 * spawn, no write, no verdict of its own — it reports whether Amabie's own hook entry is present in a
 * settings file Amabie manages, under a config Amabie still trusts.
 */
export function gatingHookInstalled(root: string): boolean {
  const cfg = readConfig(root);
  if (cfg === null || cfg === 'corrupt') return false;
  if (untrustedConfigReason(root, cfg)) return false;
  return cfg.touched.some((t) => {
    // v1.3 §C: an MCP server entry is not a completion hook; asking the hook question of that file
    // would be a category error, and the answer would be a false negative.
    if (t.kind === 'mcp') return false;
    if (!fs.existsSync(t.path)) return false;
    const doc = parseJsonOrNull(t.path);
    if (doc === null) return false;
    const owned = ownedCommandsFor(cfg, t.kind);
    return t.kind === 'codex-hooks'
      ? hasAmabieEntry(doc, owned)
      : hasAmabieEntry(doc, owned) && hasAmabieEntry(doc, owned, 'PreToolUse')
        && hasAmabieEntry(doc, owned, 'UserPromptSubmit') && hasAmabieEntry(doc, owned, 'PostToolUse')
        && hasAmabieEntry(doc, owned, 'SessionEnd');
  });
}

/** The checks as an agent needs them: what, which ecosystem, where, and the
 *  exact command. Never throws — a legacy step reports the command shape that
 *  will actually be built for it. */
export function protocolChecks(cfg: AmabieConfig): Array<{ kind: string; script: string; adapter: string; scope: string; argv: string[] }> {
  return cfg.plan.map((s) => ({
    kind: s.kind,
    script: s.script,
    adapter: s.adapter ?? cfg.project ?? 'node',
    scope: s.scope ?? '',
    argv: s.argv ?? [s.pm ?? cfg.pm, 'run', s.script],
  }));
}

/**
 * v1.5 audit finding (LOCAL root of trust) — WHO CHOSE WHAT IS CHECKED, on the surfaces a
 * user and an agent actually read.
 *
 * `LOCAL` says the records are written outside the repo. It does NOT say the writer was
 * somebody other than the worker: `amabie setup --yes` runs unattended and has never checked
 * the caller's identity, so any caller with this user's authority — the worker's own shell
 * included — can make a DIFFERENT plan and a different starting commit the ones that are
 * checked and then complete against them. That is expected onboarding behaviour at LOCAL, and
 * it is the whole reason `HARDENED` exists; reporting the level without saying who selected it
 * would be the overclaim. `HARDENED` is the worker-independent path and is unreachable without
 * a measured boundary.
 *
 * The wording deliberately uses none of the internals the everyday vocabulary ratchet budgets
 * (`tooling/probes/v13-everyday-vocabulary.mjs`), so this honest line costs the ordinary path
 * nothing.
 */
export function proofLevelLine(level: string): string {
  if (level === 'HARDENED') {
    return 'proof level: HARDENED — a measured boundary with a separate OS identity checks this work, so the worker cannot replace what judges it.';
  }
  return `proof level: ${level} — the same user account that runs the agent can also re-run \`amabie setup --yes\` and make a different plan and starting commit the ones that are checked, so this proof is same-user and operator-selected, NOT worker-independent. HARDENED is the level that adds a separate OS identity, and it is NOT available here.`;
}

export function sealedCopyReport(root: string, cfg: AmabieConfig): string {
  const store = storeFromEnv();
  let projectId: string, tail: string, level: string;
  try {
    projectId = projectIdForRoot(root);
    level = probeTrustLevelReadOnly(store).level;
    tail = ` (store ${store.root}, level ${level})`;
  } catch (e) {
    return `sealed copy: unreadable store — ${(e as Error).message}`;
  }
  const open = openSealed(store, { projectId, kind: 'plan-seal' });
  if (open.status === 'missing') return `sealed copy: none yet — this repo predates sealing or was set up elsewhere; run setup to seal it${tail}`;
  if (open.status !== 'valid') return `sealed copy: ${open.status.toUpperCase()} — ${open.reason}${tail}`;
  const same = !!cfg.planAuthority && canonicalJson(open.envelope!.payload) === canonicalJson(cfg.planAuthority);
  return same
    ? `sealed copy: store seq ${open.envelope!.seq} matches this config's sealed authority${tail}`
    : `sealed copy: MISMATCH — the .amabie config and the sealed record disagree; run setup to re-seal deliberately${tail}`;
}
