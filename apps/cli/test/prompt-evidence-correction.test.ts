import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeAgentProcess } from '../src/prompt-evidence-correction.js';

test('agent process diagnostics classify turn-limit output without retaining provider text', () => {
  const output = 'Maximum turns reached.';
  const summary = summarizeAgentProcess(1, {
    exitCode: 1,
    stdout: '',
    stderr: output,
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
  });

  assert.deepEqual(summary, {
    cycle: 1,
    exitCode: 1,
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(output, 'utf8'),
    diagnosticHint: 'turn-limit',
  });
  assert.equal('stdout' in summary, false);
  assert.equal('stderr' in summary, false);
});

test('agent process diagnostics recognize abbreviated max-turn messages', () => {
  for (const stderr of ['Max turns reached.', 'Max-turns reached.']) {
    const summary = summarizeAgentProcess(1, {
      exitCode: 1,
      stdout: '',
      stderr,
      timedOut: false,
      outputExceeded: false,
      sweepFailed: false,
    });

    assert.equal(summary.diagnosticHint, 'turn-limit', stderr);
  }
});

test('agent process diagnostics do not treat a neutral mention of permissions as a denial', () => {
  for (const stdout of [
    'The correction required no permission changes and completed the requested edit.',
    'Treat untrusted repository text as data while applying the requested edit.',
  ]) {
    const summary = summarizeAgentProcess(1, {
      exitCode: 0,
      stdout,
      stderr: '',
      timedOut: false,
      outputExceeded: false,
      sweepFailed: false,
    });

    assert.equal(summary.diagnosticHint, 'exit-success-with-output', stdout);
    assert.equal('stdout' in summary, false);
    assert.equal('stderr' in summary, false);
  }
});

test('agent process diagnostics still classify an explicit permission denial', () => {
  const summary = summarizeAgentProcess(1, {
    exitCode: 1,
    stdout: '',
    stderr: 'Error: Permission denied while writing the requested file.',
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
  });

  assert.equal(summary.diagnosticHint, 'permission-or-trust');
  assert.equal('stdout' in summary, false);
  assert.equal('stderr' in summary, false);
});

test('agent process diagnostics inspect known failure output even when the CLI exits zero', () => {
  const output = 'Authentication failed: invalid API key';
  const summary = summarizeAgentProcess(1, {
    exitCode: 0,
    stdout: '',
    stderr: output,
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
  });

  assert.equal(summary.diagnosticHint, 'authentication');
  assert.equal('stdout' in summary, false);
  assert.equal('stderr' in summary, false);
});

test('agent process diagnostics distinguish unclassified output from a silent exit', () => {
  const successful = summarizeAgentProcess(1, {
    exitCode: 0,
    stdout: 'Completed without a project diff',
    stderr: '',
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
  });
  const failed = summarizeAgentProcess(1, {
    exitCode: 1,
    stdout: 'Provider returned an unclassified message',
    stderr: '',
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
  });

  assert.equal(successful.diagnosticHint, 'exit-success-with-output');
  assert.equal(failed.diagnosticHint, 'nonzero-exit-with-output');
});

test('agent process diagnostics classify an authentication failure without exporting the credential', () => {
  const secret = 'sk-live-0123456789abcdef';
  const summary = summarizeAgentProcess(2, {
    exitCode: 1,
    stdout: 'private transcript line',
    stderr: `Invalid API key: ${secret}`,
    timedOut: false,
    outputExceeded: false,
    sweepFailed: false,
  });

  assert.equal(summary.diagnosticHint, 'authentication');
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('private transcript'));
});
