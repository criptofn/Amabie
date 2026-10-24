import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { canonicalPackageTarball } from '../package-tarball.mjs';

const inputs = process.argv.slice(2);
assert.equal(inputs.length, 2, 'pass the frozen Windows and Linux tarballs');
const canonical = [];
for (const input of inputs) {
  const original = gunzipSync(fs.readFileSync(input));
  const compressed = canonicalPackageTarball(fs.readFileSync(input));
  const normalized = gunzipSync(compressed);
  assert.equal(normalized.length, original.length);
  let entries = 0;
  for (let offset = 0; offset + 512 <= original.length;) {
    const before = original.subarray(offset, offset + 512);
    if (before.every(byte => byte === 0)) break;
    const after = normalized.subarray(offset, offset + 512);
    const name = before.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(before.subarray(124, 136).toString().trim(), 8);
    const storedChecksum = parseInt(after.subarray(148, 156).toString(), 8);
    const actualChecksum = after.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(actualChecksum, storedChecksum, `valid USTAR checksum for ${name}`);
    if (name === 'package/dist/main.js') assert.equal(after.subarray(100, 107).toString(), '000755 ');
    else assert.deepEqual(after, before, `non-bin header unchanged: ${name}`);
    assert.deepEqual(normalized.subarray(offset + 512, offset + 512 + size), original.subarray(offset + 512, offset + 512 + size), `body unchanged: ${name}`);
    entries++;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(entries, 21, 'all release file bodies must be examined');
  canonical.push(compressed);
}
assert.deepEqual(canonical[0], canonical[1], 'both frozen artifacts canonicalize to identical complete tarballs');
const report = { schema: 'amabie-package-canonicalization-check/1', inputs, checkedBodies: 21, allBodiesUnchanged: true, nonBinHeadersUnchanged: true, ustarChecksumsValid: true, canonicalSha256: createHash('sha256').update(canonical[0]).digest('hex') };
fs.writeFileSync(path.resolve(import.meta.dirname, '../../pack/canonicalization-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`PASS all 21 bodies unchanged, sole bin header executable, every USTAR checksum valid; identical canonical archive ${report.canonicalSha256}`);
