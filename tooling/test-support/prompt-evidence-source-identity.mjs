import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TREE_ROOTS = ['apps', 'packages', 'tooling/test-support'];
const ROOT_FILES = ['package-lock.json', 'package.json', 'tsconfig.json'];
const EXCLUDED_DIRECTORIES = new Set(['.git', '.local', '.cache', 'coverage', 'node_modules']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestFiles(files) {
  const sha = createHash('sha256');
  for (const file of files) sha.update(file.path).update('\0').update(file.sha256).update('\n');
  return sha.digest('hex');
}

function collectFiles(repoRoot) {
  const files = new Map();
  const addFile = (absolute, relative) => {
    const normalized = relative.split(path.sep).join('/');
    files.set(normalized, sha256(fs.readFileSync(absolute)));
  };
  const visit = (absoluteDirectory, relativeDirectory) => {
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(absoluteDirectory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) addFile(absolute, relative);
      else if (entry.isSymbolicLink()) {
        throw new Error(`Cannot fingerprint product source tree containing a symbolic link: ${relative}`);
      }
    }
  };

  for (const relative of ROOT_FILES) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Cannot fingerprint product source tree; required build input is missing: ${relative}`);
    }
    addFile(absolute, relative);
  }
  for (const relative of TREE_ROOTS) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      throw new Error(`Cannot fingerprint product source tree; required source directory is missing: ${relative}`);
    }
    visit(absolute, relative);
  }

  return [...files.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([filePath, digest]) => ({ path: filePath, sha256: digest }));
}

export function collectProductSourceIdentity(repoRoot) {
  const files = collectFiles(path.resolve(repoRoot));
  return {
    schema: 'amabie-product-source-identity/1',
    sha256: digestFiles(files),
    fileCount: files.length,
    files,
  };
}

export function assertProductSourceIdentityMatches(expected, actual, reason = 'Product source identity changed') {
  const isInvalid = (identity) => !identity
    || identity.schema !== 'amabie-product-source-identity/1'
    || !Array.isArray(identity.files)
    || identity.fileCount !== identity.files.length
    || digestFiles(identity.files) !== identity.sha256;
  if (isInvalid(expected) || isInvalid(actual)) {
    throw new Error(`${reason}: identity record is incomplete or internally inconsistent`);
  }
  const metadata = ['repositoryHead', 'nodeVersion', 'cliEntryPath', 'cliEntrySha256'];
  const metadataChanged = metadata.some((field) => expected[field] !== actual[field]);
  const filesChanged = JSON.stringify(expected.files) !== JSON.stringify(actual.files);
  if (expected.sha256 !== actual.sha256 || expected.fileCount !== actual.fileCount || metadataChanged || filesChanged) {
    throw new Error(`${reason}: expected ${expected.sha256} (${expected.fileCount} files), observed ${actual.sha256} (${actual.fileCount} files)`);
  }
  return true;
}
