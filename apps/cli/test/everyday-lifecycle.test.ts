import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { after, it, mock } from 'node:test';
import { killTree } from '@amabie/support';
import { runPlanStep } from '../src/onboarding.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-everyday-lifecycle-'));
const pids = new Set<number>();
after(() => {
  for (const pid of pids) killTree(pid);
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
    const unrelated = childProcess.spawn(process.execPath, [idle], { detached: true, stdio: 'ignore', windowsHide: true });
    assert.ok(unrelated.pid);
    pids.add(unrelated.pid);
    const pidFile = path.join(root, `${mode}.pid`);
    const sessionFile = path.join(root, `${mode}.session`);
    const parent = program(`parent-${mode}`, [
      "const { spawn } = require('node:child_process'); const fs = require('node:fs');",
      `if (process.platform === 'linux') fs.writeFileSync(${JSON.stringify(sessionFile)}, fs.readFileSync('/proc/self/stat'));`,
      `const child = spawn(process.execPath, [${JSON.stringify(idle)}], { stdio: 'ignore' });`,
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
      assert.equal(alive(unrelated.pid), true, 'the sweep must leave a preexisting unrelated process alone');
    } finally {
      killTree(unrelated.pid);
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
