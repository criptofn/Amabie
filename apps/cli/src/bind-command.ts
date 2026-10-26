import fs from 'node:fs';
import path from 'node:path';
import { materialDigest, canonicalText } from './authorization.js';
import { adapterForStep } from './project.js';
import { readUniversalManifest } from './universal.js';
import { type GlobalOpts, Out, parseGlobals } from './cli-output.js';
import { candidateIdentity, gitWithinRoot } from './git-state.js';
import { settingsPath } from './harness-hooks.js';
import { findRepoRoot, readConfig, untrustedConfigReason } from './local-config.js';
import { isRecord, rel, safePath, writeFileAtomic } from './local-files.js';
import { cmdSetup } from './setup-command.js';
import { readTaskRecord } from './task-state.js';

/**
 * M2 claim intake: the agent records what it BELIEVED happened. The claim is
 * stored as an untrusted hint next to Amabie's own evidence and can never
 * create, block, or modify a verdict — only annotate a block Amabie decided
 * from checks it executed itself. (Tests passing != task proven complete;
 * agent-reported != amabie-observed.)
 */
/**
 * THE OPERATOR'S BINDING ACT — `amabie bind <script> --requirement "<stated requirement>"`.
 *
 * WHY IT EXISTS (MEASURED, `bench-r9`/`r9b`): a task registered with five requirements and no sealed
 * proof cost the worker 1.5M and 1.7M tokens over 41–48 turns — the work was green, but the open
 * per-requirement duty invited the agent to keep trying to discharge something only an operator can
 * close. The invariant says every objective requirement must have a FROZEN PROOF OBLIGATION or remain
 * NOT PROVEN; the second half was reachable, the first was not, because binding meant hand-editing
 * `package.json` `amabie.proofs` with a 64-hex digest nobody had printed.
 *
 * This command is that act, and it is deliberately narrow: it refuses a script the sealed plan does
 * not run, it writes the DECLARATION, and — with `--reseal` — it also commits that one file and
 * re-runs the seal, so the operator's path is ONE command instead of three. It is an operator
 * command, not an agent-facing one: what a binding may point at is still decided by the plan the
 * operator already sealed.
 *
 * WHY `--reseal` ADDS STEPS SAVED AND NOT AUTHORITY (v1.2, Mission 2's last named gap). The ritual
 * was `bind` → commit → `amabie setup`, and the middle step is the one that silently breaks the
 * result if forgotten: a binding that lives only in the working tree makes the sealed base dirty,
 * and a dirty base cannot establish discrimination, so the requirement stays NOT PROVEN for a reason
 * that has nothing to do with the requirement (measured; that is why the note below exists). What
 * `--reseal` does NOT change is who may seal: `amabie setup` has never enforced that — it runs
 * unattended, `--yes` or not — so this flag removes two commands without minting any authority. The
 * script must already be part of the SEALED plan, which is the operator's earlier act.
 */
export async function cmdBind(rawArgs: string[]): Promise<number> {
  const { opts } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'bind' });
  const positional: string[] = [];
  const requirements: string[] = [];
  let reseal = false;
  const globals = new Set(['--verbose', '--yes', '--json', '--fast']);
  const optionTokens = new Set([...globals, '--requirement', '--reseal']);
  const refuseInput = (why: string): number => {
    o.context({ exitCode: 3 });
    o.verdict('NEEDS ATTENTION', why,
      'amabie bind <script> --requirement "<the exact stated requirement>" [--requirement …] [--reseal]');
    return 3;
  };
  // Validate the entire intake before a partial declaration or reseal can be written.
  // A requirement beginning with a dash is still TEXT, except an exact option token.
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]!;
    if (arg === '--requirement') {
      const value = rawArgs[i + 1];
      if (value === undefined || value.trim() === '' || optionTokens.has(value)) {
        return refuseInput('--requirement needs nonblank requirement text; no binding was written.');
      }
      requirements.push(value);
      i += 1;
    } else if (arg === '--reseal') reseal = true;
    else if (globals.has(arg)) continue;
    else if (arg.startsWith('--')) return refuseInput(`unknown bind option "${safePath(arg)}"; no binding was written.`);
    else positional.push(arg);
  }
  const script = positional[0];
  if (!script?.trim() || requirements.length === 0 || positional.length !== 1) {
    return refuseInput('bind needs one sealed script and requirement text after each --requirement; no binding was written.');
  }
  const root = findRepoRoot(process.cwd());
  if (!root) { o.verdict('UNSUPPORTED', 'not inside a git repository — there is no project to bind a requirement to.', 'cd into your project and try again'); return 2; }
  const cfg = readConfig(root);
  if (cfg === 'corrupt' || !cfg) { o.verdict('NEEDS ATTENTION', 'Amabie is not set up here, so there is no sealed plan to bind to.', 'run: amabie setup --yes'); return 2; }
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) { o.verdict('NEEDS ATTENTION', `Amabie will not write a binding into a config it does not trust (${distrust}).`, 'run: amabie setup --yes'); return 2; }
  const boundStep = cfg.plan.find((s) => s.script === script);
  if (!boundStep) {
    // Fail closed with the real recovery: the plan is what proves, so a script it does not run cannot
    // be a proof. (This is the same rule setup enforces when it validates amabie.proofs.)
    o.verdict('NEEDS ATTENTION', `the sealed plan does not run a script named "${safePath(script)}" — a binding to it would prove nothing.`, `add that check to your package.json scripts and run: amabie setup, then bind again. Plan scripts: ${cfg.plan.map((s) => s.script).map(safePath).join(', ')}`);
    return 2;
  }
  const task = readTaskRecord(root);
  const mismatchedTarget = requirements
    .map((requirement) => task?.objectiveTargets.find((target) => target.digest === materialDigest(requirement)))
    .find((target) => target && !cfg.plan.some((step) => step.script === script && step.kind === target.kind));
  if (mismatchedTarget) {
    const matchingScripts = [...new Set(cfg.plan.filter((step) => step.kind === mismatchedTarget.kind).map((step) => safePath(step.script)))];
    o.verdict('NEEDS ATTENTION', `the sealed script "${safePath(script)}" cannot prove this objective ${mismatchedTarget.kind} target. No binding was written.`,
      matchingScripts.length > 0
        ? `use a sealed ${mismatchedTarget.kind} script: ${matchingScripts.join(', ')}`
        : `add a sealed ${mismatchedTarget.kind} check and run amabie setup before binding`);
    return 2;
  }
  const pkgPath = path.join(root, 'package.json');
  const manifestPath = path.join(root, 'amabie.project.json');
  /**
   * A root Node-script binding belongs beside its package.json script even if
   * a universal manifest also exists. Any other check uses the manifest only when the manifest
   * DECLARES that check name (setup rejects a manifest binding to anything else); otherwise it
   * falls back to package.json, which accepts any sealed plan script by bare name.
   */
  const rootNodeScript = !boundStep.scope && boundStep.argv === undefined && adapterForStep(cfg, boundStep).id === 'node';
  let manifestDeclares = false;
  if (!rootNodeScript && fs.existsSync(manifestPath)) {
    const read = readUniversalManifest(root);
    if (read.manifest === null) {
      o.verdict('NEEDS ATTENTION', `amabie.project.json is not valid (${read.problems.map(safePath).join('; ').slice(0, 200)}); no binding was written.`, 'fix the manifest, then re-run');
      return 2;
    }
    manifestDeclares = read.manifest.scopes.some((s) => s.checks.some((c) => c.name === script));
  }
  const targetPath = manifestDeclares ? manifestPath : pkgPath;
  const isNode = targetPath === pkgPath;
  const surface = isNode ? 'package.json' : 'amabie.project.json';
  // Setup merges both declaration surfaces and refuses a digest bound differently on each. Refuse here,
  // before anything is written or (with --reseal) committed, instead of after.
  const otherPath = isNode ? manifestPath : pkgPath;
  let otherProofs: unknown;
  try {
    const other = JSON.parse(fs.readFileSync(otherPath, 'utf8')) as Record<string, unknown>;
    otherProofs = isNode ? other.proofs : (isRecord(other.amabie) ? (other.amabie as Record<string, unknown>).proofs : undefined);
  } catch { otherProofs = undefined; }
  if (isRecord(otherProofs)) {
    for (const r of requirements) {
      const d = materialDigest(r);
      const existing = (otherProofs as Record<string, unknown>)[d];
      if (existing !== undefined && existing !== script) {
        o.verdict('NEEDS ATTENTION', `this requirement is already bound to "${safePath(String(existing))}" in ${isNode ? 'amabie.project.json' : 'package.json'}, so binding it to "${safePath(script)}" would conflict. No binding was written.`,
          'remove or change the other declaration first, then re-run');
        return 2;
      }
    }
  }
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as Record<string, unknown>; }
  catch (e) { o.verdict('NEEDS ATTENTION', `cannot read ${surface} to record the binding (${String(e).slice(0, 120)}).`, 'fix the file, then re-run'); return 2; }
  const amabieSection = isNode ? {
    ...(isRecord(doc.amabie) ? doc.amabie as Record<string, unknown> : {}),
  } : {};
  const existingProofs = isNode ? amabieSection.proofs : doc.proofs;
  const proofs: Record<string, unknown> = isRecord(existingProofs) ? { ...existingProofs } : {};
  const written: Array<{ digest: string; text: string }> = [];
  for (const r of requirements) {
    const d = materialDigest(r);
    proofs[d] = script;
    written.push({ digest: d, text: canonicalText(r).slice(0, 90) });
  }
  const sortedProofs = Object.fromEntries(Object.entries(proofs).sort(([a], [b]) => a.localeCompare(b)));
  if (isNode) { doc.amabie = { ...amabieSection, proofs: sortedProofs }; }
  else doc.proofs = sortedProofs;
  try { writeFileAtomic(targetPath, `${JSON.stringify(doc, null, 2)}\n`); }
  catch (e) { o.verdict('NEEDS ATTENTION', `could not write the binding into ${surface} (${String(e).slice(0, 120)}).`, 'close whatever holds the file, then re-run'); return 2; }
  o.say(isNode
    ? `bound ${written.length} requirement(s) to the sealed script "${safePath(script)}":`
    : `bound ${written.length} requirement(s) to the declared check "${safePath(script)}" in amabie.project.json:`);
  for (const w of written) o.say(`  ${w.digest}  "${w.text}"`);

  // The one-act path (v1.2, Mission 2's last named gap): declare, commit the declaration alone, seal.
  if (reseal) return await resealAfterBind(root, targetPath, script, opts, o);

  o.say('this is a DECLARATION, not a seal: run `amabie setup` to seal it into the plan authority.');
  if (isNode) o.say('until then the requirement stays UNPROVEN — a green plan does not cover an unsealed binding.');
  /**
   * THE STEP THAT IS EASY TO MISS, AND IT COSTS A CONFUSING RESULT (v1.2, Mission 2).
   *
   * The discriminator compares the candidate against the SEALED BASE. A binding that lives only in the
   * working tree makes that baseline dirty, and a dirty baseline cannot establish discrimination — so
   * `setup` after an uncommitted bind leaves the requirement NOT PROVEN for a reason that has nothing
   * to do with the requirement. The recovery was documented in a probe and nowhere the operator would
   * look.
   *
   * Saying it HERE costs one line and removes the detour. It is reported, not enforced: committing is
   * the operator's act, and `setup` must still run afterwards — or `--reseal` performs both.
   */
  if (written.length > 0) {
    const id = candidateIdentity(root);
    if (id.dirty === true) {
      o.say('NOTE: the binding is written but NOT committed, and the working tree is now dirty.');
      o.say('  commit it BEFORE re-sealing, or the sealed base is dirty and discrimination cannot be established:');
      o.say(`  git add ${safePath(path.relative(root, targetPath) || path.basename(targetPath))} && git commit -m "bind requirement(s) to ${safePath(script)}"`);
      o.say('  then: amabie setup');
      o.say('  ...or re-run this bind with --reseal, which commits the declaration and re-seals in one step.');
    } else if (id.dirty === null) {
      o.say('NOTE: could not determine whether the working tree is clean. If the binding is uncommitted, commit it before re-sealing — a dirty sealed base cannot establish discrimination.');
    }
  }
  return 0;
}

/**
 * `--reseal`: commit the declaration FILE and re-run the seal, in one operator act.
 *
 * The decisions worth stating once rather than inline:
 *
 * 1. NOTHING ELSE MAY BE DIRTY. A sealed base must be exactly what the operator reviewed; a commit
 *    that swept unrelated work in would make the base something else while looking like a binding.
 *    Amabie's OWN files are excluded, for the reason `setup` excludes them from its baseline:
 *    `.amabie/**` is self-ignored, and the managed harness files (`settings.json`, `.mcp.json`) are
 *    written by setup itself — refusing on Amabie's own act would block the command with no operator
 *    fix available. The excluded set is read from `cfg.touched`, never hard-coded.
 * 2. THE COMMIT CARRIES ONLY THE DECLARATION FILE (`git commit -- <path>`), so a staged, unrelated
 *    change stays staged and uncommitted instead of riding along.
 * 3. IF THAT FILE IS ALREADY COMMITTED, nothing is committed: re-running the act is idempotent
 *    rather than an empty-commit failure.
 * 4. THE SEAL IS THE SAME `amabie setup` the operator would have run, forwarded as `--yes` (the flag
 *    IS the consent), with `--json`/`--verbose` preserved so `--json` still emits exactly ONE
 *    envelope, from the setup path.
 */
async function resealAfterBind(
  root: string, targetPath: string, script: string,
  opts: GlobalOpts, o: Out,
): Promise<number> {
  const declRel = rel(root, targetPath).split(path.sep).join('/');
  const porcelain = gitWithinRoot(root, ['status', '--porcelain']);
  if (porcelain === null) {
    o.say(`REFUSED — could not read the git working-tree state, so the declaration cannot be committed safely. It IS written to ${safePath(declRel)}: commit it yourself, then run: amabie setup`);
    return 2;
  }
  const ownSettings = rel(root, settingsPath(root)).split(path.sep).join('/');
  /**
   * What counts as "unrelated work"? Not Amabie's own surface.
   *
   * MEASURED while writing this: `git status --porcelain` reports an untracked directory as `dir/` —
   * NOT as each file inside it — so matching the settings PATH alone let `.claude/` through as
   * "another change" and refused every `--reseal` on a project whose harness dir is not committed.
   * The check therefore accepts the directory entry that CONTAINS a managed file.
   *
   * MEASURED AGAIN, and this is why the list is derived rather than spelled: v1.3 taught `setup` to
   * write `.mcp.json` as well, and a hard-coded settings path then refused every `--reseal` on a
   * freshly wired repository — the operator was told their working tree had "other changes" that
   * Amabie itself had just made, with no fix available except committing Amabie's own file. The set
   * of files Amabie manages is exactly what `setup` records in `cfg.touched` (the same list it
   * already excludes from its baseline), so it is read from there and stays correct as the managed
   * surface grows.
   */
  const cfgForOwn = readConfig(root);
  const ownPaths = cfgForOwn !== null && cfgForOwn !== 'corrupt'
    ? cfgForOwn.touched.map((t) => rel(root, t.path).split(path.sep).join('/'))
    : [ownSettings];
  const isAmabieOwned = (p: string): boolean => {
    if (p === '.amabie' || p.startsWith('.amabie/')) return true;
    if (ownPaths.includes(p)) return true;
    return p.endsWith('/') && ownPaths.some((own) => own.startsWith(p));
  };
  const changed = porcelain.split('\n').map(porcelainPath).filter((p): p is string => p !== null);
  const others = changed.filter((p) => p !== declRel && !isAmabieOwned(p));
  if (others.length > 0) {
    o.say(`REFUSED — the working tree has ${others.length} other change(s) (${others.slice(0, 3).map(safePath).join(', ')}${others.length > 3 ? ', …' : ''}), and --reseal commits the declaration ALONE: the sealed base must be exactly what you reviewed.`);
    o.say(`  the declaration IS written to ${safePath(declRel)}: commit that file together with the rest of your work, then run: amabie setup`);
    o.say('  ...or commit or stash the other changes first, then re-run this command.');
    return 2;
  }
  let committed = 'the declaration was already committed — nothing to commit';
  if (changed.includes(declRel)) {
    if (gitWithinRoot(root, ['add', '--', declRel]) === null) {
      o.say(`REFUSED — git could not stage ${safePath(declRel)}. The declaration IS written: commit it yourself, then run: amabie setup`);
      return 2;
    }
    if (gitWithinRoot(root, ['commit', '-m', `bind requirement(s) to ${script}`, '--', declRel]) === null) {
      o.say('REFUSED — git would not create the commit (are user.name and user.email configured?). The declaration IS written and staged: commit it yourself, then run: amabie setup');
      return 2;
    }
    const sha = (gitWithinRoot(root, ['rev-parse', '--short', 'HEAD']) ?? '').trim();
    committed = `committed ${safePath(declRel)} alone as ${sha === '' ? 'HEAD' : sha}`;
  }
  o.say(`--reseal: ${committed}.`);
  o.say('re-sealing now: `amabie setup` — the same act, so the saved round trip adds no authority (the script above was already part of the sealed plan).');
  const forwarded = ['--yes'];
  if (opts.json) forwarded.push('--json');
  if (opts.verbose) forwarded.push('--verbose');
  return await cmdSetup(forwarded);
}

/** Porcelain v1 is `XY PATH`, renames as `XY OLD -> NEW`, and quotes paths containing special characters. */
function porcelainPath(line: string): string | null {
  if (line.trim() === '') return null;
  const rest = line.slice(3).trim();
  const arrow = rest.lastIndexOf(' -> ');
  const raw = arrow === -1 ? rest : rest.slice(arrow + 4);
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.split(path.sep).join('/');
}
