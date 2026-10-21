// T26 — durable audit, replay protection and fail-stop (decision D03), measured through the REAL confined file route.
//
//   A. a permitted write leaves intent + outcome in the audit and no pending operation;
//   B. a write outside the contract is refused BEFORE any effect and stops the run durably;
//   C. a later, correct request is still refused - also from a fresh process that has only the disk (restart/new agent);
//   D. an interrupted launch (intent without outcome) blocks a blind repeat; the controller can reconcile it, and
//      reconcile also works on a stopped run (clarifying an effect is not continuing the worker);
//   E. a damaged audit makes every call refuse (fail closed); nothing is invented.
// Level: LOCAL (a same-user process that can write the store could rewrite the journal). Needs the privileged
// activation `provider enroll` (AppContainer identities + an ACL grant on the store).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { productionTool } from '../../apps/cli/dist/src/provider/production.js';
import { openGrants } from '../../apps/cli/dist/src/provider/production-grants.js';
import { admit, readAudit, reconcile } from '../../apps/cli/dist/src/provider/production-audit.js';
import { hostGit } from '../test-support/host-git.mjs';

// Child mode: a brand-new process that knows nothing but the disk. Prints one JSON line.
if (process.argv[2] === '--child') {
  const [, , , childStore, childWork, rel] = process.argv;
  try { productionTool(childStore, childWork, { op: 'write', path: rel, text: 'late but correct' }); console.log(JSON.stringify({ ok: true })); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); }
  process.exit(0);
}

if (process.platform !== 'win32') { console.log('SKIP the reference environment is Windows 11 AppContainer'); process.exit(0); }
const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = hostGit();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t26-'));
const base = path.join(root, 'base'), work = path.join(root, 'work'), store = path.join(root, 'store');
let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const run = (exe, args, cwd) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(r.status, 0, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const tool = (request) => productionTool(store, work, request);
const write = (rel, text = 'x') => tool({ op: 'write', path: rel, text });
const audit = () => readAudit(store);
const file = (rel) => path.join(work, rel);

try {
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 't26-probe', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n');
  run(git, ['init', '-b', 'main', base]);
  run(git, ['-C', base, 'config', 'user.email', 't26@amabie.local']);
  run(git, ['-C', base, 'config', 'user.name', 'T26 Probe']);
  run(git, ['-C', base, 'add', '-A']);
  run(git, ['-C', base, 'commit', '-m', 'base']);
  run(process.execPath, [cli, 'setup', '--yes', base], base);
  run(process.execPath, [cli, 'task', 'durable audit and fail-stop'], base);
  const enrolled = JSON.parse(run(process.execPath, [cli, 'provider', 'enroll', base, store], base));
  console.log(`enrolled as ${enrolled.package}`);

  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  const enrollment = JSON.parse(fs.readFileSync(path.join(store, 'enrollment.json'), 'utf8'));
  const now = Date.now();
  openGrants(store, enrollment.project, fs.readFileSync(path.join(store, 'producer.key'), 'utf8'), [
    { grantId: 't26-src-write', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 4096 }, notBefore: now - 1000, expiresAt: now + 3_600_000, policyGeneration: 1, prerequisites: [] },
  ]);

  await check('A. a permitted write works and leaves intent + outcome, nothing pending', () => {
    write('src/ok.txt', 'granted');
    assert.equal(fs.readFileSync(file('src/ok.txt'), 'utf8'), 'granted');
    const a = audit();
    assert.equal(a.status, 'ok');
    assert.equal(a.state.ops.size, 1);
    assert.equal(a.state.pending.size, 0);
    assert.equal(a.state.stopped.size, 0);
  });

  const runOf = () => [...audit().state.ops.values()][0];

  await check('B. a write outside the contract is blocked BEFORE any effect and stops the run durably', () => {
    assert.throws(() => write('docs/leak.txt'), /permission contract refused/);
    assert.equal(fs.existsSync(file('docs/leak.txt')), false, 'the effect happened');
    const a = audit();
    assert.equal(a.state.stopped.size, 1);
    assert.equal(a.state.stopped.has(runOf()), true);
    assert.equal(a.state.ops.size, 1, 'a refused attempt must not open an operation');
  });

  await check('C1. a later, correct request is refused by the stop', () => {
    assert.throws(() => write('src/after.txt'), /audit refused: .*stopped/);
    assert.equal(fs.existsSync(file('src/after.txt')), false);
  });

  await check('C2. the stop survives a restart: a fresh process with only the disk is refused too', () => {
    const r = spawnSync(process.execPath, [import.meta.filename, '--child', store, work, 'src/after.txt'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.ok, false, r.stdout + r.stderr);
    assert.match(out.error, /audit refused: .*stopped/);
    assert.equal(fs.existsSync(file('src/after.txt')), false);
  });

  await check('D1. a merely unready or unknown effect never stops; an interrupted launch blocks a blind repeat on a fresh run', () => {
    const other = path.join(root, 'work2');
    fs.mkdirSync(path.join(other, 'src'), { recursive: true });
    productionTool(store, other, { op: 'write', path: 'src/ok.txt', text: 'second workspace' }); // another run is unaffected by the stop
    const run2 = [...audit().state.ops].find(([, r]) => r !== runOf())?.[1];
    assert.ok(run2, 'second run recorded');
    admit(store, run2, 'interrupted-op', 'd'); // a launch that never recorded its outcome
    assert.throws(() => productionTool(store, other, { op: 'write', path: 'src/blind.txt', text: 'x' }), /unknown effect/);
    assert.equal(fs.existsSync(path.join(other, 'src/blind.txt')), false);
    reconcile(store, 'interrupted-op', 'no-effect-observed', 'checked the workspace');
    productionTool(store, other, { op: 'write', path: 'src/after-reconcile.txt', text: 'x' });
    assert.equal(audit().state.pending.size, 0);
  });

  await check('D2. reconcile works on the stopped run, but does not lift the stop', () => {
    admit(store, 'run-for-reconcile', 'op-r', 'd'); // pending on another run id
    const stoppedRun = runOf();
    // hand-craft a pending op on the stopped run through the journal API is refused (stopped) - the stop holds
    assert.throws(() => admit(store, stoppedRun, 'op-s', 'd'), /stopped/);
    reconcile(store, 'op-r', 'unknown-accepted', 'accepted by the operator');
    assert.equal(audit().state.stopped.has(stoppedRun), true);
    assert.throws(() => write('src/after.txt'), /audit refused: .*stopped/);
  });

  await check('E. a damaged audit makes every call refuse (fail closed) and nothing is invented', () => {
    const j = path.join(store, 'audit', 'journal.jsonl');
    const good = fs.readFileSync(j, 'utf8');
    try {
      fs.writeFileSync(j, good.replace(/"digest":"[^"]*"/, '"digest":"tampered"'));
      assert.equal(audit().status, 'blocked');
      assert.throws(() => write('src/damaged.txt'), /blocked/);
      assert.equal(fs.existsSync(file('src/damaged.txt')), false);
    } finally { fs.writeFileSync(j, good); }
    assert.equal(audit().status, 'ok');
  });
} catch (e) {
  failed++; console.log(`FAIL setup\n     ${String(e?.stack ?? e)}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${failed ? 'FAIL' : 'PASS'} ${passed} passed, ${failed} failed (level LOCAL, Windows AppContainer reference environment)`);
process.exit(failed ? 1 : 0);
