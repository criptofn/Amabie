import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { decide, issueGrant, runFileAction, type FileAction, type GrantPayload, type PermissionContext } from '../src/permission-contract.js';

const keys = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const pem = (k: crypto.KeyObject, t: 'public' | 'private') => k.export({ type: t === 'public' ? 'spki' : 'pkcs8', format: 'pem' }).toString();
const NOW = 1_000_000;
const base: GrantPayload = {
  grantId: 'g1', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 100 },
  notBefore: NOW - 10, expiresAt: NOW + 10, policyGeneration: 1, prerequisites: [],
};
const grant = (over: Partial<GrantPayload> = {}) => issueGrant({ ...base, ...over }, 1, 'p1', pem(keys.privateKey, 'private'));
const ctx = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  projectId: 'p1', grantKeyPem: pem(keys.publicKey, 'public'), now: NOW, policyGeneration: 1, revoked: new Set(), met: new Set(), ...over,
});
const write = (p: string, text = 'hi'): FileAction => ({ resource: { kind: 'file', path: p }, operation: 'write', args: { text } });
const ask = (action: unknown, g: ReturnType<typeof grant> | null, c = ctx(), source: 'worker-proposal' | 'tool-text' = 'worker-proposal') =>
  decide({ source, action, grant: g }, c).decision;

test('the five outcomes: authorized, forbidden, outside scope, unclear, allowed-but-unready', () => {
  assert.equal(ask(write('src/a.ts'), grant()), 'authorized');
  assert.equal(ask(write('src/a.ts'), null), 'forbidden');
  assert.equal(ask(write('docs/a.md'), grant()), 'outside-scope');
  assert.equal(ask(write('../escape'), grant()), 'unclear');
  assert.equal(ask(write('src/a.ts'), grant({ prerequisites: ['baseline-clean'] })), 'unready');
  assert.equal(ask(write('src/a.ts'), grant({ prerequisites: ['baseline-clean'] }), ctx({ met: new Set(['baseline-clean']) })), 'authorized');
});

test('scope is exact: operation, size, and the sibling that only shares a name prefix', () => {
  assert.equal(ask({ ...write('src/a.ts'), operation: 'read', args: {} }, grant()), 'outside-scope');
  assert.equal(ask(write('src/a.ts', 'x'.repeat(101)), grant()), 'outside-scope');
  assert.equal(ask(write('src2/a.ts'), grant()), 'outside-scope');
  assert.equal(ask(write('SRC/A.ts'), grant()), 'authorized'); // one resource on a case-insensitive filesystem
});

test('expiry, revocation, a newer policy, a foreign key and a wrong project are decided before the action', () => {
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ now: NOW + 10 })), 'forbidden');
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ now: NOW - 11 })), 'forbidden');
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ revoked: new Set(['g1']) })), 'forbidden');
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ policyGeneration: 2 })), 'forbidden');
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ grantKeyPem: pem(other.publicKey, 'public') })), 'forbidden');
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ projectId: 'p2' })), 'forbidden');
  assert.equal(ask(write('src/a.ts'), grant(), ctx({ deny: ['src/a.ts'] })), 'forbidden');
});

test('untrusted text and worker-forged grants mint nothing; only user or policy can issue', () => {
  assert.equal(ask(write('src/a.ts'), grant(), ctx(), 'tool-text'), 'forbidden');
  const forged = { ...grant(), payload: { ...base, resource: { kind: 'file', path: '.' }, expiresAt: NOW + 1e9 } };
  assert.equal(ask(write('docs/a.md'), forged as never), 'forbidden'); // payload changed after signing
  assert.throws(() => grant({ source: 'tool-text' as never }));
  assert.equal(ask({ ...write('src/a.ts'), extra: 1 }, grant()), 'unclear'); // closed fields
});

test('the adapter writes only on an authorized verdict and keeps to the project root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-perm-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    const ok = write('src/a.txt', 'hello');
    runFileAction(dir, ok, decide({ source: 'worker-proposal', action: ok, grant: grant() }, ctx()));
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.txt'), 'utf8'), 'hello');
    const denied = write('docs/b.txt');
    assert.throws(() => runFileAction(dir, denied, decide({ source: 'worker-proposal', action: denied, grant: grant() }, ctx())), /outside-scope/);
    assert.equal(fs.existsSync(path.join(dir, 'docs')), false);
    assert.throws(() => runFileAction(dir, ok, { decision: 'forbidden', reason: 'x', level: 'LOCAL' }), /refused/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
