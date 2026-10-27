import crypto from 'node:crypto';
import { type OpenResult, openSealed, projectIdForRoot, sealRecord, storeFromEnv, type TrustStore } from './trust-store.js';

/**
 * Which agent sessions are open on a project, kept in the USER trust store beside the other sealed
 * records, not under the repository's `.amabie`.
 *
 * Why: the open-session marker used to live only in `.amabie/task/sessions`. A session that deleted
 * `.amabie` (any interpreter, not just a shell the textual hook guard reads), unset the agent
 * environment markers and ran `amabie setup --yes` found no session, so setup resealed the tree it had
 * just edited as READY. The record here survives that deletion, and a missing or damaged project
 * state at Stop can be recognised as tampering instead of "nothing wired here".
 *
 * Honest boundary (LOCAL): the store is owned by the same user as the agent. This stops the
 * deletion-plus-reseal bypass and any edit that is not a valid sealed write; a worker that deliberately
 * rewrites the user's trust store is outside what LOCAL claims to resist.
 */
const KIND = 'agent-sessions';
const VERSION = 'amabie-agent-sessions/1';
const MAX_SESSIONS = 256;
const ATTEMPTS = 3;

export type SessionRegistry =
  | { state: 'none' }
  | { state: 'active'; digests: string[] }
  | { state: 'unreadable'; reason: string };

const digestOf = (sessionId: string): string => crypto.createHash('sha256').update(sessionId).digest('hex');

function sessionsOf(payload: unknown): Record<string, string> | null {
  const p = payload as { schema?: unknown; sessions?: unknown } | null;
  if (!p || p.schema !== VERSION || !p.sessions || typeof p.sessions !== 'object' || Array.isArray(p.sessions)) return null;
  const out: Record<string, string> = {};
  for (const [digest, at] of Object.entries(p.sessions)) {
    if (!/^[0-9a-f]{64}$/.test(digest) || typeof at !== 'string') return null;
    out[digest] = at;
  }
  return out;
}

const isNeverUsed = (opened: OpenResult): boolean => opened.status === 'unavailable' && /has no verification key/.test(opened.reason);

export function readSessionRegistry(root: string, store: TrustStore = storeFromEnv()): SessionRegistry {
  const opened = openSealed(store, { projectId: projectIdForRoot(root), kind: KIND });
  // No record, or a store that has never held a key: nothing was ever registered for this project.
  // Any other unusable state (damaged ledger or key material) is NOT absence.
  if (opened.status === 'missing' || isNeverUsed(opened)) return { state: 'none' };
  if (opened.status !== 'valid' || !opened.envelope) return { state: 'unreadable', reason: opened.reason };
  const sessions = sessionsOf(opened.envelope.payload);
  if (sessions === null) return { state: 'unreadable', reason: 'the sealed session record has an unexpected shape' };
  const digests = Object.keys(sessions);
  return digests.length === 0 ? { state: 'none' } : { state: 'active', digests };
}

/** Rewrite the project's session set with `change`; false when the record cannot be read or sealed. */
function update(root: string, store: TrustStore, change: (sessions: Record<string, string>) => void): boolean {
  const projectId = projectIdForRoot(root);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const opened = openSealed(store, { projectId, kind: KIND });
    let sessions: Record<string, string> = {};
    let expectedSeq: number | undefined;
    if (opened.status === 'valid' && opened.envelope) {
      const current = sessionsOf(opened.envelope.payload);
      if (current === null) return false;
      sessions = current;
      expectedSeq = opened.envelope.seq;
    } else if (opened.status !== 'missing' && !isNeverUsed(opened)) return false;
    change(sessions);
    const newest = Object.entries(sessions).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_SESSIONS);
    try {
      sealRecord(store, { projectId, kind: KIND, amabieVersion: VERSION, payload: { schema: VERSION, sessions: Object.fromEntries(newest) } }, expectedSeq ?? 0);
      return true;
    } catch { /* a concurrent writer moved the sequence, or the store refused; re-read and retry, then give up */ }
  }
  return false;
}

export function registerAgentSession(root: string, sessionId: string, store: TrustStore = storeFromEnv()): boolean {
  return update(root, store, (sessions) => { sessions[digestOf(sessionId)] = new Date().toISOString(); });
}

export function unregisterAgentSession(root: string, sessionId: string, store: TrustStore = storeFromEnv()): boolean {
  const digest = digestOf(sessionId);
  const registry = readSessionRegistry(root, store);
  if (registry.state === 'none' || (registry.state === 'active' && !registry.digests.includes(digest))) return true;
  return update(root, store, (sessions) => { delete sessions[digest]; });
}

export function isAgentSessionRegistered(root: string, sessionId: string, store: TrustStore = storeFromEnv()): boolean {
  const registry = readSessionRegistry(root, store);
  return registry.state === 'active' && registry.digests.includes(digestOf(sessionId));
}
