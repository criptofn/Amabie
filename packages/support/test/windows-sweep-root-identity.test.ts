import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { buildWin32SweepScript, parseWin32SweepOutput, windowsPowerShellCandidates } from '../src/index.js';

it('refuses a root PID reused by the sweep host before requesting any kills', {
  skip: process.platform !== 'win32' ? 'requires the native Windows PowerShell sweep host' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-sweep-root-identity-'));
  try {
    // The real Hosted trace showed rootPid === sweepHostPid. Bind the generated
    // root to this disposable observer's actual PID; every process action is mocked.
    const marker = 620013;
    const generated = buildWin32SweepScript(marker, Date.now()).replaceAll(String(marker), '$PID');
    const script = [
      '$script:killCalls=0',
      '$script:enumerations=0',
      '$created=[DateTime]::UtcNow',
      '$root=[pscustomobject]@{ProcessId=$PID;ParentProcessId=100;CreationDate=$created}',
      '$child=[pscustomobject]@{ProcessId=620014;ParentProcessId=$PID;CreationDate=$created}',
      'function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string[]]$Property); $script:enumerations++; $root; if($script:enumerations -le 2){$child} }',
      'function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force); $script:killCalls++ }',
      'function Wait-Process { [CmdletBinding()] param([int[]]$Id,[int]$Timeout) }',
      `try { ${generated} } catch { [Console]::Error.WriteLine($_.Exception.Message); $script:refused=$true }`,
      "[Console]::Error.WriteLine(('test-kills=' + $script:killCalls))",
      'if($script:refused){exit 2}',
    ].join(';');
    const file = path.join(dir, 'reused-root.ps1');
    fs.writeFileSync(file, script);
    const host = windowsPowerShellCandidates().find(candidate => path.basename(candidate).toLowerCase() === 'pwsh.exe') ?? 'powershell.exe';
    const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 2, `root identity must be refused before traversal:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /sweep root PID has been reused by containment observer/);
    assert.match(result.stderr, /test-kills=0/);
    assert.equal(parseWin32SweepOutput(result.stdout).failed, true, 'a refused observation cannot certify zero survivors');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
