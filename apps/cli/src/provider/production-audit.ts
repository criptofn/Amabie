/**
 * T26 — durable audit, replay protection and fail-stop for the confined tool route (decision D03).
 *
 * `productionTool` records its INTENT here before the confined process is launched, and the outcome after.
 * Three things follow from one append-only journal (`<store>/audit/journal.jsonl`, the mission-journal format:
 * one `<sha256> <body>` line per transaction, chained, fsync'd, torn tail discarded, damage => BLOCKED):
 *
 *   fail-stop   an actual attempt outside the contract (a gate refusal that is not merely `unready`) is blocked
 *               before any effect AND stops the run. The stop is a fact in the journal, so it survives restart,
 *               a new context and a different agent. A later correct request does not lift it; only a reviewed
 *               continuation (T27) can. Proposals and `unready` refusals are logged but never stop.
 *   replay      an operation id is never fresh again; a restart cannot re-use one.
 *   unknown     an intent without an outcome means "a launch may have had an effect". The run refuses further
 *               calls until the controller reconciles it. Nothing is invented (no assumed success) and nothing is
 *               blindly repeated. `reconcile` also works on a stopped run: clarifying effects is not continuing.
 *
 * A run is the canonical workspace under one enrollment, so it is the same run across restarts and agents.
 * If the audit cannot be read or written the call is refused (fail closed); a stop that could not be persisted is
 * still held in memory for the life of the process.
 *
 * LOCAL custody only: a same-user process that can write the store could rewrite this journal. The audit is
 * opt-in per store, exactly like the grant regime (`regimeOpen`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from '../mission-journal.js';
import { GateRefusal } from './production-grants.js';

export type Effect = 'completed' | 'none';
export type Clarified = 'effect-observed' | 'no-effect-observed' | 'unknown-accepted';
export type AuditEvent =
  | { t: 'intent'; op: string; run: string; digest: string; at: string }
  | { t: 'done'; op: string; effect: Effect; at: string }
  | { t: 'reconciled'; op: string; how: Clarified; note: string; at: string }
  | { t: 'refused'; run: string; why: string; at: string }
  | { t: 'stop'; run: string; why: string; at: string };

export interface AuditState { ops: Map<string, string>; pending: Map<string, string>; stopped: Map<string, string> }
export interface AuditRead { status: 'ok' | 'blocked'; reason: string; state: AuditState; seq: number; goodBytes: number; tornTail: boolean; lastSum: string }

const emptyState = (): AuditState => ({ ops: new Map(), pending: new Map(), stopped: new Map() });
const copy = (s: AuditState): AuditState => ({ ops: new Map(s.ops), pending: new Map(s.pending), stopped: new Map(s.stopped) });
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const nonEmpty = (...v: unknown[]): boolean => v.every(x => typeof x === 'string' && x !== '');
const auditDir = (store: string): string => path.join(store, 'audit');
const auditFile = (store: string): string => path.join(auditDir(store), 'journal.jsonl');
const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const now = (): string => new Date().toISOString();
const CLARIFIED: Clarified[] = ['effect-observed', 'no-effect-observed', 'unknown-accepted'];

/** A pure transition. Throws on anything illegal, so a replayed or forged event can never be applied twice. */
function apply(s: AuditState, ev: AuditEvent): void {
  switch (ev?.t) {
    case 'intent':
      if (!nonEmpty(ev.op, ev.run, ev.digest, ev.at) || s.ops.has(ev.op)) throw new Error('intent: malformed or operation id reused');
      s.ops.set(ev.op, ev.run); s.pending.set(ev.op, ev.run); return;
    case 'done':
      if (!nonEmpty(ev.op, ev.at) || (ev.effect !== 'completed' && ev.effect !== 'none') || !s.pending.delete(ev.op)) throw new Error('done: no pending operation');
      return;
    case 'reconciled':
      if (!nonEmpty(ev.op, ev.at) || typeof ev.note !== 'string' || !CLARIFIED.includes(ev.how) || !s.pending.delete(ev.op)) throw new Error('reconciled: no pending operation');
      return;
    case 'refused':
      if (!nonEmpty(ev.run, ev.at) || typeof ev.why !== 'string') throw new Error('refused: malformed');
      return;
    case 'stop':
      if (!nonEmpty(ev.run, ev.at) || typeof ev.why !== 'string') throw new Error('stop: malformed');
      if (!s.stopped.has(ev.run)) s.stopped.set(ev.run, ev.why); // the FIRST incident stays the incident
      return;
    default: throw new Error('unknown audit event');
  }
}

const blocked = (reason: string): AuditRead => ({ status: 'blocked', reason, state: emptyState(), seq: 0, goodBytes: 0, tornTail: false, lastSum: '' });

export function readAudit(store: string): AuditRead {
  let raw: string;
  try { raw = fs.readFileSync(auditFile(store), 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ok', reason: 'no audit yet', state: emptyState(), seq: 0, goodBytes: 0, tornTail: false, lastSum: '' };
    return blocked(`audit unreadable: ${(e as Error).message}`);
  }
  const lines = raw.split('\n');
  const tail = lines.pop() ?? ''; // after the last newline: empty, or a torn append
  const state = emptyState();
  let prev = '', seq = 0, good = 0;
  for (const [i, line] of lines.entries()) {
    const at = `audit line ${i + 1}`;
    const cut = line.indexOf(' ');
    const body = line.slice(cut + 1);
    if (cut !== 64 || sha(body) !== line.slice(0, 64)) return blocked(`${at}: checksum mismatch - the audit was damaged or edited`);
    let rec: { seq: number; prev: string; events: AuditEvent[] };
    try { rec = JSON.parse(body); } catch { return blocked(`${at}: not valid JSON`); }
    if (rec.seq !== seq + 1 || rec.prev !== prev || !Array.isArray(rec.events)) return blocked(`${at}: sequence or chain broken`);
    try { for (const ev of rec.events) apply(state, ev); }
    catch (e) { return blocked(`${at}: events are not a legal transition (${(e as Error).message})`); }
    seq = rec.seq; prev = line.slice(0, 64); good += Buffer.byteLength(line) + 1;
  }
  return { status: 'ok', reason: tail ? 'torn final record discarded' : 'ok', state, seq, goodBytes: good, tornTail: tail !== '', lastSum: prev };
}

/** One transaction under the lock: read, decide from the CURRENT state, validate, append, fsync. */
function tx(store: string, build: (s: AuditState) => AuditEvent[]): void {
  withLock(auditDir(store), () => {
    const cur = readAudit(store);
    if (cur.status === 'blocked') throw new Error(`audit journal is blocked: ${cur.reason}`);
    const events = build(cur.state);
    if (!events.length) return;
    const next = copy(cur.state);
    for (const ev of events) apply(next, ev); // throws before anything is written
    const body = JSON.stringify({ seq: cur.seq + 1, prev: cur.lastSum, events });
    if (cur.tornTail) fs.truncateSync(auditFile(store), cur.goodBytes);
    const fd = fs.openSync(auditFile(store), 'a');
    try { fs.writeSync(fd, `${sha(body)} ${body}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
}

/** The run a workspace belongs to: stable across restart, context change and agent change. */
export const runId = (canonicalWorkLower: string): string => sha(canonicalWorkLower).slice(0, 16);

// ponytail: a stop that could not be written to disk is still enforced, but only until this process ends.
const heldStopped = new Set<string>();
const held = (store: string, run: string): string => `${path.resolve(store).toLowerCase()}|${run}`;

/** Record the intent BEFORE the effect. Throws (and logs the refusal) when the run is stopped or an earlier effect is unknown. */
export function admit(store: string, run: string, op: string, digest: string): void {
  let refusal = '';
  if (heldStopped.has(held(store, run))) refusal = 'the run was stopped by an earlier unauthorized attempt; independent review is required';
  tx(store, s => {
    if (!refusal && s.stopped.has(run)) refusal = `the run was stopped (${s.stopped.get(run)}); independent review is required`;
    if (!refusal) {
      const open = [...s.pending].filter(([, r]) => r === run).map(([o]) => o);
      if (open.length) refusal = `an earlier operation has an unknown effect (${open[0]}); reconcile it first`;
    }
    return refusal ? [{ t: 'refused', run, why: clip(refusal), at: now() }] : [{ t: 'intent', op, run, digest, at: now() }];
  });
  if (refusal) throw new Error(`audit refused: ${refusal}`);
}

/** Record the outcome. A failure here propagates: the intent stays pending (unknown) rather than invent a completion. */
export function complete(store: string, op: string, effect: Effect): void {
  tx(store, () => [{ t: 'done', op, effect, at: now() }]);
}

/**
 * A call the gate refused. A real attempt (anything but `unready`) stops the run. Never throws: the call is
 * refused either way, and a failure to persist is covered by the in-memory stop.
 */
export function noteRefusal(store: string, run: string, err: unknown): void {
  const why = clip(err instanceof Error ? err.message : String(err));
  const stop = err instanceof GateRefusal && !err.unready;
  if (stop) heldStopped.add(held(store, run));
  try { tx(store, () => [{ t: 'refused', run, why, at: now() }, ...(stop ? [{ t: 'stop' as const, run, why, at: now() }] : [])]); } catch { /* fail closed already: the call is refused */ }
}

/** Controller-only (not reachable from the worker tools): settle an operation whose effect is unknown. */
export function reconcile(store: string, op: string, how: Clarified, note: string): void {
  tx(store, () => [{ t: 'reconciled', op, how, note: clip(note), at: now() }]);
}
