import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gateRequest, openGrants } from '../src/provider/production-grants.js';
import type { GrantPayload } from '../src/permission-contract.js';

const keys = crypto.generateKeyPairSync('ed25519');
const pem = (k: crypto.KeyObject, t: 'public' | 'private') => k.export({ type: t === 'public' ? 'spki' : 'pkcs8', format: 'pem' }).toString();
const NOW = Date.now();
const grant = (over: Partial<GrantPayload> = {}): GrantPayload => ({
  grantId: 'g1', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 100 },
  notBefore: NOW - 1000, expiresAt: NOW + 60_000, policyGeneration: 1, prerequisites: [], ...over,
});

function fixture(grants: GrantPayload[] | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-grants-'));
  const store = path.join(root, 'store'), cwd = path.join(root, 'work');
  fs.mkdirSync(store); fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(store, 'producer.pub'), pem(keys.publicKey, 'public'));
  if (grants) openGrants(store, 'p1', pem(keys.privateKey, 'private'), grants);
  const gate = (request: unknown) => gateRequest(store, 'p1', cwd, request, NOW);
  return { root, store, cwd, gate };
}
const w = (p: string, text = 'hi') => ({ op: 'write', path: p, text });

test('a store without grants/ is not gated; with grants/ only covered file operations pass', () => {
  const open = fixture(null);
  const f = fixture([grant()]);
  try {
    open.gate(w('anything/at/all.txt'));
    f.gate(w('src/a.txt'));
    f.gate({ operations: [w('src/a.txt'), { op: 'list' }, { op: 'list', path: 'src' }] });
    assert.throws(() => f.gate(w('docs/b.txt')), /outside-scope/);
    assert.throws(() => f.gate({ operations: [w('src/a.txt'), w('docs/b.txt')] }), /outside-scope/); // one bad op refuses the call
    assert.throws(() => f.gate({ op: 'read', path: 'src/a.txt' }), /outside-scope/); // a write grant is not a read grant
    assert.throws(() => f.gate(w('src/a.txt', 'x'.repeat(101))), /outside-scope/);
    assert.throws(() => f.gate({ op: 'edit', path: 'src/a.txt', find: 'a', replace: 'x'.repeat(101) }), /outside-scope/);
  } finally { fs.rmSync(open.root, { recursive: true, force: true }); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('absolute, traversal, stream, 8.3, device and .git paths never reach the contract as authorized', () => {
  const f = fixture([grant({ resource: { kind: 'file', path: '.' } as never })]);
  try {
    for (const p of ['C:\\Windows\\x', '/etc/x', '../x', 'src/../../x', 'src/a.txt:ads', 'PROGRA~1/x', 'src/nul', 'src/con.txt', 'src/a.', '.git/config'])
      assert.throws(() => f.gate(w(p)), /refused/, p);
    assert.throws(() => f.gate({ op: 'write', path: 5, text: 'x' }), /refused/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('exec, a declared check, an unknown op and a link inside the workspace are refused', () => {
  const f = fixture([grant()]);
  const outside = path.join(f.root, 'outside');
  try {
    fs.mkdirSync(outside);
    assert.throws(() => f.gate({ op: 'exec', argv: ['node', '-v'] }), /exec/);
    assert.throws(() => f.gate({ operations: [w('src/a.txt')], check: { argv: ['node'] } }), /check/);
    assert.throws(() => f.gate({ op: 'delete', path: 'src/a.txt' }), /unknown/);
    fs.symlinkSync(outside, path.join(f.cwd, 'src', 'link'), 'junction');
    assert.throws(() => f.gate(w('src/link/x.txt')), /link/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('expired or revoked grants and a newer policy generation refuse everything', () => {
  const expired = fixture([grant({ expiresAt: NOW - 1 })]);
  const stale = fixture([grant({ policyGeneration: 2 })]);
  try {
    assert.throws(() => expired.gate(w('src/a.txt')), /expired/);
    assert.throws(() => stale.gate(w('src/a.txt')), /predates/);
    fs.writeFileSync(path.join(stale.store, 'grants', 'policy.json'), JSON.stringify({ generation: 2, revoked: ['g1'], deny: [] }));
    assert.throws(() => stale.gate(w('src/a.txt')), /revoked/);
  } finally { fs.rmSync(expired.root, { recursive: true, force: true }); fs.rmSync(stale.root, { recursive: true, force: true }); }
});
