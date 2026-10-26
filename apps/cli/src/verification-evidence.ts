import fs from 'node:fs';
import path from 'node:path';
import { MAX_REQUIREMENTS } from './authorization.js';
import { sha256 } from './project.js';
import { type ProtocolEnvelope, type ProtocolProof } from './protocol.js';
import { type VerificationReport } from '@amabie/prompt-evidence';
import { type StepResult } from './check-runner.js';
import { CLI_ENTRY } from './cli-runtime.js';
import { ENV_POLICY } from './execution-environment.js';
import { type BaselineStamp, candidateIdentity } from './git-state.js';
import { CHECKPOINT_FILE, CONFIG_DIR } from './local-config.js';
import { containedRealPath, isRecord, writeFileAtomic } from './local-files.js';

/** M9: exported — evidence storage is protected authority bytes (§9). */
export const EVIDENCE_DIR = 'evidence';

export const CLAIMS_FILE = path.join('claims', 'latest.json');

/** bundles kept before the oldest are pruned — evidence must not grow unbounded */
const EVIDENCE_KEEP = 10;

const RAW_CAP = 256 * 1024;

/** Derive test counts FROM THE BYTES AMABIE CAPTURED (or from claim text —
 *  same parser, applied to untrusted input). Observation only: nothing here
 *  can make a command succeed or fail; the exit code remains the oracle and
 *  a printed summary is just another claim.
 *  Cost is bounded twice over (M2 review): only the LAST 256 KiB is scanned
 *  (summaries sit at the tail anyway) and the jest gap is a bounded `{0,120}`
 *  lazy — an adversarial multi-MB single line of "Tests:Tests:..." cannot
 *  stall the hook (an unbounded [^\n]*? here is per-start quadratic, and a
 *  hung checkpoint gets the hook killed, which fails the stop gate open). */
export function deriveObservedCounts(raw: string): { parser: string; passed: number; failed: number } | null {
  const text = raw.length > 262_144 ? raw.slice(-262_144) : raw;
  const families: Array<[string, RegExp, RegExp]> = [
    ['node --test', /#\s*pass\s+(\d+)/, /#\s*fail\s+(\d+)/],
    ['mocha', /(\d+)\s+passing\b/, /(\d+)\s+failing\b/],
    ['jest', /Tests:[^\n]{0,120}?(\d+)\s+passed/, /Tests:[^\n]{0,120}?(\d+)\s+failed/],
    ['vitest', /Tests\s+(\d+)\s+passed/, /Tests\s+(\d+)\s+failed/],
  ];
  for (const [parser, pass, fail] of families) {
    const matches = (re: RegExp): RegExpMatchArray[] => [...text.matchAll(new RegExp(re.source, `${re.flags}g`))];
    const pm = matches(pass).pop();
    if (!pm) continue;
    const fm = matches(fail).pop();
    return { parser, passed: Number(pm[1]), failed: fm ? Number(fm[1]) : 0 };
  }
  return null;
}

/** Which env vars that steer child behavior were present (NAMES only, never
 *  values — a token in NODE_OPTIONS is not evidence to store). */
function relevantEnvNames(): string[] {
  return Object.keys(process.env)
    .filter((k) => /^(npm_config_|NODE_OPTIONS$|NODE_PATH$|CI$)/.test(k))
    .sort();
}

// ---------- M3 evidence trust classes ----------
/**
 * Every evidence item belongs to exactly ONE class, stamped by the code that
 * WRITES its bytes — the label describes the writer, it is never authority:
 *
 *   AMABIE_OBSERVED      Amabie executed it itself (verification bundles).
 *   EXTERNALLY_VERIFIED  a third party's executed proof, imported by a human
 *                        (CI attestation, GLM audit). NO PRODUCER EXISTS YET:
 *                        until a real import path is built, anything on disk
 *                        claiming this class is unvalidated text at best
 *                        AGENT_REPORTED.
 *   AGENT_REPORTED       the worker's own words (claims file). A hint with
 *                        ZERO verdict authority — never sufficient for PASS,
 *                        never creates a BLOCK.
 *
 * Enforcement is STRUCTURAL, not label-based: a verdict is produced only
 * from checks Amabie executes in the same invocation, and evidence is never
 * read back for one (M2 doctrine). So copying a bundle, self-declaring a
 * class inside file content, or renaming AGENT_REPORTED bytes into a
 * Amabie-owned path all change NOTHING — the classes are honest description
 * for humans and downstream tooling, and the tests pin that they stay inert
 * as input.
 */
export type TrustClass = 'AMABIE_OBSERVED' | 'EXTERNALLY_VERIFIED' | 'AGENT_REPORTED';

// ---------- M4 provenance ----------
/**
 * M4 answers the questions authoritative evidence must carry: WHAT plan
 * (planDigest) and WHAT task (task digest, optional), WHICH CODE (baseline +
 * candidate head/tree), WHERE (per-step cwd), WHEN (per-step start/end),
 * WHAT HAPPENED (exit codes, raw-byte hashes, artifacts) — and the
 * verification.sha256 companion binds the whole answer together. All of it is
 * OBSERVATION recorded by the executing code and is never consulted for a
 * verdict (M2 doctrine stands): provenance documents proof, it never replaces
 * it, and no field here claims cryptographic authenticity — there is no
 * signing key; the bundle hash is tamper-EVIDENCE against corruption and
 * accidental edit, nothing more.
 */
/** Bundle provenance, computed by the CALLER from trusted state (config) or
 *  observation — never from file content read back off the evidence dir. */
export interface BundleProvenance {
  planDigest: string;
  baseline: BaselineStamp | null;
  /** digest of the optional task string a hook sent; raw prose is never stored */
  taskDigest?: string;
}

/**
 * Write what Amabie just executed, as bytes — argv, cwd, runtime, candidate,
 * raw streams (capped files + full-byte digests), exit codes, derived
 * observation counts. BEST-EFFORT: evidence plumbing must never crash or
 * alter the harness hook, and nothing reads this back for a verdict (S4
 * doctrine extended to the whole evidence dir). Returns the bundle dir it
 * wrote, or null when nothing was written (containment refusal, any failure)
 * — so callers' `next:` lines can point at real evidence paths (review F7).
 */
/** Keys the bundle writer itself owns — `extra` may add, never overwrite. */
const BUNDLE_RESERVED = new Set(['schema', 'at', 'source', 'status', 'trustClass', 'note',
  'amabieEntry', 'runtime', 'cwd', 'candidate', 'envOverrides', 'execPolicy', 'steps', 'provenance']);

export function writeVerificationBundle(root: string, source: string, results: StepResult[], status: string, prov?: BundleProvenance, o?: {
  /** where evidence DIRS live (M7: a candidate's bundles land under the BASE's
   *  .amabie/evidence — the candidate never holds Amabie's authoritative bytes) */
  evidenceRoot?: string;
  /** which tree cwd/candidate identity describe (defaults to the steps' root) */
  subjectRoot?: string;
  /** Trusted execution-time identity when persistence follows temporary-tree cleanup. */
  subjectIdentity?: ReturnType<typeof candidateIdentity>;
  /** additive, plainly-labeled observation fields (never read back for verdicts) */
  extra?: Record<string, unknown>;
}): string | null {
  try {
    const evidenceRoot = o?.evidenceRoot ?? root;
    const subjectRoot = o?.subjectRoot ?? root;
    if (containedRealPath(evidenceRoot, path.join(evidenceRoot, CONFIG_DIR)) === null) return null; // linked .amabie: no writes through it (S3)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(evidenceRoot, CONFIG_DIR, EVIDENCE_DIR, `${stamp}-${source}`);
    if (containedRealPath(evidenceRoot, dir) === null) return null;
    fs.mkdirSync(dir, { recursive: true });
    const steps = results.map((r, i) => {
      const files: Record<'out' | 'err', string> = { out: '', err: '' };
      const raws: Record<'out' | 'err', string> = { out: r.stdout, err: r.stderr };
      (['out', 'err'] as const).forEach((stream) => {
        // kind arrives from DISK config (validConfigShape only checks isStr), so it
        // must not shape a path component — path.join collapses `../` right out of
        // the bundle dir. detectPlan kinds (typecheck/tests/build) pass unchanged.
        const safeKind = /^[a-z][a-z0-9-]{0,31}$/.test(r.kind) ? r.kind : 'step';
        const name = `${i + 1}-${safeKind}.${stream}.log`; // name is derived, never supplied
        const text = raws[stream];
        const capped = text.length > RAW_CAP
          ? `${text.slice(0, RAW_CAP / 2)}\n…TRUNCATED (${text.length} bytes total; full-byte sha256 below)…\n${text.slice(-RAW_CAP / 2)}`
          : text;
        try { writeFileAtomic(path.join(dir, name), capped); files[stream] = name; } catch { /* best-effort per stream */ }
      });
      return {
        kind: r.kind, argv: r.argv, cwd: r.cwd, ok: r.ok, exitCode: r.exitCode,
        // blocker 1: argv above is the whitelisted DISPLAY form; execArgv+exec
        // bind what actually ran — resolved path, compact digest, env policy.
        execArgv: r.execArgv, exec: r.exec,
        startedAt: r.startedAt, endedAt: r.endedAt,
        stdout: { sha256: sha256(r.stdout), bytes: Buffer.byteLength(r.stdout, 'utf8'), file: files.out || null },
        stderr: { sha256: sha256(r.stderr), bytes: Buffer.byteLength(r.stderr, 'utf8'), file: files.err || null },
        observedCounts: deriveObservedCounts(`${r.stdout}${r.stderr}`),
      };
    });
    const bundle = {
      schema: 'amabie-verification/1', at: new Date().toISOString(), source, status,
      // M3: every bundle exists because Amabie ran the plan — AMABIE_OBSERVED
      // is not a claim this file makes, it is a fact about who wrote these bytes.
      trustClass: 'AMABIE_OBSERVED',
      note: 'Written from Amabie\'s OWN execution. Agent reports and printed summaries are claims, not evidence; this bundle is never read back to produce a verdict.',
      amabieEntry: CLI_ENTRY,
      runtime: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
      cwd: subjectRoot, candidate: o?.subjectIdentity ?? candidateIdentity(subjectRoot), envOverrides: relevantEnvNames(),
      execPolicy: ENV_POLICY, steps,
      // M4 provenance: WHICH plan/code/task this evidence belongs to, stamped
      // from trusted in-memory state at write time — never re-derived from
      // bytes read back off the evidence dir. null only if a caller has no
      // plan context to offer. Observation, not verdict input.
      provenance: prov ? { planDigest: prov.planDigest, baseline: prov.baseline, taskDigest: prov.taskDigest ?? null } : null,
      // extras add fields (plainly-labeled observations); they may never
      // shadow the bundle's own reserved keys — a caller cannot launder a
      // trustClass or status in through the side door.
      ...Object.fromEntries(Object.entries(o?.extra ?? {}).filter(([k]) => !BUNDLE_RESERVED.has(k))),
    };
    const jsonPath = path.join(dir, 'verification.json');
    writeFileAtomic(jsonPath, JSON.stringify(bundle, null, 2) + '\n');
    // M4 bundle self-hash — TAMPER-EVIDENCE only. There is no signing key in
    // this product: whoever can rewrite verification.json can rewrite this
    // file too, so it proves nothing about authenticity. It honestly binds
    // the bundle against corruption and accidental edits, and says so.
    writeFileAtomic(path.join(dir, 'verification.sha256'),
      JSON.stringify({ file: 'verification.json', sha256: sha256(fs.readFileSync(jsonPath, 'utf8')), label: 'tamper-evidence only — NOT a signature; no key exists' }, null, 2) + '\n');
    // bounded retention: newest EVIDENCE_KEEP bundles; only Amabie's own
    // <stamp>-<source> dirs are eligible; anything else in evidence/ is left alone
    const parent = path.join(evidenceRoot, CONFIG_DIR, EVIDENCE_DIR);
    const mine = fs.readdirSync(parent)
      .filter((d) => /^\d{4}-\d{2}-\d{2}T[\d-]{11,}(Z)?-(setup|doctor|doctor-selected|checkpoint|baseline(?:-control)?|candidate|promotion)$/.test(d))
      .sort();
    for (const d of mine.slice(0, Math.max(0, mine.length - EVIDENCE_KEEP))) {
      try { fs.rmSync(path.join(parent, d), { recursive: true, force: true }); } catch { /* churn-tolerant */ }
    }
    return dir;
  } catch { /* evidence is best-effort; never crash the harness hook over it */ return null; }
}

/** The agent's latest UNTRUSTED hint — read ONLY to annotate a block Amabie
 *  already decided from its own execution. Shape-checked, capped, silent null
 *  on anything odd; it can never carry authority. */
export function readAgentClaim(root: string): { at: string; text: string } | null {
  try {
    const p = path.join(root, CONFIG_DIR, CLAIMS_FILE);
    if (containedRealPath(root, p) === null) return null;
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    const o = v as { at?: unknown; text?: unknown };
    if (typeof o?.text !== 'string' || typeof o?.at !== 'string') return null;
    // `at` is interpolated into a block-reason annotation, so it must FULLY match
    // an ISO timestamp (end anchor included — a prefix-only gate lets up to ~21
    // bytes of agent prose ride the tail of a hand-planted file into the note).
    // cmdClaim always writes new Date().toISOString(), which passes.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(o.at)) return null;
    return { at: o.at.slice(0, 40), text: o.text.slice(0, 4000) };
  } catch { return null; }
}

export function promptEvidenceBundleSummary(report: VerificationReport): Record<string, unknown> {
  const { requirements, ...summary } = report;
  return {
    ...summary,
    // User-authored requirement text stays out of the durable evidence bundle.
    requirements: requirements.map(({ id, status, criteria }) => ({ id, status, criteria })),
  };
}

type CheckpointHookResponse = 'blocked' | 'continued' | 'message-and-continue' | 'not-applicable' | 'unknown';

export function writeCheckpoint(
  root: string,
  status: string,
  failed: string[],
  source: string,
  details: { checks?: StepResult[]; hookResponse?: CheckpointHookResponse; next?: string; evidencePath?: string | undefined; proof?: ProtocolProof } = {},
): void {
  try {
    // never write evidence through a committed link pointing outside the repo (S3)
    const p = path.join(root, CONFIG_DIR, CHECKPOINT_FILE);
    if (containedRealPath(root, fs.existsSync(p) ? p : path.join(root, CONFIG_DIR)) === null) return;
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    // assertPlainTarget lives inside writeFileAtomic — a dangling link that passed
    // the ancestor walk is refused there rather than CREATED outside via the write.
    const checks = (details.checks ?? []).slice(0, 32).map((step) => ({
      kind: String(step.kind).slice(0, 40),
      display: String(step.display).slice(0, 240),
      exitCode: step.exitCode,
      ok: step.ok === true,
    }));
    writeFileAtomic(p, JSON.stringify({
      at: new Date().toISOString(), status, failed: failed.slice(0, 32).map((x) => String(x).slice(0, 80)), source,
      checks,
      hookResponse: details.hookResponse ?? 'not-applicable',
      sessionEnd: 'unknown',
      ...(details.next ? { next: details.next.slice(0, 500) } : {}),
      ...(details.evidencePath ? { evidencePath: details.evidencePath.slice(0, 1000) } : {}),
      ...(details.proof ? { proof: details.proof } : {}),
    }, null, 2) + '\n');
  } catch { /* evidence is best-effort; never crash the harness hook over it */ }
}

/** Decode a bounded, historical-only checkpoint for display. It never feeds a verdict. */
export function lastVerificationFromCheckpoint(value: unknown): ProtocolEnvelope['lastVerification'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const cp = value as Record<string, unknown>;
  if (typeof cp.at !== 'string' || typeof cp.source !== 'string' || typeof cp.status !== 'string') return undefined;
  const failed = Array.isArray(cp.failed)
    ? cp.failed.filter((x): x is string => typeof x === 'string').slice(0, 32).map((x) => x.slice(0, 80))
    : [];
  const checks = Array.isArray(cp.checks) ? cp.checks.slice(0, 32).flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.kind !== 'string' || typeof row.display !== 'string' || typeof row.ok !== 'boolean') return [];
    return [{ kind: row.kind.slice(0, 40), display: row.display.slice(0, 240),
      exitCode: typeof row.exitCode === 'number' && Number.isInteger(row.exitCode) ? row.exitCode : null, ok: row.ok }];
  }) : [];
  const hookResponse: CheckpointHookResponse = cp.hookResponse === 'blocked' || cp.hookResponse === 'continued'
    || cp.hookResponse === 'message-and-continue' || cp.hookResponse === 'not-applicable'
    ? cp.hookResponse : 'unknown';
  const rawProof = isRecord(cp.proof) ? cp.proof : null;
  const proof = rawProof && typeof rawProof.registeredRequirements === 'number'
    && Number.isSafeInteger(rawProof.registeredRequirements) && rawProof.registeredRequirements >= 0
    && rawProof.registeredRequirements <= MAX_REQUIREMENTS
    // Requirements may each carry bench and e2e targets, in addition to fixed plan/diff duties.
    && Array.isArray(rawProof.obligations) && rawProof.obligations.length <= MAX_REQUIREMENTS * 2 + 16
    && rawProof.obligations.every((ob: unknown) => isRecord(ob) && typeof ob.id === 'string'
      && (ob.mode === 'objective' || ob.mode === 'non-objective')
      && (ob.status === 'met' || ob.status === 'unproven' || ob.status === 'unmet')
      && (ob.caveat === undefined || typeof ob.caveat === 'string'))
    ? rawProof as unknown as ProtocolProof : undefined;
  return {
    at: cp.at.slice(0, 80), source: cp.source.slice(0, 40), status: cp.status.slice(0, 40), failed, checks,
    hookResponse, sessionEnd: 'unknown',
    ...(typeof cp.next === 'string' ? { next: cp.next.slice(0, 500) } : {}),
    ...(typeof cp.evidencePath === 'string' ? { evidencePath: cp.evidencePath.slice(0, 1000) } : {}),
    historical: true,
    ...(proof ? { proof } : {}),
  };
}
