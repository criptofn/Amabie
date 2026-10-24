import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { TAR, extractVerifiedGoArchive } from './toolchains.mjs';

test('Go archive verification precedes extraction and preserves sibling toolchains', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-toolchain-test-'));
  try {
    const root = path.join(temp, 'installed');
    const goroot = path.join(root, 'go');
    fs.mkdirSync(goroot, { recursive: true });
    fs.writeFileSync(path.join(goroot, 'old'), 'existing Go');
    fs.mkdirSync(path.join(root, 'rust'));
    fs.writeFileSync(path.join(root, 'rust', 'preserve'), 'existing Rust');
    const archive = path.join(temp, 'archive.tar');
    fs.writeFileSync(archive, 'corrupted download');
    assert.throws(() => extractVerifiedGoArchive(archive, '0'.repeat(64), goroot), /SHA-256 mismatch/);
    assert.equal(fs.readFileSync(path.join(goroot, 'old'), 'utf8'), 'existing Go');
    const invalidHash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    assert.throws(() => extractVerifiedGoArchive(archive, invalidHash, goroot), /extraction failed/);
    assert.equal(fs.readFileSync(path.join(goroot, 'old'), 'utf8'), 'existing Go');

    const source = path.join(temp, 'source');
    fs.mkdirSync(path.join(source, 'go', 'bin'), { recursive: true });
    const executable = process.platform === 'win32' ? 'go.exe' : 'go';
    fs.writeFileSync(path.join(source, 'go', 'bin', executable), 'new Go fixture');
    const packed = spawnSync(TAR, ['-cf', archive, '-C', source, 'go'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const validHash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    extractVerifiedGoArchive(archive, validHash, goroot);
    assert.equal(fs.readFileSync(path.join(goroot, 'bin', executable), 'utf8'), 'new Go fixture');
    assert.equal(fs.readFileSync(path.join(root, 'rust', 'preserve'), 'utf8'), 'existing Rust');
    assert.deepEqual(fs.readdirSync(root).sort(), ['go', 'rust']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
