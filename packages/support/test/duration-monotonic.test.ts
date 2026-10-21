/**
 * Gate 9d8ef4a regression: under WSL the wall clock can step BACKWARDS
 * during a run (time resync), which made `Date.now() - start` negative and
 * failed evidence-schema validation (`durationMs must be a non-negative
 * integer`). Durations must come from a monotonic clock.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { runCommand } from '../src/index.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-dur-'));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

it('durationMs stays a non-negative integer when the wall clock steps backwards', async () => {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
  const ws = { root, fixture: path.join(root, 'fixture') };
  fs.mkdirSync(ws.fixture, { recursive: true });
  const realNow = Date.now;
  let calls = 0;
  // First read is "now", every later read is one hour earlier.
  Date.now = () => (calls++ === 0 ? realNow() : realNow() - 3_600_000);
  try {
    const out = await runCommand({ ws, nodeDir: path.dirname(process.execPath), argv: [process.execPath, '-e', ''] });
    assert.equal(out.exitCode, 0);
    assert.ok(Number.isInteger(out.durationMs) && out.durationMs >= 0, `durationMs=${out.durationMs}`);
  } finally {
    Date.now = realNow;
  }
});
