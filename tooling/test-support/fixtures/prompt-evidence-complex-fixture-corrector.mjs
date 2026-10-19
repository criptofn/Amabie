import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const registered = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.amabie', 'prompt-evidence.json'), 'utf8'));
const registeredRequirements = registered.requirements.map((requirement) => requirement.text);

assert.equal(input.schema, 'amabie-correction-request/1');
assert.equal(input.cycle, 1);
assert.ok(input.report?.unresolved?.length > 0, 'the correction request must name unresolved requirements');
assert.ok(input.report.unresolved.every((item) => registeredRequirements.includes(item.requirement)), 'every unresolved item must be a registered requirement');
// Amabie sends unproven items when the doctor verdict is NOT PROVEN and blocked items when it refuses the envelope (a NEEDS ATTENTION run).
assert.ok(input.report.unresolved.every((item) => item.status === 'unproven' || item.status === 'blocked'));
assert.equal(path.basename(process.cwd()), 'project');

fs.copyFileSync(path.join(import.meta.dirname, 'prompt-evidence-complex-csv.baseline.mjs'), path.join(process.cwd(), 'transactions.mjs'));
fs.copyFileSync(path.join(import.meta.dirname, 'prompt-evidence-complex-legacy.baseline.mjs'), path.join(process.cwd(), 'legacy.mjs'));
console.log('Fixture corrector applied the reviewed implementation files; independent Amabie checks still decide the result.');
