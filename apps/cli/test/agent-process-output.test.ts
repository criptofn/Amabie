import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { retainAgentProcessOutput } from '../src/agent-process-output.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-agent-output-tests-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const output = { exitCode: 1, stdout: 'Private UTF-8: Grüße 🌊\n', stderr: 'not verified\n',
  timedOut: false, outputExceeded: false, sweepFailed: false };

test('retained output is exact UTF-8 diagnostics with independent file digests and exclusive names', () => {
  const first = retainAgentProcessOutput(scratch, 1, 'correction', output);
  const second = retainAgentProcessOutput(scratch, 1, 'correction', output);
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(Object.keys(first).sort(), ['cycle', 'diagnosticOnly', 'directory', 'stage']);
  const metadata = JSON.parse(fs.readFileSync(path.join(first.directory, 'process.json'), 'utf8'));
  assert.equal(metadata.schema, 'amabie-agent-process-diagnostics/1');
  assert.equal(metadata.diagnosticOnly, true);
  assert.equal('verdict' in metadata, false);
  for (const stream of ['stdout', 'stderr'] as const) {
    const file = path.join(first.directory, `${stream}.log`);
    assert.equal(fs.readFileSync(file, 'utf8'), output[stream]);
    assert.equal(metadata[stream].bytes, Buffer.byteLength(output[stream]));
    assert.equal(metadata[stream].sha256, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
});

test('retention refuses invalid cycle, stage and over-budget output before creating files', () => {
  const root = path.join(scratch, 'invalid');
  fs.mkdirSync(root);
  assert.throws(() => retainAgentProcessOutput(root, 4, 'correction', output), /cycle/u);
  assert.throws(() => retainAgentProcessOutput(root, 1, '../escape' as 'correction', output), /stage/u);
  assert.throws(() => retainAgentProcessOutput(root, 1, 'correction', { ...output, stdout: 'x'.repeat(1024 * 1024 + 1) }), /limit/u);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('retention refuses a linked project state directory without writing through it', () => {
  const root = path.join(scratch, 'linked-state');
  const outside = path.join(scratch, 'outside-state');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, '.amabie'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => retainAgentProcessOutput(root, 1, 'correction', output), /link/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('retention refuses a linked log directory without changing the existing target', () => {
  const root = path.join(scratch, 'linked-logs');
  const outside = path.join(scratch, 'outside-logs');
  fs.mkdirSync(path.join(root, '.amabie'), { recursive: true }); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, '.amabie', 'agent-output'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => retainAgentProcessOutput(root, 1, 'correction', output), /link/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('retention reports a non-directory storage collision and preserves it', () => {
  const root = path.join(scratch, 'collision');
  fs.mkdirSync(path.join(root, '.amabie'), { recursive: true });
  const collision = path.join(root, '.amabie', 'agent-output');
  fs.writeFileSync(collision, 'preserve this user file');
  assert.throws(() => retainAgentProcessOutput(root, 1, 'correction', output), /non-directory/u);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'preserve this user file');
});
