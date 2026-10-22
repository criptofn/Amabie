#!/usr/bin/env node
/**
 * Windows first-entry preflight (T05): a crashing PowerShell host (0xC0000005)
 * is told apart from a product defect, the documented prerequisite is honoured,
 * and a kill-capable sweep is never replayed. Cases 1-6 use injected runners and
 * run on every OS; case 7 additionally exercises the real host on win32.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const support = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../packages/support/dist/src/index.js')).href);
const { runWin32SweepWithFallback, windowsPowerShellCandidates } = support;

const CRASH = 3221225477;
const CLEAN = 'snapshot=1\nlimit=0\nuncertain=0\nkilled=\nsurvivors=\n';
const phaseOf = (script) => (script.includes('Stop-Process') ? 'sweep' : 'probe');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); } catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
};

check('crashing inbox host is passed over by its probe; sweep runs once on Core', () => {
  const calls = [];
  const result = runWin32SweepWithFallback(1, Date.now(), ['powershell.exe', 'pwsh.exe'], (exe, script) => {
    calls.push(`${phaseOf(script)}:${exe}`);
    if (exe === 'powershell.exe') return { status: CRASH, stdout: '', stderr: '' };
    return { status: 0, stdout: phaseOf(script) === 'probe' ? 'probe=ok\n' : CLEAN, stderr: '' };
  });
  assert.equal(result.failed, false);
  assert.deepEqual(calls, ['probe:powershell.exe', 'probe:pwsh.exe', 'sweep:pwsh.exe']);
});

check('missing inbox host (ENOENT) falls back the same way', () => {
  const calls = [];
  const result = runWin32SweepWithFallback(1, Date.now(), ['powershell.exe', 'pwsh.exe'], (exe, script) => {
    calls.push(`${phaseOf(script)}:${exe}`);
    if (exe === 'powershell.exe') return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn' } };
    return { status: 0, stdout: phaseOf(script) === 'probe' ? 'probe=ok\n' : CLEAN, stderr: '' };
  });
  assert.equal(result.failed, false);
  assert.equal(calls.at(-1), 'sweep:pwsh.exe');
});

check('only host crashes: fail closed BEFORE any kill, naming the documented prerequisite', () => {
  const calls = [];
  const result = runWin32SweepWithFallback(1, Date.now(), ['powershell.exe'], (exe, script) => {
    calls.push(phaseOf(script));
    return { status: CRASH, stdout: '', stderr: '' };
  });
  assert.equal(result.failed, true);
  assert.deepEqual(calls, ['probe'], 'the kill-capable sweep must never start on a crashing host');
  assert.match(result.reason, /0xC0000005/u);
  assert.match(result.reason, /AMABIE_POWERSHELL_CORE_PATH/u);
});

check('sweep that crashes after a good probe is NOT replayed on another host', () => {
  const calls = [];
  const result = runWin32SweepWithFallback(1, Date.now(), ['powershell.exe', 'pwsh.exe'], (exe, script) => {
    calls.push(`${phaseOf(script)}:${exe}`);
    return phaseOf(script) === 'probe' ? { status: 0, stdout: 'probe=ok\n', stderr: '' } : { status: CRASH, stdout: '', stderr: '' };
  });
  assert.equal(result.failed, true);
  assert.match(result.reason, /not retried/u);
  assert.deepEqual(calls, ['probe:powershell.exe', 'sweep:powershell.exe']);
});

check('ordinary query failure is not mistaken for the host crash (no fallback, no remedy text)', () => {
  const calls = [];
  const result = runWin32SweepWithFallback(1, Date.now(), ['powershell.exe', 'pwsh.exe'], (exe) => {
    calls.push(exe);
    return { status: 1, stdout: '', stderr: 'query failed' };
  });
  assert.equal(result.failed, true);
  assert.deepEqual(calls, ['powershell.exe']);
  assert.doesNotMatch(result.reason, /AMABIE_POWERSHELL_CORE_PATH/u);
});

check('no candidate at all fails closed', () => {
  const result = runWin32SweepWithFallback(1, Date.now(), [], () => assert.fail('nothing to run'));
  assert.equal(result.failed, true);
});

check('real host (win32 only): clean verdict or a closed, named failure; never a silent pass on a crash', () => {
  if (process.platform !== 'win32') return;
  const candidates = windowsPowerShellCandidates();
  assert.ok(candidates.length > 0, 'at least the inbox host is a candidate');
  const home = os.homedir().toLowerCase();
  assert.ok(candidates.every((c) => !c.toLowerCase().startsWith(home)), 'no user-profile module/host path is auto-discovered');
  const result = runWin32SweepWithFallback(2147483000, Date.now(), candidates, (exe, script) => {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 60_000, windowsHide: true, encoding: 'utf8', shell: false });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: { code: r.error.code, message: r.error.message } } : {}) };
  });
  assert.deepEqual(result.killed, []);
  if (result.failed) assert.ok(result.reason && result.reason.length > 0, 'a failure must name its cause');
  console.log(`  host verdict: ${result.failed ? `closed (${result.reason})` : 'clean'}`);
});

if (failures) { console.log(`FAIL ${failures} case(s)`); process.exit(1); }
console.log('PASS windows-host-preflight');
