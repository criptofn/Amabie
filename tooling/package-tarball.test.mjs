import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalPackageTarball } from './package-tarball.mjs';

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
