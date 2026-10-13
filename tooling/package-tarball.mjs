import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

export function canonicalPackageTarball(bytes) {
  const tar = gunzipSync(bytes);
  let found = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    assert.ok(Number.isFinite(size) && size >= 0 && offset + 512 + size <= tar.length, 'invalid npm tar entry');
    if (name === 'package/dist/main.js') {
      assert.equal(found, false, 'duplicate CLI entry refused');
      assert.equal(header[156], 48, 'CLI entry must be a regular file');
      // npm on Windows cannot express execute bits; the shipped POSIX bin needs 0755.
      header.write('000755 \0', 100, 8);
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      found = true;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(found, 'npm package contains no CLI entry');
  const output = gzipSync(tar, { level: 9 });
  output[9] = 255; // RFC 1952: unknown OS, independent of the build host.
  return output;
}
