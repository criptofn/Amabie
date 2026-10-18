import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalPackageTarball } from './package-tarball.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(mode, name = 'package/dist/main.js') {
  const body = Buffer.from('#!/usr/bin/env node\nconsole.log("Amabie");\n');
  const tar = Buffer.alloc(2048);
  tar.write(name);
  tar.write(mode + ' \0', 100, 8);
  tar.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  tar[156] = 48;
  tar.write('ustar\0', 257, 6);
  tar.write('00', 263, 2);
  tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  body.copy(tar, 512);
  return { archive: gzipSync(tar), body };
}

test('Windows and POSIX bin modes produce identical portable bytes without altering the CLI body', () => {
  const windows = fixture('000644');
  const posix = fixture('000755');
  const canonical = canonicalPackageTarball(windows.archive);
  assert.deepEqual(canonical, canonicalPackageTarball(posix.archive));
  assert.equal(canonical[9], 255);
  const tar = gunzipSync(canonical);
  assert.equal(tar.subarray(100, 107).toString(), '000755 ');
  assert.deepEqual(tar.subarray(512, 512 + windows.body.length), windows.body);
  const expectedChecksum = parseInt(tar.subarray(148, 154).toString(), 8);
  tar.fill(32, 148, 156);
  assert.equal(tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0), expectedChecksum);
});

test('a package without the declared CLI cannot be reported as canonical', () => {
  assert.throws(() => canonicalPackageTarball(fixture('000644', 'package/README.md').archive), /no CLI entry/);
});

test('the exact packed CLI starts after clean-room installation', { timeout: 240_000 }, () => {
  const env = { ...process.env };
  // The Node test runner marks child processes so a nested `node --test`
  // invocation skips discovery. The clean-room journey itself must run the
  // shipped example's documented test command as an ordinary user process.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['tooling/probes/cleanroom-packed-artifact.mjs'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  assert.equal(result.error, undefined, `clean-room probe could not run: ${String(result.error ?? '')}`);
  assert.equal(result.signal, null, `clean-room probe was terminated by ${String(result.signal)}`);
  assert.equal(result.status, 0, `clean-room probe failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
});
