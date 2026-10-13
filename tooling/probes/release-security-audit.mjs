import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScopeDeclaration, scopeDir } from '../../apps/cli/dist/src/project.js';
import { runPlanStep } from '../../apps/cli/dist/src/onboarding.js';
import { killTree } from '../../packages/support/dist/src/index.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-release-security-'));
let childPid;
try {
  const root = path.join(scratch, 'root');
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside', scripts: { test: 'node checks.cjs' } }));
  fs.symlinkSync(outside, path.join(root, 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  const declaration = ecosystem => JSON.stringify({ schema: 'amabie-scopes/1', scopes: [{ path: 'web', ecosystem }] });
  fs.writeFileSync(path.join(root, 'amabie.scopes.json'), declaration('node'));
  assert.match(readScopeDeclaration(root).problems.join(' '), /resolves outside this repository/);
  assert.throws(() => scopeDir(root, { kind: 'tests', script: 'test', scope: 'web' }), /resolves outside this repository/);
  console.log('PASS outside linked scope refused during discovery and execution');
  fs.writeFileSync(path.join(root, 'amabie.scopes.json'), declaration('__proto__'));
  assert.match(readScopeDeclaration(root).problems.join(' '), /is not one Amabie can model/);
  console.log('PASS inherited adapter name refused without a TypeError');

  const fixture = path.join(scratch, 'lifecycle');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'child.cjs'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(fixture, 'parent.cjs'), [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs'); const path = require('node:path');",
    "const child = spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { stdio: 'ignore' });",
    "fs.writeFileSync(path.join(__dirname, 'child.pid'), String(child.pid));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const result = runPlanStep(fixture, 'npm', {
    kind: 'tests', script: 'check', argv: [process.execPath, path.join(fixture, 'parent.cjs')], adapter: 'node',
  }, 2500);
  const pidFile = path.join(fixture, 'child.pid');
  assert.ok(fs.existsSync(pidFile), 'the fixture must start a descendant before the timeout');
  childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.equal(result.ok, false, 'a timeout never passes');
  const running = () => {
    try {
      process.kill(childPid, 0);
      if (process.platform !== 'win32' && fs.existsSync(`/proc/${childPid}/stat`)) {
        return !/\) Z /.test(fs.readFileSync(`/proc/${childPid}/stat`, 'utf8'));
      }
      return true;
    } catch { return false; }
  };
  for (let i = 0; i < 20 && running(); i++) await new Promise(resolve => setTimeout(resolve, 100));
  const alive = running();
  assert.equal(alive, false, 'timed-out everyday checks must not leave descendants alive');
  console.log('PASS timed-out everyday check refused and descendant cleaned up');
} finally {
  if (childPid) {
    // Cleanup is bounded even when the regression assertion detects the old defect.
    if (process.platform === 'win32') killTree(childPid);
    else { try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ } }
  }
  const temp = fs.realpathSync.native(os.tmpdir());
  const relative = path.relative(temp, fs.realpathSync.native(scratch));
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
