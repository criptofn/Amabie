import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gateRequest, openGrants } from '../src/provider/production-grants.js';
import type { ExecGrantPayload, GrantPayload } from '../src/permission-contract.js';

const keys = crypto.generateKeyPairSync('ed25519');
const pem = (k: crypto.KeyObject, t: 'public' | 'private') => k.export({ type: t === 'public' ? 'spki' : 'pkcs8', format: 'pem' }).toString();
const NOW = Date.now();
const grant = (over: Partial<GrantPayload> = {}): GrantPayload => ({
  grantId: 'g1', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 100 },
  notBefore: NOW - 1000, expiresAt: NOW + 60_000, policyGeneration: 1, prerequisites: [], ...over,
});

function fixture(grants: Array<GrantPayload | ExecGrantPayload> | null) {
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

const proc = (argv: string[], over: Partial<ExecGrantPayload> = {}): ExecGrantPayload => ({
  grantId: 'p1', source: 'user', resource: { kind: 'process', argv }, operation: 'exec', args: {},
  notBefore: NOW - 1000, expiresAt: NOW + 60_000, policyGeneration: 1, prerequisites: [], ...over,
});
const ex = (argv: unknown) => ({ op: 'exec', argv });

test('T25: a process runs only on an exact-argv grant; file and process grants never cover each other', () => {
  const f = fixture([grant(), proc(['node', 'src/t.js'])]);
  try {
    f.gate(ex(['node', 'src/t.js']));
    f.gate({ operations: [w('src/a.txt'), ex(['node', 'src/t.js'])], check: { argv: ['node', 'src/t.js'] } });
    assert.throws(() => f.gate(ex(['node', 'src/other.js'])), /outside-scope/); // other argument
    assert.throws(() => f.gate(ex(['node'])), /outside-scope/); // prefix is not the grant
    assert.throws(() => f.gate(ex(['node', 'src/t.js', '--x'])), /outside-scope/); // extension is not the grant
    assert.throws(() => f.gate(ex(['cmd.exe', '/c', 'echo owned'])), /outside-scope/); // a shell is not granted
    assert.throws(() => f.gate({ operations: [w('src/a.txt')], check: { argv: ['node', 'other.js'] } }), /check/);
    for (const bad of [['C:\\Windows\\System32\\cmd.exe'], ['..\\x.exe'], ['./node'], [], 'node', [5], ['node\0']])
      assert.throws(() => f.gate(ex(bad)), /unclear/, JSON.stringify(bad));
    assert.throws(() => f.gate(w('docs/b.txt')), /outside-scope/); // the exec grant is no file grant
    const onlyProc = fixture([proc(['node', 'src/t.js'])]);
    try { assert.throws(() => onlyProc.gate(w('src/a.txt')), /forbidden/); } finally { fs.rmSync(onlyProc.root, { recursive: true, force: true }); }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('T25: an exec grant can be expired, revoked, superseded or unmet like a file grant', () => {
  const expired = fixture([proc(['node'], { expiresAt: NOW - 1 })]);
  const stale = fixture([proc(['node'])]);
  const unready = fixture([proc(['node'], { prerequisites: ['plan-approved'] })]);
  try {
    assert.throws(() => expired.gate(ex(['node'])), /expired/);
    assert.throws(() => unready.gate(ex(['node'])), /unready/);
    fs.writeFileSync(path.join(stale.store, 'grants', 'policy.json'), JSON.stringify({ generation: 1, revoked: ['p1'], deny: [] }));
    assert.throws(() => stale.gate(ex(['node'])), /revoked/);
    fs.writeFileSync(path.join(stale.store, 'grants', 'policy.json'), JSON.stringify({ generation: 2, revoked: [], deny: [] }));
    assert.throws(() => stale.gate(ex(['node'])), /predates/);
  } finally { for (const x of [expired, stale, unready]) fs.rmSync(x.root, { recursive: true, force: true }); }
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
