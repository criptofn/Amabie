import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidatePath] = process.argv.slice(2);
if (!candidatePath) {
  console.error('usage: prompt-evidence-password-policy-check.mjs <candidate module>');
  process.exit(2);
}

const candidate = await import(pathToFileURL(path.resolve(candidatePath)).href);
assert.equal(candidate.isPasswordAllowed('short'), false, 'short passwords must be rejected');
assert.equal(candidate.isPasswordAllowed('long-password-123'), true, 'a password at the configured length must be accepted');
console.log('password length policy checks passed');
