import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { admit, complete, noteRefusal, readAudit, reconcile, runId } from '../src/provider/production-audit.js';
import { GateRefusal, gateRequest, openGrants } from '../src/provider/production-grants.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-audit-'));
const id = () => crypto.randomUUID();
const file = (store: string) => path.join(store, 'audit', 'journal.jsonl');
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });

test('T26: intent then outcome; the state survives a re-read and an operation id is never fresh again', () => {
  const store = mk(), run = runId('w1'), op = id();
  try {
    admit(store, run, op, 'd');
    assert.equal(readAudit(store).state.pending.size, 1); // recorded BEFORE the effect
    complete(store, op, 'completed');
    const again = readAudit(store); // "restart": nothing but the disk
    assert.equal(again.status, 'ok');
    assert.equal(again.state.pending.size, 0);
    assert.throws(() => admit(store, run, op, 'd'), /reused/); // replay of a finished operation
    assert.throws(() => complete(store, op, 'completed'), /no pending/); // and no second outcome
  } finally { rm(store); }
});

test('T26: an intent without an outcome means the effect is unknown - the run refuses until it is reconciled', () => {
  const store = mk(), run = runId('w1'), op = id();
  try {
    admit(store, run, op, 'd'); // interrupted: no complete()
    assert.throws(() => admit(store, run, id(), 'd'), /unknown effect/); // no blind repeat
    admit(store, runId('other-workspace'), id(), 'd'); // another run is unaffected
    reconcile(store, op, 'no-effect-observed', 'checked the workspace');
    admit(store, run, id(), 'd');
    assert.throws(() => reconcile(store, op, 'unknown-accepted', 'x'), /no pending/);
  } finally { rm(store); }
});

test('T26: a real attempt stops the run durably; a correct request later does not lift it; an unready call does not stop', () => {
  const store = mk(), run = runId('w1');
  try {
    noteRefusal(store, run, new GateRefusal('permission contract refused: write secret.txt: forbidden (no grant)', true));
    admit(store, run, id(), 'd'); // merely unready: not a violation
    complete(store, [...readAudit(store).state.pending.keys()][0]!, 'none');
    noteRefusal(store, run, new GateRefusal('permission contract refused: write secret.txt: outside-scope (x)'));
    assert.equal(readAudit(store).state.stopped.size, 1);
    assert.throws(() => admit(store, run, id(), 'd'), /stopped/);
    // restart / new agent: only the disk is left, the stop is still there
    assert.throws(() => admit(store, run, id(), 'd'), /stopped/);
    assert.equal(readAudit(store).state.stopped.has(run), true);
    // independent clarification stays possible on a stopped run
    const pendingRun = runId('w2'), op = id();
    admit(store, pendingRun, op, 'd');
    noteRefusal(store, pendingRun, new GateRefusal('permission contract refused: exec: forbidden (no grant)'));
    reconcile(store, op, 'effect-observed', 'backup taken, effect confirmed');
    assert.throws(() => admit(store, pendingRun, id(), 'd'), /stopped/);
  } finally { rm(store); }
});

test('T26: a torn final record is discarded and truncated on the next append', () => {
  const store = mk(), run = runId('w1'), op = id();
  try {
    admit(store, run, op, 'd');
    fs.appendFileSync(file(store), 'deadbeef {"seq":2,"prev":"x","ev'); // crash mid-append
    const r = readAudit(store);
    assert.equal(r.status, 'ok');
    assert.equal(r.tornTail, true);
    assert.equal(r.state.pending.size, 1);
    complete(store, op, 'completed');
    assert.equal(readAudit(store).tornTail, false);
    assert.equal(readAudit(store).state.pending.size, 0);
  } finally { rm(store); }
});

test('T26: a damaged, reordered or unreadable audit fails closed and invents nothing', () => {
  const store = mk(), run = runId('w1');
  try {
    admit(store, run, id(), 'd');
    admit(store, runId('b'), id(), 'd');
    const good = fs.readFileSync(file(store), 'utf8');
    fs.writeFileSync(file(store), good.replace('"digest":"d"', '"digest":"e"')); // edited line
    assert.equal(readAudit(store).status, 'blocked');
    assert.throws(() => admit(store, run, id(), 'd'), /blocked/);
    assert.throws(() => complete(store, id(), 'completed'), /blocked/);
    fs.writeFileSync(file(store), good.split('\n').reverse().join('\n')); // reordered
    assert.equal(readAudit(store).status, 'blocked');
    fs.rmSync(file(store)); fs.mkdirSync(file(store)); // journal.jsonl is a directory
    assert.equal(readAudit(store).status, 'blocked');
    assert.throws(() => admit(store, run, id(), 'd'), /blocked/);
  } finally { rm(store); }
});

test('T26: the gate separates "unready" from an actual attempt', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const root = mk(), store = path.join(root, 'store'), cwd = path.join(root, 'work');
  fs.mkdirSync(store); fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(store, 'producer.pub'), keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  openGrants(store, 'p', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), [
    { grantId: 'g', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 50 }, notBefore: now - 1000, expiresAt: now + 60_000, policyGeneration: 1, prerequisites: ['plan-approved'] },
  ]);
  try {
    const catchIt = (req: unknown): GateRefusal => { try { gateRequest(store, 'p', cwd, req, now); } catch (e) { return e as GateRefusal; } throw new Error('not refused'); };
    const unready = catchIt({ op: 'write', path: 'src/a.txt', text: 'x' });
    assert.equal(unready instanceof GateRefusal && unready.unready, true);
    const attempt = catchIt({ op: 'write', path: 'docs/a.txt', text: 'x' });
    assert.equal(attempt.unready, false);
    // an unready operation does not hide a forbidden one in the same call
    assert.equal(catchIt({ operations: [{ op: 'write', path: 'src/a.txt', text: 'x' }, { op: 'write', path: 'docs/a.txt', text: 'x' }] }).unready, false);
  } finally { rm(root); }
});
