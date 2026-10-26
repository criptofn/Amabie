import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { windowsPowerShellCandidates } from '@amabie/support';

it('creates an explicitly secured native broker pipe on the available PowerShell runtime', {
  skip: process.platform !== 'win32' ? 'native broker compilation requires Windows' : false,
}, () => {
  const hosts = windowsPowerShellCandidates();
  const powershell = hosts.find(host => /pwsh(?:\.exe)?$/i.test(path.basename(host))) ?? hosts[0];
  assert.ok(powershell, 'a PowerShell host is required for the Windows broker');

  const repository = path.resolve(import.meta.dirname, '../../../..');
  const launcher = path.join(repository, 'tools/windows-boundary/AmabieConfinedLauncher.cs');
  const broker = path.join(repository, 'tools/windows-boundary/AmabieBroker.cs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-broker-pipe-'));
  const script = path.join(temp, 'verify-pipe.ps1');
  fs.writeFileSync(script, String.raw`param([string]$Launcher, [string]$Broker)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path $Launcher
  Add-Type -Path $Broker
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = [IO.Pipes.PipeSecurity]::new()
  $security.SetOwner($owner)
  $security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($owner, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  $flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
  $type = [AmabieBroker.Broker]
  $create = $type.GetMethod('CreateSecurePipe', $flags)
  $label = $type.GetMethod('ApplyLowMandatoryLabel', $flags)
  if ($null -eq $create -or $null -eq $label) { throw 'secure broker pipe methods were not compiled' }
  $createArguments = [Array]::CreateInstance([object], 2)
  $createArguments.SetValue('amabie-test-' + [guid]::NewGuid().ToString('N'), 0)
  $createArguments.SetValue($security, 1)
  $pipe = $create.Invoke($null, $createArguments)
  $labelArguments = [Array]::CreateInstance([object], 1)
  $labelArguments.SetValue($pipe.SafePipeHandle.DangerousGetHandle(), 0)
  try { $label.Invoke($null, $labelArguments) }
  finally { $pipe.Dispose() }
  [Console]::Out.WriteLine('PASS secure named-pipe ACL and low-label setup')
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}`);

  try {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script, launcher, broker], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASS secure named-pipe ACL and low-label setup/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
