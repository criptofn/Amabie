/**
 * P1:16 — the node:test reporter pairs start/pass events by a per-declaration identity.
 *
 * Node 22.23.3 reporter events carry NO `testId`, `parentId` or `entryFile`; they carry `name`,
 * `line` and `column`. Keying by the leaf name made two honest same-name subtests under different
 * parents collide: the second pass was rejected as `dup-pass`, and a real green suite failed closed
 * as INVALID (`rejected-event`). These tests load the SHIPPED reporter bytes in a vm context and feed
 * it both event shapes, so the claim is checked on any host Node, not only on the one that runs the
 * test. The positive controls keep a true replay refused.
 */
import assert from 'node:assert/strict';
import { Transform } from 'node:stream';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { NODE_TEST_REPORTER_SOURCE } from '../src/observers/node-test-reporter.js';

type Frame = { k: string; id?: string; tid?: unknown; reason?: string; ev?: string };

/** Loads the reporter bytes and returns a function that feeds events and returns the fd-3 frames. */
function runReporter(nodeVersion: string) {
  const frames: Frame[] = [];
  const fakeFs = {
    writeSync: (_fd: number, text: string) => { frames.push(JSON.parse(text)); },
    closeSync: () => {},
  };
  const fakeRequire = (id: string) => {
    if (id === 'node:stream') return { Transform };
    if (id === 'node:fs') return fakeFs;
    throw new Error(`unexpected require ${id}`);
  };
  const sandbox = {
    require: fakeRequire,
    module: { exports: {} as Record<string, unknown> },
    process: { on: () => {}, pid: 1000, ppid: 999, versions: { node: nodeVersion }, env: {} },
  };
  vm.runInNewContext(NODE_TEST_REPORTER_SOURCE, sandbox);
  const Reporter = sandbox.module.exports as unknown as new (o: object) => { _transform(e: unknown, enc: string, cb: () => void): void };
  const reporter = new Reporter({});
  return {
    feed(events: Array<{ type: string; data: Record<string, unknown> }>) {
      for (const event of events) reporter._transform(event, 'utf8', () => {});
      return frames.slice();
    },
  };
}

const FILE = '/work/proj/test/shared.test.js';

/** Node 22 shape: no testId, no parentId, no entryFile — location only. */
function node22(type: string, name: string, line: number, extra: Record<string, unknown> = {}) {
  return { type, data: { name, line, column: 3, file: FILE, ...extra } };
}

/** Node 26 shape: a unique testId per declaration. */
function node26(type: string, name: string, testId: number, extra: Record<string, unknown> = {}) {
  return { type, data: { name, testId, line: testId, column: 3, file: FILE, ...extra } };
}

const TWO_SHARED_UNDER_DIFFERENT_PARENTS_NODE22 = [
  node22('test:start', 'A', 1),
  node22('test:start', 'shared', 2),
  node22('test:pass', 'shared', 2),
  node22('test:pass', 'A', 1),
  node22('test:start', 'B', 4),
  node22('test:start', 'shared', 5),
  node22('test:pass', 'shared', 5),
  node22('test:pass', 'B', 4),
];

describe('P1:16 — same-name subtests under different parents are distinct declarations', () => {
  it('Node 22 shape: two `shared` subtests at different lines both pass, with no rejection', () => {
    const frames = runReporter('22.23.3').feed(TWO_SHARED_UNDER_DIFFERENT_PARENTS_NODE22);
    const passes = frames.filter(f => f.k === 'pass');
    const rejects = frames.filter(f => f.k === 'reject');
    assert.equal(rejects.length, 0, `no honest pass may be rejected: ${JSON.stringify(rejects)}`);
    assert.equal(passes.filter(f => f.id === 'shared').length, 2, 'both `shared` passes are counted');
    const [first, second] = passes.filter(f => f.id === 'shared');
    assert.notEqual(first?.tid, undefined, 'a Node 22 pass frame carries an identity for the attribution check');
    assert.notEqual(first?.tid, second?.tid, 'the two declarations have distinct identities');
  });

  it('Node 26 shape: two `shared` subtests with distinct testIds both pass', () => {
    const frames = runReporter('26.7.0').feed([
      node26('test:start', 'A', 1),
      node26('test:start', 'shared', 2),
      node26('test:pass', 'shared', 2),
      node26('test:start', 'B', 4),
      node26('test:start', 'shared', 5),
      node26('test:pass', 'shared', 5),
    ]);
    assert.equal(frames.filter(f => f.k === 'reject').length, 0);
    assert.deepEqual(frames.filter(f => f.k === 'pass').map(f => f.tid), [2, 5]);
  });
});

describe('P1:16 positive control — a true replay is still refused', () => {
  it('Node 22 shape: an identical second pass for the same declaration is rejected as dup-pass', () => {
    const frames = runReporter('22.23.3').feed([
      node22('test:start', 'shared', 2),
      node22('test:pass', 'shared', 2),
      node22('test:pass', 'shared', 2),
    ]);
    const rejects = frames.filter(f => f.k === 'reject');
    assert.equal(frames.filter(f => f.k === 'pass').length, 1, 'only the first pass is counted');
    assert.deepEqual(rejects.map(f => f.reason), ['dup-pass']);
  });

  it('Node 26 shape: a repeated testId is rejected as dup-pass', () => {
    const frames = runReporter('26.7.0').feed([
      node26('test:start', 'shared', 7),
      node26('test:pass', 'shared', 7),
      node26('test:pass', 'shared', 7),
    ]);
    assert.deepEqual(frames.filter(f => f.k === 'reject').map(f => f.reason), ['dup-pass']);
  });

  it('a pass for a declaration that never started is still refused as no-run', () => {
    const frames = runReporter('22.23.3').feed([node22('test:pass', 'ghost', 9)]);
    assert.deepEqual(frames.filter(f => f.k === 'reject').map(f => f.reason), ['no-run']);
  });
});
