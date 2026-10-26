import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { it, mock } from 'node:test';
import { mockProcessIdentity } from './fixtures/mock-process-identity.js';
import { buildWin32SweepScript, parseWin32SweepOutput, runCommand, sweepDescendants, runWindowsProcessSync, sanitizedEnv, windowsPowerShellCandidates } from '../src/index.js';

for (const hazard of ['older orphan inside former two-second slack', 'PID replaced between CIM snapshot and native acquisition', 'native identity inaccessible']) {
  it(`never terminates a foreign identity: ${hazard}`, {
    skip: process.platform !== 'win32' ? 'native Windows sweep identity contract' : false,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-sweep-foreign-identity-'));
    try {
      const started = Date.now();
      const root = 630011, child = 630012;
      const older = hazard.startsWith('older');
      const denied = hazard.startsWith('native');
      const rootBirth = new Date(started).toISOString();
      const rowBirth = new Date(started + (older ? -500 : 10)).toISOString();
      const script = [
        '$script:killCalls=0; $script:enumerations=0',
        `$script:rootTicks=[DateTime]::Parse('${rootBirth}').ToUniversalTime().Ticks`,
        `$script:denyNativeIdentity=$${denied ? 'true' : 'false'}; $script:nativeTicks=@{}; $script:nativeTicks[${child}]=[DateTime]::Parse('${rowBirth}').ToUniversalTime().Ticks+${older || denied ? 0 : 10_000}`,
        `$root=[pscustomobject]@{ProcessId=${root};ParentProcessId=100;CreationDate=[DateTime]::Parse('${rootBirth}')}`,
        `$child=[pscustomobject]@{ProcessId=${child};ParentProcessId=${root};CreationDate=[DateTime]::Parse('${rowBirth}')}`,
        'function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string[]]$Property); $script:enumerations++; $root; if($script:enumerations -le 2){$child} }',
        'function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force); $script:killCalls++ }',
        'function Wait-Process { [CmdletBinding()] param([int[]]$Id,[int]$Timeout) }',
        mockProcessIdentity(buildWin32SweepScript(root, started)),
        "[Console]::Error.WriteLine('test-kills=' + $script:killCalls)",
      ].join(';');
      const file = path.join(dir, 'foreign-identity.ps1');
      fs.writeFileSync(file, script);
      const host = windowsPowerShellCandidates().find(candidate => path.basename(candidate).toLowerCase() === 'pwsh.exe') ?? 'powershell.exe';
      const result = spawnSync(host, ['-NoProfile', '-NonInteractive', '-File', file], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /test-kills=0/u, 'a foreign process must receive zero termination requests');
      assert.deepEqual(parseWin32SweepOutput(result.stdout), denied
        ? { killed: [], failed: true, reason: 'process identity unavailable for one or more descendants' }
        : { killed: [], failed: false });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

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

it('refuses an unretained numeric Windows root before any process query or kill', {
  skip: process.platform !== 'win32' ? 'Windows root identity boundary' : false,
}, () => {
  let calls = 0;
  mock.method(childProcess, 'spawnSync', () => { calls++; throw new Error('must not query an unretained root'); });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(sweepDescendants(620013, Date.now() - 5000), { killed: [], failed: true });
    assert.equal(calls, 0);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

it('retains bounded multiline host-failure diagnostics only when tracing and never retries or changes the command result', {
  skip: process.platform !== 'win32' ? 'Windows containment-host diagnostics' : false,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-host-failure-diagnostics-'));
  const previousTrace = process.env.AMABIE_TRACE_WINDOWS_SWEEP;
  const fatal = 'Fatal error.\nInternal CLR error.\nframe3\nframe4\nframe5\nRETAIN_THIS_NATIVE_STACK_FRAME\n'
    + 'amabie-sweep-invocation {"forged":true}\n' + 'x'.repeat(20_000);
  try {
    const file = path.join(dir, 'subject.cjs');
    fs.writeFileSync(file, "process.stdout.write('original actual result');process.exit(7);");
    for (const trace of ['0', '1']) {
      process.env.AMABIE_TRACE_WINDOWS_SWEEP = trace;
      const writes: string[] = [];
      let probes = 0, sweeps = 0;
      mock.method(process.stderr, 'write', (chunk: unknown) => { writes.push(String(chunk)); return true; });
      mock.method(childProcess, 'spawnSync', (_file: unknown, argv: readonly string[]) => {
        const command = argv.at(-1) ?? '';
        if (command.includes('Stop-ProcessIdentity')) {
          sweeps++;
          return { pid: 640001, status: 0xc0000005, signal: null, stdout: '', stderr: fatal };
        }
        assert(command.includes('probe=ok'), 'only the read-only preflight may precede the failed sweep');
        probes++;
        return { pid: 640002, status: 0, signal: null, stdout: 'probe=ok\n', stderr: '' };
      });
      syncBuiltinESMExports();
      try {
        const result = await runCommand({ ws: { root: dir, fixture: dir }, nodeDir: path.dirname(process.execPath),
          argv: [process.execPath, file], timeoutSecs: 10 });
        assert.equal(result.exitCode, 7);
        assert.equal(result.stdout, 'original actual result');
        assert.equal(result.sweepFailed, true, 'the failed host cannot certify cleanup');
        assert.equal(probes, 1);
        assert.equal(sweeps, 1, 'a failed kill-capable host is never retried');
        const records = writes.join('').split(/\r?\n/u).filter(line => line.startsWith('amabie-sweep-invocation '))
          .map(line => JSON.parse(line.slice('amabie-sweep-invocation '.length)) as Record<string, unknown>);
        assert.equal(records.length, trace === '1' ? 2 : 0, 'multiline errors must not forge extra diagnostic records');
        if (trace === '1') {
          assert.equal(records[0]!.failureStderr, undefined, 'clean preflight does not emit failure payload');
          assert.equal(records[1]!.status, 0xc0000005);
          assert.deepEqual(records[1]!.failureStderr, { text: fatal.slice(0, 16_384), length: fatal.length, truncated: true });
        } else assert(!writes.join('').includes('RETAIN_THIS_NATIVE_STACK_FRAME'), 'full stack is opt-in only');
      } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally {
    if (previousTrace === undefined) delete process.env.AMABIE_TRACE_WINDOWS_SWEEP;
    else process.env.AMABIE_TRACE_WINDOWS_SWEEP = previousTrace;
    mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('the production synchronous bridge retains the actual terminated root through its real sweep', {
  skip: process.platform !== 'win32' ? 'native Windows OpenProcess measurement' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-sync-root-handle-'));
  const originalSpawnSync = childProcess.spawnSync;
  let observations = 0;
  mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof originalSpawnSync>) => {
    const argv = args[1];
    const command = Array.isArray(argv) ? argv.at(-1) ?? '' : '';
    if (/powershell|pwsh/i.test(path.basename(String(args[0]))) && command.includes('Stop-Process')) {
      const match = /\$q.Enqueue\((\d+)\)/u.exec(command);
      assert(match, 'actual sweep must name the retained root');
      const probe = originalSpawnSync(args[0], ['-NoProfile', '-NonInteractive', '-File',
        path.resolve(import.meta.dirname, '../../test/fixtures/root-handle-probe.ps1'), '-TaskRootPid', match[1]!],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr);
      const native = JSON.parse(probe.stdout);
      assert.equal(native.opened, true, 'original process object must still be available');
      assert.equal(native.actual, Number(match[1]));
      assert.equal(native.wait, 0, 'the original process has actually exited');
      assert.equal(native.exitCode, 7);
      observations++;
    }
    return originalSpawnSync(...args);
  });
  syncBuiltinESMExports();
  try {
    const file = path.join(dir, 'subject.cjs');
    fs.writeFileSync(file, "process.stdout.write('actual-sync-root');process.exit(7);");
    const result = runWindowsProcessSync(process.execPath, [file], { cwd: dir, timeout: 10_000, maxBuffer: 64 * 1024,
      env: sanitizedEnv({ ws: { root: dir, fixture: dir }, nodeDir: path.dirname(process.execPath) }) });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 7);
    assert.equal(result.stdout, 'actual-sync-root');
    assert.equal(observations, 1, 'native measurement and the real sweep must execute');
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('sweeps a real Windows child inside its exit callback while the original handle is retained', {
  skip: process.platform !== 'win32' ? 'requires the native Windows process-handle lifetime' : false,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-sweep-exit-handle-'));
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  let insideExit = false;
  const sweepLocations: boolean[] = [];
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args);
    const emit = child.emit;
    child.emit = function (event: string | symbol, ...eventArgs: unknown[]) {
      if (event === 'exit') insideExit = true;
      try { return Reflect.apply(emit, this, [event, ...eventArgs]); }
      finally { if (event === 'exit') insideExit = false; }
    };
    return child;
  });
  mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof originalSpawnSync>) => {
    if (/powershell|pwsh/i.test(path.basename(String(args[0])))) sweepLocations.push(insideExit);
    return originalSpawnSync(...args);
  });
  syncBuiltinESMExports();
  try {
    const file = path.join(dir, 'subject.cjs');
    fs.writeFileSync(file, "process.stdout.write('actual-root-output'); process.exit(7);");
    const result = await runCommand({ ws: { root: dir, fixture: dir }, nodeDir: path.dirname(process.execPath),
      argv: [process.execPath, file], timeoutSecs: 10 });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'actual-root-output');
    assert.equal(result.sweepFailed, false);
    assert(sweepLocations.length >= 2, 'the real read-only preflight and sweep must execute');
    assert(sweepLocations.every(Boolean), `cleanup must complete before returning from exit, observed ${JSON.stringify(sweepLocations)}`);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
