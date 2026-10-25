import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { containmentEnv, sanitizedEnv } from '../src/index.js';
import { windowsSyncProcess } from '../src/windowsSyncProcess.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-sync-lifetime-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
function subject(source: string): string {
  const file = path.join(root, `subject-${serial++}.cjs`);
  fs.writeFileSync(file, source);
  return file;
}
const options = () => ({ cwd: root, env: sanitizedEnv({ ws: { root, fixture: root }, nodeDir: path.dirname(process.execPath) }),
  timeout: 5_000, maxBuffer: 64 * 1024 });

it('preserves the real PID, nonzero exit, stdout and stderr through a held-exit handshake', () => {
  let cleanups = 0;
  const result = windowsSyncProcess(process.execPath,
    [subject("process.stdout.write('actual out');process.stderr.write('actual err');process.exit(7);")], options(), containmentEnv(), (pid, started) => {
      cleanups++;
      assert(Number.isSafeInteger(pid) && pid > 0);
      assert(Number.isFinite(started));
      return { failed: false, killed: [] };
    });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert(result.pid > 0);
  assert.equal(result.stdout, 'actual out');
  assert.equal(result.stderr, 'actual err');
  assert.deepEqual(result.output, [null, 'actual out', 'actual err']);
  assert.equal(cleanups, 1);
});

it('keeps literal argv, cwd and the declared environment; no control channel reaches the subject', () => {
  const args = ['a b', '"; & not a shell', 'ü'];
  const opts = options();
  opts.env.AMABIE_SYNC_TEST = 'declared';
  const result = windowsSyncProcess(process.execPath, [subject([
    "const thread=require('node:worker_threads');const stdin=require('node:fs').readFileSync(0);",
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.AMABIE_SYNC_TEST,isMain:thread.isMainThread,port:thread.parentPort!==null,data:thread.workerData!=null,stdin:stdin.length}));",
  ].join('\n')), ...args], opts, containmentEnv(), () => ({ failed: false, killed: [] }));
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.args, args);
  assert.equal(observed.cwd, root);
  assert.equal(observed.value, 'declared');
  assert.equal(observed.isMain, true);
  assert.equal(observed.port, false);
  assert.equal(observed.data, false);
  assert.equal(observed.stdin, 0, 'control request must not be the subject stdin');
});

it('reports actual ENOENT without inventing an exit or sweeping an unspawned PID', () => {
  let cleanups = 0;
  const result = windowsSyncProcess(path.join(root, 'missing-program.exe'), [], options(), containmentEnv(), () => {
    cleanups++;
    return { failed: false, killed: [] };
  });
  assert.equal(result.status, null);
  assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ENOENT');
  assert.equal(result.pid, 0);
  assert.equal(cleanups, 0);
});

it('a real timeout retains ETIMEDOUT and visits cleanup once after stopping the original child', () => {
  const marker = path.join(root, 'timeout-actually-ran');
  const file = subject(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');setInterval(()=>{},1000);`);
  let cleanups = 0;
  const result = windowsSyncProcess(process.execPath, [file], { ...options(), timeout: 500 }, containmentEnv(), () => {
    cleanups++;
    return { failed: false, killed: [] };
  });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ETIMEDOUT');
  assert.equal(result.status, null);
  assert.equal(cleanups, 1);
});

it('a real output overflow remains ENOBUFS with bounded retained bytes', () => {
  let cleanups = 0;
  const result = windowsSyncProcess(process.execPath, [subject("process.stdout.write('x'.repeat(256*1024));")],
    { ...options(), maxBuffer: 1024 }, containmentEnv(), () => { cleanups++; return { failed: false, killed: [] }; });
  assert.equal((result.error as NodeJS.ErrnoException)?.code, 'ENOBUFS');
  assert.equal(Buffer.byteLength(result.stdout), 1024);
  assert.equal(cleanups, 1);
});

it('actual command success cannot override failed or throwing cleanup', () => {
  const file = subject("process.stdout.write('real success');");
  for (const cleanup of [() => ({ failed: true, killed: [] }), () => { throw new Error('controlled observation failure'); }]) {
    const result = windowsSyncProcess(process.execPath, [file], options(), containmentEnv(), cleanup);
    assert.equal(result.status, 0, 'original exit is retained for diagnostics');
    assert.equal(result.stdout, 'real success');
    assert.match(result.error?.message ?? '', /containment sweep could not confirm/);
  }
});

it('the same bridge runs after the actual ESM bundling used by the distributed CLI', async () => {
  const bundled = path.join(root, 'bridge-bundle.mjs');
  await build({ entryPoints: [path.resolve(import.meta.dirname, '../src/windowsSyncProcess.js')],
    outfile: bundled, bundle: true, platform: 'node', target: 'node22', format: 'esm', legalComments: 'none' });
  const module = await import(pathToFileURL(bundled).href) as typeof import('../src/windowsSyncProcess.js');
  const result = module.windowsSyncProcess(process.execPath, [subject("process.stdout.write('bundled-actual-output');process.exit(7);")],
    { ...options(), timeout: 1000 }, containmentEnv(), () => ({ failed: false, killed: [] }));
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'bundled-actual-output');
});
