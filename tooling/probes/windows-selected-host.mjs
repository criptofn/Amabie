// Strict read-only CI prerequisite, not a containment or HARDENED verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { containmentEnv, windowsPowerShellCandidates } from '../../packages/support/dist/src/index.js';

try {
  assert.equal(process.platform, 'win32', 'this prerequisite requires Windows');
  const host = process.env.AMABIE_POWERSHELL_CORE_PATH;
  assert(host && path.isAbsolute(host) && path.basename(host).toLowerCase() === 'pwsh.exe', 'select an absolute PowerShell 7 executable');
  assert(fs.statSync(host).isFile(), 'selected host must be an existing file');
  const canonical = (file) => fs.realpathSync(file).toLowerCase();
  assert.equal(canonical(windowsPowerShellCandidates()[0]), canonical(host), 'the product must select exactly this host first');
  const started = Date.now();
  const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./windows-selected-host.ps1', import.meta.url)), '-ObservedPid', String(process.pid)], {
    env: containmentEnv(), windowsHide: true, shell: false, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024,
  });
  assert(!result.error, result.error?.message);
  assert.equal(result.status, 0, `selected host failed: ${result.stderr ?? ''}`);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.schema, 'amabie-windows-selected-host/1');
  assert.equal(observation.edition, 'Core');
  assert(Number.isInteger(observation.major) && observation.major >= 7, 'PowerShell 7 or newer is required');
  assert(Number.isSafeInteger(observation.count) && observation.count > 0, 'snapshot must not be empty');
  assert.equal(observation.observedPid, process.pid);
  assert.equal(observation.selfObserved, true, 'snapshot must include this live parent process');
  console.log(JSON.stringify({...observation, host, elapsedMs: Date.now() - started}));
  console.log('PASS selected PowerShell host: real CIM snapshot with own-process positive control; no kills requested');
} catch (error) {
  console.error(`FAIL selected PowerShell host: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
