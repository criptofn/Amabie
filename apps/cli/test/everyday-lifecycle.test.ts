import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, it, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
// Tests execute from dist/test; keep the shared test helper in the source tree.
const { cleanupOwnedFixture } = await import(new URL('../../../../tooling/test-support/owned-fixture-cleanup.mjs', import.meta.url).href) as
  typeof import('../../../tooling/test-support/owned-fixture-cleanup.mjs');
import { cmdSetup, runPlanStep, runPlanSteps } from '../src/onboarding.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-everyday-lifecycle-'));
const pids = new Set<number>();
const OWNER_TOKEN = `amabie-test-owner:${randomUUID()}`;
after(() => {
  for (const pid of pids) cleanupOwnedFixture(pid, OWNER_TOKEN);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'win32' && fs.existsSync(`/proc/${pid}/stat`)) {
      return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    }
    return true;
  } catch { return false; }
}

async function assertStopped(pid: number): Promise<void> {
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, 'a finished check must not retain a live descendant');
}

function program(name: string, text: string): string {
  const file = path.join(root, `${name}.cjs`);
  fs.writeFileSync(file, text);
  return file;
}

function run(file: string, timeoutMs = 10_000) {
  return runPlanStep(root, 'npm', { kind: 'tests', script: 'check', adapter: 'node', argv: [process.execPath, file] }, timeoutMs);
}

for (const mode of ['normal', 'timeout'] as const) {
  it(`cleans up descendants after ${mode} exit without killing unrelated processes`, async () => {
    const idle = program(`idle-${mode}`, 'setInterval(() => {}, 1000);');
    const unrelated = childProcess.spawn(process.execPath, [idle, OWNER_TOKEN], { detached: true, stdio: 'ignore', windowsHide: true });
    assert.ok(unrelated.pid);
    pids.add(unrelated.pid);
    const pidFile = path.join(root, `${mode}.pid`);
    const sessionFile = path.join(root, `${mode}.session`);
    const parent = program(`parent-${mode}`, [
      "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
      `if (process.platform === 'linux') fs.writeFileSync(${JSON.stringify(sessionFile)}, fs.readFileSync('/proc/self/stat'));`,
      `const child = spawn(process.execPath, [${JSON.stringify(idle)}, ${JSON.stringify(OWNER_TOKEN)}], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      mode === 'normal' ? 'child.unref();' : 'setInterval(() => {}, 1000);',
    ].join('\n'));
    try {
      const result = run(parent, mode === 'timeout' ? 2500 : 10_000);
      assert.ok(fs.existsSync(pidFile), 'the descendant must exist before measuring cleanup');
      const descendant = Number(fs.readFileSync(pidFile, 'utf8'));
      pids.add(descendant);
      assert.equal(result.ok, mode === 'normal');
      assert.equal(result.exitCode, mode === 'normal' ? 0 : null);
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(sessionFile, 'utf8');
        const pid = Number(stat.slice(0, stat.indexOf(' ')));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        assert.equal(Number(fields[2]), pid, 'the synchronous check owns its process group');
        assert.equal(Number(fields[3]), pid, 'the synchronous check owns its POSIX session');
      }
      await assertStopped(descendant);
      pids.delete(descendant);
      assert.equal(alive(unrelated.pid), true, 'the sweep must leave a preexisting unrelated process alone');
    } finally {
      cleanupOwnedFixture(unrelated.pid, OWNER_TOKEN);
      pids.delete(unrelated.pid);
    }
  });
}

it('preserves an ordinary nonzero check exit and its output', () => {
  const result = run(program('failure', "console.log('observed failure'); process.exit(7);"));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /observed failure/);
});

it('refuses a successful check when containment cannot be measured', () => {
  const originalSpawnSync = childProcess.spawnSync;
  const originalReadDir = fs.readdirSync;
  if (process.platform === 'win32') {
    mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof originalSpawnSync>) => {
      // Every sweep host, including an operator-selected Core pwsh.exe (AMABIE_POWERSHELL_CORE_PATH).
      if (/powershell|pwsh/i.test(path.basename(String(args[0])))) throw new Error('simulated unavailable containment tool');
      return originalSpawnSync(...args);
    });
  } else {
    mock.method(fs, 'readdirSync', (...args: Parameters<typeof originalReadDir>) => {
      if (String(args[0]) === '/proc') throw new Error('simulated unreadable process table');
      return originalReadDir(...args);
    });
    // On hosts without /proc the shared supervisor reads the table with ps.
    mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof originalSpawnSync>) => {
      if (String(args[0]).endsWith('/ps')) throw new Error('simulated unavailable containment tool');
      return originalSpawnSync(...args);
    });
  }
  syncBuiltinESMExports();
  try {
    const result = run(program('success', "console.log('successful check');"));
    assert.equal(result.ok, false, 'uncertain containment must not become a successful check');
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /containment sweep/);
    assert.match(result.stdout, /successful check/);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it('setup stops before the next check after containment becomes unmeasurable', async () => {
  const project = path.join(root, 'halt-plan');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const first = path.join(project, 'first-ran');
  const later = path.join(project, 'later-ran');
  fs.writeFileSync(path.join(project, 'build.cjs'), "require('node:fs').writeFileSync('first-ran', 'observed');");
  fs.writeFileSync(path.join(project, 'test.cjs'), "require('node:fs').writeFileSync('later-ran', 'must not execute');");
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'containment-halt', scripts: { build: 'node build.cjs', test: 'node test.cjs' },
  }));
  const originalSpawnSync = childProcess.spawnSync;
  const originalReadDir = fs.readdirSync;
  mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof originalSpawnSync>) => {
    const program = String(args[0]);
    if (fs.existsSync(first) && (/powershell|pwsh/i.test(path.basename(program)) || program.endsWith('/ps'))) {
      throw new Error('controlled loss of cleanup measurement after real build');
    }
    return originalSpawnSync(...args);
  });
  if (process.platform !== 'win32') {
    mock.method(fs, 'readdirSync', (...args: Parameters<typeof originalReadDir>) => {
      if (fs.existsSync(first) && String(args[0]) === '/proc') throw new Error('controlled loss of process table');
      return originalReadDir(...args);
    });
  }
  const previousTrustStore = process.env.AMABIE_TRUST_STORE;
  process.env.AMABIE_TRUST_STORE = path.join(root, 'halt-plan-trust');
  syncBuiltinESMExports();
  try {
    assert.equal(await cmdSetup(['--yes', project]), 2, 'cleanup uncertainty stays fail-closed');
    assert.equal(fs.existsSync(first), true, 'the build actually ran before cleanup failed');
    assert.equal(fs.existsSync(later), false, 'no later command may run after unconfirmed cleanup');
    const batch = runPlanSteps(project, 'npm', [
      { kind: 'build', script: 'build', adapter: 'node', argv: [process.execPath, path.join(project, 'build.cjs')] },
      { kind: 'tests', script: 'test', adapter: 'node', argv: [process.execPath, path.join(project, 'test.cjs')] },
    ]);
    assert.equal(batch.length, 1, 'candidate/control batches also stop at the unmeasured process');
    assert.equal(batch[0]!.exitCode, null);
    assert.equal(fs.existsSync(later), false, 'batch execution cannot launch the later check either');
  } finally {
    if (previousTrustStore === undefined) delete process.env.AMABIE_TRUST_STORE;
    else process.env.AMABIE_TRUST_STORE = previousTrustStore;
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it('ordered checks still collect ordinary measured project failures', () => {
  const project = path.join(root, 'ordinary-failure-plan');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'first.cjs'), 'process.exit(7);');
  fs.writeFileSync(path.join(project, 'later.cjs'), "require('node:fs').writeFileSync('later-ran', 'observed');");
  const results = runPlanSteps(project, 'npm', [
    { kind: 'build', script: 'build', adapter: 'node', argv: [process.execPath, path.join(project, 'first.cjs')] },
    { kind: 'tests', script: 'test', adapter: 'node', argv: [process.execPath, path.join(project, 'later.cjs')] },
  ]);
  assert.deepEqual(results.map(result => result.exitCode), [7, 0]);
  assert.equal(fs.readFileSync(path.join(project, 'later-ran'), 'utf8'), 'observed');
});
