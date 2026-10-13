#!/usr/bin/env node
// Reconcile preserved evidence; never convert an unexecuted gate into PASS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence));
const repo = path.resolve(import.meta.dirname, '../..');
const candidate = path.join(evidence, 'candidate');
const read = file => fs.readFileSync(path.join(evidence, file), 'utf8');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const parse = file => {
  const text = read(file);
  const start = text.lastIndexOf('=== VERIFY-PRODUCTIZATION');
  assert(start >= 0, `Missing final summary: ${file}`);
  return text.slice(start).split(/\r?\n/).flatMap(line => {
    const m = /^(PASS|SKIP|FAIL|INCOMPLETE)  (.*?)(?:  — (.*))?$/.exec(line);
    return m ? [{ verdict: m[1], label: m[2], note: m[3] ?? '', evidence: file }] : [];
  });
};
const previous = parse('windows-productization-r2.log');
assert.equal(previous.length, 75);
assert.equal(previous.filter(g => g.verdict === 'PASS').length, 71);
const master = previous.find(g => g.label === 'probe: master-pass mutation battery (built dist)');
assert.equal(master.verdict, 'INCOMPLETE');
const previousMutation = read('windows-productization-r2-steps/075.stdout.log');
const mutationEvidence = [];
for (let i = 1; i <= 13; i++) {
  const id = `M${i}`;
  const file = i <= 11 ? 'windows-productization-r2-steps/075.stdout.log' : 'm12-m13-resolution.log';
  assert(new RegExp(`^PASS ${id} caught by `, 'm').test(i <= 11 ? previousMutation : read(file)));
  if (i > 11) {
    const raw = JSON.parse(read(`blocker-resolution/m12-m13/${id}.json`));
    assert.equal(raw.error, null); assert.equal(raw.signal, null); assert.equal(raw.status, 1);
    assert(/\bFAIL [FG]\b/.test(read(`blocker-resolution/m12-m13/${id}.stdout.log`)), 'Owning assertion must reject the mutation');
  }
  mutationEvidence.push({ id, verdict: 'PASS', evidence: file });
}
Object.assign(master, { verdict: 'PASS', note: 'All 13 faults caught across preserved unchanged M1–M11 and bounded isolated M12/M13; not a newly uninterrupted full battery.', evidence: mutationEvidence });
const remaining = parse('remaining-35-resolution.log');
const plan = JSON.parse(read('blocker-resolution-remaining-35.json'));
assert.deepEqual(remaining.map(g => g.label), plan.map(g => g.label));
assert.equal(remaining.length, 35);
assert.equal(remaining.filter(g => g.verdict === 'FAIL').length, 1);
const rerun = parse('pytest-fixed-resolution.log');
assert.equal(rerun.length, 1); assert.equal(rerun[0].verdict, 'PASS');
const failed = remaining.find(g => g.verdict === 'FAIL');
assert.equal(failed.label, rerun[0].label);
Object.assign(failed, { ...rerun[0], previousFailureEvidence: 'blocker-resolution/remaining-35/017.json', note: 'Test-only import fixed; shipped module invoked; attack must execute successfully and emit exactly one no-run rejection.' });
const gates = [...previous, ...remaining];
assert.equal(gates.length, 110); assert.equal(new Set(gates.map(g => g.label)).size, 110);
const counts = Object.fromEntries(['PASS', 'SKIP', 'FAIL', 'INCOMPLETE'].map(v => [v, gates.filter(g => g.verdict === v).length]));
assert.deepEqual(counts, { PASS: 105, SKIP: 5, FAIL: 0, INCOMPLETE: 0 });
for (const [file, marker] of [['blocker-final-budget.log', 'BATTERY-BUDGET: PASS'], ['blocker-final-runner-tests.log', '# fail 0'], ['blocker-final-source-integrity.log', 'no parallel changes'], ['blocker-final-repack.log', 'PASS three identical'], ['blocker-final-cleanroom.log', 'PACKED-CLEANROOM-PASS (7/7 acceptance steps)']]) assert(read(file).includes(marker), file);
const oldManifest = JSON.parse(fs.readFileSync(path.join(candidate, 'MANIFEST.json'), 'utf8'));
assert(read('blocker-final-linux-runner-tests.log').includes('# fail 0'), 'Native Linux runner/selection self-checks must pass');
assert(read('blocker-final-doc-consistency.log').includes('doc consistency: all 9 checks held'), 'Updated release documents must pass their consistency gate');
const cli = oldManifest.artifacts.find(a => a.name === 'amabie-cli-2.0.0.tgz');
assert.equal(hash(path.join(repo, 'pack/npm', cli.name)), cli.sha256);
assert.equal(hash(path.join(candidate, cli.name)), cli.sha256);
const rehearsal = JSON.parse(read('blocker-final-e2e.json'));
assert.equal(rehearsal.completed, true); assert.equal(rehearsal.tarballSha256, cli.sha256);
const ledger = { schema: 'amabie-release-gate-ledger/1', checkedAt: new Date().toISOString(), counts, gates, mutationEvidence,
  interpretation: 'Applicable supported LOCAL npm release gates completed; five explicit host/cost skips remain unverified. Results reconcile existing gates, not a new full uninterrupted run.' };
fs.writeFileSync(path.join(evidence, 'final-gate-ledger.json'), JSON.stringify(ledger, null, 2) + '\n');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-final-index-'));
const index = path.join(scratch, 'index');
const git = (args, isolated = false) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: isolated ? { ...process.env, GIT_INDEX_FILE: index } : process.env });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const defaultIndex = path.resolve(repo, git(['rev-parse', '--git-path', 'index']));
const before = hash(defaultIndex);
try {
  git(['read-tree', 'HEAD'], true); git(['add', '--all'], true);
  const tree = git(['write-tree'], true);
  const changes = git(['diff', '--name-only', '9b4a3dc77ad7f805ad9d60a616d41c7bbb0e4646', tree, '--']).split('\n').filter(Boolean);
  const allowed = new Set(['docs/RELEASE-CHECKLIST.md', 'docs/RELEASE-AUDIT.md', 'docs/RELEASE-2.0.0.md', 'tooling/probes/master-pass-mutations.mjs', 'tooling/probes/runner-observation-pytest.mjs', 'tooling/step-budgets.mjs', 'tooling/verify-productization.mjs', 'tooling/test-support/run-probe.mjs', 'tooling/test-support/run-probe.test.mjs', 'tooling/test-support/productization-selection.test.mjs', 'tooling/probes/release-blocker-finalize.mjs']);
  assert(changes.every(file => allowed.has(file)), `Unexpected source change: ${changes.filter(file => !allowed.has(file))}`);
  const archive = path.join(candidate, 'amabie-source-snapshot-rc2.tar');
  git(['archive', '--format=tar', `--output=${archive}`, tree], true);
  assert.equal(hash(defaultIndex), before, 'Default index must remain untouched');
  const unchangedArtifacts = oldManifest.artifacts.filter(a => !/^amabie-source-snapshot.*\.tar$/.test(a.name));
  const artifacts = [...unchangedArtifacts, { name: path.basename(archive) }].map(a => ({ name: a.name, bytes: fs.statSync(path.join(candidate, a.name)).size, sha256: hash(path.join(candidate, a.name)) }));
  for (const a of unchangedArtifacts) assert.equal(artifacts.find(b => a.name === b.name).sha256, a.sha256, `Preserved artifact changed: ${a.name}`);
  const historicalManifest = path.join(evidence, 'previous-candidate-manifest.json');
  if (!fs.existsSync(historicalManifest)) fs.writeFileSync(historicalManifest, JSON.stringify(oldManifest, null, 2) + '\n', { flag: 'wx' });
  const previous = JSON.parse(fs.readFileSync(historicalManifest, 'utf8'));
  assert.equal(previous.sourceTree, '9b4a3dc77ad7f805ad9d60a616d41c7bbb0e4646');
  assert.equal(previous.artifacts.find(a => a.name === cli.name).sha256, cli.sha256);
  fs.writeFileSync(path.join(candidate, 'MANIFEST.json'), JSON.stringify({ status: 'READY FOR FINAL APPROVAL', sourceTree: tree, priorSourceTree: previous.sourceTree, sourceChanges: changes, privateWebsiteZip: true, publicationAuthorized: false, gateLedger: '../final-gate-ledger.json', gateLedgerSha256: hash(path.join(evidence, 'final-gate-ledger.json')), artifacts }, null, 2) + '\n');
  console.log(`PASS final reconciliation: 105 PASS / 5 explicit SKIP; source tree ${tree}; CLI ${cli.sha256}; private website unchanged. Publication is not authorised.`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
