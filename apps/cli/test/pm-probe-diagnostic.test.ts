import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { packageManagerProbeProblem } from '../src/onboarding.js';

describe('doctor package-manager probe diagnostics', () => {
  it('reports a failed descendant sweep separately from a missing package manager', () => {
    const problem = packageManagerProbeProblem(
      'npm',
      new Error('post-run containment sweep could not confirm zero surviving descendants'),
    );

    assert.match(problem, /could not confirm descendant cleanup after probing "npm"/);
    assert.match(problem, /rejected the probe result/);
    assert.doesNotMatch(problem, /npm.*not runnable/i);
  });

  it('retains the unavailable-tool diagnosis when no containment error exists', () => {
    const problem = packageManagerProbeProblem('npm');

    assert.match(problem, /package manager "npm" is not runnable/);
    assert.match(problem, /calling PATH is deliberately ignored/);
  });
});
