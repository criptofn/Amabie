import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runPlanStep } from '../src/check-runner.js';
import { pinPlanPrograms } from '../src/execution-environment.js';
import { type PlanStep } from '../src/project.js';
import { attributeStepFailure, projectVenv, validateToolchainDir, type AttributeInput } from '../src/sealed-toolchain.js';

/**
 * A virtualenv inside the repository: the right message when the pinned Python lacks the project's
 * packages, and one trust rule for an interpreter the worker can write — it runs only while it is the
 * very file the human sealed at setup.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-venv-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const WIN = process.platform === 'win32';
const MISSING = "ModuleNotFoundError: No module named 'pytest'";

/** A tiny runnable stand-in for an interpreter that exits with the given code. */
function fakeInterpreter(file: string, exitCode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, WIN ? `@exit /b ${exitCode}\r\n` : `#!/bin/sh\nexit ${exitCode}\n`);
  if (!WIN) fs.chmodSync(file, 0o755);
}
const interpreterName = WIN ? 'python.cmd' : 'python';
const venvBin = WIN ? 'Scripts' : 'bin';

function input(over: Partial<AttributeInput>): AttributeInput {
  return { kind: 'tests', script: 'pytest', exitCode: 1, output: MISSING, childPathDirs: [], vanishedDirs: [], seal: null, ...over };
}

test('a .venv or venv is detected with the layout and activation command of each platform', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const name of ['.venv', 'venv']) {
      const root = fs.mkdtempSync(path.join(TMP, 'detect-'));
      const python = platform === 'win32' ? path.join(root, name, 'Scripts', 'python.exe') : path.join(root, name, 'bin', 'python');
      fs.mkdirSync(path.dirname(python), { recursive: true });
      fs.writeFileSync(python, '');
      const venv = projectVenv(root, platform);
      assert.ok(venv, `${platform} ${name}`);
      assert.equal(venv.python, python);
      assert.equal(venv.activate, platform === 'win32' ? `${name}\\Scripts\\activate` : `source ${name}/bin/activate`);
      assert.equal(projectVenv(root, platform === 'win32' ? 'linux' : 'win32'), null, 'the other platform layout is not mistaken for this one');
    }
  }
  assert.equal(projectVenv(fs.mkdtempSync(path.join(TMP, 'none-'))), null);
});

test('a missing Python module with a virtualenv present says to activate it and run setup again', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'msg-'));
  fakeInterpreter(path.join(root, '.venv', venvBin, interpreterName), 0);
  const venv = { dir: path.join(root, '.venv'), python: path.join(root, '.venv', venvBin, interpreterName), activate: 'source .venv/bin/activate' };
  const outsidePython = path.join(os.tmpdir(), 'system', interpreterName);

  const wrong = attributeStepFailure(input({ program: outsidePython, venv }));
  assert.equal(wrong.cause, 'environment');
  assert.match(wrong.reason, /could not import "pytest"/);
  assert.match(wrong.reason, /not the active one when setup ran/);
  assert.match(wrong.next, /source \.venv\/bin\/activate.*amabie setup/);

  // The pinned interpreter IS the virtualenv's: the missing module is the project's own problem.
  assert.equal(attributeStepFailure(input({ program: venv.python, venv })).cause, 'project');
  // No virtualenv to point at: nothing to say beyond the project failing.
  assert.equal(attributeStepFailure(input({ program: outsidePython, venv: null })).cause, 'project');
});

test('an interpreter inside the repository is pinned with its identity; one outside is not', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'pin-'));
  const outside = fs.mkdtempSync(path.join(TMP, 'sys-'));
  fakeInterpreter(path.join(root, '.venv', venvBin, interpreterName), 0);
  fakeInterpreter(path.join(outside, interpreterName), 0);
  const plan: PlanStep[] = [{ kind: 'tests', script: 'pytest', argv: ['python', '-m', 'pytest'] }];
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path.join(root, '.venv', venvBin);
    const inRepo = pinPlanPrograms(plan, root);
    assert.deepEqual(inRepo.problems, []);
    assert.match(inRepo.plan[0]!.programId ?? '', /#[0-9a-f]{64}$/);

    process.env.PATH = outside;
    const sys = pinPlanPrograms(plan, root);
    assert.equal(sys.plan[0]!.programId, undefined, 'a program outside the repository keeps the plan bytes it always had');
  } finally { process.env.PATH = savedPath; }
});

test('a repo-resident interpreter runs while it is the sealed one and is refused once replaced', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'run-'));
  const file = path.join(root, '.venv', venvBin, interpreterName);
  fakeInterpreter(file, 0);
  const savedPath = process.env.PATH;
  let step: PlanStep;
  try {
    process.env.PATH = path.dirname(file);
    step = pinPlanPrograms([{ kind: 'tests', script: 'pytest', argv: ['python', 'x'] }], root).plan[0]!;
  } finally { process.env.PATH = savedPath; }
  assert.equal(runPlanStep(root, 'npm', step).ok, true, 'the sealed interpreter runs');

  fakeInterpreter(file, 7); // the worker swaps the interpreter for one that decides differently
  assert.throws(() => runPlanStep(root, 'npm', step), /not the one sealed at setup/);

  const unsealed: PlanStep = { kind: 'tests', script: 'pytest', argv: [file, 'x'] };
  assert.throws(() => runPlanStep(root, 'npm', unsealed), /did not record its identity/);
});

test('--toolchain-dir on a virtualenv inside the repository is refused with the way that works', () => {
  const root = fs.mkdtempSync(path.join(TMP, 'dir-'));
  const bin = path.join(root, '.venv', venvBin);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  const r = validateToolchainDir(root, bin);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.problem, /activate it in your own terminal and run `amabie setup`/);
  const plain = path.join(root, 'tools');
  fs.mkdirSync(plain);
  const p = validateToolchainDir(root, plain);
  assert.doesNotMatch(p.ok ? '' : p.problem, /activate/);
});
