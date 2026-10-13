import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const field = (header, start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
function readPackage(file) {
  const gzip = fs.readFileSync(file);
  const tar = gunzipSync(gzip);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    assert.ok(Number.isFinite(size) && size >= 0 && offset + 512 + size <= tar.length, `invalid tar entry ${name}`);
    entries.set(name, {
      header, body: tar.subarray(offset + 512, offset + 512 + size),
      fields: { mode: field(header, 100, 8), uid: field(header, 108, 8), gid: field(header, 116, 8), size, mtime: field(header, 136, 12), type: field(header, 156, 1), owner: field(header, 265, 32), group: field(header, 297, 32) },
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { file, gzip, tar, entries };
}
const [leftPath, rightPath] = process.argv.slice(2);
assert.ok(leftPath && rightPath, 'usage: node tooling/probes/release-package-compare.mjs <left.tgz> <right.tgz>');
const left = readPackage(leftPath), right = readPackage(rightPath);
const differences = [];
for (const name of new Set([...left.entries.keys(), ...right.entries.keys()])) {
  const a = left.entries.get(name), b = right.entries.get(name);
  if (!a || !b) { differences.push({ name, missing: !a ? 'left' : 'right' }); continue; }
  if (!a.header.equals(b.header)) differences.push({ name, kind: 'header', left: a.fields, right: b.fields });
  if (!a.body.equals(b.body)) {
    const position = a.body.findIndex((byte, index) => byte !== b.body[index]);
    differences.push({ name, kind: 'body', leftSha256: sha(a.body), rightSha256: sha(b.body), leftBytes: a.body.length, rightBytes: b.body.length, firstDifference: position, leftContext: a.body.subarray(Math.max(0, position - 100), position + 180).toString(), rightContext: b.body.subarray(Math.max(0, position - 100), position + 180).toString() });
  }
}
const report = {
  schema: 'amabie-package-comparison/1',
  left: { file: leftPath, gzipSha256: sha(left.gzip), tarSha256: sha(left.tar), gzipHeader: left.gzip.subarray(0, 10).toString('hex') },
  right: { file: rightPath, gzipSha256: sha(right.gzip), tarSha256: sha(right.tar), gzipHeader: right.gzip.subarray(0, 10).toString('hex') },
  gzipIdentical: left.gzip.equals(right.gzip), tarIdentical: left.tar.equals(right.tar), entryOrderIdentical: [...left.entries.keys()].join('\n') === [...right.entries.keys()].join('\n'), differences,
};
const output = path.resolve(import.meta.dirname, '../../pack/package-comparison.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.gzipIdentical ? 0 : 1;
