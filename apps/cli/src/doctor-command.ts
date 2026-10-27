import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { composePlan, planDigest, SCOPES_FILE, stepKey } from './project.js';
import { PROTOCOL_DOCTOR_PARTIAL } from './protocol.js';
import { validatePromptEvidenceRequest, verifyPromptEvidence, type ValidatedPromptEvidenceRequest, type VerificationReport } from '@amabie/prompt-evidence';
import { createCodingSealedPlanAdapter } from './prompt-evidence.js';
import { decideFastPath } from './fastpath.js';
import { collectDiffSignals } from './change-signals.js';
import { type StepResult, attributeRunFailures, planWithFreshTests, runPlanStep, unresolvedStep } from './check-runner.js';
import { Out, dirArg, parseGlobals } from './cli-output.js';
import { installedDoctorCommand } from './cli-runtime.js';
import { stepDisplay } from './execution-environment.js';
import { agentCapability, proofLevelLine, protocolChecks, readOnlyProblems, sealedCopyReport, securityCapability } from './integration-status.js';
import { findRepoRoot, readConfig, untrustedConfigReason } from './local-config.js';
import { containedRealPath } from './local-files.js';
import { obligationsFor, proofScopeLine, proofSummary } from './proof-obligations.js';
import { discriminationObligation, refactorPreservationLimit, sealedTestEntryHint } from './regression-proof.js';
import { bindOriginalPrompt, bindTaskRevisions, promptEpochIssues, readOriginalPrompt, readTaskRecord, taskRevisionIssues } from './task-state.js';
import { promptEvidenceBundleSummary, writeCheckpoint, writeVerificationBundle } from './verification-evidence.js';

function takeDoctorOptions(args: string[]): { rest: string[]; check?: string; promptEvidence?: string; problems: string[] } {
  const rest: string[] = [];
  const problems: string[] = [];
  let check: string | undefined;
  let promptEvidence: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--check') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) problems.push('--check needs a sealed check id');
      else if (check !== undefined) problems.push('--check may be provided once');
      else { check = value; i += 1; }
      continue;
    }
    if (arg.startsWith('--check=')) {
      const value = arg.slice('--check='.length);
      if (!value) problems.push('--check needs a sealed check id');
      else if (check !== undefined) problems.push('--check may be provided once');
      else check = value;
      continue;
    }
    if (arg === '--prompt-evidence') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) problems.push('--prompt-evidence needs a request file path');
      else if (promptEvidence !== undefined) problems.push('--prompt-evidence may be provided once');
      else { promptEvidence = value; i += 1; }
      continue;
    }
    if (arg.startsWith('--prompt-evidence=')) {
      const value = arg.slice('--prompt-evidence='.length);
      if (!value) problems.push('--prompt-evidence needs a request file path');
      else if (promptEvidence !== undefined) problems.push('--prompt-evidence may be provided once');
      else promptEvidence = value;
      continue;
    }
    rest.push(arg);
  }
  return { rest, ...(check === undefined ? {} : { check }), ...(promptEvidence === undefined ? {} : { promptEvidence }), problems };
}

export async function cmdDoctor(rawArgs: string[]): Promise<number> {
  const doctorArgs = takeDoctorOptions(rawArgs);
  const { opts, rest } = parseGlobals(doctorArgs.rest);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'doctor' });
  if (doctorArgs.problems.length > 0 || (doctorArgs.check !== undefined && opts.fast) || (doctorArgs.promptEvidence !== undefined && (doctorArgs.check !== undefined || opts.fast))) {
    const reason = doctorArgs.problems.join('; ') || (doctorArgs.promptEvidence !== undefined && doctorArgs.check !== undefined ? '--prompt-evidence requires the full plan and cannot be combined with --check' : doctorArgs.promptEvidence !== undefined && opts.fast ? '--prompt-evidence requires the full plan and cannot be combined with --fast' : '--check cannot be combined with --fast');
    o.context({ exitCode: 3, problems: [reason] });
    o.verdict('NEEDS ATTENTION', `invalid doctor options: ${reason}.`, `use \`${installedDoctorCommand('<sealed-check-id>')}\` for one diagnostic check, or \`${installedDoctorCommand()}\` for the full gate`);
    return 3;
  }
  const root = findRepoRoot(dirArg(rest) ?? process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository.', 'cd into your project'); return 2; }
  o.context({ root });
  // 1.1: the "no package.json → UNSUPPORTED" gate is gone. Doctor's question is
  // "is Amabie actually protecting this repo?", and the config answers it for
  // every ecosystem; a repo that was never set up says so below.
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Amabie's local config (.amabie/amabie.local.json) is unreadable.", 'run: amabie setup (rewrites it; your other settings are untouched)'); return 2; }
  if (!cfg) {
    // "Never set up" and "nothing here to set up" are different facts, and only
    // the first one is about wiring. A directory with no recognizable project
    // has nothing Amabie could protect, so it is UNSUPPORTED — which also keeps
    // the answer honest when findRepoRoot lands on an unrelated ancestor repo
    // (a stray .git above a temp dir is a real thing to hit).
    const composed = composePlan(root);
    if (composed.problems.length) {
      o.verdict('NEEDS ATTENTION', `the nested-scope declaration (${SCOPES_FILE}) is not usable: ${composed.problems.join('; ')}.`, `fix ${SCOPES_FILE} (or delete it to go back to root-only discovery), then run: amabie setup --yes`);
      return 2;
    }
    if (composed.scopes.length === 0) {
      o.verdict('UNSUPPORTED', `${root} has no project Amabie can model at its root (no package.json, pyproject.toml / setup.py / tox.ini, Cargo.toml, go.mod / go.work).`, `if your checks live in subdirectories, declare them in ${SCOPES_FILE}, then: amabie setup --yes`);
      return 2;
    }
    o.verdict('NEEDS ATTENTION', 'Amabie is NOT fully active yet — this repo was never set up.', 'run: amabie setup --yes'); return 2;
  }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Amabie found a local config it does not trust (${distrust}) — it will not run plans from it.`, 'run: amabie setup --yes (rewrites it as this machine\'s own)'); return 2; }

  const problems = readOnlyProblems(root, cfg, true); // doctor is about to execute — liveness is its question
  if (problems.length) {
    o.context({ problems });
    o.verdict('NEEDS ATTENTION', 'Amabie is NOT fully active here:', '');
    for (const p of problems) o.say(`  - ${p}`);
    o.say(problems.some((p) => p.startsWith('Amabie could not confirm descendant cleanup after probing '))
      ? 'next: resolve the descendant-sweep failure above, then rerun `amabie doctor --json`; setup alone will not fix it'
      : 'next: amabie setup --yes repairs the above without touching your other settings');
    return 2;
  }
  // Facts every later verdict in this command needs: the sealed checks, the
  // MEASURED custody level, and which harnesses can actually gate an agent.
  let promptEvidenceRequest: ValidatedPromptEvidenceRequest | null = null;
  if (doctorArgs.promptEvidence !== undefined) {
    const task = readTaskRecord(root);
    if (!task) {
      o.context({ exitCode: 3, problems: ['no registered Amabie task is available for this experimental request'] });
      o.verdict('NEEDS ATTENTION', 'Prompt-to-Evidence needs the original task and every exact requirement registered first.', 'run amabie task with the original intent and each exact --requirement, bind each requirement to a sealed script, then retry');
      return 3;
    }
    const requestPath = path.resolve(root, doctorArgs.promptEvidence);
    const realPath = containedRealPath(root, requestPath);
    if (realPath === null) {
      o.context({ exitCode: 3, problems: ['request file must be a regular file inside the project'] });
      o.verdict('NEEDS ATTENTION', 'the Prompt-to-Evidence request is missing, linked, or outside this project.', 'place the request in the project and pass its relative path');
      return 3;
    }
    try {
      const stat = fs.statSync(realPath);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('request file must be a regular file no larger than 256 KiB');
      promptEvidenceRequest = validatePromptEvidenceRequest(JSON.parse(fs.readFileSync(realPath, 'utf8')) as unknown, { ...task, taskType: 'coding' });
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error).replace(/[\r\n\t]+/g, ' ').slice(0, 240);
      o.context({ exitCode: 3, problems: [`invalid Prompt-to-Evidence request: ${reason}`] });
      o.verdict('NEEDS ATTENTION', `the experimental request is invalid: ${reason}.`, 'correct the request so its goal and requirement set exactly match the registered task');
      return 3;
    }
  }
  const doctorSecurity = securityCapability();
  o.context({ checks: protocolChecks(cfg), security: doctorSecurity, agent: agentCapability(root) });
  o.say(proofLevelLine(doctorSecurity.level));
  if (doctorArgs.check !== undefined) {
    const step = cfg.plan.find((candidate) => stepKey(candidate) === doctorArgs.check);
    if (!step) {
      const available = cfg.plan.map((candidate) => stepKey(candidate));
      const reason = `no sealed check has id "${doctorArgs.check}"`;
      const ids = `available ids: ${available.join(', ') || '(none)'}`;
      o.context({ exitCode: 3, problems: [`${reason}; ${ids}`] });
      o.verdict('NEEDS ATTENTION', `${reason}; ${ids}.`, `copy one id exactly, then run \`${installedDoctorCommand('<sealed-check-id>')}\``);
      return 3;
    }
    const id = stepKey(step);
    o.context({ schema: PROTOCOL_DOCTOR_PARTIAL });
    o.say(`running one sealed diagnostic check [${id}]: ${stepDisplay(cfg.pm, step)}`);
    let result: StepResult;
    let blocked = false;
    try { result = runPlanStep(root, cfg.pm, step); }
    catch (e) { result = unresolvedStep(root, cfg.pm, step, e); blocked = true; }
    o.step(result);
    const partialStatus = blocked ? 'partial-blocked' : result.ok ? 'partial-pass' : 'partial-fail';
    const evidenceDir = writeVerificationBundle(root, 'doctor-selected', [result], partialStatus,
      { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null },
      { extra: { partial: true, checkId: id, fullPlanRun: false } });
    if (evidenceDir === null) o.say('diagnostic evidence: could not be written');
    else o.say(`diagnostic evidence: ${evidenceDir} — this is not a full-plan result`);
    o.say('completion checkpoint unchanged; remaining checks and task obligations were not evaluated.');
    const problems = blocked
      ? [`${id} could not run: ${result.tail}`]
      : result.ok ? [] : [`${id} failed: ${result.display}`];
    o.context({
      exitCode: !blocked && result.ok ? 0 : 2,
      partialCheck: { id, passed: !blocked && result.ok, ran: !blocked || result.exitCode !== null, exitCode: result.exitCode },
      problems,
      ...(evidenceDir === null ? {} : { evidencePath: evidenceDir }),
    });
    o.verdict('PARTIAL', blocked
      ? `the selected check "${id}" could not run; this diagnostic did not evaluate completion.`
      : result.ok
        ? `the selected check "${id}" passed; this diagnostic did not evaluate completion.`
        : `the selected check "${id}" failed; this diagnostic did not evaluate completion.`,
    `repair or inspect this check, rerun: ${installedDoctorCommand(id)}; then run the full gate: ${installedDoctorCommand()}`);
    return !blocked && result.ok ? 0 : 2;
  }
  // READY is earned HERE, now — the plan runs in every doctor invocation, so a
  // hand-written or stale checkpoint can never produce READY on its own (S4).
  // --run is accepted but no longer changes behavior.
  // 1.1 §23 — the OPT-IN fast path. It is off unless `--fast` is asked for, and
  // it can only leave out a step the PROJECT declared paths for, whose declared
  // paths the change provably missed. An undeclared check always runs, an empty
  // change set runs everything, and every skip is printed AND carried in the
  // envelope: a skip is not a pass, and a run that was not the full plan must not
  // be readable as one.
  const changedTouched = opts.fast ? collectDiffSignals(root, cfg).touched : [];
  const decision = opts.fast ? decideFastPath(cfg.plan, cfg.planAuthority?.stepPaths ?? {}, changedTouched) : null;
  if (decision !== null && decision.usedFastPath) {
    o.context({ skipped: decision.skipped.map((s) => ({ step: s.key, reason: s.reason })) });
    o.say('FAST PATH — sealed declarations justify leaving out these checks (a skip is NOT a pass):');
    for (const s of decision.skipped) o.say(`  ~ skipped ${s.step.kind}: ${s.step.script} — ${s.reason}`);
  }
  const stepsToRun = decision === null ? cfg.plan : decision.run;
  const executionPlan = planWithFreshTests(stepsToRun);
  o.say('running the verification plan:');
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  const refused: string[] = [];
  const refusedScripts = new Set<string>();
  const ranByScript = new Map<string, StepResult[]>();
  for (const s of executionPlan) {
    let r: StepResult;
    try { r = runPlanStep(root, cfg.pm, s); }
    catch (e) { refused.push(`plan step "${s.script}" refused: ${(e as Error).message}`); refusedScripts.add(s.script); continue; }
    ran.push(r);
    const scriptRuns = ranByScript.get(s.script) ?? [];
    scriptRuns.push(r);
    ranByScript.set(s.script, scriptRuns);
    o.step(r); if (!r.ok) failed.push(r);
    if (r.exitCode === null) break;
  }
  let promptEvidenceReport: VerificationReport | undefined;
  if (promptEvidenceRequest !== null) {
    const resultsByScript = new Map([...ranByScript.entries()].map(([script, results]) => [script, results.map(result => ({
      ok: result.ok,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      execDigest: result.exec.digest,
      stdout: result.stdout,
      stderr: result.stderr,
    }))]));
    const adapter = createCodingSealedPlanAdapter({
      plan: cfg.plan,
      proofBindings: cfg.planAuthority?.proofBindings ?? {},
      resultsByScript,
      refusedScripts,
      planDigest: planDigest(cfg.plan),
      baselineDigest: cfg.baseline?.head ?? null,
    });
    promptEvidenceReport = bindTaskRevisions(
      bindOriginalPrompt(await verifyPromptEvidence(promptEvidenceRequest, [adapter], { runId: crypto.randomUUID(), attempt: 0 }), readOriginalPrompt(root), promptEvidenceRequest.goal.text),
      [...taskRevisionIssues(root, readTaskRecord(root)!), ...promptEpochIssues(root)]);
    o.context({ promptEvidence: promptEvidenceReport });
    o.say(`Prompt-to-Evidence (EXPERIMENTAL): ${promptEvidenceReport.verdict} — ${promptEvidenceReport.coverage.met}/${promptEvidenceReport.coverage.total} requirements verified.`);
    o.say(`  Original-goal source coverage: ${promptEvidenceReport.sourceCoverage.mappedNonWhitespaceCharacters}/${promptEvidenceReport.sourceCoverage.nonWhitespaceCharacters} non-whitespace characters${promptEvidenceReport.sourceCoverage.complete ? '' : ' — incomplete, so PASS is unavailable'}.`);
    for (const issue of promptEvidenceReport.issues) o.say(`  Scope issue: ${issue}`);
    for (const requirement of promptEvidenceReport.requirements) {
      o.say(`  ${requirement.id} ${requirement.status.toUpperCase()}: ${requirement.text}`);
      for (const criterion of requirement.criteria) o.say(`    ${criterion.status.toUpperCase()} — ${criterion.note}`);
    }
  }
  if (refused.length) {
    // a script name Amabie will not execute is a config problem, not a test
    // result — honest NEEDS ATTENTION, no checkpoint, no fake run.
    writeVerificationBundle(root, 'doctor', ran, 'blocked', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null }, { ...(promptEvidenceReport === undefined ? {} : { extra: { promptEvidence: promptEvidenceBundleSummary(promptEvidenceReport) } }) });
    o.context({ problems: refused });
    o.verdict('NEEDS ATTENTION', 'the config names a script Amabie will not execute — doctor cannot certify this plan:', '');
    for (const p of refused) o.say(`  - ${p}`);
    o.say('next: amabie setup --yes reseals from the package.json scripts');
    return 2;
  }
  const evidenceDir = writeVerificationBundle(root, 'doctor', ran, failed.length ? 'fail' : 'pass', { planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null }, { ...(promptEvidenceReport === undefined ? {} : { extra: { promptEvidence: promptEvidenceBundleSummary(promptEvidenceReport) } }) });
  writeCheckpoint(root, failed.length ? 'fail' : 'pass', failed.map((f) => f.kind), 'doctor', {
    checks: ran, hookResponse: 'not-applicable', evidencePath: evidenceDir ?? undefined,
  });
  if (promptEvidenceReport !== undefined) {
    if (evidenceDir === null) o.say('Prompt-to-Evidence artifact: could not be written; the result remains in this command output only.');
    else {
      o.context({ evidencePath: evidenceDir });
      o.say(`Prompt-to-Evidence artifact: ${evidenceDir} — verification.json stores evidence digests and statuses; free-form requirement text is omitted.`);
    }
  }
  if (failed.length) {
    o.context({ problems: failed.map((f) => `${f.kind} failed: ${f.display}`) });
    // v1.5 blocker 6: the same MEASURED attribution setup prints. Doctor is the gate a worker meets
    // most often, so it must not blame the project for a restriction Amabie itself imposed. The
    // wiring fact stays in the line (it is what doctor checked first); only the blame moves.
    const attribution = attributeRunFailures(root, cfg, failed, cfg.plan);
    o.verdict('NEEDS ATTENTION',
      attribution.cause === 'project'
        ? `wiring is good, but the checks just failed (${failed.map((f) => f.kind).join(', ')}). ${attribution.reason}`
        : attribution.reason,
      attribution.next);
    // v1.5 §4D — MEASURED in the clean-room first run: doctor printed a blind 12-line TAIL of the
    // runner output (stack frames, with the failing test's NAME cut off), while TROUBLESHOOTING.md
    // tells the reader "the full runner output is written to disk and its path is printed — read
    // that file, not the summary". The path was never printed. The bundle already returns it.
    o.say(evidenceDir === null
      ? 'full runner output: could not be written (evidence storage failed) — the excerpt above is all Amabie kept'
      : `full runner output: ${evidenceDir} — per-step logs and verification.json; read those, not the excerpt above`);
    for (const failure of failed) {
      const failedStep = executionPlan[ran.indexOf(failure)];
      if (failedStep) o.say(`focused recheck after repair: ${installedDoctorCommand(stepKey(failedStep))}`);
    }
    return 2;
  }
  // M6: the same obligation read a checkpoint makes, for humans (no hook stdin
  // here, so only the registered task hint participates; unattributable states
  // say UNPROVEN rather than pretending to a verdict).
  const task = readTaskRecord(root);
  const obligations = obligationsFor(task?.kinds ?? [], collectDiffSignals(root, cfg), new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0, 'setup', task, cfg);
  // Measured, not inferred: is the sealed plan SENSITIVE to this change at all? When the
  // measurement exists it supersedes the declared-kind heuristic (see cmdCheckpoint).
  const regression = refactorPreservationLimit(discriminationObligation(root, cfg, 600_000, undefined, undefined, ran), task?.kinds ?? []);
  if (regression !== null) {
    for (let i = obligations.length - 1; i >= 0; i -= 1) {
      if (obligations[i]!.id === regression.id) obligations.splice(i, 1);
    }
    obligations.push(regression);
  }
  if (promptEvidenceReport !== undefined && promptEvidenceReport.verdict !== 'PASS') {
    const failedRequirements = promptEvidenceReport.coverage.unmet;
    const pendingRequirements = promptEvidenceReport.coverage.unproven + promptEvidenceReport.coverage.blocked;
    obligations.push({
      id: 'prompt-evidence',
      mode: 'objective',
      status: promptEvidenceReport.verdict === 'FAIL' ? 'unmet' : 'unproven',
      note: `experimental per-requirement evaluation is ${promptEvidenceReport.verdict}: ${failedRequirements} requirement(s) have contradictory evidence, ${pendingRequirements} remain unproven or blocked, ${promptEvidenceReport.issues.length} scope issue(s) — see promptEvidence for the criteria, gaps and issues`,
    });
  }
  const proof = proofSummary(task?.requirementCount ?? 0, obligations);
  o.context({ proof });
  o.say(`proof scope: ${proofScopeLine(proof)}`);
  const unmet = obligations.filter((x) => x.status === 'unmet');
  const unproven = obligations.filter((x) => x.status === 'unproven');
  const objectiveOpen = unproven.filter((x) => x.mode === 'objective');
  const subjectiveOpen = unproven.filter((x) => x.mode !== 'objective');
  if (unmet.length > 0) {
    writeCheckpoint(root, 'fail', ['obligation'], 'doctor', {
      checks: ran, hookResponse: 'not-applicable', next: unmet.map((x) => x.note).join('; '), evidencePath: evidenceDir ?? undefined, proof,
    });
    o.context({ problems: unmet.map((x) => x.note) });
    const restoreSource = cfg.baseline?.head ?? 'HEAD';
    o.verdict('NEEDS ATTENTION', `the sealed checks pass, but a proof obligation is objectively violated — ${unmet.map((x) => x.note).join('; ')}`, `restore the deleted verification files with \`git restore --source=${restoreSource} --staged --worktree <path>\`; if the deletion was already committed, commit the restoration before rerunning doctor — or have a human review this deletion`);
    return 2;
  }
  /**
   * FAIL CLOSED, scoped to what was AUTHORIZED. The product invariant: Amabie must never issue
   * PASS/READY merely because the configured tests are green while authorized requirements are not
   * independently covered, and missing or ambiguous proof must never degrade to PASS.
   *
   * Two classes, deliberately treated differently:
   *   - OBJECTIVE obligations (regression evidence, lost coverage, an unbound sealed target) always
   *     refuse READY;
   *   - NON-OBJECTIVE ones refuse READY only when a TASK was registered, because then a human
   *     authorized a requirement that needs their acceptance. Without a task record they are
   *     Amabie's own inference from the diff (e.g. "a lockfile changed"), and refusing READY for
   *     that would fail the documented journeys: a green Rust crate whose first `cargo check`
   *     created `Cargo.lock` would be reported NOT PROVEN (measured — that is exactly what the
   *     rust/go end-to-end probes caught).
   */
  const authorized = task !== null;
  const refuse = objectiveOpen.length > 0 || (authorized && subjectiveOpen.length > 0);
  if (refuse) {
    o.context({ problems: unproven.map((x) => `UNPROVEN: ${x.note}`) });
    const because = objectiveOpen.length > 0
      ? `${objectiveOpen.length} objective obligation(s) have no adequate proof`
      : `${subjectiveOpen.length} authorized requirement(s) need a human's explicit acceptance`;
    const next = objectiveOpen.some((ob) => ob.id === 'regression-evidence')
      ? `Add a regression assertion that fails on the reported starting commit and passes with the actual implementation. Amabie compares with the starting commit automatically; stay on this branch.${sealedTestEntryHint(root, cfg)} Keep the planned test command and starting commit unchanged; then run: amabie doctor`
      : objectiveOpen.length > 0
        ? 'the operator can bind the requirement with amabie bind <matching sealed script> --requirement "<exact text>" --reseal — or take the work through a candidate and have a human accept it there'
        : 'the operator can bind each requirement with amabie bind <sealed script> --requirement "<exact text>" --reseal, or take the work through a candidate and have a human accept it there: amabie work <name> "<intent>" → amabie finish <name> → amabie accept <candidate> in a terminal';
    writeCheckpoint(root, 'unproven', unproven.map((x) => x.id), 'doctor', {
      checks: ran, hookResponse: 'not-applicable', next, evidencePath: evidenceDir ?? undefined, proof,
    });
    o.verdict('NOT PROVEN',
      `the checks passed, but the task is not proven: ${because} — a green plan is not a proven deliverable (NO PROOF, NO DONE).`,
      next);
    for (const ob of unproven) o.say(`  - UNPROVEN [${ob.id}] (${ob.mode}): ${ob.note}`);
    o.say(evidenceDir === null
      ? 'full evidence could not be written; no saved run logs are available'
      : `full evidence: ${evidenceDir} — per-step logs and verification.json`);
    return 2;
  }
  writeCheckpoint(root, 'pass', [], 'doctor', { checks: ran, hookResponse: 'not-applicable', evidencePath: evidenceDir ?? undefined, proof });
  o.verdict('READY', 'wiring verified; the checks just ran and passed, and nothing more needs proof.', 'nothing to do — the agent finishes, Amabie checks');
  if (unproven.length > 0) {
    // Nothing was authorized, so these are Amabie's own observations about the diff. They are said
    // plainly — READY here means "your checks passed", never "your change is proven".
    o.say(`note: ${unproven.length} observation(s) about this diff are UNPROVEN and are not covered by any authorized requirement — the plan passing does not prove them (NO PROOF, NO DONE).`);
  }
  for (const ob of obligations) {
    if (ob.caveat) o.say(`evidence caveat [${ob.id}]: ${ob.caveat}`);
    o.detail(`obligation [${ob.id}] ${ob.status.toUpperCase()} (${ob.mode}): ${ob.note}`);
  }
  if (obligations.some((ob) => ob.caveat)) {
    o.say(evidenceDir === null
      ? 'full evidence could not be written; no saved run logs are available'
      : `full evidence: ${evidenceDir} — per-step logs and verification.json`);
  }
  // M3 (verbose-only — trust classes are evidence internals, not default UX):
  o.detail('trust: this READY is AMABIE_OBSERVED — Amabie executed the checks in this very invocation. Agent words are AGENT_REPORTED and never sufficient for a PASS; no class is promoted by copying bytes into an Amabie-owned file (evidence is never read back for verdicts).');
  if (cfg.planAuthority) o.detail('authority: every command that just ran is one setup sealed — script-text drift is blocked before execution, not excused after it passes.');
  o.detail(sealedCopyReport(root, cfg));
  return 0;
}
