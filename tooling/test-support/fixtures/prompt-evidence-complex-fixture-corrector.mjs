import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const expected = [
  'Reject missing, non-numeric, NaN, and infinite amounts.',
  'Include the original one-based physical CSV line number in each row error.',
  'Apply first-row-wins semantics to duplicate ids.',
  'Compute a signed total from accepted transactions only.',
  'Export CSV with correct quoting, formula neutralization, and preservation of ordinary text.',
];

assert.equal(input.schema, 'amabie-correction-request/1');
assert.equal(input.cycle, 1);
assert.equal(input.report?.unresolved?.length, expected.length);
assert.deepEqual(input.report.unresolved.map((item) => item.requirement), expected);
assert.ok(input.report.unresolved.every((item) => item.status === 'unproven'));
assert.equal(path.basename(process.cwd()), 'project');

fs.copyFileSync(path.join(import.meta.dirname, 'prompt-evidence-complex-csv.baseline.mjs'), path.join(process.cwd(), 'transactions.mjs'));
fs.copyFileSync(path.join(import.meta.dirname, 'prompt-evidence-complex-legacy.baseline.mjs'), path.join(process.cwd(), 'legacy.mjs'));
console.log('Fixture corrector applied the reviewed implementation files; independent Amabie checks still decide the result.');
