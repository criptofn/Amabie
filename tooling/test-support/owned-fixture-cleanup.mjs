import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPowerShellCandidates } from '../../packages/support/dist/src/index.js';

export function cleanupOwnedFixture(pid, ownerToken) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'absent';
  assert.match(ownerToken, /^amabie-test-owner:[a-f0-9-]{36}$/);
  if (process.platform === 'win32') {
    const result = spawnSync(windowsPowerShellCandidates()[0], ['-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./owned-fixture-cleanup.ps1', import.meta.url)),
      '-TargetProcessId', String(pid), '-OwnerToken', ownerToken,
      '-ExpectedExecutable', fs.realpathSync.native(process.execPath)],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
    assert.equal(result.status, 0, `owned fixture cleanup failed: ${result.error?.message ?? result.stderr}`);
    const record = JSON.parse(result.stdout);
    assert.equal(record.processId, pid);
    assert(['absent', 'not-owned', 'terminated'].includes(record.outcome));
    return record.outcome;
  }
  try {
    if (process.platform === 'linux') {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!command.includes(ownerToken) || fs.realpathSync(`/proc/${pid}/exe`) !== fs.realpathSync(process.execPath)) return 'not-owned';
    } else {
      const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
      if (result.status === 1 && !result.stdout.trim()) return 'absent';
      assert.equal(result.status, 0, result.stderr);
      if (!result.stdout.trim().startsWith(process.execPath + ' ') || !result.stdout.split(/\s+/).includes(ownerToken)) return 'not-owned';
    }
    // POSIX stays best-effort after observation, as in the existing harness.
    // Windows retains the exact kernel handle through its ownership check.
    process.kill(pid, 'SIGKILL');
    return 'terminated';
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return 'absent';
    throw error;
  }
}
