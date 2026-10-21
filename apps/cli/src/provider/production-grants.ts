/**
 * T24 — the permission contract (T23) in front of the REAL confined file route.
 *
 * `productionTool` hands a worker's operations to `production-tool.cjs`, which runs inside the AppContainer and
 * uses raw `fs`. The OS decides there; it knows nothing about grants. This gate runs in the trusted controller
 * BEFORE the confined process is launched and refuses the WHOLE call unless every file operation is covered by
 * a signed grant. Two independent layers: the contract says what was approved, the OS bounds what a process can
 * reach even if the contract were wrong.
 *
 * The regime is opt-in per store: `<store>/grants/` exists. The store is outside the worker's write reach, so a
 * worker cannot open or close it. A store without that directory behaves exactly as before (honest gap: the
 * controller must open the regime; there is no default-deny for an old enrollment).
 *
 * T25: `exec` and a declared `check` are judged as PROCESS actions - one exact argv per grant (bare program name,
 * no wildcard, no shell family). Without a matching exec grant they are refused. A file grant never covers a
 * process and an exec grant never covers a file, so there is no blanket native-shell exception.
 *
 * Honest limits (LOCAL, never HARDENED): `maxBytes` bounds the bytes one operation carries (an `edit` is judged
 * by its `replace`), not the resulting file size. A granted `node <script>` runs code the worker may have written
 * under a file grant; the AppContainer bounds that, the contract does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decide, decideExec, issueGrant, type ExecGrantPayload, type FileAction, type GrantPayload, type PermissionContext, type Verdict } from '../permission-contract.js';
import type { RecordEnvelope } from '../authority-envelope.js';

export interface GrantPolicy { generation: number; revoked: string[]; deny: string[] }
const DEFAULT_POLICY: GrantPolicy = { generation: 1, revoked: [], deny: [] };
const SEGMENT = /^[a-zA-Z0-9_.-]+$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function plainJson<T>(file: string): T {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 1024 * 1024) throw new Error(`unsafe grant file: ${path.basename(file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Controller-only: open (or extend) the regime. The signing key is the store's producer key. */
export function openGrants(store: string, projectId: string, privateKeyPem: string, grants: Array<GrantPayload | ExecGrantPayload>, policy: GrantPolicy = DEFAULT_POLICY): void {
  const dir = path.join(store, 'grants');
  fs.mkdirSync(dir, { recursive: true });
  const policyFile = path.join(dir, 'policy.json');
  if (!fs.existsSync(policyFile)) fs.writeFileSync(policyFile, JSON.stringify(policy), { flag: 'wx' });
  let seq = fs.readdirSync(dir).filter(f => /^grant-\d+\.json$/.test(f)).length;
  for (const g of grants) fs.writeFileSync(path.join(dir, `grant-${++seq}.json`), JSON.stringify(issueGrant(g, seq, projectId, privateKeyPem)), { flag: 'wx' });
}

/** A path the contract may judge: plain segments only, so no stream (`:`), 8.3 alias (`~`) or reserved device name. */
function safePath(p: unknown): p is string {
  return typeof p === 'string' && p.split(/[\\/]/).every(s => s === '' || (SEGMENT.test(s) && !/^\.+$/.test(s) && !/[. ]$/.test(s) && !RESERVED.test(s)));
}

/** No component of the target below the workspace may be a link or junction (they are not created inside a call). */
function noLinkBelow(cwd: string, rel: string): void {
  let p = path.resolve(cwd);
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    p = path.join(p, part);
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('a link inside the workspace');
  }
}

/** Throws unless every operation of `request` is covered. Returns silently when no regime is open for the store. */
export function gateRequest(store: string, projectId: string, cwd: string, request: unknown, now = Date.now()): void {
  const dir = path.join(store, 'grants');
  if (!fs.existsSync(dir)) return;
  const refuse = (why: string): never => { throw new Error(`permission contract refused: ${why}`); };
  const policy = plainJson<GrantPolicy>(path.join(dir, 'policy.json'));
  const grants = fs.readdirSync(dir).filter(f => /^grant-\d+\.json$/.test(f)).map(f => plainJson<RecordEnvelope>(path.join(dir, f)));
  const ctx: PermissionContext = {
    projectId, grantKeyPem: fs.readFileSync(path.join(store, 'producer.pub'), 'utf8'), now,
    policyGeneration: policy.generation, revoked: new Set(policy.revoked), met: new Set(), deny: ['.git', ...policy.deny],
  };
  // A process is its own resource: a file grant never covers it and an exec grant never covers a file.
  const execGate = (what: string, argv: unknown): void => {
    let best: Verdict = { decision: 'forbidden', reason: 'no grant', level: 'LOCAL' };
    for (const g of grants) {
      const v = decideExec({ source: 'worker-proposal', argv, grant: g }, ctx);
      if (v.decision === 'authorized') { best = v; break; }
      if (best.decision === 'forbidden') best = v;
    }
    if (best.decision !== 'authorized') refuse(`${what}: ${best.decision} (${best.reason})`);
  };
  const r = request as { operations?: unknown[]; check?: { argv?: unknown } } | null;
  // The declared check runs only after a change, but is judged up front: the whole call is covered or refused.
  if (r && typeof r === 'object' && r.check !== undefined) execGate('check', r.check?.argv);
  const ops = Array.isArray(r?.operations) ? r!.operations : [request];
  for (const op of ops as Array<Record<string, unknown> | null>) {
    const kind = op?.op;
    if (kind === 'exec') { execGate('exec', op!.argv); continue; }
    if (kind === 'list') { if (op!.path !== undefined && op!.path !== '.' && !safePath(op!.path)) refuse('list path'); continue; }
    if (kind !== 'read' && kind !== 'write' && kind !== 'edit') refuse('unknown operation');
    if (!safePath(op!.path)) refuse(`${kind} path is not a plain repo-relative path`);
    const action: FileAction = kind === 'read'
      ? { resource: { kind: 'file', path: op!.path as string }, operation: 'read', args: {} }
      : { resource: { kind: 'file', path: op!.path as string }, operation: 'write', args: { text: (kind === 'edit' ? op!.replace : op!.text) as string } };
    let best: Verdict = { decision: 'forbidden', reason: 'no grant', level: 'LOCAL' };
    for (const g of grants) {
      const v = decide({ source: 'worker-proposal', action, grant: g }, ctx);
      if (v.decision === 'authorized') { best = v; break; }
      if (best.decision === 'forbidden') best = v;
    }
    if (best.decision !== 'authorized') refuse(`${kind} ${String(op!.path)}: ${best.decision} (${best.reason})`);
    try { noLinkBelow(cwd, op!.path as string); } catch (e) { refuse(`${kind} ${String(op!.path)}: ${(e as Error).message}`); }
  }
}
