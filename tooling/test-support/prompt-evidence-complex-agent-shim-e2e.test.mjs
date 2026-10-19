import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const harness = path.join(repoRoot, 'tooling/test-support/prompt-evidence-complex-codex-e2e.mjs');

function runHarness(args, { env = process.env, timeout = 4 * 60_000 } = {}) {
  return spawnSync(process.execPath, [harness, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 24 * 1024 * 1024,
    windowsHide: true,
  });
}

for (const agent of ['codex', 'claude']) {
  test(`${agent} profile completes the ten-requirement correction rehearsal through a local executable shim`, { timeout: 8 * 60_000 }, () => {
    const prepared = runHarness(['prepare']);
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout || prepared.error?.message);
    let scenario;
    try {
      scenario = JSON.parse(prepared.stdout);
    } catch (error) {
      assert.fail(`prepare did not return one JSON manifest: ${error instanceof Error ? error.message : String(error)}\nstdout prefix:\n${prepared.stdout.slice(0, 2_000)}\nstdout suffix:\n${prepared.stdout.slice(-2_000)}\nstderr:\n${prepared.stderr}`);
    }
    assert.equal(scenario.requirements, 10);
    assert.deepEqual(scenario.initialCoverage, { total: 10, met: 5, unmet: 0, unproven: 5, blocked: 0 });

    const env = { ...process.env };
    delete env.AMABIE_ALLOW_CODEX_PROVIDER_USAGE;
    delete env.AMABIE_ALLOW_CLAUDE_PROVIDER_USAGE;
    const corrected = runHarness(['correct-shim', scenario.tempRoot, '--agent', agent], { env });
    assert.equal(corrected.status, 0, corrected.stderr || corrected.stdout || corrected.error?.message);
    const result = JSON.parse(corrected.stdout);

    assert.equal(result.executionMode, 'local-agent-shim');
    assert.equal(result.providerCallMade, false);
    assert.equal(result.correctionAttempts, 1);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(result.coverage, { total: 10, met: 10, unmet: 0, unproven: 0, blocked: 0 });
    assert.equal(result.claimUsedAsEvidence, false);
    assert.ok(result.changedFiles.includes('transactions.mjs'));
    assert.ok(result.changedFiles.includes('legacy.mjs'));
    assert.equal(result.providerShim?.requestSchema, 'amabie-correction-request/1');
    assert.equal(result.providerShim?.reportSchema, 'amabie-correction-report/3');
    assert.equal(result.providerShim?.cycle, 1);
    // A NEEDS ATTENTION doctor run is refused fail-closed: every registered requirement goes to the agent as blocked, without criteria.
    assert.equal(result.providerShim?.unresolvedCount, 10);
    assert.equal(result.providerShim?.unresolvedCriterionCount, 0);
    assert.equal(result.providerShim?.criteriaContractsMatchRequest, false);
    assert.equal(result.providerShim?.refusalContractMatchesRequest, true);
    assert.equal(result.providerShim?.evidenceFactsIncluded, false);
  });
}
