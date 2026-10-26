import fs from 'node:fs';
import path from 'node:path';
import { declaredTask, materialDigest, canonicalText, TASK_KINDS, type TaskKind, type TaskIdentity } from './authorization.js';
import { inferTaskKinds } from './change-signals.js';
import { Out, parseGlobals } from './cli-output.js';
import { CONFIG_DIR, TASK_FILE, findRepoRoot, readConfig, untrustedConfigReason } from './local-config.js';
import { containedRealPath, rel, safePath, writeFileAtomic } from './local-files.js';
import { appendTaskRevision, readClaudeTurnState, sameTask, writeClaudeTurnState } from './task-state.js';

/**
 * M6 task-intake: the worker registers what it was ASKED for so Amabie can
 * derive that kind's proof obligations. The registration itself carries ZERO
 * authority (AGENT_REPORTED, like `amabie claim`): it can only ever ADD
 * obligations — the sealed plan stays the floor no declaration lifts.
 */
export function cmdTask(rawArgs: string[]): number {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project here to attach a task to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt') { o.verdict('NEEDS ATTENTION', "Amabie's local config is unreadable — it will not attach a task to state it cannot read.", 'run: amabie setup'); return 2; }
  if (!cfg) { o.verdict('NEEDS ATTENTION', 'Amabie is not set up in this repo, so there is no verification record to attach a task to.', 'run: amabie setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Amabie will not record a task against a config it does not trust (${distrust}).`, "run: amabie setup --yes (rewrites it as this machine's own)"); return 2; }
  let kindFlag: string | null = null;
  let sessionId: string | null = null;
  const prose: string[] = [];
  const requirements: string[] = [];
  /**
   * A STATED REQUIREMENT MUST NEVER BE SILENTLY DROPPED (v1.2, found by a probe rather than by a hunch).
   *
   * MEASURED, tooling/probes/v12-fixture-configurations.mjs: fixture `cli-exit-codes` states EIGHT
   * requirements and `amabie task` recorded SEVEN digests. The missing one begins with `--`:
   *
   *   "--strict moves warnings into errors rather than dropping them"
   *
   * The old loop required the value to NOT start with `--` (`!rest[i+1].startsWith('--')`) and then
   * skipped any remaining `--` token outright, so a requirement whose TEXT begins with a dash-like
   * token was neither consumed nor reported: the operator saw "8 requirements" in their head and
   * "7 requirement(s)" on screen, and the eighth became prose nobody checks. That is the exact
   * failure this repository exists to prevent, and it is the same defect class as the MEASURED `work`
   * bug recorded in orchestrate.ts ("Amabie silently registered FEWER, i.e. weaker verification than
   * the human authorized") — fixed there in v1.1, still present here.
   *
   * The rule now: `--requirement` takes the NEXT ARGUMENT VERBATIM as the requirement text. The only
   * values rejected are the ones that cannot be text at all — no value, or another option token,
   * which is a misuse Amabie refuses instead of guessing. An unrecognised option is REFUSED rather
   * than ignored, because ignoring `--requirment "x"` (a typo) registers zero duties while the
   * operator believes otherwise, and a silent coverage hole is the one outcome this command may
   * never produce.
   */
  const optionToken = (s: string): boolean => s === '--requirement' || s === '--session' || s === '--kind' || s.startsWith('--kind=');
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--session') {
      const value = rest[++i];
      if (sessionId !== null || !value || value.startsWith('--')) { o.say('REFUSED — --session needs exactly one current Claude session id. Nothing was registered.'); return 3; }
      sessionId = value; continue;
    }
    if (a === '--kind') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        o.say(`REFUSED — --kind needs one of: ${TASK_KINDS.join(', ')}${value === undefined ? ' (no value followed it)' : ` (it was followed by "${value.slice(0, 40)}", which is another option)`}. Nothing was registered.`);
        return 3;
      }
      kindFlag = rest[++i]!; continue;
    }
    if (a.startsWith('--kind=')) { kindFlag = a.slice(7); continue; }
    // GLM F-3: the requirement TEXT keeps its identity — hashed, prose never
    // stored (M3/M4). Counting alone let ["A","B"] and ["C","D"] share one
    // acceptance; an acceptance now binds to WHAT was listed.
    if (a === '--requirement') {
      const value = rest[i + 1];
      if (value === undefined) {
        o.say('REFUSED — --requirement needs the requirement TEXT as its value and nothing followed it. Nothing was registered, because registering fewer duties than were listed is the one outcome this command may never produce.');
        return 3;
      }
      if (optionToken(value)) {
        o.say(`REFUSED — --requirement was followed by the option "${value.slice(0, 40)}", so its value is missing or mis-ordered. Quote the requirement text (a requirement that itself begins with "--" is fine: put it after --requirement). Nothing was registered.`);
        return 3;
      }
      requirements.push(rest[++i]!); continue;
    }
    if (a.startsWith('--')) {
      o.say(`REFUSED — unknown option "${a.slice(0, 40)}". amabie task takes --kind, --requirement and --session only; an ignored option here would silently register FEWER duties than you listed. Nothing was registered.`);
      return 3;
    }
    prose.push(a);
  }
  const requirementCount = requirements.length;
  const text = prose.join(' ').trim();
  if (!text && kindFlag === null && requirementCount === 0) { o.say('usage: amabie task "<intent>" [--kind bugfix|refactor|dependency|performance|ui|multi] [--requirement "<part>"]…'); return 3; }
  const inferred = inferTaskKinds([text, ...requirements].join(' '));
  let kinds: TaskKind[];
  if (kindFlag !== null) {
    if (!(TASK_KINDS as readonly string[]).includes(kindFlag)) { o.verdict('NEEDS ATTENTION', `unknown task kind "${kindFlag.slice(0, 40)}" — one of: ${TASK_KINDS.join(', ')}.`, 're-run with --kind <one of those>, or omit --kind and let Amabie infer'); return 3; }
    // blocker 3 LAW: an agent-selected --kind may ADD useful classification;
    // it may NEVER REMOVE trusted/inferred material intent. The recorded
    // kinds are the UNION — "--kind bugfix" on "fix the crash and make the
    // dialog prettier" keeps the ui duty. --kind is not an authority override.
    kinds = [...new Set([kindFlag as TaskKind, ...inferred])];
  } else kinds = inferred;
  if (requirementCount > 0 && !kinds.includes('multi')) kinds.push('multi');
  let task: TaskIdentity;
  try { task = declaredTask(text, kinds, requirements); }
  catch (e) { o.say(`REFUSED — ${(e as Error).message}`); return 2; }
  const turn = sessionId ? readClaudeTurnState(root, sessionId) : null;
  if (sessionId && (!turn || (turn.registeredPromptId === turn.promptId && !sameTask(turn.task, task)))) {
    o.say('REFUSED — this session has no current request, or a different task is already registered. Submit a new request before changing its task.'); return 2;
  }

  try {
    if (containedRealPath(root, path.join(root, CONFIG_DIR)) === null) {
      o.verdict('NEEDS ATTENTION', '.amabie resolves outside the repository (a link?) — Amabie will not write through it.', 'replace it with a real folder, then re-run'); return 2;
    }
    const taskPath = path.join(root, CONFIG_DIR, TASK_FILE);
    if (containedRealPath(root, taskPath) === null) {
      o.verdict('NEEDS ATTENTION', `${rel(root, taskPath)} resolves outside the repository (a link?) — Amabie will not write through it.`, 'replace it with a real folder inside .amabie, then re-run'); return 2;
    }
    fs.mkdirSync(path.dirname(taskPath), { recursive: true });
    appendTaskRevision(root, task);
    writeFileAtomic(taskPath, JSON.stringify({
      schema: 'amabie-task/2', at: new Date().toISOString(), ...task,
      trustClass: 'AGENT_REPORTED',
      authority: 'ZERO — registering a task can only ADD proof obligations; the sealed plan is the floor no declaration lifts',
    }, null, 2) + '\n');
    if (sessionId && turn && !writeClaudeTurnState(root, sessionId, { ...turn, registeredPromptId: turn.promptId, task })) {
      throw new Error('could not bind task registration to the current Claude request');
    }
  } catch (e) {
    o.verdict('NEEDS ATTENTION', `could not record the task (${String(e).slice(0, 140)}).`, 'fix the file/permission, then re-run'); return 2;
  }
  o.say(`task registered: ${kinds.length ? kinds.join(' + ') : 'no kind inferred'}${requirementCount ? ` (${requirementCount} requirement(s))` : ''}.`);
  const proofScriptFor = (digest: string, kind?: 'bench' | 'e2e'): string | null => {
    const script = cfg.planAuthority?.proofBindings?.[digest];
    return script !== undefined && cfg.plan.some(step => step.script === script && (kind === undefined || step.kind === kind))
      ? script : null;
  };
  const bindHint = (kind?: 'bench' | 'e2e'): void => {
    const scripts = [...new Set(cfg.plan.filter((step) => !kind || step.kind === kind).map((step) => step.script))];
    const command = scripts.length > 0
      ? `amabie bind <${kind ? `sealed ${kind}` : 'sealed plan'} script> --requirement "<exact registered text>" --reseal`
      : kind ? `add a sealed ${kind} check and run amabie setup` : 'add a sealed check to the plan and run amabie setup';
    o.say(`  trusted operator action (same-UID workers can invoke CLI in LOCAL): ${command}`);
    if (scripts.length > 0) o.say(`  matching sealed scripts: ${scripts.map(safePath).join(', ')}`);
  };
  for (const target of task.objectiveTargets) {
    const script = proofScriptFor(target.digest, target.kind);
    o.say(`objective ${target.kind} target: ${target.digest} — ${script
      ? `bound to sealed "${script}" check; its successful result is still required`
      : 'needs a matching sealed proof binding'}`);
    if (!script) bindHint(target.kind);
  }
  /**
   * Print every requirement's digest so the operator can actually BIND it.
   *
   * MEASURED gap this closes: `amabie.proofs` accepts any requirement digest, but nothing ever told
   * the operator what the digest was, so the proof-binding path had no actionable input. Coverage
   * has to be attainable, or "every objective requirement has a frozen proof obligation" is not a
   * promise.
   */
  for (const r of requirements) {
    const d = materialDigest(r);
    const target = task.objectiveTargets.find((t) => t.digest === d);
    const script = proofScriptFor(d, target?.kind);
    const state = target
      ? `[objective ${target.kind} target${script ? ` bound to "${script}"` : '; needs matching proof'}]`
      : script
        ? `[bound to sealed proof "${script}"; successful result still required]`
        : `[needs sealed proof${task.subjectiveRequirementDigests.includes(d) ? ' or human acceptance' : ''}]`;
    o.say(`requirement ${state}: ${d} — "${canonicalText(r).slice(0, 90)}"`);
    if (!target && !script) bindHint();
  }
  o.say('this is an AGENT_REPORTED hint with zero authority — the next checkpoint proves the sealed plan PLUS this task\'s obligations; nothing here weakens either.');
  if (text !== '' && inferred.length === 0) {
    // blocker 3: the intent was understood by NO pattern. The honest move is
    // to surface the ambiguity ONCE at registration — a --kind flag chosen by
    // the agent must not silently resolve it. Requirements are the human's
    // vocabulary: each becomes a duty, closable by proof or acceptance.
    o.say('NOTICE: no obligation could be derived from this intent. Ask the HUMAN what must be proven and re-register with one --requirement "<part>" per part — do NOT let --kind alone paper over the ambiguity. A candidate for this task freezes these kinds as its authority; un-derived intent stays visible here.');
  }
  return 0;
}
