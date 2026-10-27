import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { discriminationObligation, planDiscrimination, readConfig } from '../src/onboarding.js';

/**
 * The Express false proof: a baseline tree without the project's installed (git-ignored)
 * dependencies "failed" because its test runner was absent, and that failure was counted as the
 * checks catching the change. These fixtures install a real executable under node_modules/.bin
 * (the shape npm writes) and run it through the real sealed plan.
 */
const CLI = process.env.AMABIE_TEST_CLI ?? path.resolve(import.meta.dirname, '../src/main.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-baseline-dependencies-'));
process.env.AMABIE_TRUST_STORE = path.join(TMP, 'store');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MINI_RUNNER = [
  "const fs = require('fs'); const path = require('path');",
  "const dir = process.argv[2]; let pass = 0; let fail = 0;",
  "for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((x) => x.endsWith('.test.cjs')).sort()) {",
  "  for (const [name, fn] of Object.entries(require(path.resolve(dir, f)))) {",
  "    try { fn(); pass += 1; } catch (e) { fail += 1; console.log('  FAIL ' + name + ': ' + e.message); }",
  '  }',
  '}',
  "console.log('  ' + pass + ' passing'); if (fail) console.log('  ' + fail + ' failing');",
  'process.exit(fail ? 1 : 0);',
  '',
].join('\n');
const SOURCE = "module.exports = (n) => 'hello ' + n;\n";
const FIXED = "module.exports = (n) => 'hello ' + n.trimStart();\n";
const TEST = "const assert = require('node:assert/strict'); const greet = require('../greet.cjs');\nexports.greets = () => assert.equal(greet('Ada'), 'hello Ada');\n";
const REGRESSION = "const assert = require('node:assert/strict'); const greet = require('../greet.cjs');\nexports.trims = () => assert.equal(greet('  Ada'), 'hello Ada');\n";

function git(root: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function amabie(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
function write(root: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function commit(root: string) { git(root, 'add', '.'); git(root, 'commit', '--allow-empty', '-m', 'fixture'); }
function repo(name: string, scripts: Record<string, string>): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  write(root, 'package.json', JSON.stringify({ name, private: true, scripts }));
  write(root, '.gitignore', 'node_modules/\n.tool-ready\n');
  write(root, 'greet.cjs', SOURCE);
  write(root, 'tests/greet.test.cjs', TEST);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Amabie Regression'); git(root, 'config', 'user.email', 'regression@amabie.local');
  return root;
}
function seal(root: string) {
  commit(root);
  { const s = amabie(root, "setup", "--yes"); assert.equal(s.code, 0, s.out); }
  commit(root); { const s = amabie(root, "setup", "--yes"); assert.equal(s.code, 0, s.out); }
  const cfg = readConfig(root); assert.ok(cfg && cfg !== 'corrupt');
  return cfg;
}
/** An installed, git-ignored dependency with a bin, shaped like npm's own output (shim in node_modules/.bin). */
function installMiniRunner(root: string) {
  write(root, 'node_modules/mini-runner/package.json', JSON.stringify({ name: 'mini-runner', version: '1.0.0', bin: 'bin.js' }));
  write(root, 'node_modules/mini-runner/bin.js', MINI_RUNNER);
  const shim = path.join(root, 'node_modules/.bin/mini-runner');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(`${shim}.cmd`, `@ECHO off\r\n"${process.execPath}" "%~dp0\\..\\mini-runner\\bin.js" %*\r\n`);
  } else {
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/../mini-runner/bin.js" "$@"\n`, { mode: 0o755 });
  }
}
function dependencyProject(name: string) {
  const root = repo(name, { test: 'mini-runner tests' });
  installMiniRunner(root);
  return { root, cfg: seal(root) };
}

test('the sealed plan runs the installed dependency, and the baseline comparison sees the same one', () => {
  const { root, cfg } = dependencyProject('dependency-baseline');
  assert.ok(fs.existsSync(path.join(root, 'node_modules')) && git(root, 'ls-files', 'node_modules') === '', 'the dependency is untracked');
  write(root, 'greet.cjs', FIXED);
  const cmp = planDiscrimination(root, cfg, 60_000);
  assert.notEqual(cmp.basePassed, null, cmp.reason);
  assert.equal(cmp.basePassed, true, 'the unchanged tests pass on the base with its dependency, so they do not discriminate');
});

test('an ignored product change in a dependency-backed project is NOT PROVEN, never met', () => {
  const { root, cfg } = dependencyProject('dependency-unused-export');
  write(root, 'greet.cjs', SOURCE + 'module.exports.unusedHelper = () => 42;\n');
  const obligation = discriminationObligation(root, cfg, 60_000);
  assert.equal(obligation?.status, 'unproven');
  assert.match(obligation?.note ?? '', /pass on the base commit too/);
  const doctor = amabie(root, 'doctor');
  assert.equal(doctor.code, 2, doctor.out);
  assert.match(doctor.out, /NOT PROVEN/);
});

test('a vacuous new assertion beside an ignored change is NOT PROVEN, never met', () => {
  const { root, cfg } = dependencyProject('dependency-vacuous-test');
  write(root, 'greet.cjs', SOURCE + 'module.exports.unusedHelper = () => 42;\n');
  write(root, 'tests/vacuous.test.cjs', "exports.vacuous = () => require('node:assert').ok(true);\n");
  const obligation = discriminationObligation(root, cfg, 60_000);
  assert.equal(obligation?.status, 'unproven', obligation?.note);
  assert.match(obligation?.note ?? '', /pass on the base commit too/);
});

test('a genuinely discriminating change in a dependency-backed project still proves', () => {
  const { root, cfg } = dependencyProject('dependency-genuine');
  write(root, 'greet.cjs', FIXED);
  write(root, 'tests/trims.test.cjs', REGRESSION);
  const obligation = discriminationObligation(root, cfg, 60_000);
  assert.equal(obligation?.status, 'met', obligation?.note);
  assert.match(obligation?.note ?? '', /fail without this change/);
  assert.match(obligation?.caveat ?? '', /WRITTEN BY THE WORKER/, 'a worker-written discriminator keeps its provenance caveat');
});

test('baseline dependencies are a private copy: the live installation is not shared with the comparison run', () => {
  const { root, cfg } = dependencyProject('dependency-private');
  // A check that scribbles into its own node_modules must not reach the repository's installation.
  write(root, 'tests/scribble.test.cjs', "exports.scribble = () => require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'node_modules', 'scribbled.txt'), 'x');\n");
  write(root, 'greet.cjs', FIXED);
  planDiscrimination(root, cfg, 60_000);
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'scribbled.txt')), false);
});

test('workspace links in the copied dependencies resolve inside the baseline tree, not the candidate', { skip: process.platform === 'win32' && 'symlink creation needs privileges on this host' }, () => {
  const root = repo('dependency-workspace', { test: 'mini-runner tests' });
  write(root, 'packages/lib/package.json', JSON.stringify({ name: 'lib', version: '1.0.0', main: 'index.cjs' }));
  write(root, 'packages/lib/index.cjs', 'module.exports = () => 1;\n');
  installMiniRunner(root);
  fs.symlinkSync('../packages/lib', path.join(root, 'node_modules', 'lib'), 'dir');
  const cfg = seal(root);
  write(root, 'packages/lib/index.cjs', 'module.exports = () => 2;\n');
  write(root, 'tests/lib.test.cjs', "exports.lib = () => require('node:assert').equal(require('lib')(), 2);\n");
  const obligation = discriminationObligation(root, cfg, 60_000);
  assert.equal(obligation?.status, 'met', `the base must run its OWN packages/lib, so the new check fails there: ${obligation?.note}`);
});

/** A directory link that needs no privilege here: a junction on Windows (what npm workspaces write), a symlink elsewhere. */
function linkDir(target: string, at: string) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

test('an ABSOLUTE workspace link (a Windows junction) is rebased onto the baseline tree, never left pointing at the live source', () => {
  const root = repo('dependency-absolute-link', { test: 'mini-runner tests' });
  write(root, 'packages/lib/package.json', JSON.stringify({ name: 'lib', version: '1.0.0', main: 'index.cjs' }));
  write(root, 'packages/lib/index.cjs', 'module.exports = () => 1;\n');
  installMiniRunner(root);
  linkDir(path.join(root, 'packages', 'lib'), path.join(root, 'node_modules', 'lib'));
  const cfg = seal(root);
  write(root, 'packages/lib/index.cjs', 'module.exports = () => 2;\n');
  write(root, 'tests/lib.test.cjs', "exports.lib = () => require('node:assert').equal(require('lib')(), 2);\n");
  const obligation = discriminationObligation(root, cfg, 60_000);
  assert.equal(obligation?.status, 'met', `a link into the candidate would run the live lib (2) on the base and look vacuous: ${obligation?.note}`);
});

test('a dependency link that leaves the project makes the comparison INCONCLUSIVE with the way out, never a run against shared files', () => {
  const root = repo('dependency-outside-link', { test: 'mini-runner tests' });
  installMiniRunner(root);
  const store = path.join(TMP, 'shared-store', 'pkg');
  write(path.dirname(store), 'pkg/index.cjs', 'module.exports = 1;\n');
  linkDir(store, path.join(root, 'node_modules', 'shared'));
  const cfg = seal(root);
  write(root, 'greet.cjs', FIXED);
  write(root, 'tests/trims.test.cjs', REGRESSION);
  const cmp = planDiscrimination(root, cfg, 60_000);
  assert.equal(cmp.basePassed, null, cmp.reason);
  assert.match(cmp.reason, /node_modules\/shared points outside the project/);
  assert.match(cmp.reason, /install the dependencies inside the project/);
  const obligation = discriminationObligation(root, cfg, 60_000);
  assert.equal(obligation?.status, 'unproven');
  assert.match(obligation?.note ?? '', /points outside the project/);
});

/** A project whose test command cannot start in the baseline tree: its tool lives outside anything Amabie can materialize. */
function startFailureProject(name: string, baseline: string) {
  const root = repo(name, { test: 'node scripts/run.cjs' });
  write(root, 'scripts/run.cjs', [
    "const fs = require('fs');",
    `if (!fs.existsSync('.tool-ready')) { ${baseline} }`,
    "console.log('  1 passing');",
    '',
  ].join('\n'));
  write(root, '.tool-ready', '');
  return { root, cfg: seal(root) };
}

for (const [label, emit, cause] of [
  ['exit 127 with a shell "not found"', "console.error('sh: 1: mocha: not found'); process.exit(127);", /"mocha" was not found|could not be executed/],
  ['exit 126', "console.error('permission denied'); process.exit(126);", /could not be executed \(exit 126\)/],
  ['a shell not-found line behind an ordinary exit code', "console.error('sh: 1: mocha: not found'); process.exit(1);", /"mocha" was not found/],
  ['zero executed tests', "console.log('  0 passing (1ms)'); process.exit(1);", /no tests were executed/],
] as const) {
  test(`a baseline command that cannot run is UNESTABLISHED, not regression evidence: ${label}`, () => {
    const { root, cfg } = startFailureProject(`start-failure-${label.replace(/\W+/g, '-')}`, emit);
    write(root, 'greet.cjs', FIXED);
    const cmp = planDiscrimination(root, cfg, 60_000);
    assert.equal(cmp.basePassed, null, cmp.reason);
    assert.match(cmp.reason, cause);
    const obligation = discriminationObligation(root, cfg, 60_000);
    assert.equal(obligation?.status, 'unproven');
    assert.match(obligation?.note ?? '', /could not be established/);
    assert.doesNotMatch(obligation?.note ?? '', /fail without this change/);
  });
}

test('an unfamiliar reporter with no summary is not read as zero executed tests', () => {
  const { root, cfg } = startFailureProject('start-failure-unfamiliar', "console.log('custom reporter: 1 check failed'); process.exit(1);");
  write(root, 'greet.cjs', FIXED);
  assert.equal(planDiscrimination(root, cfg, 60_000).basePassed, false, 'a real, unrecognised failure still discriminates');
});
