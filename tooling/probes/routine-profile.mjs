/**
 * T13 / P0:25 — AN APPROVED ROUTINE PROFILE IS A PROPOSAL UNTIL EVERY PREREQUISITE IS MET.
 *
 * The operator commits `amabie.profiles.json` once: a narrow task type, its reviewed requirement text and
 * the sealed check that measures it. `amabie profile apply` is the deterministic controller:
 *
 *   MATCH           the task matches, the file is committed and unmodified, the script is sealed
 *                   -> the task is registered and the requirement bound/sealed, no manual JSON editing
 *   NO MATCH        a task the profile does not describe                  -> PROPOSAL ONLY, nothing written
 *   NOT SEALED      the profile names a script the sealed plan does not run -> PROPOSAL ONLY, nothing written
 *   WORKER EDIT     the committed profile was edited and not re-approved     -> PROPOSAL ONLY, nothing written
 *   UNCOMMITTED     a brand-new profile file nobody approved                 -> PROPOSAL ONLY, nothing written
 *
 *   node tooling/probes/routine-profile.mjs [--cli <main.js>]
 *
 * Fixtures live only in the OS temp dir. No model or provider is invoked. Prints PASS/FAIL; exit 0 only if
 * every expectation held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cliArg = process.argv.indexOf('--cli');
const cli = path.resolve(cliArg === -1 ? path.join(repo, 'apps/cli/dist/src/main.js') : process.argv[cliArg + 1]);

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-routine-profile-'));
const env = { ...process.env, AMABIE_TRUST_STORE: path.join(root, 'trust-store') };
delete env.AMABIE_ALLOW_CODEX_PROVIDER_USAGE;
delete env.AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE;

const run = (exe, args, cwd) => spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
const git = (cwd, args) => {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
};
const amabie = (cwd, args) => run(process.execPath, [cli, ...args], cwd);

const REQUIREMENT = 'Greet Grace with the special welcome.';
const IMPL = 'export const greet = name => `Welcome, ${name}!`;\n';
const TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greeting.mjs';\ntest('greets Grace', () => assert.equal(greet('Grace'), 'Welcome, Grace!'));\n";
const profileDoc = (over = {}) => JSON.stringify({
  schema: 'amabie-profiles/1',
  profiles: [{ id: 'greeting-fix', version: 1, kind: 'bugfix', match: 'greet(ing)?\\b', script: 'test', requirement: REQUIREMENT, ...over }],
}, null, 2) + '\n';

/** A sealed project; `profile` is committed before setup unless `commitProfile` is false. */
function project(name, { profile = profileDoc(), commitProfile = true, afterSetup } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `routine-profile-${name}`, type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'greeting.mjs'), IMPL);
  fs.writeFileSync(path.join(dir, 'greeting.test.mjs'), TEST);
  if (commitProfile) fs.writeFileSync(path.join(dir, 'amabie.profiles.json'), profile);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'probe@amabie.local']);
  git(dir, ['config', 'user.name', 'Routine Profile Probe']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'reviewed greeting check, implementation and routine profile']);
  const setup = amabie(dir, ['setup', '--yes']);
  if (setup.status !== 0 && setup.status !== 2) throw new Error(`setup failed in ${name}: ${setup.stdout}${setup.stderr}`);
  if (!commitProfile) fs.writeFileSync(path.join(dir, 'amabie.profiles.json'), profile);
  afterSetup?.(dir);
  return dir;
}

/** What a refused profile must leave untouched: the declaration surface and the task record. */
const snapshot = dir => ['package.json', path.join('.amabie', 'task', 'current.json')]
  .map(f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } }).join('\u0000');
const text = r => `${r.stdout}${r.stderr}`;

// ── MATCH ─────────────────────────────────────────────────────────────────────────
const match = project('match');
const listed = amabie(match, ['profile', 'list', 'Fix the greeting for Grace']);
check(/APPLICABLE greeting-fix/.test(listed.stdout) && listed.status === 0,
  'MATCH list: the matching profile is shown as applicable, read-only', text(listed).slice(0, 300));
const before = snapshot(match);
const applied = amabie(match, ['profile', 'apply', 'greeting-fix', 'Fix the greeting for Grace']);
const pkg = JSON.parse(fs.readFileSync(path.join(match, 'package.json'), 'utf8'));
const proofs = Object.values(pkg.amabie?.proofs ?? {});
check((applied.status === 0 || applied.status === 2) && proofs.length === 1 && proofs[0] === 'test',
  'MATCH apply: the task is registered and the reviewed requirement is bound to the sealed check, no manual JSON editing',
  `exit=${applied.status} proofs=${JSON.stringify(pkg.amabie?.proofs ?? null)} ${text(applied).slice(0, 400)}`);
check(snapshot(match) !== before && fs.existsSync(path.join(match, '.amabie', 'task', 'current.json')),
  'MATCH apply: a task record exists afterwards');
const again = amabie(match, ['profile', 'apply', 'greeting-fix', 'Fix the greeting for Grace']);
check(again.status === 0 && /already bound/.test(again.stdout),
  'MATCH repeat: an already bound routine task needs no second approval', `exit=${again.status} ${text(again).slice(0, 300)}`);

// ── PROPOSALS: nothing may be written ─────────────────────────────────────────────
function proposal(name, label, setupOpts, task = 'Fix the greeting for Grace') {
  const dir = project(name, setupOpts);
  const base = snapshot(dir);
  const r = amabie(dir, ['profile', 'apply', 'greeting-fix', task]);
  check(r.status === 2 && /PROPOSAL ONLY/.test(text(r)) && snapshot(dir) === base,
    label, `exit=${r.status} unchanged=${snapshot(dir) === base} ${text(r).slice(0, 300)}`);
}
proposal('no-match', 'NO MATCH: a task the profile does not describe stays a proposal and writes nothing', {}, 'Rewrite the billing page layout');
proposal('not-sealed', 'NOT SEALED: a profile naming a script the sealed plan does not run stays a proposal and writes nothing',
  { profile: profileDoc({ script: 'lint' }) });
proposal('worker-edit', 'WORKER EDIT: a committed profile modified since approval stays a proposal and writes nothing',
  { afterSetup: dir => fs.writeFileSync(path.join(dir, 'amabie.profiles.json'), profileDoc({ requirement: 'Anything passes.' })) });
proposal('uncommitted', 'UNCOMMITTED: a profile file nobody committed stays a proposal and writes nothing', { commitProfile: false });

fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(`RESULT: routine profile — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
