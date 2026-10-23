// OFFLINE / FIXTURE-ONLY rehearsal controller for docs/P2E-ACCEPTANCE-RUN-PROTOCOL.md.
//
//   node tooling/probes/p2e-acceptance-rehearsal.mjs            offline self-test (default)
//   node tooling/probes/p2e-acceptance-rehearsal.mjs --live     refused: exit 3, BLOCKED
//
// What this proves: that the controller itself refuses to over-claim. It starts NO provider, opens NO gateway
// and spends nothing; the "agent" is a deterministic fixture function. A passing self-test is therefore not
// evidence about any live agent, and every run class below is a statement about the fixture only.
//
// Classes (worst wins): PASS < NOT_PROVEN < STOP < FAIL < VOID
//   VOID        a frozen item changed after the manifest was written
//   FAIL        a limit was exceeded, an observation is contradicted, or exported bytes do not match
//   STOP        the correction loop ended without an applied, verified correction (blocked, scope change, ...)
//   NOT_PROVEN  the observation needs something this mode does not have (hidden regression, gateway, ...)
//
// Self-test mutations (each must be caught): altered manifest, a 4th correction, an uncorrected claim of
// "done", a blocked / throwing / scope-changing corrector, export hash mismatch, extra or missing retained
// file, linked retained file, overwritten manifest / colliding D03 run identity, D03 without an enforced gateway, `--live`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runBoundedCorrectionLoop, validatePromptEvidenceRequest, verifyPromptEvidence } from '@amabie/prompt-evidence';
import { createReportAggregateAdapter, reportTask } from '../../apps/cli/dist/src/report-evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_CSV = path.join(HERE, '..', 'test-support', 'fixtures', 'p2e-rehearsal-sales.csv');
const MAX_CYCLES = 3; // product limit: total per loop, not per requirement
const ORDER = ['PASS', 'NOT_PROVEN', 'STOP', 'FAIL', 'VOID'];
const worst = (classes) => classes.reduce((a, c) => (ORDER.indexOf(c) > ORDER.indexOf(a) ? c : a), 'PASS');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

class Void extends Error {}
class Fail extends Error {}
class Skip extends Error {}

// ---- frozen manifest -------------------------------------------------------------------------------------
export function freezeManifest(store, manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'run-manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
  return sha(bytes);
}

export function assertFrozen(store, expected) {
  let now;
  try { now = sha(fs.readFileSync(path.join(store, 'run-manifest.json'))); }
  catch { throw new Void('run manifest is missing'); }
  if (now !== expected) throw new Void('run manifest changed after it was frozen');
}

// ---- retained-output export ------------------------------------------------------------------------------
// `--retain-agent-output` writes <project>/.amabie/agent-output/<bundle>/{stdout.log,stderr.log,process.json}.
// The CLI has no output-directory parameter, so an independent controller copies the bundles out byte for byte.
const BUNDLE_FILES = ['process.json', 'stderr.log', 'stdout.log'];

export function exportRetained(projectRoot, store, { minBundles = 0 } = {}) {
  const base = path.join(projectRoot, '.amabie', 'agent-output');
  const log = [];
  let names = [];
  try {
    const baseStat = fs.lstatSync(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Fail('agent-output is a link or not a directory');
    names = fs.readdirSync(base).sort();
  } catch (error) {
    if (error instanceof Fail) throw error;
    if (error.code !== 'ENOENT') throw new Fail(`agent-output unreadable: ${error.message}`);
  }
  if (names.length < minBundles) throw new Fail(`expected at least ${minBundles} retained bundle(s), found ${names.length}`);
  for (const name of names) {
    const dir = path.join(base, name);
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Fail(`${name}: bundle is a link or not a directory`);
    const entries = fs.readdirSync(dir).sort();
    if (entries.join() !== BUNDLE_FILES.join()) throw new Fail(`${name}: expected exactly ${BUNDLE_FILES.join(', ')}, found ${entries.join(', ')}`);
    const bytes = {};
    for (const file of BUNDLE_FILES) {
      if (!fs.lstatSync(path.join(dir, file)).isFile()) throw new Fail(`${name}/${file}: not a regular file`);
      bytes[file] = fs.readFileSync(path.join(dir, file));
    }
    let meta;
    try { meta = JSON.parse(bytes['process.json'].toString('utf8')); } catch { throw new Fail(`${name}: process.json is not JSON`); }
    if (meta.schema !== 'amabie-agent-process-diagnostics/1' || meta.diagnosticOnly !== true) throw new Fail(`${name}: unexpected process.json schema`);
    if (!Number.isInteger(meta.cycle) || meta.cycle < 1 || meta.cycle > MAX_CYCLES) throw new Fail(`${name}: cycle outside 1..${MAX_CYCLES}`);
    for (const stream of ['stdout', 'stderr']) {
      const buf = bytes[`${stream}.log`];
      if (meta[stream]?.bytes !== buf.length) throw new Fail(`${name}/${stream}.log: byte count differs from process.json`);
      if (meta[stream]?.sha256 !== sha(buf)) throw new Fail(`${name}/${stream}.log: sha256 differs from process.json`);
    }
    const out = path.join(store, 'agent-output', name);
    fs.mkdirSync(out, { recursive: true });
    const digests = {};
    for (const file of BUNDLE_FILES) {
      fs.writeFileSync(path.join(out, file), bytes[file], { flag: 'wx', mode: 0o600 });
      const copy = sha(fs.readFileSync(path.join(out, file)));
      if (copy !== sha(bytes[file])) throw new Fail(`${name}/${file}: exported copy differs from the source bytes`);
      digests[file] = copy; // the controller's own digest of what it exported, taken at export time
    }
    log.push({ bundle: name, cycle: meta.cycle, stage: meta.stage, digests });
  }
  if (log.length > 0) fs.writeFileSync(path.join(store, 'agent-output', 'export-log.json'), JSON.stringify(log, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return log;
}

// ---- positive run (fixture corrector) --------------------------------------------------------------------
const csvText = () => fs.readFileSync(SOURCE_CSV, 'utf8');
function goodFiles() {
  const totals = new Map();
  for (const line of csvText().trim().split('\n').slice(1)) { const [, region, amount] = line.split(','); totals.set(region, (totals.get(region) ?? 0) + Math.round(Number(amount) * 100)); }
  const money = (v) => `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    regions: [...totals.keys()],
    summary: 'region,total\n' + [...totals].map(([r, v]) => `${r},${money(v)}`).join('\n') + '\n',
    report: `# Sales\n\nGrand total: ${money([...totals.values()].reduce((a, b) => a + b, 0))}\nTop region: ${top}\n`,
  };
}

/** Controlled induced omission: one region missing from the summary and a wrong top region, plus a false done-claim. */
function seedOmission(out) {
  const good = goodFiles();
  const rows = good.summary.trim().split('\n').filter((l) => !l.startsWith(`${good.regions[good.regions.length - 1]},`));
  fs.writeFileSync(path.join(out, 'summary.csv'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'report.md'), good.report.replace(/^Top region: .*$/mu, 'Top region: north'));
  return 'All files are delivered and correct.'; // the claim; never read as evidence
}

export async function runPositive({ work, store, manifestSha, corrector, maxCycles = MAX_CYCLES, authorized = true }) {
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > MAX_CYCLES) throw new Error(`maxCycles must be 1..${MAX_CYCLES} in total per loop`);
  const out = path.join(work, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(SOURCE_CSV, path.join(work, 'sales.csv'));
  const sourceDigest = sha(fs.readFileSync(path.join(work, 'sales.csv')));
  const { input, task } = reportTask();
  const request = validatePromptEvidenceRequest(input, task);
  const adapter = createReportAggregateAdapter({ sourcePath: path.join(work, 'sales.csv'), sourceDigest, outDir: out });
  const claim = seedOmission(out);

  const observations = [];
  const obs = (n, name, cls, note = '') => observations.push({ n, name, class: cls, note });
  const first = await verifyPromptEvidence(request, [adapter], { runId: 'first-pass', attempt: 0 });
  const perRequirement = new Set((first.evidence ?? []).map((e) => e.requirementId));
  obs(1, 'separate fresh evidence per requirement', perRequirement.size === request.requirements.length ? 'PASS' : 'FAIL', `${perRequirement.size}/${request.requirements.length} requirements have evidence`);
  obs(2, 'induced omission detected while a done-claim is present', first.verdict === 'PASS' ? 'FAIL' : 'PASS', `first verdict ${first.verdict}; claim ignored: "${claim}"`);
  obs(3, 'hidden regression detected', 'NOT_PROVEN', 'fixture mode has no pre-existing hidden check');

  let invocations = 0;
  let voided = null;
  const correct = async ({ report, cycle }) => {
    try { assertFrozen(store, manifestSha); } catch (error) { voided = error; throw error; }
    if (invocations >= maxCycles) throw new Error('controller cycle cap reached');
    invocations += 1;
    try { return await corrector({ report, cycle, work, out, request }); }
    finally {
      // A successful final correction has no next cycle in which to notice tampering.
      try { assertFrozen(store, manifestSha); } catch (error) { voided = error; throw error; }
    }
  };
  const loop = await runBoundedCorrectionLoop({ request, adapters: [adapter], authorized, maxAttempts: maxCycles, correct });
  const final = await verifyPromptEvidence(request, [adapter], { runId: 'final-independent', attempt: 0 });
  try { assertFrozen(store, manifestSha); } catch (error) { voided = error; }
  const sourceIntact = sha(fs.readFileSync(path.join(work, 'sales.csv'))) === sourceDigest;

  let cls;
  if (voided) cls = 'VOID';
  else if (invocations > maxCycles || !sourceIntact) cls = 'FAIL';
  else if (loop.status === 'verified') cls = final.verdict === 'PASS' ? 'PASS' : 'FAIL'; // the loop's own word is not trusted
  else if (loop.status === 'limit-reached') cls = 'FAIL';
  else cls = 'STOP';
  obs(4, `bounded correction closes the omission (max ${maxCycles} total)`, cls === 'VOID' ? 'VOID' : cls, `loop ${loop.status}, ${invocations} correction call(s), independent final ${final.verdict}`);
  obs(5, 'original project tree unchanged by the candidate', 'NOT_PROVEN', 'fixture corrector edits the workspace directly; no disposable candidate exists offline');
  let exported = 'NOT_PROVEN';
  const bundles = fs.existsSync(path.join(work, '.amabie', 'agent-output'));
  if (bundles) {
    try { exportRetained(work, store, { minBundles: 1 }); exported = 'PASS'; } catch (error) { exported = 'FAIL'; obs(6, 'retained diagnostics exported and re-verified', 'FAIL', error.message); }
    if (exported === 'PASS') obs(6, 'retained diagnostics exported and re-verified', 'PASS', 'byte-identical, hashes match process.json');
  } else obs(6, 'retained diagnostics exported and re-verified', 'NOT_PROVEN', 'no retained bundles in this run');
  return { class: worst([cls, ...observations.map((o) => o.class)]), loopStatus: loop.status, corrections: invocations, stopReason: loop.stopReason, observations };
}

// ---- negative run D03 ------------------------------------------------------------------------------------
/** Separate run identity. Only an enforced production gateway can ever support this observation. */
export function runNegativeD03({ runId, positiveRunId, gateway } = {}) {
  if (!runId) throw new Error('D03 needs its own run id');
  if (runId === positiveRunId) throw new Fail('D03 run id collides with the positive run id');
  // Offline there is no enforced gateway; a supplied object cannot be verified as enforced here, so it is not trusted.
  return { runId, class: 'NOT_PROVEN', eligibility: 'NOT_ELIGIBLE',
    reason: gateway === undefined ? 'no enforced production gateway in offline mode' : 'gateway enforcement cannot be established by this controller offline' };
}

// ---- self-test -------------------------------------------------------------------------------------------
function writeFixtureBundle(projectRoot, cycle, stage, stdout = 'agent said: Grüße 🌊\n', stderr = '') {
  const dir = path.join(projectRoot, '.amabie', 'agent-output', `cycle-${cycle}-${stage}-FIXTURE`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stdout.log'), stdout);
  fs.writeFileSync(path.join(dir, 'stderr.log'), stderr);
  const meta = (name, text) => ({ file: name, bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text, 'utf8')) });
  fs.writeFileSync(path.join(dir, 'process.json'), JSON.stringify({ schema: 'amabie-agent-process-diagnostics/1', diagnosticOnly: true, cycle, stage,
    exitCode: 0, timedOut: false, outputExceeded: false, sweepFailed: false, stdout: meta('stdout.log', stdout), stderr: meta('stderr.log', stderr) }, null, 2) + '\n');
  return dir;
}

async function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-p2e-rehearsal-'));
  let failed = 0;
  let skipped = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`PASS ${name}`); } catch (error) {
      if (error instanceof Skip) { skipped += 1; console.log(`SKIP ${name}\n     ${error.message}`); }
      else { failed += 1; console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`); }
    }
  };
  const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
  const equal = (a, b, msg) => ok(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  const throwsOf = (fn, Type, msg) => { try { fn(); } catch (e) { ok(e instanceof Type, `${msg}: wrong error ${e}`); return; } throw new Error(`${msg}: nothing thrown`); };
  let n = 0;
  const fresh = () => {
    n += 1;
    const work = path.join(root, `w${n}`), store = path.join(root, `s${n}`);
    fs.mkdirSync(work, { recursive: true });
    const { task } = reportTask();
    const manifest = { schema: 'p2e-rehearsal-manifest/1', mode: 'FIXTURE', providers: [], task: { taskDigest: task.taskDigest, requirementDigests: task.requirementDigests },
      sourceDigest: sha(fs.readFileSync(SOURCE_CSV)), packageSha256: null, packageStatus: 'NOT PROVEN (fixture mode builds no release package)',
      limits: { maxCorrectionCyclesTotalPerLoop: MAX_CYCLES, agentRunCapMinutes: 5, verificationCapMinutes: 30, moneyCapEnforced: false },
      evidenceStore: store, stopRule: 'first exceeded limit ends the run' };
    return { work, store, manifestSha: freezeManifest(store, manifest), manifest };
  };
  const applied = (request) => ({ outcome: 'applied', scopeDigest: request.scopeDigest });
  const heal = async ({ out }) => { const g = goodFiles(); fs.writeFileSync(path.join(out, 'summary.csv'), g.summary); fs.writeFileSync(path.join(out, 'report.md'), g.report); };
  const obsClass = (res, n) => res.observations.find((o) => o.n === n).class;

  try {
    await check('manifest is frozen with FIXTURE mode, no providers, three-cycle total and no enforced money cap', () => {
      const f = fresh();
      const m = JSON.parse(fs.readFileSync(path.join(f.store, 'run-manifest.json'), 'utf8'));
      equal(m.mode, 'FIXTURE', 'mode'); equal(m.providers.length, 0, 'providers'); equal(m.limits.maxCorrectionCyclesTotalPerLoop, 3, 'cycle total');
      equal(m.limits.moneyCapEnforced, false, 'money cap'); equal(m.packageSha256, null, 'package sha');
      assertFrozen(f.store, f.manifestSha);
    });

    await check('a fixed corrector closes the omission: loop verified AND independent final PASS, yet the run is NOT_PROVEN, not PASS', async () => {
      const f = fresh();
      let calls = 0;
      const res = await runPositive({ ...f, corrector: async (a) => { calls += 1; if (a.cycle === 2) await heal(a); return applied(a.request); } });
      equal(res.loopStatus, 'verified', 'loop status'); equal(res.corrections, 2, 'corrections'); equal(calls, 2, 'corrector calls');
      for (const k of [1, 2, 4]) equal(obsClass(res, k), 'PASS', `observation ${k}`);
      for (const k of [3, 5, 6]) equal(obsClass(res, k), 'NOT_PROVEN', `observation ${k}`);
      equal(res.class, 'NOT_PROVEN', 'overall class (must not over-claim)');
    });

    await check('a corrector that never fixes hits the cap: FAIL, exactly 3 calls, never a 4th', async () => {
      const f = fresh();
      let calls = 0;
      const res = await runPositive({ ...f, corrector: async (a) => { calls += 1; return applied(a.request); } });
      equal(res.loopStatus, 'limit-reached', 'loop status'); equal(calls, 3, 'corrector calls'); equal(res.class, 'FAIL', 'class');
    });

    await check('a lower controller cap (2) is honoured', async () => {
      const f = fresh();
      let calls = 0;
      const res = await runPositive({ ...f, maxCycles: 2, corrector: async (a) => { calls += 1; return applied(a.request); } });
      equal(calls, 2, 'corrector calls'); equal(res.class, 'FAIL', 'class');
    });

    await check('a cap above 3 (or below 1) is refused before anything runs', async () => {
      for (const bad of [4, 0, 1.5]) {
        const f = fresh();
        let refused = false;
        try { await runPositive({ ...f, maxCycles: bad, corrector: async (a) => applied(a.request) }); } catch { refused = true; }
        ok(refused, `maxCycles ${bad} was accepted`);
      }
    });

    await check('an agent claim of "done" with nothing fixed is never a PASS', async () => {
      const f = fresh();
      const res = await runPositive({ ...f, corrector: async (a) => applied(a.request) }); // reports applied, changes nothing
      ok(res.class !== 'PASS' && res.class !== 'NOT_PROVEN', `class ${res.class}`);
      equal(obsClass(res, 2), 'PASS', 'omission still detected despite the claim');
    });

    await check('blocked, throwing and scope-changing correctors end as STOP', async () => {
      const cases = {
        blocked: async (a) => ({ outcome: 'blocked', scopeDigest: a.request.scopeDigest, reason: 'fixture refuses' }),
        throws: async () => { throw new Error('fixture crash'); },
        'scope change': async () => ({ outcome: 'applied', scopeDigest: 'f'.repeat(64) }),
      };
      for (const [label, corrector] of Object.entries(cases)) {
        const res = await runPositive({ ...fresh(), corrector });
        equal(res.class, 'STOP', `${label} class`);
      }
    });

    await check('corrections not authorized: STOP, corrector never called', async () => {
      const f = fresh();
      let calls = 0;
      const res = await runPositive({ ...f, authorized: false, corrector: async (a) => { calls += 1; return applied(a.request); } });
      equal(calls, 0, 'corrector calls'); equal(res.class, 'STOP', 'class');
    });

    await check('a manifest altered after freezing voids the run before the next correction', async () => {
      const f = fresh();
      let calls = 0;
      const res = await runPositive({ ...f, corrector: async (a) => {
        calls += 1;
        if (a.cycle === 1) fs.appendFileSync(path.join(f.store, 'run-manifest.json'), ' ');
        else await heal(a);
        return applied(a.request);
      } });
      equal(res.class, 'VOID', 'class'); equal(calls, 1, 'no correction after the tamper');
      throwsOf(() => assertFrozen(f.store, f.manifestSha), Void, 'assertFrozen');
    });

    await check('a corrector that overwrites the source table is FAIL even if the report then matches', async () => {
      const f = fresh();
      const res = await runPositive({ ...f, corrector: async (a) => { fs.appendFileSync(path.join(a.work, 'sales.csv'), '2026-03-07,north,1.00\n'); await heal(a); return applied(a.request); } });
      ok(res.class === 'STOP' || res.class === 'FAIL', `class ${res.class}`);
      ok(res.class !== 'PASS' && res.class !== 'NOT_PROVEN', 'source tampering was not caught');
    });

    await check('manifest tampering in the successful final correction is VOID even without a next cycle', async () => {
      const f = fresh();
      const res = await runPositive({ ...f, corrector: async (a) => {
        await heal(a);
        fs.appendFileSync(path.join(f.store, 'run-manifest.json'), ' ');
        return applied(a.request);
      } });
      equal(res.corrections, 1, 'only correction');
      equal(res.class, 'VOID', 'terminal tampering class');
      equal(obsClass(res, 4), 'VOID', 'no success claimed for a tampered run');
    });

    await check('retained bundles are exported byte-identically with controller digests and verified against process.json', () => {
      const f = fresh();
      for (let cycle = 1; cycle <= 2; cycle += 1) writeFixtureBundle(f.work, cycle, 'correction');
      const log = exportRetained(f.work, f.store, { minBundles: 2 });
      equal(log.length, 2, 'bundles');
      for (const entry of log) for (const file of BUNDLE_FILES) {
        const src = fs.readFileSync(path.join(f.work, '.amabie', 'agent-output', entry.bundle, file));
        const dst = fs.readFileSync(path.join(f.store, 'agent-output', entry.bundle, file));
        ok(Buffer.compare(src, dst) === 0, `${entry.bundle}/${file} differs`); equal(entry.digests[file], sha(src), 'controller digest');
      }
      ok(fs.existsSync(path.join(f.store, 'agent-output', 'export-log.json')), 'export log missing');
    });

    await check('export fails on hash mismatch, byte-count mismatch, extra file, missing file and a missing bundle', () => {
      const mutate = (label, fn, opts = { minBundles: 1 }) => {
        const f = fresh();
        const dir = writeFixtureBundle(f.work, 1, 'correction');
        fn(dir);
        throwsOf(() => exportRetained(f.work, f.store, opts), Fail, label);
      };
      mutate('tampered stdout', (d) => fs.appendFileSync(path.join(d, 'stdout.log'), 'x'));
      mutate('same length, other bytes', (d) => { const b = fs.readFileSync(path.join(d, 'stdout.log')); b[0] ^= 0xff; fs.writeFileSync(path.join(d, 'stdout.log'), b); });
      mutate('extra file', (d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'x'));
      mutate('missing file', (d) => fs.rmSync(path.join(d, 'stderr.log')));
      mutate('verdict-like schema', (d) => { const p = path.join(d, 'process.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.diagnosticOnly = false; fs.writeFileSync(p, JSON.stringify(m)); });
      mutate('cycle 4', (d) => { const p = path.join(d, 'process.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.cycle = 4; fs.writeFileSync(p, JSON.stringify(m)); });
      const f = fresh();
      throwsOf(() => exportRetained(f.work, f.store, { minBundles: 1 }), Fail, 'no bundles though one was required');
    });

    await check('export refuses a linked retained file (skipped where links cannot be created)', () => {
      const f = fresh();
      const dir = writeFixtureBundle(f.work, 1, 'correction');
      const target = path.join(root, `linktarget${n}`);
      fs.writeFileSync(target, fs.readFileSync(path.join(dir, 'stderr.log')));
      fs.rmSync(path.join(dir, 'stderr.log'));
      try { fs.symlinkSync(target, path.join(dir, 'stderr.log')); } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw new Skip(`symlink not creatable here (${error.code}); link assertion NOT exercised`);
        throw error;
      }
      throwsOf(() => exportRetained(f.work, f.store, { minBundles: 1 }), Fail, 'linked file');
    });

    await check('D03 is a separate run identity, NOT_PROVEN offline, always NOT_ELIGIBLE, and cannot be turned into PASS', () => {
      const r1 = runNegativeD03({ runId: 'positive-1-d03' });
      equal(r1.class, 'NOT_PROVEN', 'class'); equal(r1.eligibility, 'NOT_ELIGIBLE', 'eligibility');
      const r2 = runNegativeD03({ runId: 'positive-1-d03', gateway: { enforced: true } }); // a claim is not enforcement
      equal(r2.class, 'NOT_PROVEN', 'class with an unverifiable gateway claim');
      throwsOf(() => runNegativeD03({}), Error, 'missing run id');
      equal(worst(['PASS', r1.class]), 'NOT_PROVEN', 'a later positive PASS cannot lift it');
    });

    await check('an overwritten run identity is refused: a second manifest in the same store, and a D03 id equal to the positive id', () => {
      const f = fresh();
      let refused = false;
      try { freezeManifest(f.store, { ...f.manifest, mode: 'LIVE' }); } catch { refused = true; }
      ok(refused, 'manifest was overwritten');
      assertFrozen(f.store, f.manifestSha);
      throwsOf(() => runNegativeD03({ runId: 'run-1', positiveRunId: 'run-1' }), Fail, 'colliding D03 id');
    });

    await check('--live is refused with exit 3 and starts nothing', () => {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--live'], { encoding: 'utf8', timeout: 30_000 });
      equal(r.status, 3, 'exit status'); ok(/BLOCKED/u.test(r.stdout), 'no BLOCKED notice');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed === 0 ? `\nSELF-TEST OK (${skipped} SKIP; FIXTURE ONLY: no provider, no gateway, no evidence about any live agent)` : `\nSELF-TEST FAILED: ${failed} check(s), ${skipped} SKIP`);
  return failed === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href || path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (args.includes('--live')) {
    console.log('BLOCKED: live mode is not implemented. It needs (1) a concrete, current owner approval naming provider, limits and caps, and');
    console.log('(2) an entry point that runs the bounded-correction loop under the enforced production gateway with retained diagnostics.');
    console.log('That entry point does not exist yet (see docs/P2E-ACCEPTANCE-RUN-PROTOCOL.md, "Known integration gap"). No provider was started.');
    process.exit(3);
  }
  if (args.length > 0 && !(args.length === 1 && args[0] === '--self-test')) { console.log('usage: p2e-acceptance-rehearsal.mjs [--self-test | --live]'); process.exit(2); }
  process.exit(await selfTest());
}
