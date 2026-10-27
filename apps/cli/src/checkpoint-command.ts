import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildFailurePayload } from './failure-payload.js';
import { agentToolProblem, isReadOnlyCommand, isTaskRegistration } from './agent-session-guard.js';
import { adapterFor, planAuthorityDrift, planDigest, sha256, stepKey } from './project.js';
import { collectDiffSignals, inferTaskKinds } from './change-signals.js';
import { type StepResult, attributeRunFailures, planWithFreshTests, repeatFailedStep, runPlanStep } from './check-runner.js';
import { installedCliPrefix, installedDoctorCommand } from './cli-runtime.js';
import { findRepoRoot, readConfig, untrustedConfigReason } from './local-config.js';
import { obligationsFor, proofSummary } from './proof-obligations.js';
import { gitWithinRoot } from './git-state.js';
import { discriminationObligation, refactorPreservationLimit } from './regression-proof.js';
import { isAgentSessionRegistered, registerAgentSession, unregisterAgentSession } from './session-registry.js';
import { CLAUDE_TASK_TOOL, type ClaudeTurnState, mcpInputMatchesTask, readClaudeTurnState, readTaskRecord, recordOriginalPrompt, removeClaudeTurnState, sameTask, taskFromMcpInput, writeClaudeTurnState } from './task-state.js';
import { type BundleProvenance, deriveObservedCounts, readAgentClaim, writeCheckpoint, writeVerificationBundle } from './verification-evidence.js';

/**
 * Claude Code hook entry point (Stop and PreToolUse). Contract:
 *  - PreToolUse requires task registration before matched project actions; proof gaps stay at completion.
 *  - Stop runs the sealed plan and reports whether task proof is complete.
 *  - stdin: Claude lifecycle JSON or the legacy completion payload; stdout JSON; exit 0.
 *    (`task` is M4-additive: an optional AGENT_REPORTED provenance label,
 *    stored as a digest only; old senders and unknown keys behave as before.)
 *  - all checks pass => silence (human is NOT interrupted when nothing is needed)
 *  - a check fails   => {"decision":"block", reason} => agent gets one repair turn
 *  - infra failure / unconfigured / loop guard => allow + honest systemMessage, never a fake green
 *  - corrupt local config => loud honest UNVERIFIED (GLM F-1) — absence is silent,
 *    damaged authority is NOT
 */
/** Said when a failed check passed on a re-run: unstable, still failing, and the cause to repair is the flakiness. */
export function unstableNote(unstable: string[]): string {
  if (unstable.length === 0) return '';
  return ` UNSTABLE, not passing: ${unstable.join('; ')} failed on one run and passed on another. A check that sometimes passes proves nothing, `
    + 'so do not re-run it hoping for green: find what makes it nondeterministic (timing, ordering, shared state, the network) and fix that.';
}

export async function cmdCheckpoint(): Promise<number> {
  let input: { cwd?: string; prompt?: string; stop_hook_active?: boolean; task?: string; hook_event_name?: string; tool_name?: string; tool_input?: unknown; session_id?: string } = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) as typeof input; } catch { /* interactive invocation or empty stdin */ }
  const root = findRepoRoot(input.cwd ?? process.cwd());
  const emit = (obj: Record<string, unknown>) => { console.log(JSON.stringify(obj)); return 0; };
  const sessionId = typeof input.session_id === 'string' && input.session_id.trim() !== '' ? input.session_id : null;
  if (input.hook_event_name === 'UserPromptSubmit') {
    if (!root || !sessionId) return emit({ decision: 'block', reason: 'Amabie could not start request tracking for this project. The prompt was stopped before project work; restore the project hook or run amabie setup.' });
    const state: ClaudeTurnState = {
      schema: 'amabie-turn/1', sessionDigest: sha256(sessionId), promptId: crypto.randomUUID(),
      registeredPromptId: null, task: null,
    };
    const startHead = gitWithinRoot(root, ['rev-parse', 'HEAD'])?.trim();
    if (startHead !== undefined && /^[0-9a-f]{40,64}$/i.test(startHead)) state.startHead = startHead;
    // The open session is also recorded in the user trust store: `.amabie` can be deleted from inside the session.
    if (!registerAgentSession(root, sessionId)) return emit({ decision: 'block', reason: 'Amabie could not record this agent session in its trust store. The prompt was stopped before project work; repair the trust store (see: amabie doctor), then retry.' });
    if (!writeClaudeTurnState(root, sessionId, state)) return emit({ decision: 'block', reason: 'Amabie could not save request tracking for this project. The prompt was stopped before project work; repair .amabie/task state, then retry.' });
    if (typeof input.prompt === 'string') recordOriginalPrompt(root, input.prompt, state.promptId);
    return emit({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Amabie started a fresh task scope for this request. Register the current intent and exact stated criteria with mcp__amabie__amabie_task (requirements: [] when none). If MCP approval is pending, use: amabie task "<intent>" --requirement "<each stated criterion>" --session ${JSON.stringify(sessionId)}. Omit --requirement when none were stated.`,
    } });
  }
  if (input.hook_event_name === 'SessionEnd') {
    if (root && sessionId) { removeClaudeTurnState(root, sessionId); unregisterAgentSession(root, sessionId); }
    return 0;
  }
  if (input.hook_event_name === 'PostToolUse') {
    if (input.tool_name !== CLAUDE_TASK_TOOL) return 0;
    const turn = root && sessionId ? readClaudeTurnState(root, sessionId) : null;
    const task = root ? taskFromMcpInput(root, input.tool_input) : null;
    if (!root || !sessionId || !turn || !task
      || (turn.registeredPromptId === turn.promptId && !sameTask(turn.task, task))) {
      return emit({ hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Amabie could not bind this task registration to the current request. Project actions remain blocked; register the current task again with mcp__amabie__amabie_task.',
      } });
    }
    if (turn.registeredPromptId !== turn.promptId
      && !writeClaudeTurnState(root, sessionId, { ...turn, registeredPromptId: turn.promptId, task })) {
      return emit({ hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Amabie could not save the task registration for this request. Project actions remain blocked; repair .amabie/task state, then register the task again.',
      } });
    }
    return 0;
  }
  const turn = root && sessionId ? readClaudeTurnState(root, sessionId) : null;
  // M4: optional task/intent label from non-Claude hooks — DIGEST only, raw
  // prose is never stored or echoed, so provenance cannot become a smuggling
  // channel. Claude uses the snapshot captured after its current MCP intake.
  const reportedTaskDigest = typeof input.task === 'string' && input.task.trim()
    ? sha256(input.task.trim().slice(0, 4000)) : undefined;
  const cfg = root ? readConfig(root) : null;
  const taskDigest = sessionId
    ? (turn && turn.registeredPromptId === turn.promptId ? turn.task?.taskDigest : undefined)
    : reportedTaskDigest;
  if (input.hook_event_name === 'PreToolUse') {
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
    const deny = (reason: string) => emit({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } });
    if (!toolName) return deny('Amabie could not identify this tool call, so it cannot check whether the task criteria are bound. No tool call was allowed.');
    if (!/^(?:Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Workflow|mcp__.+)$/.test(toolName)) return 0;
    if (!root) return deny('Amabie could not locate this project, so it cannot verify the task proof bindings. No tool call was allowed. Run amabie setup in the project, then retry.');
    if (cfg === null) return deny('Amabie local configuration is missing, so it cannot verify the task proof bindings. No tool call was allowed. Run amabie setup, then retry.');
    if (cfg === 'corrupt') return deny('Amabie local configuration is unreadable, so it cannot verify the task proof bindings. No tool call was allowed. Repair it or run amabie setup, then retry.');
    const distrust = untrustedConfigReason(root, cfg);
    if (distrust) return deny(`Amabie does not trust this local configuration (${distrust}), so it cannot verify task proof bindings. No tool call was allowed. Run amabie setup, then retry.`);
    const drift = planAuthorityDrift(root, cfg);
    if (drift) return deny(`Amabie's sealed verification authority has changed (${drift}). No tool call was allowed; restore the sealed plan or have the operator re-run setup.`);
    if (!turn) return deny('Amabie has no request record for this Claude session. No project change was allowed; submit the current request again so Amabie can start task tracking.');
    const authorityProblem = agentToolProblem(root, toolName, input.tool_input);
    if (authorityProblem) return deny(authorityProblem);
    if (input.tool_name === CLAUDE_TASK_TOOL) {
      if (turn.registeredPromptId !== turn.promptId) return 0;
      return turn.task && mcpInputMatchesTask(turn.task, input.tool_input)
        ? 0
        : deny('A different task is already registered for this request. Start a new request before registering another task.');
    }
    const toolInput = input.tool_input as { command?: unknown } | undefined;
    if ((toolName === 'Bash' || toolName === 'PowerShell') && sessionId
      && typeof toolInput?.command === 'string' && isTaskRegistration(toolInput.command, sessionId)) return 0;
    // A pure question needs no task: a single read-only command may run before registration (it changes
    // nothing, so there is nothing to verify). Anything that could write still waits for a task.
    if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof toolInput?.command === 'string' && isReadOnlyCommand(toolInput.command)) return 0;
    if (turn.registeredPromptId !== turn.promptId || !turn.task) return deny(`Amabie task registration is missing for this request. Approve the project MCP server in Claude's /mcp menu and call mcp__amabie__amabie_task, or run: amabie task "<intent>" --requirement "<each stated criterion>" --session ${JSON.stringify(sessionId)}. Omit --requirement when none were stated. Project changes remain blocked until registration.`);
    return 0;
  }
  // A session the trust store knows is open, whose project state has vanished, is NOT "nothing wired here":
  // `.amabie` (config, seals, turn state) was removed or damaged from inside the session.
  if (root && sessionId && (cfg === null || cfg === 'corrupt' || !turn) && isAgentSessionRegistered(root, sessionId)) {
    const lost = cfg === null ? 'its .amabie configuration is missing' : cfg === 'corrupt' ? 'its local configuration is unreadable' : 'this request has no tracking record';
    if (input.stop_hook_active === true) return emit({ systemMessage: `Amabie: this session is open in the trust store but ${lost} after one repair attempt — nothing was verified; this completion is UNVERIFIED, not a pass. A human should look.` });
    return emit({ decision: 'block', reason: `Amabie blocked completion: this agent session is open in the user trust store but ${lost}. The project's Amabie state was removed or damaged during the session, so nothing can be verified. Do not recreate it; a human operator must review the project and run amabie setup from a terminal.` });
  }
  if (!root || cfg === null) return 0; // nothing wired here — stay out of the way
  // GLM F-1: a config file that EXISTS but cannot be read is NOT "nothing wired
  // here" — treating it as absence is a silent allow through damaged authority.
  // Honest UNVERIFIED (allow + systemMessage, same posture as S2/empty-plan):
  // never a fake green, never a fake block on evidence we could not examine.
  if (cfg === 'corrupt') {
    return emit({ systemMessage: 'Amabie could not verify this task because its local config (.amabie/amabie.local.json) is unreadable — nothing was verified; this completion is UNVERIFIED, not a pass. Run: amabie setup' });
  }
  // A config this installation did not write (bogus cliPath) or that arrived
  // from a clone (tracked in git) must never drive execution (S2) — say so
  // loudly instead of silently laundering an attacker's plan into "pass".
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) return emit({ systemMessage: `Amabie found local config it does not trust (${distrust}) — nothing was verified; this completion is UNVERIFIED. Run: amabie setup` });
  if (!Array.isArray(cfg.plan) || cfg.plan.length === 0) {
    // degenerate/hand-edited config: executing zero checks is NOT a pass — say so, don't fake green
    return emit({ systemMessage: `Amabie: the verification plan is empty, so nothing was checked — this completion is UNVERIFIED, not a pass. Run: ${installedDoctorCommand()}` });
  }
  // M5: check the SEALED AUTHORITY before executing anything — a candidate-
  // edited command must never be certified as proof, not even by failing on
  // it. Verdict authority stays Amabie's own execution; this gate only
  // decides WHICH commands may run as proof at all.
  const drift = adapterFor(cfg).drift(root, cfg);
  if (drift) {
    writeCheckpoint(root, 'fail', ['authority'], 'checkpoint', {
      hookResponse: input.stop_hook_active === true ? 'message-and-continue' : 'blocked',
      next: 'restore the sealed verification plan or rerun setup after reviewing it',
    }); // state, not a bundle: nothing was executed
    if (input.stop_hook_active === true) {
      // same no-loop posture as a failed plan: one repair turn, then honest stop
      return emit({ systemMessage: `Amabie: verification authority is still changed (${drift.slice(0, 200)}) after one repair attempt — stopping anyway; a human should look.` });
    }
    // Guarded sessions cannot approve a replacement verification plan.
    return emit({ decision: 'block', reason: `Amabie blocked completion: verification authority changed by candidate — ${drift}. Amabie will not certify proof commands it never sealed. Restore the sealed checks, or have the human operator review the new plan and run: amabie setup from a terminal. An agent cannot reseal its own proof through this session.` });
  }

  // M4 provenance for every bundle this invocation writes — from the TRUSTED
  // in-memory config (shape-checked, non-distrusted above), never re-read from
  // the evidence dir.
  const prov: BundleProvenance = {
    planDigest: planDigest(cfg.plan), baseline: cfg.baseline ?? null,
    ...(taskDigest ? { taskDigest } : {}),
  };
  const failed: StepResult[] = [];
  const ran: StepResult[] = [];
  let infra = '';
  const executionPlan = planWithFreshTests(cfg.plan);
  for (const s of executionPlan) {
    let r: StepResult;
    try { r = runPlanStep(root, cfg.pm, s); } catch (e) { infra = String(e); break; }
    ran.push(r);
    if (!r.ok) failed.push(r);
    if (r.exitCode === null) break;
  }
  if (infra) {
    const evidenceDir = writeVerificationBundle(root, 'checkpoint', ran, 'infra', prov);
    writeCheckpoint(root, 'infra', failed.map((f) => f.kind), 'checkpoint', {
      checks: ran, hookResponse: 'message-and-continue', next: `run ${installedDoctorCommand()} to inspect and retry the checks`,
      evidencePath: evidenceDir ?? undefined,
    });
    return emit({ systemMessage: `Amabie could not run the checks (${infra.slice(0, 160)}) — this completion is UNVERIFIED, not a pass.` });
  }
  // A failed check that the project itself is to blame for is run again (bounded) to tell a reproducible
  // failure from an unstable one. The first failure stays the result: a later pass is never proof.
  const unstable: string[] = [];
  for (const f of failed) {
    const step = executionPlan[ran.indexOf(f)];
    if (!step || attributeRunFailures(root, cfg, [f], cfg.plan).cause !== 'project') continue;
    const again = repeatFailedStep(root, cfg.pm, step, f);
    if (!again.stable) unstable.push(`${f.display} (passed ${again.passed} of ${again.runs} runs)`);
  }
  if (failed.length === 0) {
    const evidenceDir = writeVerificationBundle(root, 'checkpoint', ran, 'pass', prov);
    writeCheckpoint(root, 'pass', [], 'checkpoint', {
      checks: ran, hookResponse: 'continued', evidencePath: evidenceDir ?? undefined,
    });
    // M6 (spec M5): the plan passing is the FLOOR, not the finish. Evaluate
    // this task's proof obligations against what Amabie observed in THIS
    // invocation (plan outcome + contained git diff). Objective violation
    // blocks; anything unprovable rides an honest systemMessage — an allow
    // that SAYS so, never a silent fake-complete. TESTS PASSING != PROVEN.
    const task = sessionId
      ? (turn && turn.registeredPromptId === turn.promptId ? turn.task : null)
      : readTaskRecord(root);
    const kinds = task && task.kinds.length > 0
      ? task.kinds
      : (typeof input.task === 'string' && input.task.trim() ? inferTaskKinds(input.task.trim().slice(0, 4000)) : []);
    const obligations = obligationsFor(kinds, collectDiffSignals(root, cfg), new Set(cfg.plan.map((s) => s.kind)), task?.requirementCount ?? 0, 'setup', task, cfg);
    /**
     * MEASUREMENT SUPERSEDES INFERENCE. `obligationsFor` decides regression evidence from the
     * DECLARED kind and the diff ("a bugfix with no test file touched is unproven"); the
     * discrimination run decides it from execution. When the measurement exists it wins — otherwise
     * a bugfix that turns an existing red check green (real regression evidence, no test file
     * touched) would be called unproven, and a test file touched for show would be called met.
     */
    const regression = refactorPreservationLimit(discriminationObligation(root, cfg, 600_000, undefined, undefined, ran, turn?.startHead), kinds);
    if (regression !== null) {
      for (let i = obligations.length - 1; i >= 0; i -= 1) {
        if (obligations[i]!.id === regression.id) obligations.splice(i, 1);
      }
      obligations.push(regression);
    }
    const proof = proofSummary(task?.requirementCount ?? 0, obligations);
    const unmet = obligations.filter((x) => x.status === 'unmet');
    const unproven = obligations.filter((x) => x.status === 'unproven');
    const objectiveOpen = unproven.filter((x) => x.mode === 'objective');
    if (unmet.length > 0) {
      const why = unmet.map((x) => x.note).join('; ');
      if (input.stop_hook_active === true) {
        writeCheckpoint(root, 'fail', ['obligation'], 'checkpoint', {
          checks: ran, hookResponse: 'message-and-continue', next: why, evidencePath: evidenceDir ?? undefined, proof,
        }); // the plan passed; the obligation did not
        return emit({ systemMessage: `Amabie: a proof obligation is still unmet (${why.slice(0, 200)}) after one repair attempt — stopping anyway; a human should look.` });
      }
      writeCheckpoint(root, 'fail', ['obligation'], 'checkpoint', {
        checks: ran, hookResponse: 'blocked', next: why, evidencePath: evidenceDir ?? undefined, proof,
      });
      // The repair must cover staged, worktree and committed deletions. Restore
      // from the sealed baseline, across both index and worktree; HEAD may
      // already be missing the file when an agent committed its deletion.
      const restoreSource = cfg.baseline?.head ?? 'HEAD';
      return emit({ decision: 'block', reason: `Amabie blocked completion: ${why}. A green plan cannot certify checks that no longer exist. Restore them (git restore --source=${restoreSource} --staged --worktree <path>); if the deletion was already committed, commit the restoration before retrying Amabie. Or have a HUMAN review this deletion — an agent claim cannot authorize it (claims are not evidence).` });
    }
    if (unproven.length > 0) {
      // FAIL CLOSED on an OBJECTIVE obligation, as the product invariant requires: an objective
      // requirement with no adequate proof must stay NOT PROVEN, and "the plan is green" is not a
      // discharge of it.
      if (objectiveOpen.length > 0) {
        const obligationNext = objectiveOpen.map((x) => x.note).join('; ');
        /**
         * BLOCK ONLY WHAT THE WORKER CAN ACTUALLY CLOSE (v1.2, Mission 2).
         *
         * MEASURED, and this is the whole reason for the split: the block reason embeds each
         * obligation's note, and some notes describe an OPERATOR act — "bind each uncovered digest
         * in package.json amabie.proofs and re-run amabie setup". A worker cannot bind a frozen
         * proof; only the operator can. Blocking with that text reads to a model as an instruction it
         * must satisfy, and it complies: measured on this host, `cli-exit-codes/guarded` with seven
         * unbound requirements ran **39 turns to 537,583 tokens and still timed out**, while the same
         * fixture's plain arm finished in 18 turns. v1.1 recorded the same shape at 1.5-1.85M tokens.
         *
         * The split is the one `candidate.ts` already prints at the candidate boundary: a duty the
         * worker can discharge with evidence in the repository belongs in a BLOCK; a duty that only an
         * operator or a human can close belongs in a message that says plainly it is not the worker's
         * — the shape that already exists below for subjective duties, and that was written for
         * exactly this reason.
         *
         * NOTHING IS SOFTENED BY THIS: the checkpoint is still written `unproven`, `doctor` still
         * refuses with NOT PROVEN and exit 2, promotion is still locked, and the message still says the
         * completion is not proven. What changes is only whether the model is ordered to keep working
         * on something it cannot finish.
         */
        const workerClosable = (x: { id: string; mode: string }): boolean =>
          x.mode === 'objective' && !x.id.startsWith('target-') && x.id !== 'per-requirement';
        const byWorker = objectiveOpen.filter(workerClosable);
        const byOperator = objectiveOpen.filter((x) => !workerClosable(x));

        if (byWorker.length > 0) {
          const why = byWorker.map((x) => x.note).join(' | ');
          if (input.stop_hook_active === true) {
            writeCheckpoint(root, 'unproven', objectiveOpen.map((x) => x.id), 'checkpoint', {
              checks: ran, hookResponse: 'message-and-continue', next: obligationNext, evidencePath: evidenceDir ?? undefined, proof,
            });
            return emit({ systemMessage: `Amabie: NOT PROVEN (${why.slice(0, 1200)}) — after one repair attempt. Stopping anyway; a human should look, or accept it with: amabie accept`.slice(0, 2000) });
          }
          writeCheckpoint(root, 'unproven', objectiveOpen.map((x) => x.id), 'checkpoint', {
            checks: ran, hookResponse: 'blocked', next: obligationNext, evidencePath: evidenceDir ?? undefined, proof,
          });
          const prefix = 'Amabie blocked completion: NOT PROVEN — ';
          const evidenceHint = evidenceDir ? ` Full test evidence: ${evidenceDir}` : '';
          const availableWhy = Math.max(0, 1400 - prefix.length - evidenceHint.length);
          return emit({ decision: 'block', reason: `${prefix}${why.slice(0, availableWhy)}${evidenceHint}` });
        }

        // Every open objective duty is operator-only. Say so, and let the turn end.
        const operatorWhy = byOperator.map((x) => x.note).join(' ');
        writeCheckpoint(root, 'unproven', objectiveOpen.map((x) => x.id), 'checkpoint', {
          checks: ran, hookResponse: 'message-and-continue', next: obligationNext, evidencePath: evidenceDir ?? undefined, proof,
        });
        return emit({ systemMessage: `Amabie: the sealed checks passed, but the work is NOT PROVEN: ${byOperator.length} duty(ies) remain open and NONE of them is yours to close — each needs the OPERATOR (amabie bind <matching sealed script> --requirement "<exact text>" --reseal) or a HUMAN (amabie accept). This is not a failure of your change: do NOT keep working on it, do NOT edit checks to make it disappear, and do NOT report it as done. Finish now and report exactly what is still open. Details: ${operatorWhy}`.slice(0, 2000) });
      }
      // Subjective / operator-only duties: an agent cannot accept a duty for a human, and — MEASURED
      // (`bench-r9`) — an agent TOLD to close one spends enormous effort trying: two trials with five
      // registered requirements burned 1.5M and 1.7M tokens over 41 and 45 turns for work that was
      // already green, because the message read as an instruction it could satisfy. So this says
      // plainly that the duty is not the worker's, and that finishing and reporting IS the correct end.
      writeCheckpoint(root, 'unproven', unproven.map((x) => x.id), 'checkpoint', {
        checks: ran, hookResponse: 'message-and-continue', next: unproven.map((x) => x.note).join('; '), evidencePath: evidenceDir ?? undefined, proof,
      });
      return emit({ systemMessage: `Amabie: the sealed checks passed. ${unproven.length} duty(ies) remain OPEN, and NONE of them is yours to close — each needs an operator or a human. This is not a failure of your change: do NOT keep trying to satisfy them, do NOT edit checks to make them disappear, and do NOT report them as done. Finish now and report exactly what is still open. Details: ${unproven.map((x) => x.note).join(' ')}`.slice(0, 2000) });
    }
    /**
     * Nothing is open: the plan passed, every objective obligation is met, and the
     * regression-evidence obligation (when it could be measured at all) is met because the checks
     * demonstrably fail without the change. That is the strongest thing this gate can say, and it is
     * the only path to a silent allow.
     */
    /**
     * …EXCEPT when a MET obligation's evidence is weaker than "met" sounds. MEASURED
     * (`bench-final-constraint-hold-guarded-3`): the worker added its own check file, the plan passed,
     * and the stated rule was STILL broken — the hidden oracle found it while Amabie said READY. The
     * gate cannot call that a failure (the check really does discriminate the change, and no
     * requirement was authorized to hold it to), but it must not stay silent either: an allow that
     * SAYS what the evidence is beats a READY that hides it.
     */
    const caveats = obligations.filter((x) => x.status === 'met' && x.caveat !== undefined);
    if (caveats.length > 0) {
      writeCheckpoint(root, 'pass', [], 'checkpoint', {
        checks: ran, hookResponse: 'message-and-continue', next: caveats.map((x) => x.caveat).join('; '), evidencePath: evidenceDir ?? undefined, proof,
      });
      const evidenceHint = evidenceDir === null ? ' Full test evidence could not be written.' : ` Full test evidence: ${evidenceDir}.`;
      return emit({ systemMessage: `Amabie: the sealed checks passed — with a caveat. ${caveats.map((x) => `${x.id}: ${x.caveat}`).join(' ')}${evidenceHint}`.slice(0, 2000) });
    }
    writeCheckpoint(root, 'pass', [], 'checkpoint', { checks: ran, hookResponse: 'continued', evidencePath: evidenceDir ?? undefined, proof });
    return 0; // silent even if an agent claim contradicts — claims never BLOCK, and never CREATE a pass
  }
  // The full runner output is written NEXT TO the evidence bundle and referred to by path, so
  // the model is not forced to pay for bytes it usually does not need — and does not have to
  // re-run the suite to see more. Measured before this: the block carried up to 4000 characters
  // of raw output, which is roughly a thousand tokens per failed attempt, on every attempt.
  const bundleDir = writeVerificationBundle(root, 'checkpoint', ran, 'fail', prov);
  if (input.stop_hook_active === true) {
    writeCheckpoint(root, 'fail', failed.map((f) => f.kind), 'checkpoint', {
      checks: ran, hookResponse: 'message-and-continue', next: `run ${installedDoctorCommand()} to inspect the full failure`,
      evidencePath: bundleDir ?? undefined,
    });
    // already one repair attempt this turn — never loop the agent; surface honestly instead
    // v1.5 §4D — MEASURED (clean-room first run): this message named what failed and why Amabie
    // stopped, but gave the human it hands off to no next action. One clause, no mechanism change.
    return emit({ systemMessage: `Amabie: checks still failing (${failed.map((f) => f.kind).join(', ')}) after one repair attempt — stopping anyway; a human should look.${unstableNote(unstable)} Run: ${installedDoctorCommand()}` });
  }
  writeCheckpoint(root, 'fail', failed.map((f) => f.kind), 'checkpoint', {
    checks: ran, hookResponse: 'blocked', next: 'repair the observed failures and finish again', evidencePath: bundleDir ?? undefined,
  });
  // M2: an agent claim may only ANNOTATE this already-decided block, and only
  // as a truthful claim-vs-observation contrast. Verdict authority: Amabie's own
  // execution (exit code). Absent/unparseable claim => no note at all.
  let claimNote = '';
  const claim = readAgentClaim(root);
  if (claim) {
    const claimed = deriveObservedCounts(claim.text);
    const observed = deriveObservedCounts(failed.map((f) => `${f.stdout}${f.stderr}`).join('\n'));
    if (claimed && observed && (claimed.passed !== observed.passed || claimed.failed !== observed.failed)) {
      claimNote = `Claim is not evidence. Agent claimed: ${claimed.passed} passed / ${claimed.failed} failed (hint recorded ${claim.at}). ` +
        `Amabie observed: ${observed.passed} passed / ${observed.failed} failed, from its own run of ${JSON.stringify(failed.map((f) => f.display).join(' + '))}. ` +
        `Repair the observed failures.\n`;
    }
  }
  // v1.5 BLOCKER 6: when the measured cause is Amabie's own environment, the AGENT reads that here —
  // otherwise a worker spends its budget repairing a project that was never at fault. The project
  // case needs no environment advice; the failure payload names the check and repair recheck.
  const attribution = attributeRunFailures(root, cfg, failed, cfg.plan);
  const reason = `${claimNote}${unstable.length > 0 ? `${unstableNote(unstable).trim()}
` : ''}${attribution.cause !== 'project' ? `${attribution.reason} NEXT: ${attribution.next}\n` : ''}${buildFailurePayload({
    steps: failed.map((f) => ({
      id: stepKey(executionPlan[ran.indexOf(f)]!),
      kind: f.kind, display: f.display, exitCode: f.exitCode,
      stdout: f.stdout ?? '', stderr: f.stderr ?? '',
    })),
    doctorCommandPrefix: installedCliPrefix(),
    writeLog: (name, text) => {
      if (typeof bundleDir !== 'string' || bundleDir === '') return null;
      const p = path.join(bundleDir, `${name}.log`); // numbered, safe name derived by the payload builder
      try { fs.writeFileSync(p, text); return p; } catch { return null; }
    },
  })}`;
  return emit({ decision: 'block', reason });
}
