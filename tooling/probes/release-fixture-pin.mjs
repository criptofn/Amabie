#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_RUNNER_RELEASES, treeSha256 } from '../../packages/support/dist/src/index.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = 'apps/cli/test/fixtures/mocha-double';
const actual = treeSha256(path.join(root, fixture));
const expected = KNOWN_RUNNER_RELEASES.mocha.find(item => item.origin === 'amabie-double').treeSha256;
console.log(JSON.stringify({ fixture, expected, actual, ...(process.argv[2] ? { originalWorkingTree: treeSha256(path.join(process.argv[2], fixture)) } : {}) }, null, 2));
assert.equal(actual, expected, 'Canonical checkout fixture does not match its reviewed runner pin.');
console.log('PASS: canonical checkout runner bytes match their pin.');
