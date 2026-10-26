/**
 * T23 — bounded permission contract + one closed local file adapter.
 *
 * A grant is a signed record (authority-envelope) minted ONLY from a trusted channel (`user` | `policy`).
 * A proposal comes from the worker; text a tool returned is never a source of authority. `decide` answers
 * before anything runs, with exactly one of:
 *   authorized     a valid grant covers this exact resource, operation and arguments, and every prerequisite is met
 *   unready        authorized in principle, but a prerequisite is not met yet (permission is not readiness)
 *   outside-scope  a valid grant exists, but not for this resource / operation / argument size
 *   forbidden      no grant, a bad or foreign signature, expired, not yet valid, revoked, superseded by a newer
 *                  policy generation, an explicit deny, or an untrusted source. Silence mints nothing.
 *   unclear        the request cannot be read as ONE exact action (malformed, ambiguous path); nothing is guessed
 *
 * LOCAL custody only (D06): the adapter stops the usual accident and a naive path escape, it is not a sandbox
 * against a same-user worker. The level is reported as LOCAL and is never relabelled HARDENED.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_SCHEMA, signedBytes, verifySeal, type RecordEnvelope } from './authority-envelope.js';
import { normPath } from './mission-journal.js';

export type GrantSource = 'user' | 'policy';
export type RequestSource = 'worker-proposal' | 'tool-text';
export type FileOperation = 'read' | 'write';
export type Decision = 'authorized' | 'unready' | 'outside-scope' | 'forbidden' | 'unclear';

export interface GrantBase { grantId: string; source: GrantSource; notBefore: number; expiresAt: number; policyGeneration: number; prerequisites: string[] }
/** T25: one exact argv, nothing else. No wildcard, no shell family, no "any program". */
export interface ExecGrantPayload extends GrantBase { resource: { kind: 'process'; argv: string[] }; operation: 'exec'; args: Record<string, never> }
export interface GrantPayload {
  grantId: string;
  source: GrantSource;
  resource: { kind: 'file'; path: string };
  operation: FileOperation;
  /** read: {}; write: { maxBytes } - bytes carried by one operation, not the resulting file size */
  args: { maxBytes?: number };
  notBefore: number;
  expiresAt: number;
  policyGeneration: number;
  prerequisites: string[];
}
export interface FileAction { resource: { kind: 'file'; path: string }; operation: FileOperation; args: { text?: string } }
export interface PermissionRequest { source: RequestSource; action: unknown; grant: RecordEnvelope | null }
export interface PermissionContext {
  projectId: string; grantKeyPem: string; now: number;
  policyGeneration: number; revoked: ReadonlySet<string>; met: ReadonlySet<string>;
  /** Explicit prohibitions (repo-relative prefixes). Their absence never grants anything. */
  deny?: readonly string[];
}
export interface Verdict { decision: Decision; reason: string; level: 'LOCAL' }

const GRANT_KIND = 'permission-grant';
const verdict = (decision: Decision, reason: string): Verdict => ({ decision, reason, level: 'LOCAL' });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> => isObj(v) && Object.keys(v).sort().join(',') === [...fields].sort().join(',');
const covers = (claim: string, p: string): boolean => p === claim || p.startsWith(`${claim}/`);

/** Controller-only. The private key never reaches a worker; only a trusted source can mint. */
export function issueGrant(p: GrantPayload | ExecGrantPayload,seq: number, projectId: string, privateKeyPem: string): RecordEnvelope {
  if (p.source !== 'user' && p.source !== 'policy') throw new Error('a grant is minted only from a user or policy source');
  const body = { schema: RECORD_SCHEMA, projectId, kind: GRANT_KIND, seq, issuedAt: new Date(p.notBefore).toISOString(), amabieVersion: '2', payload: p };
  return { ...body, signature: crypto.sign(null, signedBytes(body), crypto.createPrivateKey(privateKeyPem)).toString('base64') };
}

const GRANT_FIELDS = ['grantId', 'source', 'resource', 'operation', 'args', 'notBefore', 'expiresAt', 'policyGeneration', 'prerequisites'];
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
/** The fields every grant kind shares; the resource, operation and args belong to the kind's own reader. */
function baseOk(v: Record<string, unknown>): boolean {
  if (typeof v.grantId !== 'string' || !v.grantId || (v.source !== 'user' && v.source !== 'policy')) return false;
  if (!isObj(v.args) || !isCount(v.notBefore) || !isCount(v.expiresAt) || !isCount(v.policyGeneration)) return false;
  return Array.isArray(v.prerequisites) && v.prerequisites.every(x => typeof x === 'string');
}

function readGrant(v: unknown): GrantPayload | null {
  if (!exact(v, GRANT_FIELDS) || !baseOk(v)) return null;
  if (!exact(v.resource, ['kind', 'path']) || v.resource.kind !== 'file' || typeof v.resource.path !== 'string') return null;
  if (v.operation !== 'read' && v.operation !== 'write') return null;
  const args = v.args as Record<string, unknown>;
  const argsOk = v.operation === 'read' ? exact(args, []) : exact(args, ['maxBytes']) && isCount(args.maxBytes);
  return argsOk ? v as unknown as GrantPayload : null;
}

/** A bare program name plus plain arguments: no path (so nothing is launched by location), no NUL. */
export function readArgv(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > 64 || !v.every(x => typeof x === 'string' && x.length <= 4096 && !x.includes('\0'))) return null;
  return /^[A-Za-z0-9_.-]+$/.test(v[0]) ? v as string[] : null;
}
function readExecGrant(v: unknown): ExecGrantPayload | null {
  if (!exact(v, GRANT_FIELDS) || !baseOk(v) || v.operation !== 'exec' || !exact(v.args, [])) return null;
  if (!exact(v.resource, ['kind', 'argv']) || v.resource.kind !== 'process' || !readArgv(v.resource.argv)) return null;
  return v as unknown as ExecGrantPayload;
}

/** The ONE exact action a request names, or null. Path is repo-relative and case-folded (see normPath). */
function readAction(v: unknown): FileAction | null {
  if (!exact(v, ['resource', 'operation', 'args'])) return null;
  if (!exact(v.resource, ['kind', 'path']) || v.resource.kind !== 'file' || typeof v.resource.path !== 'string') return null;
  if (v.operation !== 'read' && v.operation !== 'write') return null;
  if (v.operation === 'read' ? !exact(v.args, []) : !exact(v.args, ['text']) || typeof v.args.text !== 'string') return null;
  try { return { resource: { kind: 'file', path: normPath(v.resource.path) }, operation: v.operation, args: v.args as FileAction['args'] }; } catch { return null; }
}

export function decide(req: PermissionRequest, ctx: PermissionContext): Verdict {
  if (req.source !== 'worker-proposal' && req.source !== 'tool-text') return verdict('unclear', 'unknown request source');
  if (req.source === 'tool-text') return verdict('forbidden', 'text a tool returned carries no authority');
  const action = readAction(req.action);
  if (!action) return verdict('unclear', 'the request is not one exact file action');
  const target = action.resource.path;
  if ((ctx.deny ?? []).some(d => { try { return covers(normPath(d), target); } catch { return false; } })) return verdict('forbidden', 'explicitly denied');

  const st = standing(req.grant, ctx, readGrant);
  if ('v' in st) return st.v;
  const p = st.p;

  let granted: string;
  try { granted = normPath(p.resource.path); } catch { return verdict('forbidden', 'no valid grant'); }
  if (p.operation !== action.operation || !covers(granted, target)) return verdict('outside-scope', 'not the granted resource or operation');
  if (action.operation === 'write' && Buffer.byteLength(action.args.text!) > p.args.maxBytes!) return verdict('outside-scope', 'exceeds the granted size');

  return ready(p, ctx);
}

function ready(p: GrantBase, ctx: PermissionContext): Verdict {
  const open = p.prerequisites.filter(x => !ctx.met.has(x));
  return open.length ? verdict('unready', `prerequisite not met: ${open.join(', ')}`) : verdict('authorized', 'covered by a valid grant');
}

/** Seal, project, revocation, policy generation and validity window - the same for every grant kind. */
function standing<P extends GrantBase>(g: RecordEnvelope | null, ctx: PermissionContext, read: (v: unknown) => P | null): { p: P } | { v: Verdict } {
  if (!g || g.kind !== GRANT_KIND || g.projectId !== ctx.projectId || !verifySeal(g, ctx.grantKeyPem)) return { v: verdict('forbidden', 'no valid grant') };
  const p = read(g.payload);
  if (!p) return { v: verdict('forbidden', 'no valid grant') };
  if (ctx.revoked.has(p.grantId)) return { v: verdict('forbidden', 'grant revoked') };
  if (p.policyGeneration !== ctx.policyGeneration) return { v: verdict('forbidden', 'grant predates the current policy') };
  if (ctx.now < p.notBefore) return { v: verdict('forbidden', 'grant not yet valid') };
  if (ctx.now >= p.expiresAt) return { v: verdict('forbidden', 'grant expired') };
  return { p };
}

/** T25: may the worker start exactly this process? The grant names one argv; any other argv is outside it. */
export function decideExec(req: { source: RequestSource; argv: unknown; grant: RecordEnvelope | null }, ctx: PermissionContext): Verdict {
  if (req.source !== 'worker-proposal' && req.source !== 'tool-text') return verdict('unclear', 'unknown request source');
  if (req.source === 'tool-text') return verdict('forbidden', 'text a tool returned carries no authority');
  const argv = readArgv(req.argv);
  if (!argv) return verdict('unclear', 'the request is not one exact process (a bare program name and plain arguments)');
  const st = standing(req.grant, ctx, readExecGrant);
  if ('v' in st) return st.v;
  const granted = st.p.resource.argv;
  if (granted.length !== argv.length || granted.some((x, i) => x !== argv[i])) return verdict('outside-scope', 'not the granted process');
  return ready(st.p, ctx);
}

/** The only code that touches the filesystem; it acts on nothing but an `authorized` verdict for this action. */
export function runFileAction(root: string, action: FileAction, v: Verdict): string | void {
  if (v.decision !== 'authorized') throw new Error(`refused: ${v.decision}`);
  const real = fs.realpathSync(root);
  const target = path.resolve(real, ...normPath(action.resource.path).split('/'));
  // A symlinked parent must not lead out of the root (checked on the parent, which must already exist).
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== real && !parent.startsWith(real + path.sep)) throw new Error('refused: path leaves the project root');
  const file = path.join(parent, path.basename(target));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('refused: target is a symbolic link');
  // ponytail: paths are case-folded (Windows reference scope); a case-sensitive filesystem needs the original spelling kept.
  if (action.operation === 'read') return fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, action.args.text!);
}
