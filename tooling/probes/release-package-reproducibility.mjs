import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-pack-cwd-'));
const pack = path.join(repo, 'tooling', 'pack.mjs');
const directory = path.join(repo, 'pack', 'npm');
const rounds = [];
try {
  for (const cwd of [repo, repo, scratch]) {
    const run = spawnSync(process.execPath, [pack], { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.tgz'));
    assert.equal(files.length, 1);
    const bytes = fs.readFileSync(path.join(directory, files[0]));
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(fs.readFileSync(path.join(directory, `${files[0]}.sha256`), 'utf8'), `${hash}  ${files[0]}\n`);
    rounds.push({ cwd, artifact: files[0], bytes: bytes.length, sha256: hash });
  }
  assert.equal(new Set(rounds.map(round => round.sha256)).size, 1, 'repeated builds and unrelated caller CWD must produce identical bytes');
  fs.writeFileSync(path.join(repo, 'pack', 'reproducibility.json'), JSON.stringify({ schema: 'amabie-package-reproducibility/1', platform: process.platform, node: process.version, rounds }, null, 2) + '\n');
  console.log(`PASS three identical npm artifacts, including an unrelated caller directory: ${rounds[0].sha256}`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
