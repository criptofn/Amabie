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
 * Needs network (git clone + npm install) and ~a few minutes; it is bounded by TIMEOUT_MS per command
 * and exits 3 (named SKIP) when the clone or install is unavailable. It never passes by not running.
 * Set AMABIE_EXPRESS_REPO to a local clone to avoid the network clone.
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
function skip(why) {
  console.log(`SKIP  ${why}`);
  console.log('PROBE-PASS-WITH-SKIP — the Express path was NOT executed here');
  process.exit(3);
}

if (!fs.existsSync(CLI)) { console.error(`FAIL: missing built CLI (run npm run build): ${CLI}`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-express-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
// A human terminal: Amabie refuses operator actions (setup) inside an agent session.
const env = { ...process.env, AMABIE_TRUST_STORE: path.join(TMP, 'store') };
delete env.CLAUDECODE; delete env.AI_AGENT;

function run(cwd, cmd, args, timeout = TIMEOUT_MS) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout, shell: process.platform === 'win32' && cmd === 'npm' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const amabie = (cwd, ...args) => run(cwd, process.execPath, [CLI, ...args]);
const git = (cwd, ...args) => run(cwd, 'git', args, 300_000);

const root = path.join(TMP, 'express');
const source = process.env.AMABIE_EXPRESS_REPO ?? EXPRESS_URL;
if (git(TMP, 'clone', '--quiet', source, root).code !== 0) skip(`could not clone ${source}`);
if (git(root, 'checkout', '--quiet', EXPRESS_COMMIT).code !== 0) skip(`${EXPRESS_COMMIT} is not available in ${source}`);
const head = git(root, 'rev-parse', 'HEAD').out.trim();
assert(head === EXPRESS_COMMIT, `pinned commit mismatch: ${head}`);
const install = run(root, 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts']);
if (install.code !== 0) skip(`npm install failed: ${install.out.slice(-300)}`);
assert(fs.existsSync(path.join(root, 'node_modules', '.bin')), 'mocha is installed under node_modules/.bin');
assert(git(root, 'ls-files', 'node_modules').out.trim() === '', 'node_modules is untracked, as in a real working copy');

fs.mkdirSync(path.join(root, '.claude'), { recursive: true }); // the repository declares its harness
git(root, 'config', 'user.name', 'Amabie Express Probe'); git(root, 'config', 'user.email', 'probe@amabie.local');

check('setup seals Express and reports READY (npm test runs mocha from the installed dependencies)', () => {
  const first = amabie(root, 'setup', '--yes');
  assert(first.code === 0, `setup #1 exited ${first.code}:\n${first.out.slice(-1500)}`);
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '--allow-empty', '-m', 'amabie setup');
  const second = amabie(root, 'setup', '--yes');
  assert(second.code === 0, `setup #2 exited ${second.code}:\n${second.out.slice(-1500)}`);
  assertMatch(second.out, /READY/, 'setup did not report READY');
  git(root, 'add', '-A'); git(root, 'commit', '--quiet', '--allow-empty', '-m', 'amabie sealed');
});

function reset() { git(root, 'reset', '--hard', '--quiet', 'HEAD'); git(root, 'clean', '-fdq', '-e', 'node_modules'); }
function append(file, text) { fs.appendFileSync(path.join(root, file), text); }
function doctor() { return amabie(root, 'doctor'); }

check('an unused export in lib/utils.js is NOT PROVEN, not met (the measured false proof)', () => {
  reset();
  append('lib/utils.js', '\nexports.unusedHelper = () => 42;\n');
  const d = doctor();
  assert(d.code === 2, `expected exit 2 (NOT PROVEN), got ${d.code}:\n${d.out.slice(-1500)}`);
  assertMatch(d.out, /NOT PROVEN/, 'doctor must say NOT PROVEN');
  assertMatch(d.out, /pass on the base commit too/, 'the reason must be that the sealed checks also pass on the base');
  assert(!/mocha: not found|was not found/.test(d.out), 'the base must have run mocha, not failed to start it');
});

check('a new vacuous assert.ok(true) test beside an ignored change is NOT PROVEN', () => {
  reset();
  append('lib/utils.js', '\nexports.unusedHelper = () => 42;\n');
  fs.writeFileSync(path.join(root, 'test', 'zz-vacuous.js'), "'use strict'\nconst assert = require('node:assert')\ndescribe('vacuous', function () { it('is true', function () { assert.ok(true) }) })\n");
  const d = doctor();
  assert(d.code === 2, `expected exit 2 (NOT PROVEN), got ${d.code}:\n${d.out.slice(-1500)}`);
  assertMatch(d.out, /NOT PROVEN/, 'doctor must say NOT PROVEN');
});

check('a genuine change with a test that fails without it still proves (and names the worker-authored test)', () => {
  reset();
  append('lib/utils.js', '\nexports.amabieProbeShout = (s) => String(s).toUpperCase();\n');
  fs.writeFileSync(path.join(root, 'test', 'zz-shout.js'), "'use strict'\nconst assert = require('node:assert')\nconst utils = require('../lib/utils')\ndescribe('amabieProbeShout', function () { it('upper-cases', function () { assert.strictEqual(utils.amabieProbeShout('ok'), 'OK') }) })\n");
  const d = doctor();
  assert(!/NOT PROVEN/.test(d.out) || /WRITTEN BY THE WORKER|written by the worker/i.test(d.out), `unexpected verdict:\n${d.out.slice(-1500)}`);
  assertMatch(d.out, /worker/i, 'a worker-written discriminator must keep its provenance caveat');
  assert(!/pass on the base commit too/.test(d.out), 'the new test must fail on the base commit');
});

if (failures > 0) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nPROBE-PASS — Express at the pinned commit: ignored changes are NOT PROVEN; a genuine discriminating change proves');
