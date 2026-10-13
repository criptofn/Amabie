#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const evidenceDirectory = process.argv[2];
assert(evidenceDirectory && path.isAbsolute(evidenceDirectory));
const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDirectory, 'source-snapshot.json'), 'utf8'));
const patch = path.join(evidenceDirectory, 'amabie-source-snapshot.patch');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(patch).toUpperCase(), receipt.patchSha256);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-integrity-index-'));
const index = path.join(scratch, 'index');
function git(cwd, args, isolated = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true,
    env: isolated ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
  assert.equal(result.status, 0, `Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const indexes = [receipt.source, receipt.target].map(root => path.resolve(root, git(root, ['rev-parse', '--git-path', 'index'])));
const indexHashes = indexes.map(hash);
try {
  assert.equal(git(receipt.source, ['rev-parse', 'HEAD']), receipt.sourceHead, 'Original source HEAD changed; inspect parallel changes.');
  git(receipt.target, ['read-tree', receipt.sourceHead], true);
  git(receipt.target, ['apply', '--cached', '--binary', patch], true);
  const snapshotTree = git(receipt.target, ['write-tree'], true);
  const originalTrackedChanges = git(receipt.source, ['diff', '--name-status', snapshotTree, '--']);
  const missionChanges = git(receipt.target, ['diff', '--name-status', snapshotTree, '--']);
  const missionUntracked = git(receipt.target, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    .map(relative => ({ relative, sha256: hash(path.join(receipt.target, relative)) }));
  const originalUntracked = git(receipt.source, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const extras = receipt.extraFiles.map(relative => ({ relative,
    sourceSha256: hash(path.join(receipt.source, relative)),
    releaseSha256: hash(path.join(receipt.target, relative)) }));
  const excludedIndexFiles = originalUntracked.filter(file => file.startsWith('.repowise/'));
  const newSourceFiles = originalUntracked.filter(file => !receipt.extraFiles.includes(file) && !excludedIndexFiles.includes(file));
  const deletedBaselineFiles = git(receipt.target, ['diff', '--name-only', '--diff-filter=D', snapshotTree, '--']);
  const report = { schema: 'amabie-release-source-integrity/1', checkedAt: new Date().toISOString(),
    sourceHead: receipt.sourceHead, snapshotTree, originalTrackedChanges, newSourceFiles,
    excludedIndexFiles, indexExclusionReason: 'Derived local RepoWise databases/caches are not product source and must not enter release artifacts.',
    extras, missionChanges, missionUntracked, deletedBaselineFiles,
    defaultIndexesPreserved: indexes.every((file, i) => hash(file) === indexHashes[i]) };
  fs.writeFileSync(path.join(evidenceDirectory, 'source-integrity.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(originalTrackedChanges, '', 'Parallel original tracked changes detected; inspect source-integrity.json.');
  assert.deepEqual(newSourceFiles, [], 'New original untracked files require review.');
  assert(extras.every(file => file.sourceSha256 === file.releaseSha256), 'An original untracked source file differs in the release worktree.');
  assert.equal(deletedBaselineFiles, '', 'A snapshot source file was deleted in the release worktree.');
  assert(report.defaultIndexesPreserved);
  console.log(`PASS: original source snapshot and ${extras.length} untracked files preserved; no parallel changes, no baseline deletions, both Git indexes unchanged.`);
  console.log(`Mission changes are recorded separately in ${path.join(evidenceDirectory, 'source-integrity.json')}`);
} finally {
  assert.equal(path.dirname(scratch), os.tmpdir());
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
