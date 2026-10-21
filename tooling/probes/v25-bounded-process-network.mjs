// T25 — bounded processes, child processes, direct network and credential paths, measured through the REAL confined boundary.
//
// Layers are measured separately, never blended:
//   A. permission contract: a process starts only on a signed EXACT-argv grant (checked in the controller BEFORE launch);
//   B. OS boundary (AppContainer) with the contract switched off by the controller, so the OS alone is measured;
//   C. network: a control arm (the same trusted listener, reached from the host) versus the confined arm, with the
//      listener's own connection journal as the independent witness.
// Reference environment: Windows 11 AppContainer (D07). Level: LOCAL - never relabelled HARDENED.
// Needs the privileged activation `provider enroll` (AppContainer identities + a read/execute ACL grant on the store).
// `--quick` skips the 90 s runaway-process arm.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { productionTool } from '../../apps/cli/dist/src/provider/production.js';
import { openGrants } from '../../apps/cli/dist/src/provider/production-grants.js';
import { hostGit } from '../test-support/host-git.mjs';

if (process.platform !== 'win32') { console.log('SKIP the reference environment is Windows 11 AppContainer'); process.exit(0); }
const quick = process.argv.includes('--quick');
const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = hostGit();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t25-'));
const base = path.join(root, 'base'), work = path.join(root, 'work'), store = path.join(root, 'store'), outside = path.join(root, 'outside');
let passed = 0, failed = 0, listener;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const run = (exe, args, cwd) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(r.status, 0, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const REFUSED = /permission contract refused/;
const tool = (request) => productionTool(store, work, request);
const facts = (r) => [r.observation].flat().find(o => o?.sideChannel === true);
const proc = (r) => r.output?.result ?? assert.fail(`no exec result: ${JSON.stringify(r.output)}`);
const exec = (argv) => { const r = tool({ op: 'exec', argv }); return { r, p: proc(r) }; };
const json = (s) => JSON.parse(s.trim().split('\n').pop());

const SECRET = `t25-${crypto.randomBytes(8).toString('hex')}`;
process.env.AMABIE_T25_CANARY_SECRET = SECRET; // a user-environment secret the worker must never see

// The controlled endpoint: a LAN address if there is one (loopback is closed to every AppContainer by default,
// which would make the capability test weaker), else loopback and the report says so.
const lan = Object.values(os.networkInterfaces()).flat().find(x => x?.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.') && !x.address.startsWith('100.'))?.address;
const host = lan ?? '127.0.0.1';
const journalOf = (j) => fs.readFileSync(j, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
const controlConnect = (h, port) => new Promise(resolve => {
  const s = net.connect({ host: h, port: Number(port) });
  s.setTimeout(3000);
  s.once('data', d => { s.destroy(); resolve(d.toString() === 'observed\n'); });
  s.once('error', () => resolve(false)); s.once('timeout', () => { s.destroy(); resolve(false); });
});

const NET_JS = (h, p) => `const net=require('node:net');const s=net.connect({host:${JSON.stringify(h)},port:${p}});s.setTimeout(4000);
const done=r=>{try{require('node:fs').writeFileSync('src/net.out',JSON.stringify({result:r}))}catch(e){}console.log(JSON.stringify({result:r}));process.exit(0)};
s.once('connect',()=>done('CONNECTED'));s.once('error',e=>done(e.code||e.message));s.once('timeout',()=>done('TIMEOUT'));
`;
const CRED_JS = (targets, storeFile) => `const fs=require('node:fs');const o={};
for(const [k,p] of Object.entries(${JSON.stringify(targets)})){try{fs.readFileSync(p);o[k]='READ'}catch(e){o[k]=e.code}}
o.envSecret=process.env.AMABIE_T25_CANARY_SECRET===undefined?'absent':'PRESENT';
o.envKeyLike=Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k));
try{fs.writeFileSync(${JSON.stringify(storeFile)},'x');o.storeWrite='WROTE'}catch(e){o.storeWrite=e.code}
console.log(JSON.stringify(o));
`;
// The grandchild reports through a file (its own stdout would need a pipe); the parent only waits for its exit, bounded.
const CHILD_JS = `const {spawn}=require('node:child_process');const fs=require('node:fs');
let c;try{c=spawn(process.execPath,['src/net.js'],{stdio:'ignore'})}catch(e){console.log(JSON.stringify({grandchild:'SPAWN-'+(e.code||e.message)}));process.exit(0)}
const end=r=>{console.log(JSON.stringify({grandchild:r,out:fs.existsSync('src/net.out')?fs.readFileSync('src/net.out','utf8').trim():null}));process.exit(0)};
c.on('error',e=>end('ERROR-'+(e.code||e.message)));c.on('exit',(code)=>end('EXIT-'+code));setTimeout(()=>end('NO-EXIT-IN-20S'),20000);
`;
const DETACH_JS = `const {spawn}=require('node:child_process');
let out;try{const c=spawn(process.execPath,['src/late.js'],{detached:true,stdio:'ignore'});c.on('error',e=>{out='ERROR-'+(e.code||e.message)});c.unref();out='SPAWNED'}catch(e){out=e.code||e.message}
setTimeout(()=>{console.log(JSON.stringify({detached:out,childStartedWhileParentAlive:require('node:fs').existsSync('src/late.start')}));process.exit(0)},3000);
`;
const LATE_JS = `const fs=require('node:fs');fs.writeFileSync('src/late.start',String(process.pid));setTimeout(()=>{fs.writeFileSync('src/late.out',String(process.pid));process.exit(0)},5000);\n`;
const SPIN_JS = `for(;;){}\n`;
const HELLO_JS = `require('node:fs').writeFileSync('src/hello.out','ran '+process.pid);console.log('hello from '+process.pid);\n`;

try {
  fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'trusted bytes outside the boundary\n');
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 't25-probe', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n');
  run(git, ['init', '-b', 'main', base]);
  run(git, ['-C', base, 'config', 'user.email', 't25@amabie.local']);
  run(git, ['-C', base, 'config', 'user.name', 'T25 Probe']);
  run(git, ['-C', base, 'add', '-A']);
  run(git, ['-C', base, 'commit', '-m', 'base']);
  run(process.execPath, [cli, 'setup', '--yes', base], base);
  run(process.execPath, [cli, 'task', 'bounded process and network audit'], base);
  const enrolled = JSON.parse(run(process.execPath, [cli, 'provider', 'enroll', base, store], base));
  console.log(`enrolled as ${enrolled.package}; endpoint ${host}${lan ? ' (LAN)' : ' (loopback only - weaker)'}`);

  // The trusted listener and its journal live outside every confined area.
  const ready = path.join(root, 'ready'), journal = path.join(root, 'connections.jsonl');
  listener = spawn(process.execPath, [path.join(repo, 'tooling/test-support/fixtures/confined-listener.cjs'), ready, journal, host], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await sleep(50);
  assert.ok(fs.existsSync(ready), 'trusted listener unavailable');
  const port = fs.readFileSync(ready, 'utf8');

  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  const enrollment = JSON.parse(fs.readFileSync(path.join(store, 'enrollment.json'), 'utf8'));
  const now = Date.now();
  const common = { source: 'user', notBefore: now - 1000, expiresAt: now + 3_600_000, policyGeneration: 1, prerequisites: [] };
  const granted = ['hello', 'net', 'cred', 'child', 'detach', 'spin'];
  openGrants(store, enrollment.project, fs.readFileSync(path.join(store, 'producer.key'), 'utf8'), [
    { grantId: 't25-src-write', resource: { kind: 'file', path: 'src' }, operation: 'write', args: { maxBytes: 4096 }, ...common },
    ...granted.map(n => ({ grantId: `t25-exec-${n}`, resource: { kind: 'process', argv: ['node', `src/${n}.js`] }, operation: 'exec', args: {}, ...common })),
  ]);

  const storeFile = path.join(store, 't25-worker-write.txt');
  const targets = { producerKey: path.join(store, 'producer.key'), enrollment: path.join(store, 'enrollment.json'), baseFile: path.join(base, 'package.json'),
    outsideFile: path.join(outside, 'secret.txt'), userCreds: path.join(os.homedir(), '.claude.json') };
  const trusted = [targets.producerKey, targets.enrollment, path.join(store, 'producer.pub'), targets.baseFile, targets.outsideFile].map(p => p);
  const before = trusted.map(sha);
  const headBefore = run(git, ['-C', base, 'rev-parse', 'HEAD'], base);

  // ── A. contract on: a process starts only on an exact-argv grant ──
  await check('A0. worker-authored scripts are written through the granted file route', () => {
    const r = tool({ operations: [
      { op: 'write', path: 'src/hello.js', text: HELLO_JS }, { op: 'write', path: 'src/net.js', text: NET_JS(host, port) },
      { op: 'write', path: 'src/cred.js', text: CRED_JS(targets, storeFile) }, { op: 'write', path: 'src/child.js', text: CHILD_JS }, { op: 'write', path: 'src/detach.js', text: DETACH_JS },
      { op: 'write', path: 'src/late.js', text: LATE_JS }, { op: 'write', path: 'src/spin.js', text: SPIN_JS },
    ] });
    assert.equal(r.output?.result?.failed, undefined, JSON.stringify(r.output));
    assert.equal(fs.existsSync(path.join(work, 'src', 'spin.js')), true);
  });
  await check('A1. a granted process starts inside the AppContainer, runs and terminates', () => {
    const { r, p } = exec(['node', 'src/hello.js']);
    assert.equal(p.status, 0, JSON.stringify(p));
    assert.match(p.stdout, /^hello from \d+/);
    assert.match(fs.readFileSync(path.join(work, 'src', 'hello.out'), 'utf8'), /^ran \d+$/);
    const f = facts(r);
    assert.deepEqual([f?.appContainer, f?.restricted, f?.capabilities, f?.integrity], [true, true, 0, 'S-1-16-4096'], JSON.stringify(r.observation));
  });
  await check('A2. a process without a grant is refused before launch, nothing runs', () => {
    for (const argv of [['node', 'src/other.js'], ['node'], ['node', 'src/hello.js', '--x'], ['cmd.exe', '/c', 'echo owned > src\\owned.txt'], ['powershell', '-NoProfile']])
      assert.throws(() => tool({ op: 'exec', argv }), /exec: outside-scope/, argv.join(' '));
    assert.equal(fs.existsSync(path.join(work, 'src', 'owned.txt')), false);
  });
  await check('A3. a path, a malformed argv and a file grant used as a process grant are refused', () => {
    for (const argv of [['C:\\Windows\\System32\\cmd.exe', '/c', 'ver'], ['..\\x.exe'], ['./node', 'src/hello.js'], []])
      assert.throws(() => tool({ op: 'exec', argv }), /exec: unclear/, JSON.stringify(argv));
  });
  await check('A4. a declared check needs its own exact grant too', () => {
    assert.throws(() => tool({ operations: [{ op: 'write', path: 'src/c.txt', text: 'x' }], check: { argv: ['cmd.exe'] } }), /check: outside-scope/);
    assert.equal(fs.existsSync(path.join(work, 'src', 'c.txt')), false);
    const r = tool({ operations: [{ op: 'write', path: 'src/c.txt', text: 'x' }], check: { argv: ['node', 'src/hello.js'] } });
    assert.equal(r.output.result.check?.status, 0, JSON.stringify(r.output));
  });
  if (quick) console.log('SKIP A5. runaway process (--quick)');
  else await check('A5. a runaway granted process is stopped by the 90 s bound and the call ends', () => {
    const t0 = Date.now();
    const { p } = exec(['node', 'src/spin.js']);
    const s = (Date.now() - t0) / 1000;
    assert.ok(p.status !== 0 && /ETIMEDOUT|null/.test(`${p.error}${p.status}`), JSON.stringify(p));
    assert.ok(s < 200, `took ${s} s`);
    console.log(`     runaway ended after ${s.toFixed(1)} s (error=${p.error}, status=${p.status})`);
  });

  // ── C. network: control arm versus confined arm, independent journal ──
  await check('C1. control arm: the same endpoint IS reachable from the host and the journal records it', async () => {
    assert.equal(await controlConnect(host, port), true);
    assert.equal(journalOf(journal).length, 1);
  });
  await check('C2. a granted process cannot open a connection (contract allows the process; the OS denies the network)', () => {
    const { r, p } = exec(['node', 'src/net.js']);
    assert.equal(p.status, 0, JSON.stringify(p));
    const res = json(p.stdout).result;
    assert.notEqual(res, 'CONNECTED', 'confined process connected');
    assert.equal(journalOf(journal).length, 1, 'the listener saw a second connection');
    assert.equal(facts(r)?.capabilities, 0);
    console.log(`     confined arm result: ${res}`);
  });
  await check('C3. a GRANDCHILD process (spawned by a granted process) cannot connect either', () => {
    const t0 = Date.now();
    const { p } = exec(['node', 'src/child.js']);
    console.log(`     took ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(p).slice(0, 300)}`);
    assert.equal(p.status, 0, JSON.stringify(p));
    const res = json(p.stdout);
    assert.match(res.grandchild, /^EXIT-/, `the grandchild did not run to an exit: ${JSON.stringify(res)}`);
    assert.notEqual(JSON.parse(res.out).result, 'CONNECTED', 'grandchild connected');
    assert.equal(journalOf(journal).length, 1, 'the listener saw a second connection');
  });
  await check('C3b. a detached grandchild is reported as contained or surviving, measured not assumed', async () => {
    const t0 = Date.now();
    const { p } = exec(['node', 'src/detach.js']);
    console.log(`     took ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(p).slice(0, 300)}`);
    await sleep(9000); // late.js writes after 5 s if it survived the call
    const started = fs.existsSync(path.join(work, 'src', 'late.start'));
    const late = fs.existsSync(path.join(work, 'src', 'late.out'));
    console.log(`     detached grandchild started: ${started} (parent view: ${p.stdout.trim()}); survived the call: ${late}`);
    assert.equal(late, false, 'a detached grandchild outlived the call (containment gap)');
  });
  await check('C4. the listener is still reachable afterwards (the denial was not a dead endpoint)', async () => {
    assert.equal(await controlConnect(host, port), true);
    assert.equal(journalOf(journal).length, 2);
  });

  // ── D. credentials ──
  await check('D1. a granted process reaches no controller key, enrollment, base file, outside file or user credential; the env secret is absent', () => {
    const { p } = exec(['node', 'src/cred.js']);
    assert.equal(p.status, 0, JSON.stringify(p));
    const o = json(p.stdout);
    for (const k of Object.keys(targets)) assert.notEqual(o[k], 'READ', `${k} was readable`);
    assert.equal(o.envSecret, 'absent');
    assert.equal(p.stdout.includes(SECRET), false);
    assert.notEqual(o.storeWrite, 'WROTE');
    console.log(`     reads: ${Object.keys(targets).map(k => `${k}=${o[k]}`).join(' ')}; storeWrite=${o.storeWrite}; secret-like env names: ${o.envKeyLike.length}`);
  });

  // ── B. contract OFF (controller action): the OS alone must still bound the process ──
  const off = path.join(store, 'grants.off');
  fs.renameSync(path.join(store, 'grants'), off);
  try {
    await check('B1. OS alone: an ungranted shell starts but cannot write outside the workspace', () => {
      const { p } = exec(['cmd.exe', '/c', `echo OWNED > "${path.join(outside, 'secret.txt')}"`]);
      assert.notEqual(p.status, 0, JSON.stringify(p));
      assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'trusted bytes outside the boundary\n');
    });
    await check('B2. OS alone: network and credentials stay closed for the same scripts', () => {
      const n = json(exec(['node', 'src/net.js']).p.stdout).result;
      assert.notEqual(n, 'CONNECTED');
      assert.equal(journalOf(journal).length, 2, 'the listener saw a confined connection');
      const o = json(exec(['node', 'src/cred.js']).p.stdout);
      for (const k of Object.keys(targets)) assert.notEqual(o[k], 'READ', `${k} was readable`);
      assert.equal(o.envSecret, 'absent');
    });
  } finally { fs.renameSync(off, path.join(store, 'grants')); }

  await check('E. trusted bytes (keys, enrollment, outside file, base file), base HEAD and the store write target are unchanged', () => {
    assert.deepEqual(trusted.map(sha), before);
    assert.equal(run(git, ['-C', base, 'rev-parse', 'HEAD'], base), headBefore);
    assert.equal(fs.existsSync(storeFile), false);
    assert.equal(fs.existsSync(path.join(store, 'grants')), true);
  });
} catch (e) {
  failed++; console.log(`FAIL setup\n     ${String(e?.stack ?? e)}`);
} finally {
  listener?.kill();
  delete process.env.AMABIE_T25_CANARY_SECRET;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${failed ? 'FAIL' : 'PASS'} ${passed} passed, ${failed} failed (level LOCAL, Windows AppContainer reference environment; endpoint ${lan ? 'LAN' : 'loopback'})`);
process.exit(failed ? 1 : 0);
