import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsPowerShellCandidates } from '../../packages/support/dist/src/index.js';
import { runProbe } from './run-probe.mjs';

test('recorded probe preserves failure/output and distinguishes a contained timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-probe-runner-'));
  try {
    const failure = path.join(root, 'failure.cjs');
    fs.writeFileSync(failure, 'console.log("observed"); console.error("failure"); process.exit(7);');
    const result = await runProbe(process.execPath, [failure], { cwd: root, timeout: 10_000, prefix: path.join(root, 'failure') });
    assert.equal(result.status, 7); assert.equal(result.error, undefined); assert.equal(result.timedOut, false);
    assert.match(fs.readFileSync(path.join(root, 'failure.stdout.log'), 'utf8'), /observed/);
    assert.match(result.stderr, /failure/);
    const missing = await runProbe(path.join(root, 'does-not-exist'), [], { cwd: root, timeout: 1_000 });
    assert.notEqual(missing.status, 0); assert.equal(missing.error.code, 'ENOENT');
    const hanging = path.join(root, 'hanging.cjs');
    const descendant = path.join(root, 'descendant.cjs');
    fs.writeFileSync(descendant, 'setInterval(() => {}, 1000);');
    fs.writeFileSync(hanging, `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });
      require('node:fs').writeFileSync('pid', JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`);
    const timeoutStartedAt = new Date().toISOString();
    const timed = await runProbe(process.execPath, [hanging], { cwd: root, timeout: 1_000 });
    assert.equal(timed.timedOut, true); assert.equal(timed.error.code, 'ETIMEDOUT');
    const pids = JSON.parse(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
    for (const [index, pid] of pids.entries()) {
      const observedAt = new Date().toISOString();
      let live = false;
      try { process.kill(pid, 0); live = true; } catch { /* exited */ }
      if (live && process.platform === 'linux') live = !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      let snapshot;
      if (live && process.platform === 'win32') {
        // Preserve the actual failing PID's identity before diagnosing PID reuse or survivors.
        // Read-only, bounded, no retry; its result never changes the liveness assertion.
        try {
          const inspected = spawnSync(windowsPowerShellCandidates()[0], [
            '-NoProfile', '-NonInteractive', '-File',
            fileURLToPath(new URL('./probe-process-snapshot.ps1', import.meta.url)),
            '-TargetProcessId', String(pid),
          ], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 });
          snapshot = { status: inspected.status, signal: inspected.signal,
            error: inspected.error?.message, stdout: inspected.stdout, stderr: inspected.stderr };
        } catch (error) { snapshot = { error: error.message }; }
      }
      assert.equal(live, false, `timed-out owner and its descendant must be gone: ${JSON.stringify({
        role: index === 0 ? 'owner' : 'descendant', pid, timeoutStartedAt,
        observedAt, diagnosticFinishedAt: new Date().toISOString(), probeStatus: timed.status, probeSignal: timed.signal,
        probeError: timed.error?.code, probeStderr: timed.stderr, snapshot,
      })}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
