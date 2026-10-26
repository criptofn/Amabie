import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { budgetFor, shouldStopAfter } from '../step-budgets.mjs';

test('selection preserves every applicable remaining gate and isolated mutations retain containment budgets', () => {
  const listed = spawnSync(process.execPath, ['tooling/verify-productization.mjs', '--list-json'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(listed.status, 0, listed.stderr);
  const gates = JSON.parse(listed.stdout);
  const lastMutation = gates.findIndex(gate => gate.label.endsWith('/ M13'));
  const windowsProvider = gates.some(gate => gate.label === 'probe: installed HARDENED production authority and custody');
  assert.equal(windowsProvider, process.platform === 'win32', 'the native Windows provider gate must appear only on Windows');
  for (const label of [
    '8.3 short-name suite (does the suite still hold when TEMP is spelled the way a runner spells it?)',
    '1.2 integrity boundary measurement (reports honestly whether confinement exists here)',
  ]) {
    const gate = gates.find(candidate => candidate.label === label);
    assert.ok(gate, `productization gate is present: ${label}`);
    assert.equal(gate.skipAware, true, `an explicit unsupported-host result is a SKIP, not a FAIL or PASS: ${label}`);
  }
  assert.equal(gates.length - lastMutation - 1, process.platform === 'win32' ? 35 : 34);
  assert.equal(gates.filter(gate => gate.label === 'full unit suite').length, 1);
  assert.equal(gates.some(gate => gate.args[0] === '--test'), false,
    'npm test already covers the unit and tooling tests; integration probes must not rerun them separately');
  assert.equal(gates[lastMutation + 1].label, 'probe: 1.1 P0 trust-boundary mutations (scratch builds)');
  for (let id = 1; id <= 13; id++) {
    const label = `probe: master-pass mutation battery (built dist) / M${id}`;
    const gate = gates.find(g => g.label === label);
    assert.deepEqual(gate.args.slice(-2), ['--only', `M${id}`]);
    assert.equal(budgetFor(label), budgetFor('probe: master-pass mutation battery (built dist)'));
    assert.equal(shouldStopAfter(label, 'FAIL'), true);
    assert.equal(shouldStopAfter(label, 'INCOMPLETE'), true);
    assert.equal(shouldStopAfter(label, 'PASS'), false);
  }
  assert.equal(gates.at(-1).costGate !== null, true, 'paid live diagnostic remains excluded');
});
