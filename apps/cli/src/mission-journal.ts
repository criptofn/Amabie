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
import { execFileSync } from 'node:child_process';
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
  /** Sub-goals under the same approved mission; `stale` = a revision invalidated a result that was `done`. */
  subgoals: SubGoal[];
  /** Open duties carried by the mission (an earlier duty stays open until closed, whoever works next). */
  duties: { id: string; text: string; open: boolean }[];
  /** The ROOT goal was checked after the last change to sub-goals, duties or the order. */
  rootVerified: boolean;
  /** Agent currently responsible; a handover is an event, never an implicit reset. */
  agent: string | null;
  /** Leases on change areas for parallel workers (T17). `fence` numbers them; `clock` only ever moves forward. */
  assignments: Assignment[];
  fence: number;
  clock: number;
  /** Evidence ids this mission still depends on (T18); retention must not remove an open one. */
  evidence: { id: string; open: boolean }[];
}
export interface Assignment {
  id: string; worker: string; paths: string[]; baseHead: string;
  /** Fencing token: only the holder of the CURRENT token for this id may renew, rebase or release. */
  token: number; expiresAt: number;
  status: 'active' | 'released' | 'expired';
}
export interface SubGoal { id: string; goal: string; dependsOn: string[]; status: 'open' | 'done' | 'stale' }
export type MissionEvent =
  | { type: 'approve'; mission: string; goal: string; approvedBy: string; attemptLimit?: number }
  | { type: 'revise'; goal: string; approvedBy: string; keep?: string[] }
  | { type: 'subgoal'; id: string; goal: string; dependsOn?: string[] }
  | { type: 'subgoal-done'; id: string }
  | { type: 'duty'; id: string; text: string }
  | { type: 'duty-close'; id: string }
  | { type: 'root-verified' }
  | { type: 'handover'; to: string }
  | { type: 'assign'; id: string; worker: string; paths: string[]; baseHead: string; at: number; ttlMs: number }
  | { type: 'renew'; id: string; token: number; at: number; ttlMs: number }
  | { type: 'rebase'; id: string; token: number; baseHead: string; at: number }
  | { type: 'release'; id: string; token: number; at: number; changed: string[]; baseMoved: string[] }
  | { type: 'evidence'; id: string }
  | { type: 'evidence-release'; id: string }
  | { type: 'attempt'; note?: string }
  | { type: 'transition'; to: MissionStatus };

export const DEFAULT_ATTEMPT_LIMIT = 3;
const NEXT: Record<MissionStatus, MissionStatus[]> = {
  none: [], approved: ['working', 'blocked'], working: ['verifying', 'blocked'],
  verifying: ['done', 'working', 'blocked'], done: [], blocked: [],
};
export const emptyState = (): MissionState => ({ mission: null, revision: 0, goal: null, status: 'none', attemptsUsed: 0, attemptLimit: DEFAULT_ATTEMPT_LIMIT, approvedBy: null, subgoals: [], duties: [], rootVerified: false, agent: null, assignments: [], fence: 0, clock: 0, evidence: [] });
/** Evidence a live mission still depends on. A finished mission holds nothing back. */
export const openEvidence = (s: MissionState): Set<string> => new Set(s.status === 'done' ? [] : s.evidence.filter(e => e.open).map(e => e.id));

/** Repo-relative, forward-slash, lower-cased (a case-insensitive filesystem makes `Src` and `src` ONE resource). */
export function normPath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();
  if (!n || n === '.' || n.startsWith('/') || /^[a-z]:/.test(n) || n.split('/').some(x => x === '..' || x === '' || x === '.')) throw new Error(`not a repo-relative area: ${JSON.stringify(p)}`);
  return n;
}
const covers = (claim: string, p: string): boolean => p === claim || p.startsWith(`${claim}/`);
const overlaps = (a: string, b: string): boolean => covers(a, b) || covers(b, a);

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
      // A revision changes the order; consumed attempts stay consumed. Finished sub-goals stay `done` only
      // when the revision names them in `keep`; every other one becomes `stale` and must be redone.
      return { ...s, goal: event.goal, approvedBy: event.approvedBy, revision: s.revision + 1, status: 'approved', rootVerified: false,
        subgoals: s.subgoals.map(g => g.status === 'done' && !(event.keep ?? []).includes(g.id) ? { ...g, status: 'stale' as const } : g) };
    case 'subgoal':
      if (s.status === 'none' || s.status === 'done' || s.status === 'blocked') throw new Error(`cannot add a sub-goal in status ${s.status}`);
      if (!event.id || !event.goal) throw new Error('a sub-goal needs an id and a goal');
      if (s.subgoals.some(g => g.id === event.id)) throw new Error(`sub-goal ${event.id} already exists`);
      for (const d of event.dependsOn ?? []) if (!s.subgoals.some(g => g.id === d)) throw new Error(`sub-goal ${event.id} depends on unknown ${d}`);
      return { ...s, rootVerified: false, subgoals: [...s.subgoals, { id: event.id, goal: event.goal, dependsOn: event.dependsOn ?? [], status: 'open' }] };
    case 'subgoal-done': {
      const g = s.subgoals.find(x => x.id === event.id);
      if (s.status !== 'working' && s.status !== 'verifying') throw new Error(`a sub-goal cannot be finished in status ${s.status}`);
      if (!g) throw new Error(`unknown sub-goal ${event.id}`);
      const open = g.dependsOn.filter(d => s.subgoals.find(x => x.id === d)?.status !== 'done');
      if (open.length) throw new Error(`sub-goal ${g.id} still depends on ${open.join(', ')}`);
      return { ...s, subgoals: s.subgoals.map(x => x.id === g.id ? { ...x, status: 'done' as const } : x) };
    }
    case 'duty':
      if (s.status === 'none' || s.status === 'done') throw new Error(`cannot open a duty in status ${s.status}`);
      if (s.duties.some(d => d.id === event.id)) throw new Error(`duty ${event.id} already exists`);
      return { ...s, rootVerified: false, duties: [...s.duties, { id: event.id, text: event.text, open: true }] };
    case 'duty-close':
      if (!s.duties.some(d => d.id === event.id && d.open)) throw new Error(`no open duty ${event.id}`);
      return { ...s, duties: s.duties.map(d => d.id === event.id ? { ...d, open: false } : d) };
    case 'root-verified':
      // The root goal is checked as a whole — finishing the last worked sub-goal is not this check.
      if (s.status !== 'verifying') throw new Error(`the root goal is checked in status verifying, not ${s.status}`);
      return { ...s, rootVerified: true };
    case 'handover':
      if (!event.to) throw new Error('a handover names the receiving agent');
      if (s.status === 'none' || s.status === 'done') throw new Error(`nothing to hand over in status ${s.status}`);
      return { ...s, agent: event.to };
    case 'assign': {
      if (s.status !== 'working') throw new Error(`areas are assigned in status working, not ${s.status}`);
      if (!event.id || !event.worker || !event.baseHead || !(event.ttlMs > 0)) throw new Error('an assignment needs id, worker, base head and a positive ttl');
      if (s.assignments.some(a => a.id === event.id)) throw new Error(`assignment ${event.id} already exists`);
      const paths = event.paths.map(normPath);
      if (paths.length === 0) throw new Error('an assignment needs at least one area');
      const now = Math.max(s.clock, event.at);
      const assignments = s.assignments.map(a => {
        if (a.status !== 'active' || !a.paths.some(x => paths.some(y => overlaps(x, y)))) return a;
        // A lease past its expiry is lost: it is recorded as expired and its token can authorize nothing again.
        if (a.expiresAt < now) return { ...a, status: 'expired' as const };
        throw new Error(`area is held by ${a.worker} (assignment ${a.id}, ${a.paths.join(', ')}) until ${a.expiresAt}`);
      });
      const token = s.fence + 1;
      return { ...s, clock: now, fence: token, assignments: [...assignments, { id: event.id, worker: event.worker, paths, baseHead: event.baseHead, token, expiresAt: now + event.ttlMs, status: 'active' as const }] };
    }
    case 'renew': case 'rebase': case 'release': {
      const now = Math.max(s.clock, event.at);
      const a = s.assignments.find(x => x.id === event.id);
      if (!a) throw new Error(`unknown assignment ${event.id}`);
      if (a.status === 'released') throw new Error(`assignment ${a.id} is already released`);
      if (a.status === 'expired' || a.token !== event.token) throw new Error(`assignment ${a.id}: responsibility was lost (token ${event.token} is void)`);
      if (a.expiresAt < now) throw new Error(`assignment ${a.id}: the lease expired at ${a.expiresAt}; a lost responsibility cannot be used later`);
      const put = (n: Assignment): MissionState => ({ ...s, clock: now, assignments: s.assignments.map(x => x.id === a.id ? n : x) });
      if (event.type === 'renew') return put({ ...a, expiresAt: now + event.ttlMs });
      if (event.type === 'rebase') return put({ ...a, baseHead: event.baseHead });
      const changed = event.changed.map(normPath);
      const outside = changed.filter(c => !a.paths.some(x => covers(x, c)));
      if (outside.length) throw new Error(`assignment ${a.id}: changes outside the assigned area: ${outside.join(', ')}`);
      const moved = event.baseMoved.map(normPath).filter(m => [...a.paths, ...changed].some(x => overlaps(x, m)));
      if (moved.length) throw new Error(`assignment ${a.id}: the baseline moved under the assigned work: ${moved.join(', ')} — rebase first`);
      return put({ ...a, status: 'released' });
    }
    case 'evidence':
      if (s.status === 'none' || s.status === 'done') throw new Error(`cannot reference evidence in status ${s.status}`);
      if (!/^[0-9a-f]{64}$/.test(event.id)) throw new Error('evidence is referenced by its 64-hex id');
      if (s.evidence.some(e => e.id === event.id)) throw new Error(`evidence ${event.id.slice(0, 12)} is already referenced`);
      return { ...s, evidence: [...s.evidence, { id: event.id, open: true }] };
    case 'evidence-release':
      if (!s.evidence.some(e => e.id === event.id && e.open)) throw new Error(`no open evidence reference ${String(event.id).slice(0, 12)}`);
      return { ...s, evidence: s.evidence.map(e => e.id === event.id ? { ...e, open: false } : e) };
    case 'attempt':
      if (s.status !== 'working') throw new Error(`an attempt needs status working, not ${s.status}`);
      if (s.attemptsUsed >= s.attemptLimit) throw new Error(`attempt limit ${s.attemptLimit} is used up`);
      return { ...s, attemptsUsed: s.attemptsUsed + 1 };
    case 'transition':
      if (!NEXT[s.status].includes(event.to)) throw new Error(`transition ${s.status} -> ${event.to} is not allowed`);
      if (event.to === 'done') {
        const pending = [...s.subgoals.filter(g => g.status !== 'done').map(g => `sub-goal ${g.id} (${g.status})`), ...s.duties.filter(d => d.open).map(d => `duty ${d.id}`)];
        if (pending.length) throw new Error(`the mission is not done: ${pending.join(', ')}`);
        if (!s.rootVerified) throw new Error('the mission is not done: the root goal has not been verified since the last change');
      }
      return { ...s, status: event.to, rootVerified: event.to === 'verifying' ? s.rootVerified : false };
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
export function withLock<T>(dir: string, action: () => T): T {
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
      // 'wx' creates the file empty before the pid is written: an empty or unparsable lock is a holder mid-acquire,
      // not a dead one. Only an old such file (the holder died between create and write) may be stolen.
      if (!Number.isInteger(holder) || holder <= 0) {
        let old = false;
        try { old = Date.now() - fs.statSync(lock).mtimeMs > 2000; } catch { continue; }
        if (!old) { if (Date.now() > deadline) throw new Error('mission journal is busy (lock being acquired)'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; }
        try { fs.unlinkSync(lock); } catch { /* another process took it first */ }
        continue;
      }
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

const git = (cwd: string, args: string[]): string[] =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);

/** Everything the worker changed since `baseHead`: committed, staged, unstaged and untracked bytes alike. */
export function changedPaths(worktree: string, baseHead: string): string[] {
  return [...new Set([...git(worktree, ['diff', '--name-only', baseHead]), ...git(worktree, ['ls-files', '-o', '--exclude-standard'])])];
}

/** What other work put on the shared line since the worker's baseline (`baseHead`..`currentHead`). */
export function baselineMoves(worktree: string, baseHead: string, currentHead: string): string[] {
  return git(worktree, ['diff', '--name-only', `${baseHead}..${currentHead}`]);
}
