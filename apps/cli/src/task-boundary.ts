import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { candidateDiffSignals, isAmabieOwnArtifact } from './change-signals.js';
import { openSealed, projectIdForRoot, sealRecord, storeFromEnv, type TrustStore } from './trust-store.js';

/**
 * Where a request may start its own accounting.
 *
 * A request is judged on what changed since it began (not since `amabie setup`) ONLY when the project
 * at that moment is exactly a state Amabie itself either sealed or let through. Two facts qualify:
 *   1. nothing differs from the sealed baseline, or
 *   2. the content of everything that differs equals what the last Stop that did NOT block verified.
 * "The tree is clean and the agent committed it" is neither: a commit is not acceptance. A request
 * that ended blocked, unproven, or released after one repair attempt records nothing, so the next
 * request inherits that work and is judged from the sealed baseline again.
 *
 * Both facts live in the USER trust store, beside the open-session record, never under `.amabie`: the
 * repository (and the per-request state in it) is writable by the agent, and a boundary the agent
 * could move would be approval it gave itself. LOCAL boundary: a worker that deliberately rewrites the
 * user's trust store is outside what LOCAL claims to resist.
 */
const KIND = 'task-boundary';
const VERSION = 'amabie-task-boundary/1';
const ATTEMPTS = 3;
/** More changed files than this and no boundary is claimed: the request is judged from the baseline. */
const MAX_FILES = 5000;
/** Boundaries kept per project; losing one only means that session is judged from the baseline. */
const MAX_STARTS = 256;

interface Payload { schema: typeof VERSION; verified: string | null; starts: Record<string, string> }

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

function payloadOf(raw: unknown): Payload | null {
  const p = raw as { schema?: unknown; verified?: unknown; starts?: unknown } | null;
  if (!p || p.schema !== VERSION || !(p.verified === null || typeof p.verified === 'string')
    || !p.starts || typeof p.starts !== 'object' || Array.isArray(p.starts)) return null;
  const starts: Record<string, string> = {};
  for (const [session, head] of Object.entries(p.starts)) {
    if (!/^[0-9a-f]{64}$/.test(session) || typeof head !== 'string' || !/^[0-9a-f]{40,64}$/i.test(head)) return null;
    starts[session] = head;
  }
  return { schema: VERSION, verified: p.verified, starts };
}

function read(root: string, store: TrustStore): Payload | null {
  const opened = openSealed(store, { projectId: projectIdForRoot(root), kind: KIND });
  return opened.status === 'valid' && opened.envelope ? payloadOf(opened.envelope.payload) : null;
}

/** Read-modify-write of the project's record; false when it cannot be read or sealed (never a boundary). */
function update(root: string, store: TrustStore, change: (p: Payload) => void): boolean {
  const projectId = projectIdForRoot(root);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const opened = openSealed(store, { projectId, kind: KIND });
    let payload: Payload = { schema: VERSION, verified: null, starts: {} };
    let expectedSeq = 0;
    if (opened.status === 'valid' && opened.envelope) {
      const current = payloadOf(opened.envelope.payload);
      if (current === null) return false;
      payload = current;
      expectedSeq = opened.envelope.seq;
    } else if (opened.status !== 'missing' && !(opened.status === 'unavailable' && /has no verification key/.test(opened.reason))) return false;
    change(payload);
    try {
      sealRecord(store, { projectId, kind: KIND, amabieVersion: VERSION, payload }, expectedSeq);
      return true;
    } catch { /* a concurrent writer moved the sequence; re-read and retry, then give up */ }
  }
  return false;
}

/**
 * A digest of everything the project differs by from the sealed baseline: which files, and their bytes
 * as they are on disk now. A commit does not change it, so "verified, then committed" is recognisable;
 * any edit, addition, deletion or rewrite after the verdict is not. null when it cannot be established.
 */
export function projectDigest(root: string, baselineHead: string): { digest: string; empty: boolean } | null {
  const signals = candidateDiffSignals(root, baselineHead);
  if (!signals.resolved) return null;
  const files = signals.touched.filter((p) => !isAmabieOwnArtifact(p)).sort();
  if (files.length > MAX_FILES) return null;
  const hash = crypto.createHash('sha256').update(`${VERSION}\0${baselineHead}\0`);
  for (const file of files) {
    let body: string;
    try {
      const full = path.join(root, file);
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      body = stat === undefined ? 'absent'
        : stat.isSymbolicLink() ? `link:${fs.readlinkSync(full)}`
          : stat.isFile() ? `file:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
            : 'other';
    } catch { return null; }
    hash.update(`${file}\0${body}\0`);
  }
  return { digest: hash.digest('hex'), empty: files.length === 0 };
}

/** A Stop that did not block: the project's present content is now the verified one. */
export function recordVerified(root: string, baselineHead: string, store: TrustStore = storeFromEnv()): boolean {
  const now = projectDigest(root, baselineHead);
  return now !== null && update(root, store, (p) => { p.verified = now.digest; });
}

/**
 * A request is starting. `startHead` is HEAD when the tree and index match it, null when they do not.
 * Records the boundary only when the project is the sealed baseline or the last verified state;
 * otherwise clears this session's boundary, so a stale one can never be used. Returns whether a
 * boundary now exists.
 */
export function openRequest(root: string, baselineHead: string, sessionId: string, startHead: string | null, store: TrustStore = storeFromEnv()): boolean {
  const now = projectDigest(root, baselineHead);
  const session = sha(sessionId);
  let trusted = false;
  const written = update(root, store, (p) => {
    trusted = startHead !== null && now !== null && (now.empty || now.digest === p.verified);
    if (!trusted || startHead === null) { delete p.starts[session]; return; }
    p.starts[session] = startHead;
    const keys = Object.keys(p.starts);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STARTS))) delete p.starts[key];
  });
  return written && trusted;
}

/** The start of this session's current request, only if Amabie recorded it as a trusted boundary. */
export function trustedStart(root: string, sessionId: string, store: TrustStore = storeFromEnv()): string | undefined {
  return read(root, store)?.starts[sha(sessionId)];
}
