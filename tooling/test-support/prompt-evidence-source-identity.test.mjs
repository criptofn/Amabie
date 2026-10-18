import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertProductSourceIdentityMatches,
  collectProductSourceIdentity,
} from './prompt-evidence-source-identity.mjs';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-source-identity-'));
  const entries = {
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'tsconfig.json': '{"compilerOptions":{}}\n',
    'apps/cli/src/main.ts': 'export const source = true;\n',
    'apps/cli/dist/src/main.js': 'export const built = true;\n',
    'packages/core/prompt-evidence/src/index.ts': 'export const verifier = true;\n',
    'packages/core/prompt-evidence/dist/index.js': 'export const builtVerifier = true;\n',
    'tooling/test-support/fixture.mjs': 'export const fixture = true;\n',
    'apps/cli/node_modules/untracked-runtime/index.js': 'must not be included\n',
    '.git/HEAD': 'git metadata must not be included\n',
  };
  for (const [relative, contents] of Object.entries(entries)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return root;
}

test('product source identity hashes CLI, verifier, test harness, and build inputs without runtime or Git internals', () => {
  const root = makeFixture();
  try {
    const identity = collectProductSourceIdentity(root);

    assert.equal(identity.schema, 'amabie-product-source-identity/1');
    assert.match(identity.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(assertProductSourceIdentityMatches(identity, identity), true);
    assert.deepEqual(identity.files.map(({ path: file }) => file), [
      'apps/cli/dist/src/main.js',
      'apps/cli/src/main.ts',
      'package-lock.json',
      'package.json',
      'packages/core/prompt-evidence/dist/index.js',
      'packages/core/prompt-evidence/src/index.ts',
      'tooling/test-support/fixture.mjs',
      'tsconfig.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('product source identity changes when executable CLI or verifier bytes change', () => {
  const root = makeFixture();
  try {
    const before = collectProductSourceIdentity(root);
    fs.appendFileSync(path.join(root, 'packages/core/prompt-evidence/dist/index.js'), '// changed\n');
    const after = collectProductSourceIdentity(root);

    assert.notEqual(after.sha256, before.sha256);
    assert.notDeepEqual(after.files, before.files);
    assert.throws(
      () => assertProductSourceIdentityMatches(before, after, 'test product'),
      /test product: expected [a-f0-9]{64} \(8 files\), observed [a-f0-9]{64} \(8 files\)/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
