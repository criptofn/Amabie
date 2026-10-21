/**
 * T15 — a small transactional journal for ONE mission (order, revisions, attempts, state).
 *
 * Storage decision (routine, per handoff: "SQLite is a possible implementation, not a decided one"):
 * an append-only JSONL file, stdlib only. Each line is `<sha256> <body>`; body carries `seq`, the previous
 * line's checksum, the events of ONE transaction and the state projection AFTER them.
 *   - a transaction is one line, so a crash between two transitions leaves all of them or none;
 *   - a torn final line (no newline) is discarded: the previous consistent state is the truth;
 *   - a damaged line anywhere else, a broken chain, or a projection that is not what the events produce
 *     is BLOCKED — never repaired and never defaulted;
 *   - the projection is always rebuilt from the events; nothing is approved unless an `approve` event says so.
 *
 * LOCAL custody only: a same-UID worker can rewrite this file and its chain. Protecting the file is the
 * trust boundary's job (see trust-store.ts); this module makes accidents and interruptions detectable.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type MissionStatus = 'none' | 'approved' | 'working' | 'verifying' | 'done' | 'blocked';
export interface MissionState {
  mission: string | null;
  revision: number;
  goal: string | null;
  status: MissionStatus;
  attemptsUsed: number;
  attemptLimit: number;
  approvedBy: string | null;
}
export type MissionEvent =
  | { type: 'approve'; mission: string; goal: string; approvedBy: string; attemptLimit?: number }
  | { type: 'revise'; goal: string; approvedBy: string }
  | { type: 'attempt'; note?: string }
  | { type: 'transition'; to: MissionStatus };

export const DEFAULT_ATTEMPT_LIMIT = 3;
const NEXT: Record<MissionStatus, MissionStatus[]> = {
  none: [], approved: ['working', 'blocked'], working: ['verifying', 'blocked'],
  verifying: ['done', 'working', 'blocked'], done: [], blocked: [],
};
export const emptyState = (): MissionState => ({ mission: null, revision: 0, goal: null, status: 'none', attemptsUsed: 0, attemptLimit: DEFAULT_ATTEMPT_LIMIT, approvedBy: null });

/** Pure reducer. Throws on any event the current state does not allow. */
export function reduce(state: MissionState, event: MissionEvent): MissionState {
  const s = { ...state };
  switch (event.type) {
    case 'approve':
      if (s.status !== 'none') throw new Error('a mission is already approved');
      if (!event.mission || !event.goal || !event.approvedBy) throw new Error('approval needs mission, goal and approver');
      return { ...s, mission: event.mission, goal: event.goal, approvedBy: event.approvedBy, revision: 1, status: 'approved', attemptLimit: event.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT };
    case 'revise':
      if (s.status === 'none' || s.status === 'done' || s.status === 'blocked') throw new Error(`cannot revise a mission in status ${s.status}`);
      if (!event.goal || !event.approvedBy) throw new Error('a revision needs the new goal and its approver');
      // A revision changes the order; consumed attempts stay consumed.
      return { ...s, goal: event.goal, approvedBy: event.approvedBy, revision: s.revision + 1, status: 'approved' };
    case 'attempt':
      if (s.status !== 'working') throw new Error(`an attempt needs status working, not ${s.status}`);
      if (s.attemptsUsed >= s.attemptLimit) throw new Error(`attempt limit ${s.attemptLimit} is used up`);
      return { ...s, attemptsUsed: s.attemptsUsed + 1 };
    case 'transition':
      if (!NEXT[s.status].includes(event.to)) throw new Error(`transition ${s.status} -> ${event.to} is not allowed`);
      return { ...s, status: event.to };
    default: throw new Error('unknown mission event');
  }
}
export const project = (events: MissionEvent[]): MissionState => events.reduce(reduce, emptyState());

export interface JournalRead {
  /** 'blocked' = the journal cannot be trusted; state is then unusable and `reason` says why. */
  status: 'ok' | 'blocked';
  reason: string;
  state: MissionState;
  seq: number;
  /** Byte length of the last consistent prefix; a torn tail starts here. */
  goodBytes: number;
  tornTail: boolean;
  lastSum: string;
}
export const journalPath = (dir: string): string => path.join(dir, 'journal.jsonl');
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const blocked = (reason: string): JournalRead => ({ status: 'blocked', reason, state: emptyState(), seq: 0, goodBytes: 0, tornTail: false, lastSum: '' });

export function readJournal(dir: string): JournalRead {
  let raw: string;
  try { raw = fs.readFileSync(journalPath(dir), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ok', reason: 'no journal yet', state: emptyState(), seq: 0, goodBytes: 0, tornTail: false, lastSum: '' }; return blocked(`journal unreadable: ${(e as Error).message}`); }
  const lines = raw.split('\n');
  const tail = lines.pop() ?? ''; // text after the last newline: empty, or a torn append
  let state = emptyState(), prev = '', seq = 0, good = 0;
  for (const [i, line] of lines.entries()) {
    const at = `journal line ${i + 1}`;
    const cut = line.indexOf(' ');
    const body = line.slice(cut + 1);
    if (cut !== 64 || sha(body) !== line.slice(0, 64)) return blocked(`${at}: checksum mismatch — the journal was damaged or edited`);
    let rec: { seq: number; prev: string; events: MissionEvent[]; projection: MissionState };
    try { rec = JSON.parse(body); } catch { return blocked(`${at}: not valid JSON`); }
    if (rec.seq !== seq + 1 || rec.prev !== prev) return blocked(`${at}: sequence or chain broken`);
    try { for (const ev of rec.events) state = reduce(state, ev); }
    catch (e) { return blocked(`${at}: events are not a legal transition (${(e as Error).message})`); }
    if (JSON.stringify(rec.projection) !== JSON.stringify(state)) return blocked(`${at}: stored projection differs from what the events produce`);
    seq = rec.seq; prev = line.slice(0, 64); good += Buffer.byteLength(line) + 1;
  }
  return { status: 'ok', reason: tail ? 'torn final record discarded' : 'ok', state, seq, goodBytes: good, tornTail: tail !== '', lastSum: prev };
}

const LOCK_WAIT_MS = 5000;
function withLock<T>(dir: string, action: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'journal.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A dead holder's lock is stale; a live one is waited for, never stolen.
      let holder = NaN;
      try { holder = Number(fs.readFileSync(lock, 'utf8')); } catch { continue; }
      let alive = true;
      try { process.kill(holder, 0); } catch (k) { alive = (k as NodeJS.ErrnoException).code === 'EPERM'; }
      if (!alive) { try { fs.unlinkSync(lock); } catch { /* another process took it first */ } continue; }
      if (Date.now() > deadline) throw new Error(`mission journal is busy (held by pid ${holder})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
}

/**
 * Append ONE transaction (all events or none). `expectedSeq` is a compare-and-append guard: a writer that
 * read an older journal is refused instead of silently overwriting a newer state. Returns the new state.
 */
export function transact(dir: string, events: MissionEvent[], expectedSeq?: number): MissionState {
  if (events.length === 0) throw new Error('an empty transaction');
  return withLock(dir, () => {
    const cur = readJournal(dir);
    if (cur.status === 'blocked') throw new Error(`mission journal is blocked: ${cur.reason}`);
    if (expectedSeq !== undefined && expectedSeq !== cur.seq) throw new Error(`journal moved: expected seq ${expectedSeq}, found ${cur.seq}`);
    const state = events.reduce(reduce, cur.state); // throws before anything is written
    const body = JSON.stringify({ seq: cur.seq + 1, prev: cur.lastSum, events, projection: state });
    if (cur.tornTail) fs.truncateSync(journalPath(dir), cur.goodBytes); // drop the torn tail before appending after it
    const fd = fs.openSync(journalPath(dir), 'a');
    try {
      fs.writeSync(fd, `${sha(body)} ${body}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return state;
  });
}
