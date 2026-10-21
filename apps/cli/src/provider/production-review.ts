/**
 * T27 — independent review authority for a stopped run (decision D03).
 *
 * T26 stops a run for good after an unauthorized attempt. Only a REVIEW can let work continue, and then only as
 * a NEW run that references the history; the stopped run stays stopped and a later correct result never lifts it.
 *
 * The reviewer is a second key, distinct from the store's `producer.key`:
 *   - the store keeps only `reviewer.pub`; the private key lives with the reviewer, outside the store and the
 *     work area, so neither the worker nor the producer can sign a review (a producer-signed receipt is refused);
 *   - a review is a signed `incident-review` record bound to the exact incident, the grants on disk, and the live
 *     subject (snapshot / task / policy bytes). Any change makes it stale; it is single-use (the journal spends it);
 *   - the signed claim is never trusted for the objective: the controller supplies the LIVE objective results and
 *     an unmet or empty mandatory check refuses the continuation (a review cannot waive an objective failure).
 *
 * `continueStoppedRun` is controller-side. It is deliberately not a worker tool and not a `provider` verb.
 * Honest limits (LOCAL): a signature proves which key signed, not that a human did; the live evidence is supplied by
 * the trusted caller; a same-user process that can write the store could replace `reviewer.pub` before enrollment.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_SCHEMA, authorityJson, isEnvelope, signedBytes, verifySeal, type RecordEnvelope } from '../authority-envelope.js';
import { continueRun, readAudit } from './production-audit.js';

export const REVIEW_KIND = 'incident-review';
export interface ReviewPayload {
  run: string;
  /** sha256 of the stopped run id and its recorded incident */
  incident: string;
  /** sha256 of the grant policy and grant files the continued run would work under */
  grants: string;
  /** sha256 of the live subject (snapshot, task, policy bytes) the reviewer looked at */
  subject: string;
  /** ids of the mandatory checks the reviewer relied on */
  objective: string[];
  decision: 'continue-with-new-run';
  expiresAt: number;
}
export interface LiveEvidence { subject: string; objective: Array<{ id: string; met: boolean }> }

const sha = (text: string | Buffer): string => crypto.createHash('sha256').update(text).digest('hex');
const reviewerPub = (store: string): string => path.join(store, 'reviewer.pub');
const publicDer = (pem: string): Buffer => crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;

export const subjectDigest = (parts: Record<string, string>): string => sha(authorityJson(parts));

export function incidentDigest(store: string, run: string): string {
  const why = readAudit(store).state.stopped.get(run);
  if (why === undefined) throw new Error('the run has no recorded incident');
  return sha(`${run}\n${why}`);
}

export function grantsDigest(store: string): string {
  const dir = path.join(store, 'grants');
  const files = fs.readdirSync(dir).filter(f => f === 'policy.json' || /^grant-\d+\.json$/.test(f)).sort();
  return sha(files.map(f => `${f}\n${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\n'));
}

/** A fresh reviewer key pair. The caller keeps `privateKey` away from the store and the work area. */
export function newReviewerKey(): { publicKey: string; privateKey: string } {
  const k = crypto.generateKeyPairSync('ed25519');
  return { publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** Controller-only, once per store: record the PUBLIC reviewer key. It must be a different key than the producer's. */
export function enrollReviewer(store: string, publicKeyPem: string): void {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the reviewer key must be Ed25519');
  if (publicDer(publicKeyPem).equals(publicDer(fs.readFileSync(path.join(store, 'producer.pub'), 'utf8')))) throw new Error('review and production require distinct keys');
  fs.writeFileSync(reviewerPub(store), publicKeyPem, { flag: 'wx' });
}

/** Reviewer-side. Signed with the reviewer's own key, never with a key the store holds. */
export function issueReview(p: ReviewPayload, seq: number, projectId: string, reviewerPrivateKeyPem: string): RecordEnvelope {
  const body = { schema: RECORD_SCHEMA, projectId, kind: REVIEW_KIND, seq, issuedAt: new Date().toISOString(), amabieVersion: '2', payload: p };
  return { ...body, signature: crypto.sign(null, signedBytes(body), crypto.createPrivateKey(reviewerPrivateKeyPem)).toString('base64') };
}

const PAYLOAD_FIELDS = 'decision,expiresAt,grants,incident,objective,run,subject';

/**
 * Controller-only: accept an independent review and let a NEW run take over from the stopped one. Returns the new
 * run id. Throws (and changes nothing) for a forged, foreign, replayed, expired or stale review, and whenever a
 * mandatory objective check is unmet or missing.
 */
export function continueStoppedRun(store: string, projectId: string, receipt: unknown, live: LiveEvidence, now = Date.now()): string {
  let pub: string;
  try { pub = fs.readFileSync(reviewerPub(store), 'utf8'); } catch { throw new Error('no reviewer is enrolled for this store'); }
  if (!isEnvelope(receipt) || receipt.kind !== REVIEW_KIND || receipt.projectId !== projectId) throw new Error('not a review for this project');
  if (!verifySeal(receipt, pub)) throw new Error('the review is not signed by the enrolled reviewer');
  const p = receipt.payload as ReviewPayload;
  if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== PAYLOAD_FIELDS) throw new Error('the review payload is malformed');
  if (p.decision !== 'continue-with-new-run' || typeof p.run !== 'string' || !Number.isSafeInteger(p.expiresAt) || !Array.isArray(p.objective) || !p.objective.every(x => typeof x === 'string')) throw new Error('the review payload is malformed');
  if (now >= p.expiresAt) throw new Error('the review has expired');
  if (p.incident !== incidentDigest(store, p.run)) throw new Error('the review does not match the recorded incident');
  if (p.grants !== grantsDigest(store)) throw new Error('stale review: the grants changed since it was issued');
  if (p.subject !== live.subject) throw new Error('stale review: the snapshot, task or policy changed since it was issued');
  // The objective comes from live evidence, never from what the signer claims; subjective review cannot waive it.
  if (!live.objective.length || live.objective.some(o => o.met !== true)) throw new Error('an objective check is red or missing; a review cannot waive it');
  const seen = new Set(live.objective.map(o => o.id));
  if (!p.objective.length || p.objective.some(id => !seen.has(id))) throw new Error('the reviewed objective checks are not part of the live evidence');
  return continueRun(store, p.run, receipt); // the journal keeps the receipt and spends its digest: a replay is refused
}
