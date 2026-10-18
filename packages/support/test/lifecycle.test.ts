/**
 * Audit F5 — process-lifecycle containment on NORMAL exit.
 *
 * Benign local node processes whose only behavior is a long timer; no other
 * software is involved. Two layers are tested separately:
 *
 *  1. sweepMechanism: sweepDescendants() positively proven against a LIVE
 *     parent's descendant (enumerate + kill). Windows enumerates via
 *     Win32_Process.ParentProcessId (which a live orphan retains after its
 *     parent dies — stale-PPID lineage); POSIX via the child's own process
 *     GROUP, and (audit S1) also the child's SESSION so a descendant that
 *     setpgid()ed into its own group is still caught, plus a transitive
 *     PPID BFS, with a group-kill backstop.
 *  2. containment: after runCommand resolves — normal exit or timeout — no
 *     descendant of the spawned child may still be alive. Which layer won the
 *     race (Amabie's post-exit sweep vs an OS job-object container wrapping
 *     the test session) is environment-dependent and NOT asserted; on plain
 *     hosts only layer 1 exists, which is why layer 1 is proven directly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { runCommand, sweepDescendants, buildWin32SweepScript, parseWin32SweepOutput, posixSessionMember, windowsPowerShellCandidates, runWin32SweepWithFallback, type RunOutcome, type WorkspaceLayout } from '../src/index.js';

const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
const survivorArgs = ['-e', 'setTimeout(()=>{}, 300000)'];

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-lifecycle-'));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

const PROCESS_TREE_FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'process-tree-parent.cjs');

function workspace(): WorkspaceLayout {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const ws = { root, fixture: path.join(root, 'fixture') };
  fs.mkdirSync(ws.fixture, { recursive: true });
  return ws;
}

function testPowerShellHost(): string {
  return windowsPowerShellCandidates().find((candidate) => path.basename(candidate).toLowerCase() === 'pwsh.exe') ?? 'powershell.exe';
}

/** Child script: spawn ONE plain node helper on a long timer, unref it so
 *  THIS process can exit while the helper lives on, print the helper PID. */
const survivorChildScript = [
  "const { spawn } = require('node:child_process');",
  `const g = spawn(process.execPath, ${JSON.stringify(survivorArgs)},`,
  "  { stdio: 'ignore', windowsHide: true });",
  'g.unref();',
  'console.log(String(g.pid));',
].join(' ');

function isAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'],
      { timeout: 15_000, encoding: 'utf8', windowsHide: true });
    return (r.stdout ?? '').includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function untilDead(pid: number, budgetMs = 8_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

function killIfAlive(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { timeout: 15_000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

/**
 * v1.5 post-audit — DIAGNOSTIC ONLY, used exclusively to build the message of a FAILING assertion.
 *
 * WHY. `sweepDescendants finds and kills a live parent's child process` failed once on the hosted
 * Windows runner (`sweep killed [7564] but not 2144`, 35,980 ms; 894 ms on a dev machine) and never
 * reproduced in 14 local attempts. The old message named only the sweep result, the liveness of the
 * two processes and the platform, which cannot say WHICH exclusion happened. `sweepWin32` queues a
 * child only if it is present in the tree snapshot, keyed under the expanded parent PID, and has a
 * non-null `CreationDate` within two seconds of the root's spawn. It is reported as killed only if
 * `Stop-Process` succeeds; a final snapshot checks the same process identity for survivors. A blind re-run could
 * therefore return green or red without a reason, which is the false-red/false-green pattern this
 * project exists to remove.
 *
 * WHAT THIS ADDS, and nothing else: on failure it takes a FRESH, throwaway `Get-CimInstance`
 * Win32_Process observation for the two known PIDs and prints ProcessId / ParentProcessId /
 * CreationDate / presence for each, alongside the liveness the test already measures, the sweep
 * input, the expected child and the cut the sweep used. `CreationDate` is immutable for a live
 * process, so a fresh read of a still-running child is comparable with the filter that rejected it.
 *
 * WHAT IT MUST NEVER DO: change an assertion, a threshold, a timeout or a kill; turn a failure into
 * a pass; or be consulted by product code. It cannot: it runs only after a check has already failed,
 * and its output is only ever the text of that failure.
 */
type CimRow = { pid: number; present: boolean; ppid: number | null; createdIso: string | null };

function parseCimLine(line: string): CimRow | null {
  const m = /^row=(\d+);present=(true|false)(?:;ppid=(-?\d+);creationDate=(.*))?$/.exec(line.trim());
  if (m === null) return null;
  const pid = Number(m[1] ?? '');
  if (!Number.isFinite(pid)) return null;
  const present = m[2] === 'true';
  const ppid = m[3] === undefined ? null : Number(m[3]);
  const created = m[4] === undefined || m[4] === 'null' ? null : m[4];
  return { pid, present, ppid: ppid !== null && Number.isFinite(ppid) ? ppid : null, createdIso: created };
}

/** Fresh, throwaway CIM observation. Never throws: a diagnostic that fails must say so, not mask
 *  the failure it was collected for. */
function cimObservation(pids: number[]): string[] {
  if (process.platform !== 'win32') {
    return ['cimObservation: not applicable (sweepWin32 did not run on this platform)'];
  }
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    '$all=@(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_ -ne $null });' +
    `Write-Output ('snapshotCount=' + $all.Count);` +
    `foreach($want in @(${pids.map((p) => Math.trunc(p)).join(',')})){` +
    `$hit=$all | Where-Object { [int]$_.ProcessId -eq $want } | Select-Object -First 1;` +
    `if($null -eq $hit){ Write-Output ('row=' + $want + ';present=false') } else {` +
    `$cd=$hit.CreationDate;` +
    `$cdText=if($null -eq $cd){'null'}else{([DateTime]$cd).ToUniversalTime().ToString('o')};` +
    `Write-Output ('row=' + $want + ';present=true;ppid=' + [int]$hit.ParentProcessId + ';creationDate=' + $cdText) } }`;
  try {
    const r = spawnSync(testPowerShellHost(), ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 30_000, encoding: 'utf8', windowsHide: true });
    if (r.error) return [`cimObservation: unavailable (${r.error.message})`];
    if (r.status !== 0) return [`cimObservation: unavailable (powershell exit ${String(r.status)})`];
    const lines = (r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
    return lines.length > 0 ? lines : ['cimObservation: empty output'];
  } catch (e) {
    return [`cimObservation: unavailable (${e instanceof Error ? e.message : String(e)})`];
  }
}

/** Which of the four exclusion shapes the fresh observation is consistent with. Observation only —
 *  it never asserts, and where two shapes remain possible it says both. */
function shapeFromObservation(row: CimRow | null, parentPid: number,
  cutIso: string, childAlive: boolean): string {
  if (row === null) return 'shape: could not parse the row';
  if (!row.present) {
    return childAlive
      ? 'shape (a) SNAPSHOT MISS: the child is ALIVE by tasklist but absent from a fresh CIM '
        + 'snapshot, so the sweep had nothing to dequeue'
      : 'shape: absent from the fresh snapshot and not alive (it exited before the sweep)';
  }
  if (row.createdIso === null) {
    return 'shape (c-null) CREATIONDATE NULL: `$c.CreationDate -and ...` rejects a null date';
  }
  const created = new Date(row.createdIso);
  const cut = new Date(cutIso);
  if (Number.isFinite(created.getTime()) && created.getTime() < cut.getTime()) {
    return `shape (c-cut) CREATIONDATE BEFORE CUT: child ${row.createdIso} < cut ${cutIso} — the `
      + 'two-second clock slack is the only time filter that can reject it here';
  }
  if (row.ppid !== parentPid) {
    return `shape (b) PARENT MISMATCH: fresh snapshot says ParentProcessId=${String(row.ppid)}, `
      + `the sweep expanded ${parentPid}`;
  }
  return childAlive
    ? 'shape (d) or a snapshot difference: present with the right parent and a date after the cut, '
      + 'so the sweep could have enqueued it — either its `Stop-Process` failed, or the snapshot the '
      + 'sweep took differed from this one'
    : 'present with the right parent and date, and no longer alive: it died without appearing in '
      + '`killed` (killed between the sweep and this observation, or the sweep\'s report lost it)';
}

/** The full failure message for the Windows assertion: everything needed to decide WHY. */
function sweepFailureDiagnostic(parentPid: number, childPid: number, spawnedAtMs: number): string {
  const cutIso = new Date(spawnedAtMs - 2_000).toISOString();
  const parts: string[] = [
    `sweepInputParentPid=${parentPid}`,
    `expectedChildPid=${childPid}`,
    `spawnedAtMs=${spawnedAtMs}`,
    `cutUsedBySweep=${cutIso}`,
    `aliveAtAssertionParent=${String(isAlive(parentPid))}`,
    `aliveAtAssertionChild=${String(isAlive(childPid))}`,
  ];
  const observed = cimObservation([parentPid, childPid]);
  for (const line of observed) {
    parts.push(`cimObservation ${line}`);
    const row = parseCimLine(line);
    if (row !== null && row.pid === childPid) {
      parts.push(shapeFromObservation(row, parentPid, cutIso, isAlive(childPid)));
    }
  }
  return parts.join(' | ');
}

describe('audit F5 — sweep mechanism (live parent, positive proof)', () => {
  it('sweepDescendants finds and kills a live parent\'s child process', async () => {
    // Intermediate parent that spawns a child then sits on a timer, so the
    // sweep runs while the parent is still alive (mechanism, not race, is
    // what this test pins down).
    const mid = spawn(process.execPath, [PROCESS_TREE_FIXTURE], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    let out = '';
    mid.stdout?.setEncoding('utf8');
    mid.stdout?.on('data', (d: string) => { out += d; });
    const kidPid = await new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no child pid printed')), 15_000);
      mid.stdout?.on('data', () => {
        const n = Number(out.trim());
        if (Number.isFinite(n) && n > 0) { clearTimeout(to); resolve(n); }
      });
      mid.on('error', (e) => { clearTimeout(to); reject(e); });
    });
    try {
      assert.ok(isAlive(kidPid), 'precondition: child should be alive before sweep');
      // Include one second of test scheduling slack; the production sweep allows two.
      const spawnedAtMs = Date.now() - 1_000;
      const res = sweepDescendants(mid.pid, spawnedAtMs);
      /*
       * v1.5 post-audit: this assertion fired ONCE on the hosted Windows runner and never locally.
       *
       *   error: 'sweep killed [7564] but not 2144'   duration_ms: 35980   (894 ms on a dev machine)
       *
       * `killed` holding ONE pid is consistent with the BFS never having enqueued the child, which
       * `sweepWin32` can only cause in four ways: the child is missing from the CIM snapshot, its
       * ParentProcessId is not the intermediate parent, its CreationDate is null or falls before the
       * cut (`spawnedAtMs - 2_000`), or its `Stop-Process` failed. The old message could not tell
       * those apart, so a blind re-run could only produce a green or a red WITHOUT A REASON.
       *
       * The failure message now carries the whole sweep result, the liveness of both processes at
       * assertion time, the sweep's input and cut, and a fresh throwaway `Get-CimInstance`
       * observation of both PIDs with the shape it is consistent with. It is built ONLY when an
       * assertion is about to fail. DIAGNOSTIC ONLY — no assertion, threshold, timeout or kill was
       * changed, and nothing here can turn a failure into a pass.
       */
      assert.equal(res.failed, false,
        'sweep must not fail'
        + (res.failed ? ` | diagnostic: ${sweepFailureDiagnostic(mid.pid!, kidPid, spawnedAtMs)}` : ''));
      assert.ok(res.killed.includes(kidPid),
        `sweep killed ${JSON.stringify(res.killed)} but not ${kidPid}`
        + ` | result=${JSON.stringify(res)}`
        + ` | platform=${process.platform}`
        + (res.killed.includes(kidPid)
          ? ''
          : ` | diagnostic: ${sweepFailureDiagnostic(mid.pid!, kidPid, spawnedAtMs)}`));
      if (process.platform === 'win32') {
        assert.ok(isAlive(mid.pid!), 'sweeping a process tree must not kill the caller-supplied root process');
        assert.ok(!res.killed.includes(mid.pid!), 'the root PID is never reported as a descendant kill');
      }
      assert.ok(await untilDead(kidPid), `child ${kidPid} survived the sweep`);
    } finally {
      killIfAlive(kidPid);
      killIfAlive(mid.pid!);
    }
  });
});

describe('Windows sweep output contract', () => {
  it('accepts a complete descendant-only result and fails on survivors, cap, unknown identity, or malformed output', () => {
    assert.deepEqual(parseWin32SweepOutput('snapshot=42\nlimit=0\nuncertain=0\nkilled=21,22\nsurvivors=\n'), { killed: [21, 22], failed: false });
    assert.deepEqual(parseWin32SweepOutput('snapshot=42\nlimit=0\nuncertain=0\nkilled=\nsurvivors=22\n'), {
      killed: [], failed: true, reason: 'surviving process ids: 22',
    });
    assert.deepEqual(parseWin32SweepOutput('snapshot=42\nlimit=0\nuncertain=1\nkilled=\nsurvivors=\n'), {
      killed: [], failed: true, reason: 'process identity unavailable for one or more descendants',
    });
    assert.equal(parseWin32SweepOutput('snapshot=42\nlimit=1\nuncertain=0\nkilled=21\nsurvivors=\n').failed, true,
      'a partially traversed tree is never reported as clear');
    assert.equal(parseWin32SweepOutput('snapshot=42\nlimit=0\nkilled=\nsurvivors=\n').failed, true,
      'a truncated output protocol is never read as an empty tree');
  });
});

describe('Windows PowerShell host fallback', () => {
  it('uses an explicit trusted pwsh.exe override first and otherwise defaults to the system host', {
    skip: process.platform !== 'win32',
  }, () => {
    const original = new Map<string, string | undefined>();
    const keys = ['SystemRoot', 'ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'AMABIE_POWERSHELL_CORE_PATH'];
    for (const key of keys) original.set(key, process.env[key]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-pwsh-candidate-'));
    const configured = path.join(root, 'operator', 'pwsh.exe');
    const localAppDataHost = path.join(root, 'local', 'Programs', 'PowerShell', '7', 'pwsh.exe');
    fs.mkdirSync(path.dirname(configured), { recursive: true });
    fs.mkdirSync(path.dirname(localAppDataHost), { recursive: true });
    fs.writeFileSync(configured, 'test fixture');
    fs.writeFileSync(localAppDataHost, 'test fixture');
    try {
      process.env.SystemRoot = 'C:\\WINDOWS';
      process.env.ProgramW6432 = path.join(root, 'program64');
      process.env.ProgramFiles = path.join(root, 'program');
      process.env['ProgramFiles(x86)'] = path.join(root, 'program32');
      process.env.LOCALAPPDATA = path.join(root, 'local');
      delete process.env.AMABIE_POWERSHELL_CORE_PATH;
      assert.equal(windowsPowerShellCandidates()[0], 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      process.env.AMABIE_POWERSHELL_CORE_PATH = configured;
      const candidates = windowsPowerShellCandidates();
      assert.equal(candidates[0], configured, 'an explicit override is the operator-selected host');
      assert.ok(!candidates.includes(localAppDataHost), 'user-writable LocalAppData hosts are not discovered implicitly');

      process.env.AMABIE_POWERSHELL_CORE_PATH = path.join(root, 'operator', 'not-pwsh.exe');
      assert.ok(!windowsPowerShellCandidates().includes(process.env.AMABIE_POWERSHELL_CORE_PATH),
        'the override must name an existing PowerShell Core executable');
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries only after a process-host access violation and keeps successful scan semantics authoritative', () => {
    const calls: string[] = [];
    const fallbackEvents: Array<[string, string, string]> = [];
    const clean = 'snapshot=1\nlimit=0\nuncertain=0\nkilled=\nsurvivors=\n';
    const result = runWin32SweepWithFallback(53001, Date.now(), ['powershell.exe', 'pwsh.exe'], (executable) => {
      calls.push(executable);
      return executable === 'powershell.exe'
        ? { status: 3221225477, stdout: '', stderr: '' }
        : { status: 0, stdout: clean, stderr: '' };
    }, (previous, next, reason) => fallbackEvents.push([previous, next, reason]));
    assert.deepEqual(result, { killed: [], failed: false });
    assert.deepEqual(calls, ['powershell.exe', 'pwsh.exe']);
    assert.deepEqual(fallbackEvents, [['powershell.exe', 'pwsh.exe', 'engine access violation 0xC0000005']]);
  });

  it('does not retry a valid scan that reports surviving descendants', () => {
    const calls: string[] = [];
    const result = runWin32SweepWithFallback(53001, Date.now(), ['powershell.exe', 'pwsh.exe'], (executable) => {
      calls.push(executable);
      return { status: 0, stdout: 'snapshot=1\nlimit=0\nuncertain=0\nkilled=\nsurvivors=53002\n', stderr: '' };
    });
    assert.deepEqual(result, { killed: [], failed: true, reason: 'surviving process ids: 53002' });
    assert.deepEqual(calls, ['powershell.exe']);
  });

  it('fails closed after non-crash errors or when no fallback runtime succeeds', () => {
    const ordinaryFailure: string[] = [];
    const failedScan = runWin32SweepWithFallback(53001, Date.now(), ['powershell.exe', 'pwsh.exe'], (executable) => {
      ordinaryFailure.push(executable);
      return { status: executable === 'powershell.exe' ? 1 : 0, stdout: '', stderr: 'query failed' };
    });
    assert.equal(failedScan.failed, true);
    assert.deepEqual(ordinaryFailure, ['powershell.exe'], 'ordinary command errors are not retried');

    const noHost = runWin32SweepWithFallback(53001, Date.now(), ['powershell.exe'], () => ({
      status: 3221225477, stdout: '', stderr: '',
    }));
    assert.equal(noHost.failed, true);
  });
});

describe('Windows sweep snapshot refresh', () => {
  const processRow = (pid: number, parentPid: number, created: string): string =>
    `[pscustomobject]@{ProcessId=${pid};ParentProcessId=${parentPid};CreationDate=[DateTime]::Parse('${created}')}`;
  const runWithSnapshots = (rootPid: number, spawnedAtMs: number, first: string[], before: string[], after: string[],
    afterWait = after, onWaitCalls?: (count: number) => void) => {
    const setup = [
      '$script:enumerations=0',
      '$script:waitCalls=0',
      `$script:first=@(${first.join(',')})`,
      `$script:before=@(${before.join(',')})`,
      `$script:after=@(${after.join(',')})`,
      `$script:afterWait=@(${afterWait.join(',')})`,
      'function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string[]]$Property); if(($Property -join ",") -ne "ProcessId,ParentProcessId,CreationDate"){throw "unexpected process snapshot properties"}; $script:enumerations++; if($script:enumerations -eq 1){$script:first} elseif($script:enumerations -eq 2){$script:before} else {$script:after} }',
      'function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) }',
      'function Wait-Process { [CmdletBinding()] param([int[]]$Id,[int]$Timeout); if($Timeout -ne 2 -or $Id.Count -le 0){throw "invalid bounded wait"}; $script:waitCalls++; $script:after=$script:afterWait }',
    ].join(';');
    // These tests exercise generated-script semantics with mocked process
    // snapshots, not Windows PowerShell 5.1 itself. Prefer installed PowerShell
    // Core when the inbox host is unavailable or crashes on CIM enumeration.
    const result = spawnSync(testPowerShellHost(), ['-NoProfile', '-NonInteractive', '-Command', `${setup}; ${buildWin32SweepScript(rootPid, spawnedAtMs)}; Write-Output ('test-waits=' + $script:waitCalls)`], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1_000_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = (result.stdout ?? '').split(/\r?\n/u);
    const waitLine = lines.find(line => line.startsWith('test-waits='));
    assert.ok(waitLine, 'mocked wait-call observation missing');
    onWaitCalls?.(Number(waitLine.slice('test-waits='.length)));
    return parseWin32SweepOutput(lines.filter(line => !line.startsWith('test-waits=')).join('\n'));
  };

  it('indexes the pre-kill process identities once for a large snapshot', {
    skip: process.platform !== 'win32',
  }, () => {
    const rootPid = 53001;
    const spawnedAtMs = Date.now();
    const created = new Date(spawnedAtMs - 1_000).toISOString();
    const trackedRow = (pid: number, parentPid: number): string =>
      `(New-TestProcess -Id ${pid} -Parent ${parentPid} -Created '${created}')`;
    const root = trackedRow(rootPid, 100);
    const candidates = Array.from({ length: 64 }, (_, index) => trackedRow(53100 + index, rootPid));
    // Put unrelated rows first so a per-descendant linear lookup reads most of
    // the table repeatedly. A one-pass identity index stays below the bound.
    const unrelated = Array.from({ length: 96 }, (_, index) => trackedRow(54000 + index, 99999));
    const setup = [
      '$script:enumerations=0; $script:processIdReads=0',
      'function New-TestProcess { param([int]$Id,[int]$Parent,[string]$Created); $row=[pscustomobject]@{_ProcessId=$Id;_ParentProcessId=$Parent;_CreationDate=[DateTime]::Parse($Created)}; Add-Member -InputObject $row -MemberType ScriptProperty -Name ProcessId -Value {$script:processIdReads++;$this._ProcessId}; Add-Member -InputObject $row -MemberType ScriptProperty -Name ParentProcessId -Value {$this._ParentProcessId}; Add-Member -InputObject $row -MemberType ScriptProperty -Name CreationDate -Value {$this._CreationDate}; $row }',
      `$script:first=@(${root})`,
      `$script:before=@(${[root, ...unrelated, ...candidates].join(',')})`,
      `$script:after=@(${[root, ...unrelated].join(',')})`,
      'function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string[]]$Property); if(($Property -join ",") -ne "ProcessId,ParentProcessId,CreationDate"){throw "unexpected process snapshot properties"}; $script:enumerations++; if($script:enumerations -eq 1){$script:first} elseif($script:enumerations -eq 2){$script:before} else {$script:after} }',
      'function Stop-Process { [CmdletBinding()] param([int]$Id,[switch]$Force) }',
    ].join(';');
    const result = spawnSync(testPowerShellHost(), ['-NoProfile', '-NonInteractive', '-Command', `${setup}; ${buildWin32SweepScript(rootPid, spawnedAtMs)}; [Console]::Error.WriteLine('processIdReads=' + $script:processIdReads)`], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 1_000_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const processIdReads = Number(/processIdReads=(\d+)/.exec(result.stderr ?? '')?.[1]);
    assert.ok(Number.isFinite(processIdReads), `missing process identity read count: ${result.stderr}`);
    const sweep = parseWin32SweepOutput(result.stdout ?? '');
    assert.equal(sweep.failed, false);
    assert.equal(sweep.killed.length, candidates.length);
    assert.ok(processIdReads < 5_000,
      `pre-kill lookup should index process identities once; observed ${processIdReads} ProcessId reads`);
  });

  it('finds a descendant omitted by the first snapshot and ignores an older reused-PID child', {
    skip: process.platform !== 'win32',
  }, () => {
    const rootPid = 51001;
    const childPid = 51002;
    const spawnedAtMs = Date.now();
    const childCreated = new Date(spawnedAtMs - 1_000).toISOString();
    const olderCreated = new Date(spawnedAtMs - 60_000).toISOString();
    const root = processRow(rootPid, 100, childCreated);
    const child = processRow(childPid, rootPid, childCreated);
    const oldChild = processRow(51003, rootPid, olderCreated);
    assert.deepEqual(runWithSnapshots(rootPid, spawnedAtMs,
      [root, oldChild], [root, child, oldChild], [root, oldChild]), { killed: [childPid], failed: false });
  });

  it('waits briefly for an asynchronous termination before classifying the post-kill snapshot', {
    skip: process.platform !== 'win32',
  }, () => {
    const rootPid = 51501;
    const childPid = 51502;
    const spawnedAtMs = Date.now();
    const created = new Date(spawnedAtMs - 1_000).toISOString();
    const root = processRow(rootPid, 100, created);
    const child = processRow(childPid, rootPid, created);
    let waitCalls = 0;
    const sweep = runWithSnapshots(rootPid, spawnedAtMs,
      [root, child], [root, child], [root, child], [root], count => { waitCalls = count; });
    assert.deepEqual(sweep, { killed: [childPid], failed: false },
      'the post-kill snapshot must reflect the bounded wait');
    assert.equal(waitCalls, 1, 'one bounded wait is made for a killed descendant');
  });

  it('fails closed when a descendant appears in the final snapshot and remains alive', {
    skip: process.platform !== 'win32',
  }, () => {
    const rootPid = 52001;
    const childPid = 52002;
    const spawnedAtMs = Date.now();
    const created = new Date(spawnedAtMs - 1_000).toISOString();
    const root = processRow(rootPid, 100, created);
    const child = processRow(childPid, rootPid, created);
    assert.deepEqual(runWithSnapshots(rootPid, spawnedAtMs, [root], [root], [root, child]), {
      killed: [], failed: true, reason: `surviving process ids: ${childPid}`,
    });
  });
});

describe('audit F5 — containment through runCommand', () => {
  it('normal exit-0 of a child that left a helper behind: sweep clean, no survivors', async () => {
    const ws = workspace();
    const out: RunOutcome = await runCommand({
      ws, nodeDir: NODE_DIR,
      argv: [NODE, '-e', survivorChildScript],
      timeoutSecs: 60,
    });
    assert.equal(out.exitCode, 0, out.stderr);
    const grandchildPid = Number(out.stdout.trim());
    assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `no pid printed: ${out.stdout}`);
    try {
      assert.equal(out.sweepFailed, false, 'sweep reported failure');
      assert.ok(Array.isArray(out.sweptPids), 'sweptPids must be present on normal runs');
      assert.ok(await untilDead(grandchildPid),
        `grandchild ${grandchildPid} survived normal child exit (containment gap)`);
    } finally {
      killIfAlive(grandchildPid);
    }
  });

  it('a clean exit with no descendants sweeps nothing and does not fail', async () => {
    const ws = workspace();
    const out = await runCommand({
      ws, nodeDir: NODE_DIR,
      argv: [NODE, '-e', 'console.log("hi")'],
      timeoutSecs: 60,
    });
    assert.equal(out.exitCode, 0);
    assert.equal(out.sweepFailed, false);
    assert.deepEqual(out.sweptPids, []);
  });

  it('timeout: tree kill + sweep leave no survivors and do not fail', async () => {
    const ws = workspace();
    // Child spawns the survivor, then sits forever; the 2s timeout tree-kills
    // it on the timer, and the post-close sweep must still run cleanly.
    const script = survivorChildScript + " ;setTimeout(()=>{}, 120000);";
    const out = await runCommand({ ws, nodeDir: NODE_DIR, argv: [NODE, '-e', script], timeoutSecs: 2 });
    assert.equal(out.killedByTimeout, true);
    assert.equal(out.exitCode, -1);
    const grandchildPid = Number(out.stdout.trim());
    assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `no pid printed: ${JSON.stringify(out.stdout)}`);
    try {
      assert.equal(out.sweepFailed, false, 'sweep reported failure');
      assert.ok(await untilDead(grandchildPid),
        `grandchild ${grandchildPid} alive after timeout+sweep`);
    } finally {
      killIfAlive(grandchildPid);
    }
  });

  it('the swept child PID itself is never listed as killed (only descendants)', async () => {
    const ws = workspace();
    const out = await runCommand({
      ws, nodeDir: NODE_DIR,
      argv: [NODE, '-e', survivorChildScript],
      timeoutSecs: 60,
    });
    assert.ok(out.childPid);
    assert.ok(!out.sweptPids?.includes(out.childPid!),
      'sweep must target descendants, not the already-exited child');
    // Amabie itself must never appear in a sweep result.
    assert.ok(!out.sweptPids?.includes(process.pid));
    for (const p of out.sweptPids ?? []) killIfAlive(p);
  });
});

describe('audit S1 — POSIX session-membership predicate (setpgid escapees)', () => {
  it('a member of the child session is caught even after it setpgid()s', () => {
    // detached child: session id == childPid; a descendant that setpgid into a
    // new group keeps sid == childPid -> still a member (old pgid-only check
    // would MISS it).
    assert.equal(posixSessionMember(/* pgrp */ 9999, /* sid */ 4242, /* childPid */ 4242), true);
  });
  it('a member of the child group is caught', () => {
    assert.equal(posixSessionMember(/* pgrp */ 4242, /* sid */ 1, 4242), true);
  });
  it('an unrelated process is not swept', () => {
    assert.equal(posixSessionMember(/* pgrp */ 77, /* sid */ 88, 4242), false);
  });
});
