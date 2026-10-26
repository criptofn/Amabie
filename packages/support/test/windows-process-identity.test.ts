import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { WINDOWS_PROCESS_IDENTITY_BOOTSTRAP } from '../src/windowsProcessIdentity.js';
import { windowsPowerShellCandidates } from '../src/index.js';

it('native identity rejects changed birth and exact older-parent ordering, then terminates only its pinned process', {
  skip: process.platform !== 'win32' ? 'requires Windows native process handles' : false,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-native-identity-'));
  const subject = path.join(dir, 'subject.cjs');
  fs.writeFileSync(subject, "process.stdout.write('ready');setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [subject], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const unrelated = spawn(process.execPath, [subject], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.all([once(child.stdout!, 'data'), once(unrelated.stdout!, 'data')]);
    assert(child.pid);
    assert(unrelated.pid);
    const exited = once(child, 'exit');
    const file = path.join(dir, 'native-identities.ps1');
    fs.writeFileSync(file, `$ErrorActionPreference='Stop';${WINDOWS_PROCESS_IDENTITY_BOOTSTRAP}
$root=[AmabieSweep.NativeProcess]::Root(${child.pid})
$pin=$null;$reopened=$null;$waiter=$null
try{
  $row=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${child.pid}' -Property ProcessId,CreationDate -ErrorAction Stop
  if(-not $row){throw 'actual child CIM identity missing'}
  [long]$ticks=$row.CreationDate.ToUniversalTime().Ticks
  $changed=[AmabieSweep.NativeProcess]::Child(${child.pid},$ticks+10000,0)
  $older=[AmabieSweep.NativeProcess]::Child(${child.pid},$ticks,$root.CreationTicks+1)
  if($changed -or $older){throw 'foreign or older identity acquired termination authority'}
  $pin=[AmabieSweep.NativeProcess]::Child(${child.pid},$ticks,$root.CreationTicks)
  if(-not $pin){throw 'actual CIM identity did not match native process'}
  $same=($pin.CreationTicks -eq $root.CreationTicks)
  # Retain the wait handle while the child is alive. Reopening by PID after
  # asynchronous termination can fail before the process object is signaled.
  $waiter=[System.Diagnostics.Process]::GetProcessById(${child.pid})
  [void]$waiter.Handle
  $terminated=$pin.Terminate()
  if(-not $waiter.WaitForExit(2000)){throw 'owned fixture child did not exit within two seconds'}
  $alreadyExited=-not $pin.Terminate()
  $reopened=[AmabieSweep.NativeProcess]::Root(${child.pid})
  @{changedRejected=($null -eq $changed);olderRejected=($null -eq $older);same=$same;terminated=$terminated;alreadyExited=$alreadyExited;retainedBirth=($reopened.CreationTicks -eq $root.CreationTicks)} | ConvertTo-Json -Compress
}finally{if($waiter){$waiter.Dispose()};if($reopened){$reopened.Dispose()};if($pin){$pin.Dispose()};$root.Dispose()}
`);
    const host = windowsPowerShellCandidates().find(candidate => path.basename(candidate).toLowerCase() === 'pwsh.exe') ?? 'powershell.exe';
    const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { changedRejected: true, olderRejected: true, same: true,
      terminated: true, alreadyExited: true, retainedBirth: true });
    await exited;
    assert.equal(unrelated.exitCode, null, 'unrelated live process must remain untouched');
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally {
    // ChildProcess objects still own these exact fixture identities; no stale PID kill.
    child.kill(); unrelated.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
