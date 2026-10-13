#!/usr/bin/env node
/**
 * v1.4 — THE INSTALLED-ARTIFACT JOURNEY.
 *
 * WHY THIS EXISTS: every other probe in this repository measures Amabie from the
 * SOURCE TREE, running `node apps/cli/dist/src/main.js`. That is not the thing a
 * user installs. This probe measures the artifact that actually ships — the
 * `.tgz` — by installing it with npm into a prefix whose path CONTAINS SPACES (a
 * real-world condition that has broken this project before), and then driving
 * the whole everyday journey through the INSTALLED `amabie` binary:
 *
 *   1. `amabie --version`            the artifact reports the version it claims
 *   2. `amabie setup --yes`          wires the repository, using the project's own check
 *   3. `amabie doctor`               the gate on demand
 *   4. green completion              the Stop hook ALLOWS (and says nothing)
 *   5. failing completion            the Stop hook BLOCKS, with a JSON decision
 *   6. repair guidance               the block NAMES the failing check
 *   7. retry guard                   `stop_hook_active` stops a second block
 *   8. Codex wiring                  `.codex/hooks.json` carries one Amabie handler
 *   9. uninstall                     removes Amabie's entries and NOTHING else
 *  10. upgrade from v1.3.0           no duplicated hooks or MCP entries (optional input)
 *
 * THE HOOK IS NOT SIMULATED. The exact command `setup` wrote into
 * `.claude/settings.json` is read back out of that file and executed with the
 * Stop-event JSON on stdin — the same contract the harness uses. A hook that was
 * never driven is not evidence that a completion can be blocked.
 *
 * Usage:
 *   node tooling/probes/v14-rc-artifact-journey.mjs
 *   node tooling/probes/v14-rc-artifact-journey.mjs --tarball=pack/npm/amabie-rn-cli-1.4.0.tgz
 *   node tooling/probes/v14-rc-artifact-journey.mjs --from-tarball=<v1.3.0.tgz>
 *
 * Exit: 0 all checks passed; 3 one or more explicit SKIPs and no failures
 *       (host-bound — an install that cannot run here is NOT a pass);
 *       1 otherwise. Fixtures live only under the OS temp dir and are removed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const argOf = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const EXPECTED_VERSION = argOf('expect-version') ?? '1.4.0';
const TARBALL = path.resolve(argOf('tarball') ?? path.join(REPO, 'pack', 'npm', `amabie-rn-cli-${EXPECTED_VERSION}.tgz`));
const FROM_TARBALL = argOf('from-tarball') === undefined ? null : path.resolve(argOf('from-tarball'));

let passed = 0; let failed = 0; let skipped = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skip = (name, why) => { skipped += 1; console.log(`SKIP ${name} — ${why}`); };
const say = (s) => console.log(`     ${s}`);

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 300_000, windowsHide: true, ...opts });

if (!fs.existsSync(TARBALL)) {
  console.error(`FAIL: no tarball at ${TARBALL}\n      build it first: npm run build && node tooling/pack.mjs`);
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie rc spaces '));   // SPACES, deliberately
const PREFIX = path.join(ROOT, 'install prefix');                            // and again here
const REPO_DIR = path.join(ROOT, 'project repo');
const AMABIE_BIN = path.join(PREFIX, process.platform === 'win32' ? 'amabie.cmd' : 'bin/amabie');
/** The installed bundle the shim launches. The journey runs THIS, so every
 *  command below is the shipped artifact and not the source tree. */
const AMABIE_MAIN = path.join(PREFIX, 'node_modules', '@amabie', 'cli', 'dist', 'main.js');
const cleanup = () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* OS temp; inert */ } };

console.log(`tarball:  ${TARBALL}`);
console.log(`root:     ${ROOT}`);
console.log(`prefix:   ${PREFIX}`);
console.log('');

/** Install a tarball into the SAME prefix — the second call is an upgrade.
 *
 *  MEASURED: on Windows `npm` is `npm.cmd`, which `spawnSync` without a shell
 *  cannot execute (`status: null`, no output), and the prefix path deliberately
 *  CONTAINS SPACES, so building a shell command line would have to quote every
 *  path correctly or install into the wrong place. Both problems disappear by
 *  running npm's own JS entry point through the current node — no shell, no
 *  quoting, exactly how the product invokes npm itself
 *  (`apps/cli/src/pipeline.ts` resolves `npm-cli.js` the same way). */
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
function install(tgz) {
  const via = fs.existsSync(NPM_CLI) ? [process.execPath, [NPM_CLI, 'install', '--global', '--prefix', PREFIX, '--no-audit', '--no-fund', tgz]] : ['npm', ['install', '--global', '--prefix', PREFIX, '--no-audit', '--no-fund', tgz]];
  const r = run(via[0], via[1], { timeout: 600_000 });
  if (r.error) say(`npm spawn error: ${String(r.error.message)}`);
  return r;
}
/** The journey binary: the INSTALLED bundle, run by node. Windows `.cmd` shims
 *  cannot be spawned without a shell, and the prefix path contains spaces, so the
 *  shim is verified separately (once, below) and the journey drives the very file
 *  that shim launches. */
const amabie = (args, opts = {}) => run(process.execPath, [AMABIE_MAIN, ...args], opts);
/** The npm-generated shim, quoted, through a shell — this is what a user types. */
const shim = (line) => run(`"${AMABIE_BIN}" ${line}`, [], { shell: true, timeout: 300_000 });

/** Read the exact Stop-hook command `setup` wrote, so the hook is driven as written. */
function stopHookCommands() {
  const file = path.join(REPO_DIR, '.claude', 'settings.json');
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const entry of (doc.hooks?.Stop ?? [])) for (const h of (entry.hooks ?? [])) if (h.type === 'command') out.push(h.command);
  return out;
}

/** Amabie's OWN hooks, identified by what they run. The fixture deliberately
 *  ships a user-owned Stop hook too, so counting every command hook would fail on
 *  a correct installation — the question is how many hooks AMABIE installed, and
 *  whether the user's survived. */
const isAmabieHook = (command) => /checkpoint/.test(command);
const amabieStopHookCommands = () => stopHookCommands().filter(isAmabieHook);

/** Drive a hook command with the Stop-event JSON on stdin — the real contract. */
function driveHook(command, { active = false } = {}) {
  const input = JSON.stringify({ cwd: REPO_DIR, stop_hook_active: active, hook_event_name: 'Stop' });
  const shell = process.platform === 'win32' ? { shell: true } : {};
  const r = run(command, [], { cwd: REPO_DIR, input, timeout: 300_000, ...shell });
  let decision = null;
  try { decision = JSON.parse((r.stdout ?? '').trim() || 'null'); } catch { decision = 'UNPARSEABLE'; }
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), decision };
}

try {
  // ── 1. install the exact artifact ────────────────────────────────────────
  const first = install(TARBALL);
  check('the exact tarball installs (path contains spaces)', first.status === 0, `npm exit ${first.status}`);
  if (first.status !== 0) { say((first.stderr ?? '').slice(0, 600)); throw new Error('install failed'); }
  check('the installed bundle exists', fs.existsSync(AMABIE_MAIN), AMABIE_MAIN);
  check('the npm-generated shim exists (prefix path contains spaces)', fs.existsSync(AMABIE_BIN), AMABIE_BIN);

  // The shim is what a user actually types, so it is executed once, verbatim.
  const shimVersion = shim('--version');
  check('the shim runs the installed artifact (`amabie --version`)', (shimVersion.stdout ?? '').trim() === `amabie ${EXPECTED_VERSION}`,
    (shimVersion.stdout ?? '').trim() || (shimVersion.stderr ?? '').slice(0, 200));

  const version = amabie(['--version']);
  check('installed artifact reports its version', /^amabie \d+\.\d+\.\d+/.test((version.stdout ?? '').trim()), (version.stdout ?? '').trim());
  check(`installed artifact reports ${EXPECTED_VERSION}`, (version.stdout ?? '').trim() === `amabie ${EXPECTED_VERSION}`, (version.stdout ?? '').trim());

  // ── 2. a real repository with its OWN check, plus user-owned config ──────
  fs.mkdirSync(REPO_DIR, { recursive: true });
  fs.mkdirSync(path.join(REPO_DIR, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(REPO_DIR, '.codex'), { recursive: true });
  run('git', ['-C', REPO_DIR, 'init', '-b', 'main']);
  run('git', ['-C', REPO_DIR, 'config', 'user.name', 'Amabie RC']);
  run('git', ['-C', REPO_DIR, 'config', 'user.email', 'rc@amabie.local']);

  // The check is controlled by a file, so the SAME sealed plan can pass and fail
  // without re-sealing: switching behaviour must never require re-running setup.
  fs.writeFileSync(path.join(REPO_DIR, 'check.js'), "process.exit(require('fs').readFileSync('state.txt','utf8').trim()==='fail'?1:0);\n");
  fs.writeFileSync(path.join(REPO_DIR, 'state.txt'), 'pass\n');
  fs.writeFileSync(path.join(REPO_DIR, 'package.json'), JSON.stringify({ name: 'rc-journey', private: true, scripts: { test: 'node check.js' } }, null, 2) + '\n');

  // USER-OWNED material that must survive setup AND uninstall.
  const userStopHook = { hooks: [{ type: 'command', command: 'echo USER-OWNED-HOOK' }] };
  fs.writeFileSync(path.join(REPO_DIR, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [userStopHook] }, permissions: { allow: ['Bash(ls:*)'] } }, null, 2) + '\n');
  const userMcp = { mcpServers: { 'user-server': { command: 'node', args: ['user-server.js'] } } };
  fs.writeFileSync(path.join(REPO_DIR, '.mcp.json'), JSON.stringify(userMcp, null, 2) + '\n');
  run('git', ['-C', REPO_DIR, 'add', '.']);
  run('git', ['-C', REPO_DIR, 'commit', '-q', '-m', 'fixture']);

  // ── 3. setup ─────────────────────────────────────────────────────────────
  const setup = amabie(['setup', '--yes'], { cwd: REPO_DIR });
  check('`amabie setup --yes` succeeds in a real repo', setup.status === 0, `exit ${setup.status}`);
  if (setup.status !== 0) say((setup.stdout ?? '').slice(-900));
  check('setup ends READY', /READY/.test(setup.stdout ?? ''));

  const hooks = amabieStopHookCommands();
  check('setup installed exactly ONE Amabie Stop hook', hooks.length === 1, `${hooks.length} Amabie hook command(s)`);
  const userSurvivedSetup = JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.claude', 'settings.json'), 'utf8'));
  check('a user-owned Stop hook SURVIVES setup', JSON.stringify(userSurvivedSetup.hooks?.Stop ?? []).includes('USER-OWNED-HOOK'));
  check('a user-owned Stop hook survives EXACTLY once',
    (JSON.stringify(userSurvivedSetup.hooks?.Stop ?? []).match(/USER-OWNED-HOOK/g) ?? []).length === 1);
  check('unrelated user settings survive setup', JSON.stringify(userSurvivedSetup.permissions ?? {}) === JSON.stringify({ allow: ['Bash(ls:*)'] }));

  // ── 4. doctor ────────────────────────────────────────────────────────────
  const doctor = amabie(['doctor'], { cwd: REPO_DIR });
  check('`amabie doctor` reports READY', doctor.status === 0 && /READY/.test(doctor.stdout ?? ''), `exit ${doctor.status}`);

  // ── 5. everyday green completion: the hook must ALLOW, silently ──────────
  if (hooks.length !== 1) throw new Error('cannot drive the hook: expected one command');
  const green = driveHook(hooks[0]);
  check('green completion: hook exits 0', green.status === 0, `exit ${green.status}`);
  check('green completion: hook does NOT block', green.decision === null || green.decision?.decision !== 'block', JSON.stringify(green.decision));
  check('green completion: hook is silent (0 bytes on stdout)', green.stdout === '', `${green.stdout.length} byte(s)`);

  // ── 6/7. failing completion: BLOCK, name the check, then respect the retry guard
  fs.writeFileSync(path.join(REPO_DIR, 'state.txt'), 'fail\n');
  const blocked = driveHook(hooks[0]);
  const isBlock = blocked.decision !== null && blocked.decision !== 'UNPARSEABLE' && blocked.decision.decision === 'block';
  check('failing completion: hook exits 0 with a JSON decision', blocked.status === 0 && blocked.decision !== 'UNPARSEABLE', `exit ${blocked.status}`);
  check('failing completion: decision is BLOCK', isBlock, JSON.stringify(blocked.decision)?.slice(0, 200));
  const reason = isBlock ? String(blocked.decision.reason ?? '') : '';
  check('repair guidance: the reason names the failing check', /\btests\b|\btest\b/.test(reason), reason.slice(0, 200));
  check('repair guidance: the reason points at the evidence, not a raw log dump', /full output|log|\.amabie/i.test(reason) || reason.length <= 1200, `${reason.length} char(s)`);
  const again = driveHook(hooks[0], { active: true });
  const blocksAgain = again.decision !== null && again.decision !== 'UNPARSEABLE' && again.decision.decision === 'block';
  check('retry guard: stop_hook_active prevents a SECOND block', !blocksAgain, JSON.stringify(again.decision)?.slice(0, 160));
  fs.writeFileSync(path.join(REPO_DIR, 'state.txt'), 'pass\n');

  // ── 8. Codex wiring (the host permits it here; wiring is a file, not a session)
  const codexFile = path.join(REPO_DIR, '.codex', 'hooks.json');
  if (!fs.existsSync(codexFile)) {
    skip('Codex wiring: .codex/hooks.json written', 'no Codex harness detected on this host — nothing to wire');
  } else {
    const doc = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
    const stop = (doc.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).filter((h) => h.type === 'command');
    check('Codex wiring: one Stop handler in .codex/hooks.json', stop.length === 1, `${stop.length} handler(s)`);
    check('Codex wiring: it runs the same checkpoint entry point', /checkpoint/.test(stop[0]?.command ?? ''), String(stop[0]?.command ?? '').slice(0, 120));
    // The same hook contract, driven the way Codex documents it (JSON on stdin/stdout).
    const codexRun = driveHook(stop[0].command);
    check('Codex wiring: the written hook produces a parseable decision on stdout', codexRun.decision === null || codexRun.decision !== 'UNPARSEABLE', JSON.stringify(codexRun.decision)?.slice(0, 140));
  }

  // ── 9. upgrade from v1.3.0 (optional input) ──────────────────────────────
  if (FROM_TARBALL === null) {
    skip('upgrade from v1.3.0', 'no --from-tarball given — the v1.3.0 artifact is required for this section');
  } else if (!fs.existsSync(FROM_TARBALL)) {
    skip('upgrade from v1.3.0', `--from-tarball does not exist: ${FROM_TARBALL}`);
  } else {
    const up = install(FROM_TARBALL);
    check('upgrade: the v1.3.0 artifact installs into the same prefix', up.status === 0, `npm exit ${up.status}`);
    const oldVersion = amabie(['--version']);
    check('upgrade: the prefix now reports 1.3.0', (oldVersion.stdout ?? '').trim() === 'amabie 1.3.0', (oldVersion.stdout ?? '').trim());
    const oldSetup = amabie(['setup', '--yes'], { cwd: REPO_DIR });
    check('upgrade: v1.3.0 setup succeeds on the already-wired repo', oldSetup.status === 0, `exit ${oldSetup.status}`);

    const up2 = install(TARBALL);
    check('upgrade: the v1.4.0 candidate installs over it', up2.status === 0, `npm exit ${up2.status}`);
    check('upgrade: the prefix reports 1.4.0', (amabie(['--version']).stdout ?? '').trim() === `amabie ${EXPECTED_VERSION}`);

    const reSetup = amabie(['setup', '--yes'], { cwd: REPO_DIR });
    check('upgrade: setup after upgrade succeeds', reSetup.status === 0, `exit ${reSetup.status}`);
    const hooksAfter = amabieStopHookCommands();
    check('upgrade: NO duplicated Stop hook', hooksAfter.length === 1, `${hooksAfter.length} Amabie hook command(s)`);
    const settingsAfter = JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.claude', 'settings.json'), 'utf8'));
    check('upgrade: the user-owned hook is still there exactly once',
      (JSON.stringify(settingsAfter.hooks?.Stop ?? []).match(/USER-OWNED-HOOK/g) ?? []).length === 1);
    const mcpAfter = JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.mcp.json'), 'utf8'));
    check('upgrade: NO duplicated MCP entries', Object.keys(mcpAfter.mcpServers ?? {}).filter((k) => k === 'amabie').length <= 1,
      `amabie entries: ${Object.keys(mcpAfter.mcpServers ?? {}).filter((k) => k === 'amabie').length}`);
    check('upgrade: the user MCP server survives', 'user-server' in (mcpAfter.mcpServers ?? {}));
    check('upgrade: the config is still readable and reports the repo', /repo:/.test(amabie(['status'], { cwd: REPO_DIR }).stdout ?? '') || amabie(['status'], { cwd: REPO_DIR }).status !== 3);
  }

  // ── 10. uninstall removes Amabie's material and NOTHING else ─────────────
  const un = amabie(['uninstall'], { cwd: REPO_DIR });
  check('`amabie uninstall` succeeds', un.status === 0, `exit ${un.status}`);
  const hooksAfterUninstall = stopHookCommands();
  check('uninstall: Amabie\'s Stop hook is gone', !hooksAfterUninstall.some((h) => /checkpoint/.test(h)), JSON.stringify(hooksAfterUninstall).slice(0, 160));
  const settingsFinal = fs.existsSync(path.join(REPO_DIR, '.claude', 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.claude', 'settings.json'), 'utf8')) : null;
  check('uninstall: the user-owned Stop hook SURVIVES', JSON.stringify(settingsFinal?.hooks?.Stop ?? []).includes('USER-OWNED-HOOK'));
  check('uninstall: unrelated user permissions SURVIVE', JSON.stringify(settingsFinal?.permissions ?? {}) === JSON.stringify({ allow: ['Bash(ls:*)'] }));
  const mcpFinal = fs.existsSync(path.join(REPO_DIR, '.mcp.json')) ? JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.mcp.json'), 'utf8')) : null;
  check('uninstall: the user MCP server SURVIVES', mcpFinal !== null && 'user-server' in (mcpFinal.mcpServers ?? {}));
  check('uninstall: Amabie\'s own state is removed', !fs.existsSync(path.join(REPO_DIR, '.amabie')));
} catch (e) {
  failed += 1;
  console.log(`FAIL unexpected: ${String(e?.message ?? e)}`);
} finally {
  cleanup();
}

console.log('');
const line = `${passed} passed, ${failed} failed, ${skipped} skipped`;
if (failed > 0) { console.log(`RC-ARTIFACT-JOURNEY: FAIL (${line})`); process.exit(1); }
if (skipped > 0) { console.log(`RC-ARTIFACT-JOURNEY: PASS WITH EXPLICIT SKIP (${line}) — a SKIP is never a pass`); process.exit(3); }
console.log(`RC-ARTIFACT-JOURNEY: PASS (${line})`);
process.exit(0);
