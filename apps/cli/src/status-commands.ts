import fs from 'node:fs';
import path from 'node:path';
import { parseJsonOrNull, planAuthorityDrift } from './project.js';
import { PROTOCOL_RESULT, type ProtocolIntegration } from './protocol.js';
import { AGENT_INTEGRATIONS, hasAdvisory, installAdvisory, removeAdvisory } from './agents.js';
import { Out, dirArg, parseGlobals } from './cli-output.js';
import { installedCliPrefix } from './cli-runtime.js';
import { codexHooksPath, detectHarnesses, findUnownedAmabieHookEntries, hasAmabieEntry, settingsPath, uninstallHooks } from './harness-hooks.js';
import { agentCapability, gatingHookInstalled, proofLevelLine, protocolChecks, readOnlyProblems, sealedCopyReport, securityCapability } from './integration-status.js';
import { CHECKPOINT_FILE, CONFIG_DIR, findRepoRoot, readConfig, untrustedConfigReason } from './local-config.js';
import { containedRealPath, rel, writeFileAtomic } from './local-files.js';
import { hasMcpEntry, mcpConfigPath } from './mcp-registration.js';
import { proofScopeLine } from './proof-obligations.js';
import { projectTestEntryHint } from './regression-proof.js';
import { readTaskRecord } from './task-state.js';
import { CLAIMS_FILE, lastVerificationFromCheckpoint } from './verification-evidence.js';

/** Startup orientation only: no checks, evidence writes, or completion decision. */
export function cmdSessionStart(): number {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')) as { hook_event_name?: unknown };
    if (input.hook_event_name !== 'SessionStart') return 0;
    const root = findRepoRoot(process.cwd());
    if (!root) return 0;
    const hint = projectTestEntryHint(root);
    const cfg = readConfig(root);
    if (!hint || !cfg || cfg === 'corrupt' || planAuthorityDrift(root, cfg)) return 0;
    const doc = parseJsonOrNull(settingsPath(root));
    const owned = new Set(cfg.hookCommands);
    if (!doc || !hasAmabieEntry(doc, owned) || !hasAmabieEntry(doc, owned, 'PreToolUse')
      || !hasAmabieEntry(doc, owned, 'UserPromptSubmit') || !hasAmabieEntry(doc, owned, 'PostToolUse')
      || !hasAmabieEntry(doc, owned, 'SessionEnd')) return 0;
    const cliPrefix = installedCliPrefix();
    const context = [
      'Amabie completion workflow (not a verification result).',
      `Work in ${JSON.stringify(root)}.`,
      'Implement the requested change and regression assertions, then finish normally with a factual summary.',
      'At the start of each new project request, call Amabie MCP mcp__amabie__amabie_task before project changes, with the current intent and every stated criterion copied verbatim; use requirements: [] when none were stated. This is AGENT_REPORTED input only and cannot bind or prove criteria.',
      'After amabie_task, continue authorized implementation and tests even when an objective criterion lacks a sealed proof; keep it NOT PROVEN and let the completion hook report the operator binding hint. Subjective-only duties may continue to human acceptance.',
      'Amabie starts a fresh task scope on every user request. It blocks Claude Code shell, write, agent-delegation and MCP calls until that request is registered; after registration, proof gaps do not block project work. Read tools remain available.',
      'Never edit the plan or hooks, or run setup/bind/accept. Keep every unbound criterion NOT PROVEN.',
      'Amabie runs the sealed base comparison itself; do not switch, reset, or restore this branch to reproduce the baseline.',
      'If the Amabie MCP task tool is missing or unavailable, stop and ask the operator to restore Amabie MCP before changing files; shell commands are blocked until registration succeeds.',
      'Use the project test runner\'s file or case filter for early feedback. The Stop hook runs the full sealed checks at completion; do not rerun the full suite just for an Amabie verdict.',
      'If the hook reports a failure, repair that problem and recheck its exact id with amabie_doctor(check). A focused result is PARTIAL.',
      cliPrefix === null
        ? 'This CLI path cannot be safely embedded in a shell command. Use the configured Amabie MCP amabie_doctor(check) tool or ask a human to inspect the installation.'
        : `If MCP is unavailable, run this installed CLI instead of guessing a global amabie command: ${cliPrefix} doctor --check "<reported-id>".`,
      'Preserve the sealed plan, baseline and hooks; do not setup, bind or accept to clear a failure.',
      hint.trim(),
    ].join('\n');
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  } catch { /* unavailable or malformed startup input cannot manufacture verification */ }
  return 0;
}

/**
 * amabie status — the Lazy-Connect read surface: "Amabie already recognizes
 * this environment; what is its state?" Answers from config and wiring bytes
 * on disk only — ZERO project commands executed, ZERO writes: the only
 * subprocesses are a few read-only git metadata probes (tracked-file and
 * toplevel checks under Amabie's hardened git), so a full status run leaves
 * the repo byte-identical. Every line is a fact about state, never a claim
 * that the project passes; the checkpoint is reported as history, not health.
 */
export function cmdStatus(rawArgs: string[], compact = false): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'status' });
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('NOT CONNECTED', 'not inside a git repository — Amabie has nothing to attach to here.', 'cd into your project, then: amabie setup --yes'); return 2; }
  o.context({ root });
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NOT CONNECTED', "Amabie's local config (.amabie/amabie.local.json) is unreadable.", 'run: amabie setup --yes (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) { o.verdict('NOT CONNECTED', `${root} is a git repository but Amabie was never set up here — no config, no hooks, no proof.`, 'when you want protection here: amabie setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NOT CONNECTED', `Amabie found a local config it does not trust (${distrust}) — it will not run plans from it.`, "run: amabie setup --yes (rewrites it as this machine's own)"); return 2; }
  const problems = readOnlyProblems(root, cfg, false); // state only — no liveness spawn
  if (problems.length) {
    o.context({ problems });
    o.verdict('NEEDS ATTENTION', `Amabie is set up in ${root}, but its wiring is not sound:`, '');
    for (const p of problems) o.say(`  - ${p}`);
    o.say('next: amabie setup --yes repairs the above; amabie doctor proves the checks actually run');
    return 2;
  }
  const security = securityCapability();
  o.context({
    checks: protocolChecks(cfg),
    security,
    agent: agentCapability(root),
  });
  if (compact && !opts.json) {
    o.verdict('CONNECTED', `${root}: wiring and sealed plan are intact. No project check was run.`, 'amabie doctor runs the checks');
    o.say(proofLevelLine(security.level));
    const last = lastVerificationFromCheckpoint(parseJsonOrNull(path.join(root, CONFIG_DIR, CHECKPOINT_FILE)));
    o.say(last
      ? `last verification (historical only): ${JSON.stringify(last.status)} (${JSON.stringify(last.source)}) at ${JSON.stringify(last.at)}; session end: unknown`
      : 'last verification: none recorded');
    return 0;
  }
  o.say(`repo: ${root}`);
  o.say(`plan: ${cfg.plan.length} step(s): ${cfg.plan.map((s) => `${s.kind}:${s.script}`).join(', ')} — sealed authority intact`);
  o.say(proofLevelLine(security.level));
  o.detail(sealedCopyReport(root, cfg));
  const task = readTaskRecord(root);
  o.say(`task: ${task ? `${task.kinds.join('+')} (${task.requirementCount} requirement(s))` : 'none registered — verify will demand a frozen task before any PASS'}`);
  let candidates: string[] = [];
  try { candidates = fs.readdirSync(path.join(root, CONFIG_DIR, 'candidates')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { /* no registry yet = none */ } // 'candidates' must match CANDIDATES_SUBDIR in candidate.ts
  o.say(`candidates: ${candidates.length ? candidates.join(', ') : 'none'}`);
  const cp = parseJsonOrNull(path.join(root, CONFIG_DIR, CHECKPOINT_FILE));
  o.say(`last checkpoint: ${cp ? `${cp.status} (${cp.source}) at ${cp.at} — a past run, NOT a claim about now` : 'none'}`);
  o.verdict('CONNECTED', 'Amabie recognizes this repo: trusted config, wiring intact, sealed authority un-drifted. No project command was executed to answer this — only a few read-only git metadata reads — this is a statement about state, not about your code passing.', 'to run the checks: amabie doctor');
  return 0;
}

export function cmdUninstall(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository.', 'cd into the project you set up'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Amabie's local config is unreadable, so Amabie cannot tell which settings entries it owns.", 'run: amabie setup (recreates the config), then amabie uninstall'); return 2; }
  if (!cfg) { o.say('Amabie is not installed in this repo — nothing to remove.'); return 0; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Amabie will not remove settings based on a config it does not trust (${distrust}) — it cannot prove which entries are its own.`, 'run: amabie setup --yes (recreates the record as this machine\'s own), then amabie uninstall'); return 2; }
  // M9 additive: BOTH refusal checks run BEFORE any hook is touched. An
  // uninstall that ends up refusing must not leave a repo with its hooks
  // stripped while the config stays live — that is a modified verification
  // authority (the pre-execution containment gate in candidate.ts blocks on
  // exactly that state), and a refusal should never manufacture it. These are
  // preconditions of the teardown, not after-the-fact exceptions.
  if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
    o.verdict('NEEDS ATTENTION', '.amabie resolves outside the repository (a link?) — Amabie will not delete through it.', 'replace it with a real folder, then re-run: amabie uninstall'); return 2;
  }
  // M7: .amabie/candidates holds the registry and (by default) the candidate
  // worktrees themselves. Removing .amabie wholesale would orphan a worker's
  // tree and erase the records proving it belongs to this repo (guarantee 11).
  try {
    if (fs.readdirSync(path.join(root, CONFIG_DIR, 'candidates')).length > 0) { // must match CANDIDATES_SUBDIR in candidate.ts
      o.verdict('NEEDS ATTENTION', "candidates are still registered under .amabie/candidates — uninstall would remove Amabie's registry while the worktrees (and the worker's edits in them) remain.", 'amabie isolate --list, then --remove each (or --discard), then re-run: amabie uninstall'); return 2;
    }
  } catch { /* absent or empty: nothing to protect */ }
  const { removed, problems } = uninstallHooks(root, cfg);
  if (problems.length) {
    // keep .amabie: it is the ownership record the advertised retry needs (S6)
    o.verdict('NEEDS ATTENTION', `Amabie removed ${removed} of its hook entries but ${problems.length} file(s) could not be cleaned completely; its ownership record (.amabie) is kept so a retry can finish the job:`, 'fix the listed files, then re-run: amabie uninstall is safe to repeat');
    for (const p of problems) console.log(`  - ${p}`);
    return 2;
  }
  const remainingAmabieHooks = [
    ...findUnownedAmabieHookEntries(root, settingsPath(root), {
      Stop: new Set(), PreToolUse: new Set(), UserPromptSubmit: new Set(), PostToolUse: new Set(), SessionEnd: new Set(), SessionStart: new Set(),
    }),
    ...findUnownedAmabieHookEntries(root, codexHooksPath(root), { Stop: new Set() }),
  ];
  if (remainingAmabieHooks.length) {
    fs.rmSync(path.join(root, CONFIG_DIR), { recursive: true, force: true });
    o.say('removed ' + removed + ' hook entries owned by this installation; other Amabie hooks remain:');
    for (const entry of remainingAmabieHooks) o.say('  - ' + entry);
    o.verdict('NEEDS ATTENTION',
      'this installation was removed, but unowned Amabie hook commands were left untouched.',
      'remove the listed entries with their owning installation or edit those exact hook entries manually');
    return 2;
  }
  fs.rmSync(path.join(root, CONFIG_DIR), { recursive: true, force: true });
  o.say(`removed ${removed} Amabie hook entr${removed === 1 ? 'y' : 'ies'}; every other settings entry was kept (content preserved — re-serialization may reformat whitespace).`);
  o.verdict('READY', 'Amabie is fully removed from this repo.', 'to bring it back: amabie setup');
  return 0;
}

export function cmdClaim(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const text = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!text) { o.say('usage: amabie claim "<what the agent believes happened>"'); return 3; }
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project here to attach a claim to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Amabie's local config is unreadable — it will not attach claims to state it cannot read.", 'run: amabie setup'); return 2; }
  if (!cfg) { o.verdict('NEEDS ATTENTION', 'Amabie is not set up in this repo, so there is no verification record to attach a claim to.', 'run: amabie setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Amabie will not record claims against a config it does not trust (${distrust}).`, "run: amabie setup --yes (rewrites it as this machine's own)"); return 2; }
  try {
    if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
      o.verdict('NEEDS ATTENTION', '.amabie resolves outside the repository (a link?) — Amabie will not write claims through it.', 'replace it with a real folder, then re-run'); return 2;
    }
    // the claims PATH (not just .amabie) must stay inside: a linked claims/
    // dir would otherwise let the atomic write land outside the repo (S3)
    const claimPath = path.join(root, CONFIG_DIR, CLAIMS_FILE);
    if (containedRealPath(root, claimPath) === null) {
      o.verdict('NEEDS ATTENTION', `${rel(root, claimPath)} resolves outside the repository (a link?) — Amabie will not write claims through it.`, 'replace it with a real folder inside .amabie, then re-run'); return 2;
    }
    fs.mkdirSync(path.dirname(claimPath), { recursive: true });
    writeFileAtomic(claimPath, JSON.stringify({
      at: new Date().toISOString(), kind: 'agent-claim',
      // M3: the writer is the agent, so the class is AGENT_REPORTED —
      // permanently insufficient for a PASS, by the read side's design.
      trustClass: 'AGENT_REPORTED',
      authority: 'UNTRUSTED HINT — claims are not evidence; verdicts come only from checks Amabie executes',
      text: text.slice(0, 4000),
    }, null, 2) + '\n');
  } catch (e) {
    o.verdict('NEEDS ATTENTION', `could not record the claim (${String(e).slice(0, 140)}).`, 'fix the file/permission, then re-run'); return 2;
  }
  o.say('claim recorded as an UNTRUSTED hint. Amabie does not execute, trust, or report anything from it;');
  o.say('the next completion check re-runs the plan itself and judges only its own execution (claim ≠ evidence).');
  return 0;
}

/**
 * 1.1 §21/§26 — `amabie result`: the machine-readable answer to "what does
 * Amabie know about this repo right now?" for an agent that must NOT spend its
 * context parsing prose or slurping logs.
 *
 * It reports FACTS with their provenance: the sealed checks, where the state
 * lives, the MEASURED custody level, which harnesses can actually gate, the
 * last recorded completion (labelled as history, never as health), and any
 * reason the wiring is not sound. It never runs the plan — that is `doctor` —
 * so calling it is free and safe for an agent to do at any time.
 */
export function cmdResult(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'result', schema: PROTOCOL_RESULT });
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('NOT CONNECTED', 'not inside a git repository — there is no Amabie state to report here.', 'cd into your project, then: amabie setup --yes'); return 2; }
  o.context({ root });
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NOT CONNECTED', "Amabie's local config (.amabie/amabie.local.json) is unreadable, so nothing here can be reported as its state.", 'run: amabie setup --yes (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) { o.verdict('NOT CONNECTED', `${root} is a git repository, but Amabie is not set up here yet — so there is nothing to report and nothing has been checked.`, 'when you want verification here: amabie setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NOT CONNECTED', `Amabie found a local config it does not trust (${distrust}) — it will not report results from it.`, 'run: amabie setup --yes (rewrites it as this machine\'s own)'); return 2; }
  const problems = readOnlyProblems(root, cfg, false); // state only: no commands, no liveness spawn
  const cp = parseJsonOrNull(path.join(root, CONFIG_DIR, CHECKPOINT_FILE));
  const lastVerification = lastVerificationFromCheckpoint(cp);
  const task = readTaskRecord(root);
  o.context({
    checks: protocolChecks(cfg),
    security: securityCapability(),
    agent: agentCapability(root),
    // The full record (bundles, checkpoints, claims) lives here; the envelope
    // names it instead of pasting it, so an agent's context stays small.
    evidencePath: path.join(root, CONFIG_DIR),
    ...(lastVerification ? { lastVerification } : {}),
    ...(task ? { next: `task registered: ${task.kinds.join('+')} (${task.requirementCount} requirement(s))` } : {}),
  });
  o.say(`repo: ${root}`);
  o.say(`checks: ${cfg.plan.map((s) => `${s.kind}:${s.script}`).join(', ')}`);
  o.say(`last checkpoint: ${lastVerification ? `${lastVerification.status} (${lastVerification.source}) at ${lastVerification.at} — historical only` : 'none — no completion has been checked here yet'}`);
  if (lastVerification) {
    o.say(`proof in that run: ${lastVerification.proof ? proofScopeLine(lastVerification.proof) : 'not recorded (older checkpoint or a pre-check block)'}`);
    for (const ob of lastVerification.proof?.obligations ?? []) {
      if (ob.caveat) o.say(`evidence caveat in that run [${ob.id}]: ${ob.caveat}`);
    }
    if (lastVerification.checks.length > 0) {
      const passed = lastVerification.checks.filter((x) => x.ok).length;
      const failed = lastVerification.checks.length - passed;
      o.say(`checks in that run: ${passed} passed, ${failed} failed${lastVerification.failed.includes('obligation') ? '; proof obligation remained open' : ''}`);
      for (const check of lastVerification.checks) o.say(`  ${check.ok ? '✓' : '✗'} ${check.kind}: ${check.display} (exit ${check.exitCode === null ? 'unknown' : check.exitCode})`);
    } else {
      o.say('checks in that run: none recorded (older checkpoint or a pre-check block)');
    }
    o.say(lastVerification.source === 'checkpoint'
      ? `completion hook in that run: ${lastVerification.hookResponse}; session end: unknown`
      : 'diagnostic run; no completion-hook response in this record; session end: unknown');
    if (lastVerification.next) o.say(`recorded next step: ${lastVerification.next}`);
    if (lastVerification.evidencePath) o.say(`full evidence: ${lastVerification.evidencePath}`);
  }
  if (problems.length) {
    o.context({ problems });
    o.verdict('NEEDS ATTENTION', 'a recorded result cannot be treated as current: the wiring is not sound here.', 'run: amabie setup --yes');
    for (const p of problems) o.say(`  - ${p}`);
    return 2;
  }
  o.verdict('CONNECTED',
    lastVerification ? `last recorded verification: ${lastVerification.status} (${lastVerification.source}) at ${lastVerification.at} — a past run, not a claim about now`
      : 'no completion has been checked here yet — the wiring is sound, but nothing has been proven',
    'to check the code now: amabie doctor');
  return 0;
}

/**
 * 1.1 §18–21 — `amabie agents`: which agents work here, what each can ACTUALLY
 * do, and install/uninstall of the ADVISORY integration where no hook can gate.
 *
 * This command exists because "we support your agent" is the kind of sentence
 * that hides a lie. Every integration is listed with its real capability: GATED
 * means a completion can be blocked; ADVISORY means the agent is told and may
 * ignore it. Nothing here pretends to gate, and nothing is installed unless the
 * user asks for it by name.
 */
export function cmdAgents(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'agents' });
  const pos = rest.filter((a) => !a.startsWith('--'));
  const mode = pos[0] === 'install' || pos[0] === 'uninstall' ? pos[0] : null;
  const id = mode ? pos[1] : undefined;
  const dirToken = mode ? pos[2] : pos[0];
  const root = findRepoRoot(dirToken ?? process.cwd());
  if (!root) { o.verdict('NOT CONNECTED', 'not inside a git repository — there is no project to integrate an agent with.', 'cd into your project, then: amabie setup --yes'); return 2; }
  o.context({ root });

  const found = new Set(detectHarnesses(root).found.map((h) => h.name));
  const advisory = hasAdvisory(root);
  // v1.3, slice 1 — "is Amabie's hook installed HERE?" is a different question from "is the agent
  // present?", and it is the one a protection claim needs. Computed once, used by the rows below.
  const wired = gatingHookInstalled(root);
  const integrations: ProtocolIntegration[] = AGENT_INTEGRATIONS.map((a) => ({
    id: a.id,
    label: a.label,
    gating: a.gating,
    ...(a.gatingMeasured === undefined ? {} : { gatingMeasured: a.gatingMeasured }),
    // v1.4 §C: the trust step is reported on the SAME row as the capability, and only while the hook
    // is actually installed here (before that there is nothing to trust, and the row already says so).
    ...(a.gatingNeedsTrust !== undefined && wired ? { gatingNeedsTrust: a.gatingNeedsTrust } : {}),
    detected: a.id === 'generic' ? true : found.has(a.id),
    ...(a.gating || a.gatingMeasured === false ? {} : { advisoryInstalled: advisory }),
    summary: a.summary,
  }));
  o.context({ integrations, agent: agentCapability(root) });

  if (mode !== null) {
    const advisoryIds = AGENT_INTEGRATIONS.filter((a) => !a.gating).map((a) => a.id).join(', ');
    if (id === undefined) { o.verdict('NEEDS ATTENTION', `agents ${mode} needs an integration id.`, `advisory integrations: ${advisoryIds} (example: amabie agents ${mode} generic)`); return 2; }
    const integration = AGENT_INTEGRATIONS.find((a) => a.id === id);
    if (!integration) { o.verdict('NEEDS ATTENTION', `"${id}" is not an agent integration Amabie knows.`, `known: ${AGENT_INTEGRATIONS.map((a) => a.id).join(', ')}`); return 2; }
    if (integration.gating) { o.verdict('NEEDS ATTENTION', `${integration.label} is a GATING integration — it is installed by setup, not by an advisory command, so its hook keeps one owner.`, 'run: amabie setup --yes'); return 2; }
    const res = mode === 'install' ? installAdvisory(root) : removeAdvisory(root);
    if (!res.ok) { o.verdict('NEEDS ATTENTION', res.problem, 'fix that file, then re-run'); return 2; }
    o.verdict('CONNECTED',
      res.changed
        ? `advisory integration ${mode === 'install' ? 'installed' : 'removed'} in ${rel(root, res.file)} — it tells the agent to consult Amabie before claiming completion, and it is ADVISORY: it cannot block anything.`
        : `nothing changed — the advisory block was already ${mode === 'install' ? 'present' : 'absent'} in ${rel(root, res.file)}.`,
      mode === 'install' ? 'to confirm the checks run: amabie doctor' : `to reinstall: amabie agents install ${integration.id}`);
    return 0;
  }

  o.say(`repo: ${root}`);
  o.say('agent integrations (GATED = can block a completion; ADVISORY = the agent is told and may ignore it):');
  // v1.3 §C: whether the agent can also ASK is a separate, useful fact on the "am I protected?"
  // command. Reported from the same signature-matched evidence the rest of Amabie uses.
  const cfgForTools = readConfig(root);
  const toolsRegistered = cfgForTools !== null && cfgForTools !== 'corrupt'
    && (() => {
      const doc = parseJsonOrNull(mcpConfigPath(root));
      return doc !== null && hasMcpEntry(doc, new Set(cfgForTools.mcpArgSignatures ?? []));
    })();
  for (const i of integrations) {
    // v1.3 §E: three states, not two. GATED (a hook is installed and can block), UNMEASURED (the
    // harness documents a mechanism this project has not reproduced — claimed as neither), ADVISORY
    // (the agent is told and may ignore it).
    const unmeasured = i.gatingMeasured === false;
    const word = i.gating ? 'GATED   ' : unmeasured ? 'UNMEASURED' : 'ADVISORY';
    // v1.4 §C: a GATED row whose harness still holds the hook at its own trust gate says so ON THE
    // ROW. "GATED" with the one remaining human step unstated is how a written file gets read as
    // protection.
    const extra = i.gating
      ? ` [${wired ? 'hook installed here' : 'hook NOT installed here'}${wired && toolsRegistered ? ', agent tools registered' : ''}${wired && i.gatingNeedsTrust !== undefined ? `; ${i.gatingNeedsTrust}` : ''}]`
      : unmeasured
        ? ` [Amabie's completion hook is ${wired ? 'installed here' : 'NOT installed here'} — whether this harness honours it is UNMEASURED]`
        : ` [AGENTS.md block ${advisory ? 'installed' : 'not installed'}]`;
    o.say(`  ${word} ${i.label} — ${i.detected ? 'detected' : 'not detected'}${extra}`);
    o.detail(i.summary);
  }
  const gated = integrations.filter((i) => i.gating && i.detected);
  if (gated.length === 0) {
    const unmeasured = integrations.filter((i) => i.gatingMeasured === false && i.detected);
    o.verdict('NEEDS ATTENTION',
      unmeasured.length > 0
        ? `${unmeasured.map((i) => i.label).join(', ')} is installed here and documents a completion-hook mechanism Amabie has NOT measured — so nothing here can be reported as gated. Detecting an agent is not protecting the repository.`
        : 'no agent here can be GATED today — a completion can be checked, but nothing can block it.',
      'any agent can use the protocol directly: amabie result --json');
    return 2;
  }
  if (!wired) {
    o.verdict('NEEDS ATTENTION',
      `${gated.map((i) => i.label).join(', ')} is installed here, but Amabie's completion hook is NOT — nothing runs automatically, so nothing can block a completion. Detecting the agent is not protecting the repository.`,
      'to install the hook: amabie setup --yes');
    return 2;
  }
  // v1.3 §E: the tools are registered but the harness holds them at its own consent gate. Saying so
  // is the difference between a user who approves once and a user who concludes the tools are broken.
  if (toolsRegistered) {
    o.say('note: Claude Code holds a project MCP server at "pending approval" until you approve it once in an interactive session — the entry is written; the tools appear after you approve.');
  }
  // v1.4 §C: the hook is written, and the harness still holds it at ITS gate. This is the one step
  // Amabie cannot take for the user, so CONNECTED is printed with it rather than after it.
  const trustPending = gated.filter((i) => i.gatingNeedsTrust !== undefined);
  for (const i of trustPending) o.say(`note: ${i.label} — ${i.gatingNeedsTrust}.`);
  // v1.5 §4C — the question this command exists to answer ("what is actually wired here?") had no
  // answer for SCOPE: MEASURED (`git status` after setup) .claude/settings.json, .codex/hooks.json
  // and .mcp.json are tracked PROJECT files, while .amabie/ self-ignores. One line, and the user
  // can decide what to commit without reading source.
  o.say('scope: the harness and tool entries Amabie writes (.claude/settings.json, .codex/hooks.json, .mcp.json) are PROJECT files — committing them shares them with a clone, and each developer then runs `amabie setup --yes` once so the recorded path matches their machine. Amabie\'s own state is local to you: .amabie/ (self-ignored) and this machine\'s trust store.');
  o.verdict('CONNECTED', `${gated.map((i) => i.label).join(', ')} can gate completions here — the hook is installed in this repository.${trustPending.length > 0 ? ` (${trustPending.map((i) => i.label).join(', ')} gates once the hook is trusted.)` : ''}`, 'to confirm end to end: amabie doctor');
  return 0;
}
