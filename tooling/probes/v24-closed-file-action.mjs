// T24 — one real bounded file action, mediated end to end, measured through the REAL confined boundary.
//
// Two independent layers are measured separately:
//   A. the permission contract (signed grant, checked in the controller BEFORE the confined process starts);
//   B. the OS boundary (AppContainer), with the contract switched off by the controller - so a contract bug
//      cannot hide an OS hole and an OS hole cannot hide behind the contract.
// Reference environment: Windows 11 AppContainer (D07). Level: LOCAL - never relabelled HARDENED.
// Needs the privileged activation `provider enroll` (AppContainer identities + a read/execute ACL grant on the store).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { productionTool } from '../../apps/cli/dist/src/provider/production.js';
import { openGrants } from '../../apps/cli/dist/src/provider/production-grants.js';
import { hostGit } from '../test-support/host-git.mjs';

if (process.platform !== 'win32') { console.log('SKIP the reference environment is Windows 11 AppContainer'); process.exit(0); }
const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = hostGit();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t24-'));
const base = path.join(root, 'base'), work = path.join(root, 'work'), store = path.join(root, 'store'), outside = path.join(root, 'outside');
let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const run = (exe, args, cwd) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(r.status, 0, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const DENIED = /permission denied|access is denied|EPERM|EACCES|operation not permitted|ENOENT/i;
const REFUSED = /permission contract refused/;
const tool = (request) => productionTool(store, work, request);
const refused = (request, why) => assert.throws(() => tool(request), why);

try {
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'trusted bytes outside the boundary\n');
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 't24-probe', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n');
  run(git, ['init', '-b', 'main', base]);
  run(git, ['-C', base, 'config', 'user.email', 't24@amabie.local']);
  run(git, ['-C', base, 'config', 'user.name', 'T24 Probe']);
  run(git, ['-C', base, 'add', '-A']);
  run(git, ['-C', base, 'commit', '-m', 'base']);
  run(process.execPath, [cli, 'setup', '--yes', base], base);
  run(process.execPath, [cli, 'task', 'closed file action audit'], base);
  const enrolled = JSON.parse(run(process.execPath, [cli, 'provider', 'enroll', base, store], base));
  console.log(`enrolled as ${enrolled.package}`);

  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  const enrollment = JSON.parse(fs.readFileSync(path.join(store, 'enrollment.json'), 'utf8'));
  const now = Date.now();
  openGrants(store, enrollment.project, fs.readFileSync(path.join(store, 'producer.key'), 'utf8'), [{
    grantId: 't24-src-write', source: 'user', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 4096 },
    notBefore: now - 1000, expiresAt: now + 3_600_000, policyGeneration: 1, prerequisites: [],
  }]);

  const trusted = ['producer.key', 'enrollment.json', 'producer.pub'].map(f => path.join(store, f)).concat(path.join(outside, 'secret.txt'), path.join(base, 'package.json'));
  const before = trusted.map(sha);
  const headBefore = run(git, ['-C', base, 'rev-parse', 'HEAD'], base);

  // ── A. contract on ──
  check('A1. a granted write actually executes inside the AppContainer', () => {
    const r = tool({ op: 'write', path: 'src/a.txt', text: 'granted\n' });
    assert.equal(fs.readFileSync(path.join(work, 'src', 'a.txt'), 'utf8'), 'granted\n', JSON.stringify(r));
    const facts = [r.observation].flat().find(o => o?.sideChannel === true);
    assert.deepEqual([facts?.appContainer, facts?.restricted, facts?.capabilities, facts?.integrity], [true, true, 0, 'S-1-16-4096'], JSON.stringify(r.observation));
  });
  check('A2. an edit inside the grant executes too', () => {
    tool({ op: 'edit', path: 'src/a.txt', find: 'granted', replace: 'edited' });
    assert.equal(fs.readFileSync(path.join(work, 'src', 'a.txt'), 'utf8'), 'edited\n');
  });
  check('A3. the same effect outside the grant is refused and nothing is written', () => {
    refused({ op: 'write', path: 'docs/b.txt', text: 'x' }, /outside-scope/);
    assert.equal(fs.existsSync(path.join(work, 'docs', 'b.txt')), false);
  });
  check('A4. absolute and traversal targets are refused before launch; bytes unchanged', () => {
    refused({ op: 'write', path: path.join(outside, 'secret.txt'), text: 'OWNED' }, REFUSED);
    refused({ op: 'edit', path: '../outside/secret.txt', find: 'trusted', replace: 'OWNED' }, REFUSED);
    refused({ op: 'write', path: 'src/a.txt:stream', text: 'x' }, REFUSED);
  });
  check('A5. the alternative native route (exec, declared check) has no grant and is refused', () => {
    refused({ op: 'exec', argv: ['cmd.exe', '/c', 'echo owned > src\\x.txt'] }, /exec/);
    refused({ operations: [{ op: 'write', path: 'src/c.txt', text: 'x' }], check: { argv: ['cmd.exe'] } }, /check/);
    assert.equal(fs.existsSync(path.join(work, 'src', 'c.txt')), false);
  });
  const link = path.join(work, 'src', 'link');
  check('A6. a controller-planted junction under the granted path is refused', () => {
    fs.symlinkSync(outside, link, 'junction');
    refused({ op: 'write', path: 'src/link/x.txt', text: 'x' }, /link/);
    assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
  });

  // ── B. contract OFF (controller action): the OS alone must still bound the process ──
  const off = path.join(store, 'grants.off');
  fs.renameSync(path.join(store, 'grants'), off);
  try {
    const hit = (request) => JSON.stringify(tool(request));
    check('B1. OS alone: absolute path to a trusted file outside is denied', () => {
      assert.match(hit({ op: 'write', path: path.join(outside, 'secret.txt'), text: 'OWNED' }), DENIED);
    });
    check('B2. OS alone: writing through the junction is denied', () => {
      assert.match(hit({ op: 'write', path: 'src/link/x.txt', text: 'OWNED' }), DENIED);
      assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
    });
    check('B3. OS alone: controller key and enrollment are not writable by the worker', () => {
      assert.match(hit({ op: 'write', path: path.join(store, 'producer.key'), text: 'OWNED' }), DENIED);
      assert.match(hit({ op: 'write', path: path.join(store, 'enrollment.json'), text: 'OWNED' }), DENIED);
    });
    check('B4. OS alone: the base checkout is not writable by the worker', () => {
      assert.match(hit({ op: 'write', path: path.join(base, 'package.json'), text: 'OWNED' }), DENIED);
      assert.match(hit({ op: 'write', path: path.join(base, '.git', 'HEAD'), text: 'OWNED' }), DENIED);
    });
  } finally { fs.renameSync(off, path.join(store, 'grants')); }

  check('C. trusted bytes (keys, enrollment, outside file, base file) and base HEAD are unchanged', () => {
    assert.deepEqual(trusted.map(sha), before);
    assert.equal(run(git, ['-C', base, 'rev-parse', 'HEAD'], base), headBefore);
    assert.equal(fs.existsSync(path.join(store, 'grants')), true);
  });
} catch (e) {
  failed++; console.log(`FAIL setup\n     ${String(e?.message ?? e)}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${failed ? 'FAIL' : 'PASS'} ${passed} passed, ${failed} failed (level LOCAL, Windows AppContainer reference environment)`);
process.exit(failed ? 1 : 0);
