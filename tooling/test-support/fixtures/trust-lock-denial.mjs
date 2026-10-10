import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const { ensureStoreKey } = await import(pathToFileURL(path.join(repo, 'apps/cli/dist/src/trust-store.js')));
const root = path.resolve(process.argv[2]);
let lockAttempts = 0;
let waits = 0;
const realMkdir = fs.mkdirSync.bind(fs);
const realLstat = fs.lstatSync.bind(fs);
const realWait = Atomics.wait;

fs.mkdirSync = (...args) => {
  if (path.basename(String(args[0])) === '.authority-lock') {
    lockAttempts++;
    throw Object.assign(new Error('simulated persistent Windows lock denial'), { code: 'EPERM' });
  }
  return realMkdir(...args);
};
fs.lstatSync = (...args) => {
  if (path.basename(String(args[0])) === '.authority-lock') {
    throw Object.assign(new Error('simulated missing lock directory'), { code: 'ENOENT' });
  }
  return realLstat(...args);
};
Date.now = () => 10_000;
Atomics.wait = (...args) => {
  waits++;
  return Reflect.apply(realWait, Atomics, args);
};

const started = performance.now();
try {
  ensureStoreKey({ root });
  process.exitCode = 2;
} catch (error) {
  assert.equal(error.code, 'EPERM');
  process.stdout.write(`${JSON.stringify({ lockAttempts, waits, elapsedMs: performance.now() - started })}\n`);
}
