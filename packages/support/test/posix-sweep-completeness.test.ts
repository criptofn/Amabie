/**
 * P0:19–20 — POSIX sweep completeness.
 *
 * Before the fix, a child session with 201 retained-session helpers stopped at the 200-process cap and
 * still reported `failed: false`, so one helper survived as "no survivors". The `ps` fallback (hosts
 * without /proc) queried only processes attached to a terminal, so a helper without one was invisible
 * and the same false "complete" was reported. These tests pin the corrected contract: every supported
 * enumeration source is complete, a survivor is never reported as a clean sweep, and positive cases stay
 * clean.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { psTableRows, runCommand, sweepPosixPasses, type PosixSweepIo } from '../src/index.js';

const FIXTURE = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'tooling', 'test-support', 'fixtures', 'posix-sweep-cap-fixture.py');
const LINUX_WITH_PYTHON = process.platform === 'linux' && fs.existsSync('/usr/bin/python3');

/** Fields after the `(comm)` in /proc/<pid>/stat: state, ppid, pgrp, session, ... */
function procFields(pid: number): string[] {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

/** Live = readable /proc entry that is not a zombie or dead. */
function alive(pid: number): boolean {
  try {
    const state = procFields(pid)[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

function sessionOf(pid: number): number {
  return Number(procFields(pid)[3]);
}

describe('audit P0:19 — POSIX sweep processes the whole session (no silent 200-process cap)', () => {
  it('a child session with 201 retained helpers is swept completely and reported complete', { skip: LINUX_WITH_PYTHON ? false : 'Linux with /usr/bin/python3 only' }, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-posix-cap-'));
    const registry = path.join(scratch, 'fixture-pids.txt');
    const fixture = path.join(scratch, 'fixture.py');
    fs.copyFileSync(FIXTURE, fixture);
    try {
      const outcome = await runCommand({ ws: { root: scratch, fixture: scratch }, nodeDir: path.dirname(process.execPath), argv: ['/usr/bin/python3', fixture, registry], timeoutSecs: 10 });
      const [root, ...helpers] = fs.readFileSync(registry, 'utf8').trim().split('\n').map(Number);
      await new Promise(resolve => setTimeout(resolve, 200));
      const survivors = helpers.filter(alive);
      assert.equal(helpers.length, 201, 'fixture precondition: 201 helpers');
      assert.equal(outcome.exitCode, 0);
      const swept = outcome.sweptPids ?? [];
      assert.equal(outcome.sweepFailed, false, `sweep must not report a clean result while helpers remain (swept ${swept.length} of ${helpers.length})`);
      assert.equal(swept.length, 201, 'every retained-session helper is swept, not the first 200');
      assert.deepEqual(survivors, [], `no helper of session ${root} may survive a sweep reported as complete`);
    } finally {
      // Fixture helpers self-expire after 15 s. A red run can leave some alive, so kill whatever is still
      // in the fixture session before removing scratch.
      if (fs.existsSync(registry)) {
        const [root, ...helpers] = fs.readFileSync(registry, 'utf8').trim().split('\n').map(Number);
        for (const pid of helpers) {
          try {
            if (sessionOf(pid) === root && alive(pid)) process.kill(pid, 'SIGKILL');
          } catch { /* already gone */ }
        }
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('psTableRows (the no-/proc fallback) includes a session helper that has no controlling terminal', { skip: process.platform === 'win32' ? 'POSIX sh harness' : false }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-ps-fallback-'));
    const ps = path.join(dir, 'ps');
    // Models the default ps query, which lists only terminal-attached processes; `-A` is the full table.
    fs.writeFileSync(ps, '#!/bin/sh\ncase " $* " in\n  *" -A "*) printf "%s\\n" "  100 1 100 100 Ss" "  300 100 100 100 S" "  301 100 100 100 Z" ;;\n  *) printf "%s\\n" "  100 1 100 100 Ss" ;;\nesac\n');
    fs.chmodSync(ps, 0o755);
    try {
      const rows = psTableRows(ps);
      assert.notEqual(rows, null);
      assert.ok(rows?.some(row => row.p === 300), 'the helper without a terminal must be in the table the sweep uses');
      assert.equal(rows?.some(row => row.p === 301), false, 'a zombie is not a sweep target');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on macOS the table is requested without a `sid` column, which macOS ps rejects; elsewhere the session is read', { skip: process.platform === 'win32' ? 'POSIX sh harness' : false }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-ps-darwin-'));
    const ps = path.join(dir, 'ps');
    // Models macOS: a `sid` keyword is an error and exits non-zero; the supported columns print their rows.
    fs.writeFileSync(ps, '#!/bin/sh\ncase "$*" in\n  *sid=*) echo "ps: sid: keyword not found" >&2; exit 1 ;;\n  *) printf "%s\\n" "  100 1 100 Ss" "  300 100 300 S" "  301 100 100 Z" ;;\nesac\n');
    fs.chmodSync(ps, 0o755);
    try {
      const rows = psTableRows(ps, 'darwin');
      assert.notEqual(rows, null, 'a macOS table must not be reported as unreadable');
      assert.deepEqual(rows, [{ p: 100, ppid: 1, pgrp: 100, sid: -1 }, { p: 300, ppid: 100, pgrp: 300, sid: -1 }], 'a zombie is dropped and the session is unknown, not guessed');
      assert.equal(psTableRows(ps, 'linux'), null, 'where sid is requested and the tool refuses it, the sweep still reports "could not look", never "no survivors"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('on macOS the real ps lists this process, and a child that exits cleanly is swept as complete', { skip: process.platform === 'darwin' ? false : 'macOS only: the real BSD ps' }, async () => {
    const rows = psTableRows();
    assert.notEqual(rows, null, 'the macOS ps must accept the columns the sweep asks for');
    assert.ok(rows?.some(row => row.p === process.pid && row.ppid === process.ppid), 'this process is in the table');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-ps-real-'));
    try {
      const outcome = await runCommand({ ws: { root: scratch, fixture: scratch }, nodeDir: path.dirname(process.execPath), argv: [process.execPath, '-e', ''], timeoutSecs: 20 });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.sweepFailed, false, 'a command that left nothing behind is not reported as an unconfirmed sweep');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

type Row = { p: number; ppid: number; pgrp: number; sid: number };

/** In-memory process table: a successful kill removes the row, except for `unkillable` pids. */
function fakeIo(rows: Row[], { unkillable = new Set<number>(), tableFails = false } = {}): PosixSweepIo {
  const table = new Map(rows.map(row => [row.p, { ...row }]));
  return {
    self: 9999,
    table: () => (tableFails ? null : [...table.values()]),
    kill: pid => {
      if (!table.has(pid)) return false;
      if (!unkillable.has(pid)) table.delete(pid);
      return true;
    },
    killGroup: () => {},
    pause: () => {},
  };
}

describe('audit P0:19 — sweep pass logic over an injected process table', () => {
  it('201 killable session helpers are all killed and the sweep is complete', () => {
    const helpers = Array.from({ length: 201 }, (_, i) => ({ p: 101 + i, ppid: 100, pgrp: 100, sid: 100 }));
    const result = sweepPosixPasses(100, fakeIo([{ p: 100, ppid: 1, pgrp: 100, sid: 100 }, ...helpers]));
    assert.equal(result.failed, false);
    assert.equal(result.killed.length, 201);
  });

  it('an unkillable helper is a known survivor, so the sweep reports failure', () => {
    const rows = [{ p: 100, ppid: 1, pgrp: 100, sid: 100 }, { p: 150, ppid: 100, pgrp: 100, sid: 100 }];
    const result = sweepPosixPasses(100, fakeIo(rows, { unkillable: new Set([150]) }));
    assert.equal(result.failed, true);
  });

  it('a process outside the session and lineage is never touched', () => {
    const rows = [
      { p: 100, ppid: 1, pgrp: 100, sid: 100 },
      { p: 150, ppid: 100, pgrp: 100, sid: 100 },
      { p: 500, ppid: 1, pgrp: 500, sid: 500 },
    ];
    const result = sweepPosixPasses(100, fakeIo(rows));
    assert.deepEqual(result.killed, [150]);
    assert.equal(result.failed, false);
  });

  it('a descendant that escaped the session is reached through the PPID closure', () => {
    const rows = [
      { p: 100, ppid: 1, pgrp: 100, sid: 100 },
      { p: 150, ppid: 100, pgrp: 100, sid: 100 },
      { p: 700, ppid: 150, pgrp: 700, sid: 700 },
    ];
    const result = sweepPosixPasses(100, fakeIo(rows));
    assert.ok(result.killed.includes(700));
    assert.equal(result.failed, false);
  });

  it('an unreadable process table is a failed sweep, not an empty one', () => {
    const result = sweepPosixPasses(100, fakeIo([], { tableFails: true }));
    assert.equal(result.failed, true);
    assert.deepEqual(result.killed, []);
  });
});
