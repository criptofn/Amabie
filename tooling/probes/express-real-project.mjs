#!/usr/bin/env node
/**
 * A REAL, pinned Node project (expressjs/express) through the PRODUCT's regression gate.
 *
 * WHY: a baseline temp tree has no git-ignored node_modules, so `npm test` died there with
 * `sh: 1: mocha: not found` (exit 127) and that failure was counted as the checks catching the
 * change. Measured on this commit of Express before the fix: an unused export in lib/utils.js, or a
 * new `assert.ok(true)` test, received Stop PASS. Hand-built fixtures cannot show that the installed
 * executables of a real dependency tree (mocha and its ~hundreds of packages) are comparable on the base.
 *
 * Both entries are exercised: `doctor --json` (the exit code and the structured obligations) AND the real
 * hook sequence a Claude session produces — UserPromptSubmit, `amabie task --session`, then Stop
 * (`amabie checkpoint`, the entry that decides whether a completion is allowed).
 *
 * Needs network (git clone + npm install) and ~a few minutes; it is bounded by TIMEOUT_MS per command.
 * An unavailable clone or install is a named NOT-RUN (exit 3), which CI treats as a failure: a proof that
 * did not run is not a pass. Set AMABIE_EXPRESS_REPO to a local clone to avoid the network clone.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const EXPRESS_URL = 'https://github.com/expressjs/express.git';
const EXPRESS_COMMIT = '1c6f1b0fe4000977b9a7b4f34097e4d527dd9824';
const TIMEOUT_MS = 600_000;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(s, re, msg) { assert(re.test(s), `${msg}\n     expected /${re}/ in:\n     ${String(s).split('\n').slice(0, 24).join('\n     ')}`); }
function notRun(why) {
  console.log(`NOT-RUN  ${why}`);
  console.log('PROBE-NOT-RUN — the Express path was NOT executed here; this is not a pass');
  process.exit(3);
}

if (!fs.existsSync(CLI)) { console.error(`FAIL: missing built CLI (run npm run build): ${CLI}`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-express-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
// A human terminal: Amabie refuses operator actions (setup) inside an agent session.
const env = { ...process.env, AMABIE_TRUST_STORE: path.join(TMP, 'store') };
for (const marker of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[marker];

/** A command that did not run to a normal exit (spawn error, timeout, signal) is never an answer. */
function run(cwd, cmd, args, timeout = TIMEOUT_MS, input) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout, input, shell: process.platform === 'win32' && cmd === 'npm' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error || r.signal || r.status === null) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} did not finish (${r.error?.code ?? r.signal ?? 'no exit status'}):\n${out.slice(-600)}`);
  }
  return { code: r.status, out, stdout: r.stdout ?? '' };
}
const amabie = (cwd, ...args) => run(cwd, process.execPath, [CLI, ...args]);
const git = (cwd, ...args) => run(cwd, 'git', args, 300_000);
function mustGit(cwd, ...args) {
  const r = git(cwd, ...args);
  assert(r.code === 0, `git ${args.join(' ')} exited ${r.code}:\n${r.out.slice(-600)}`);
  return r;
}
function envelope(stdout) {
  const text = (stdout ?? '').trim();
  try { return JSON.parse(text); } catch { /* a leading prose line */ }
  for (const line of text.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line.trim()); } catch { /* keep looking */ }
  }
  return null;
}

const root = path.join(TMP, 'express');
const source = process.env.AMABIE_EXPRESS_REPO ?? EXPRESS_URL;
let head;
try {
  if (git(TMP, 'clone', '--quiet', source, root).code !== 0) notRun(`could not clone ${source}`);
  if (git(root, 'checkout', '--quiet', EXPRESS_COMMIT).code !== 0) notRun(`${EXPRESS_COMMIT} is not available in ${source}`);
  head = git(root, 'rev-parse', 'HEAD').out.trim();
} catch (e) { notRun(String(e.message).split('\n')[0]); }
assert(head === EXPRESS_COMMIT, `pinned commit mismatch: ${head}`);
let install;
try { install = run(root, 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts']); } catch (e) { notRun(String(e.message).split('\n')[0]); }
if (install.code !== 0) notRun(`npm install failed: ${install.out.slice(-300)}`);
assert(fs.existsSync(path.join(root, 'node_modules', '.bin')), 'mocha is installed under node_modules/.bin');
assert(mustGit(root, 'ls-files', 'node_modules').out.trim() === '', 'node_modules is untracked, as in a real working copy');

fs.mkdirSync(path.join(root, '.claude'), { recursive: true }); // the repository declares its harness
mustGit(root, 'config', 'user.name', 'Amabie Express Probe');
mustGit(root, 'config', 'user.email', 'probe@amabie.local');

check('setup seals Express and reports READY (npm test runs mocha from the installed dependencies)', () => {
  const first = amabie(root, 'setup', '--yes');
  assert(first.code === 0, `setup #1 exited ${first.code}:\n${first.out.slice(-1500)}`);
  mustGit(root, 'add', '-A'); mustGit(root, 'commit', '--quiet', '--allow-empty', '-m', 'amabie setup');
  const second = amabie(root, 'setup', '--yes');
  assert(second.code === 0, `setup #2 exited ${second.code}:\n${second.out.slice(-1500)}`);
  assertMatch(second.out, /READY/, 'setup did not report READY');
  mustGit(root, 'add', '-A'); mustGit(root, 'commit', '--quiet', '--allow-empty', '-m', 'amabie sealed');
});
assert(failures === 0, 'setup failed, so no later check can mean anything');

function reset() { mustGit(root, 'reset', '--hard', '--quiet', 'HEAD'); mustGit(root, 'clean', '-fdq', '-e', 'node_modules'); }
function append(file, text) { fs.appendFileSync(path.join(root, file), text); }

let sessionCounter = 0;
/**
 * The real completion path: a user prompt opens a request in a session, the agent registers the task
 * (`amabie task --session`, the CLI form of mcp__amabie__amabie_task), the change is made, and then
 * Stop (`amabie checkpoint`) is the entry that allows or blocks the completion.
 */
function stopAfter(change) {
  reset();
  const session = `express-probe-session-${++sessionCounter}`;
  const prompt = run(root, process.execPath, [CLI, 'checkpoint'], 120_000, JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, session_id: session, prompt: 'Add a small helper to Express.' }));
  assert(prompt.code === 0 && envelope(prompt.stdout)?.decision !== 'block', `UserPromptSubmit did not open the request:\n${prompt.out.slice(-600)}`);
  const task = amabie(root, 'task', 'Add a small helper to Express.', '--session', session);
  assert(task.code === 0, `task registration exited ${task.code}:\n${task.out.slice(-600)}`);
  change();
  const doctor = amabie(root, 'doctor', '--json');
  const stop = run(root, process.execPath, [CLI, 'checkpoint'], TIMEOUT_MS, JSON.stringify({ hook_event_name: 'Stop', cwd: root, session_id: session, stop_hook_active: false }));
  const d = envelope(doctor.stdout);
  const s = envelope(stop.stdout);
  assert(d !== null, `doctor --json printed no envelope (exit ${doctor.code}):\n${doctor.out.slice(-800)}`);
  assert(stop.code === 0, `Stop (checkpoint) exited ${stop.code}; a hook that crashes is not an answer:\n${stop.out.slice(-800)}`);
  assert(s !== null, `Stop printed no JSON envelope:\n${stop.out.slice(-800)}`);
  return { doctor: d, doctorCode: doctor.code, doctorOut: doctor.out, stop: s };
}
const regression = (d) => (d.proof?.obligations ?? []).find((ob) => ob.id === 'regression-evidence');

function assertNotProven(r) {
  assert(r.doctorCode === 2, `doctor: expected exit 2 (NOT PROVEN), got ${r.doctorCode}:\n${r.doctorOut.slice(-1500)}`);
  assert(r.doctor.status === 'NOT PROVEN', `doctor: expected status NOT PROVEN, got ${String(r.doctor.status)}`);
  assertMatch(r.doctorOut, /pass on the base commit too/, 'the reason must be that the sealed checks also pass on the base');
  assert(!/mocha: not found|was not found/.test(r.doctorOut), 'the base must have run mocha, not failed to start it');
  assert(regression(r.doctor)?.status === 'unproven', `regression-evidence must be unproven, got ${JSON.stringify(regression(r.doctor))}`);
  assert(r.stop.decision === 'block', `Stop must BLOCK the completion, got ${JSON.stringify(r.stop).slice(0, 400)}`);
  assertMatch(String(r.stop.reason ?? ''), /NOT PROVEN/, 'the Stop reason must say NOT PROVEN');
}

check('an unused export in lib/utils.js is NOT PROVEN at doctor (exit 2) and BLOCKED at Stop (the measured false proof)', () => {
  assertNotProven(stopAfter(() => append('lib/utils.js', '\nexports.unusedHelper = () => 42;\n')));
});

check('a new vacuous assert.ok(true) test beside an ignored change is NOT PROVEN at doctor and BLOCKED at Stop', () => {
  assertNotProven(stopAfter(() => {
    append('lib/utils.js', '\nexports.unusedHelper = () => 42;\n');
    fs.writeFileSync(path.join(root, 'test', 'zz-vacuous.js'), "'use strict'\nconst assert = require('node:assert')\ndescribe('vacuous', function () { it('is true', function () { assert.ok(true) }) })\n");
  }));
});

check('a genuine change with a test that fails without it proves: READY at doctor, allowed at Stop, with the worker-authored caveat', () => {
  const r = stopAfter(() => {
    append('lib/utils.js', '\nexports.amabieProbeShout = (s) => String(s).toUpperCase();\n');
    fs.writeFileSync(path.join(root, 'test', 'zz-shout.js'), "'use strict'\nconst assert = require('node:assert')\nconst utils = require('../lib/utils')\ndescribe('amabieProbeShout', function () { it('upper-cases', function () { assert.strictEqual(utils.amabieProbeShout('ok'), 'OK') }) })\n");
  });
  assert(r.doctorCode === 0, `doctor: expected exit 0, got ${r.doctorCode}:\n${r.doctorOut.slice(-1500)}`);
  assert(r.doctor.status === 'READY', `doctor: expected status READY, got ${String(r.doctor.status)}`);
  const ob = regression(r.doctor);
  assert(ob?.status === 'met', `regression-evidence must be met, got ${JSON.stringify(ob)}`);
  assertMatch(String(ob.caveat ?? ''), /worker/i, 'the met obligation must carry the worker-authored provenance caveat');
  assert(!/pass on the base commit too/.test(r.doctorOut), 'the new test must fail on the base commit');
  assert(r.stop.decision !== 'block', `Stop must ALLOW a proven completion, got ${JSON.stringify(r.stop).slice(0, 400)}`);
  assertMatch(String(r.stop.systemMessage ?? ''), /zz-shout\.js/, 'the Stop allow must name the worker-written check');
  assertMatch(String(r.stop.systemMessage ?? ''), /worker/i, 'the Stop allow must say the evidence is the worker\'s');
});

if (failures > 0) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nPROBE-PASS — Express at the pinned commit: ignored changes are NOT PROVEN (doctor) and blocked (Stop); a genuine discriminating change is READY, met, and allowed with its caveat');
