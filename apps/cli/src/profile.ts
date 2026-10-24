/**
 * T13 — an approved ROUTINE PROFILE: a narrow, known task type whose criteria and conditions of use the
 * operator reviewed once, so a matching routine task needs no hand-edited JSON and no second per-task
 * permission for what the profile already covers.
 *
 * A profile is only a PROPOSAL until a deterministic controller (never a model) finds every prerequisite
 * met. It adds no authority: the requirement text comes from the committed profile (not from the task
 * text), the script must already be in the SEALED plan, and the file must be committed and unmodified —
 * so a worker that edits or invents a profile gets a proposal, not a grant. Applying one is exactly
 * `amabie task` + `amabie bind --reseal` with the profile's reviewed arguments.
 *
 * ponytail: same-UID worker that commits a profile file is the documented `bind` limit, not a new one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Out, TASK_KINDS, cmdBind, cmdTask, findRepoRoot, gitWithinRoot, parseGlobals, readConfig, untrustedConfigReason } from './onboarding.js';
import { materialDigest } from './authorization.js';

export const PROFILES_FILE = 'amabie.profiles.json';
export const PROFILES_SCHEMA = 'amabie-profiles/1';

interface Profile { id: string; version: number; kind: string; match: string; script: string; requirement: string }

const clip = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80);

function parseProfiles(file: string): Profile[] | string {
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return `cannot read ${PROFILES_FILE} (${clip(String(e))})`; }
  const d = doc as { schema?: unknown; profiles?: unknown } | null;
  if (!d || d.schema !== PROFILES_SCHEMA || !Array.isArray(d.profiles)) return `${PROFILES_FILE} is not a ${PROFILES_SCHEMA} document`;
  const seen = new Set<string>();
  for (const p of d.profiles as Record<string, unknown>[]) {
    const ok = p && typeof p.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.id) && Number.isInteger(p.version)
      && typeof p.kind === 'string' && typeof p.match === 'string' && p.match.length > 0 && p.match.length <= 200
      && typeof p.script === 'string' && typeof p.requirement === 'string' && p.requirement.trim() !== '';
    if (!ok) return `${PROFILES_FILE} holds a malformed profile`;
    if (seen.has(p.id as string)) return `${PROFILES_FILE} repeats profile id "${clip(p.id as string)}"`;
    seen.add(p.id as string);
  }
  return d.profiles as Profile[];
}

/** Every unmet prerequisite of one profile for one task text. Empty = the controller may apply it. */
function unmet(root: string, profile: Profile, text: string, plan: readonly { script: string }[]): string[] {
  const out: string[] = [];
  if (!(TASK_KINDS as readonly string[]).includes(profile.kind)) out.push(`kind "${clip(profile.kind)}" is not a task kind`);
  let re: RegExp | null = null;
  try { re = new RegExp(profile.match, 'i'); } catch { out.push('match pattern does not compile'); }
  if (re && !re.test(text)) out.push('the task does not match this profile');
  if (!plan.some((s) => s.script === profile.script)) out.push(`the sealed plan does not run "${clip(profile.script)}"`);
  return out;
}

export async function cmdProfile(rawArgs: string[]): Promise<number> {
  const { opts, rest } = parseGlobals(rawArgs);
  const o = new Out(opts.verbose, opts.json);
  o.context({ command: 'profile' });
  const usage = 'amabie profile list "<task text>"   |   amabie profile apply <id> "<task text>"';
  const [sub, ...args] = rest;
  const refuse = (why: string, next = usage, code = 2): number => { o.context({ exitCode: code }); o.verdict('NEEDS ATTENTION', why, next); return code; };
  if ((sub !== 'list' && sub !== 'apply') || args.length !== (sub === 'list' ? 1 : 2) || args.some((a) => a.trim() === '' || a.startsWith('--'))) {
    return refuse('profile takes a subcommand and nonblank arguments; nothing was written.', usage, 3);
  }
  const root = findRepoRoot(process.cwd());
  if (!root) return refuse('not inside a git repository — there is no project to apply a profile to.');
  const cfg = readConfig(root);
  if (cfg === 'corrupt' || !cfg) return refuse('Amabie is not set up here, so there is no sealed plan.', 'run: amabie setup --yes');
  const distrust = untrustedConfigReason(root, cfg);
  if (distrust) return refuse(`Amabie will not use a config it does not trust (${distrust}).`, 'run: amabie setup --yes');
  const file = path.join(root, PROFILES_FILE);
  if (!fs.existsSync(file)) return refuse(`no ${PROFILES_FILE}: PROPOSAL ONLY — no approved routine profile exists in this project.`);
  const profiles = parseProfiles(file);
  if (typeof profiles === 'string') return refuse(`${profiles}: PROPOSAL ONLY.`);
  // Operator-approved = committed and unmodified. A worker-edited or brand-new file is a proposal.
  const tracked = gitWithinRoot(root, ['ls-files', '--error-unmatch', '--', PROFILES_FILE]) !== null;
  const dirty = gitWithinRoot(root, ['status', '--porcelain', '--', PROFILES_FILE]);
  const approved = tracked && dirty !== null && dirty.trim() === '';

  if (sub === 'list') {
    const text = args[0]!;
    for (const p of profiles) {
      const problems = unmet(root, p, text, cfg.plan);
      if (!approved) problems.push(`${PROFILES_FILE} is not committed and unmodified (not operator-approved)`);
      o.say(`${problems.length === 0 ? 'APPLICABLE' : 'PROPOSAL ONLY'} ${p.id} v${p.version}${problems.length ? ` — ${problems.join('; ')}` : ''}`);
    }
    o.verdict('NEEDS ATTENTION', 'profiles are proposals; only `amabie profile apply` may use one, and only when every prerequisite is met.', usage);
    return 0;
  }

  const [id, text] = args as [string, string];
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return refuse(`no profile "${clip(id)}": PROPOSAL ONLY. Known: ${profiles.map((p) => p.id).join(', ') || '(none)'}.`);
  const problems = unmet(root, profile, text, cfg.plan);
  if (!approved) problems.push(`${PROFILES_FILE} is not committed and unmodified (not operator-approved)`);
  if (problems.length > 0) return refuse(`profile "${profile.id}" stays a PROPOSAL ONLY — ${problems.join('; ')}. Nothing was written.`);

  o.say(`profile ${profile.id} v${profile.version}: every prerequisite is met; registering the task with its reviewed requirement.`);
  const registered = cmdTask([text, '--kind', profile.kind, '--requirement', profile.requirement]);
  if (registered !== 0) return registered;
  const fresh = readConfig(root);
  const bound = fresh && fresh !== 'corrupt' && fresh.planAuthority?.proofBindings?.[materialDigest(profile.requirement)] === profile.script;
  if (bound) { o.say(`requirement already bound to the sealed "${profile.script}" check — nothing to re-approve.`); return 0; }
  return cmdBind([profile.script, '--requirement', profile.requirement, '--reseal']);
}
