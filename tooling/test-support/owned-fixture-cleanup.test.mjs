import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { cleanupOwnedFixture } from './owned-fixture-cleanup.mjs';

async function sentinel(body) {
  const token = `amabie-test-owner:${randomUUID()}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/owned-cleanup-sentinel.cjs', import.meta.url)), token],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exit = once(child, 'exit');
  try {
    const [data] = await once(child.stdout, 'data');
    assert.match(String(data), /ready/);
    await body(child, token, exit);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  }
}

test('stale-PID cleanup refuses a controlled process with a different owner', async () => {
  await sentinel(async (child, token) => {
    const priorOwner = `amabie-test-owner:${randomUUID()}`;
    assert.notEqual(priorOwner, token);
    // The supplied number now denotes another fixture. No unrelated real process is targeted.
    assert.equal(cleanupOwnedFixture(child.pid, priorOwner), 'not-owned');
    process.kill(child.pid, 0);
    assert.equal(child.exitCode, null, 'the unrelated positive control remains alive');
  });
});

test('an owned live fixture is actually terminated, not silently left behind', async () => {
  await sentinel(async (child, token, exit) => {
    assert.equal(cleanupOwnedFixture(child.pid, token), 'terminated');
    await exit;
    assert(child.exitCode !== null || child.signalCode !== null);
  });
});
