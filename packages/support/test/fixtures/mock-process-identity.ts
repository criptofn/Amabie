import assert from 'node:assert/strict';
import { WINDOWS_PROCESS_IDENTITY_BOOTSTRAP } from '../../src/windowsProcessIdentity.js';

/** Replace one immutable native boundary in synthetic CIM tests only.
 * Real-process tests execute the unchanged native bootstrap. No production switch.
 */
export function mockProcessIdentity(script: string): string {
  assert.equal(script.split(WINDOWS_PROCESS_IDENTITY_BOOTSTRAP).length, 2,
    'synthetic fixture must replace exactly one complete native bootstrap');
  return script.replace(WINDOWS_PROCESS_IDENTITY_BOOTSTRAP, `
function Open-SweepIdentity {
  param([int]$ProcessId,[long]$ExpectedTicks,[long]$ParentTicks,[switch]$Root)
  if($Root){
    $rootRow=@(@($script:root)+@($script:first) | Where-Object {$_ -and [int]$_.ProcessId -eq $ProcessId})[0]
    if(-not $rootRow){throw 'mock root identity missing'}
    $ticks=$rootRow.CreationDate.ToUniversalTime().Ticks
  }else{
    if($script:denyNativeIdentity){throw 'native process identity access denied'}
    $ticks=$ExpectedTicks
    if($script:nativeTicks -and $script:nativeTicks.ContainsKey($ProcessId)){$ticks=[long]$script:nativeTicks[$ProcessId]}
    if($ticks-($ticks%10) -ne $ExpectedTicks-($ExpectedTicks%10) -or $ticks -lt $ParentTicks){return $null}
  }
  $identity=[pscustomobject]@{ProcessId=$ProcessId;CreationTicks=[long]$ticks}
  Add-Member -InputObject $identity -MemberType ScriptMethod -Name Terminate -Value {Stop-Process -Id $this.ProcessId -Force -ErrorAction Stop;return $true}
  Add-Member -InputObject $identity -MemberType ScriptMethod -Name Dispose -Value {$script:disposedIdentities++}
  $identity
}
function Stop-ProcessIdentity {param([object]$Identity);$Identity.Terminate()}
`);
}
