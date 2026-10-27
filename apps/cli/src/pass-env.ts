import { passEnvNameProblem } from '@amabie/support';
import { openSealed, projectIdForRoot, sealRecord, storeFromEnv, type TrustStore } from './trust-store.js';

/**
 * The variable NAMES a human allowed checks to receive (`amabie setup --pass-env NAME`), kept in the
 * USER trust store beside the other sealed records, not in the repo-writable `.amabie` config: a
 * worker that could add a name could pull any variable of the operator's (an API token) into a test it
 * wrote. Only names are stored. Values are read from the operator's process when a check runs and are
 * never written to the config, the trust store, the evidence or the output.
 *
 * Honest boundary (LOCAL): the store is owned by the same user as the agent; this stops an edit that is
 * not a valid sealed write, not a worker that deliberately rewrites the user's trust store.
 */
const KIND = 'pass-env';
const VERSION = 'amabie-pass-env/1';

function namesOf(payload: unknown): string[] | null {
  const p = payload as { schema?: unknown; names?: unknown } | null;
  if (!p || p.schema !== VERSION || !Array.isArray(p.names)) return null;
  return p.names.every((n) => typeof n === 'string' && passEnvNameProblem(n) === null) ? (p.names as string[]) : null;
}

/** The sealed names, or [] when none were ever authorized or the record cannot be trusted (fail closed: nothing passes). */
export function sealedPassEnvNames(root: string, store: TrustStore = storeFromEnv()): string[] {
  try {
    const opened = openSealed(store, { projectId: projectIdForRoot(root), kind: KIND });
    return opened.status === 'valid' && opened.envelope ? (namesOf(opened.envelope.payload) ?? []) : [];
  } catch { return []; }
}

/** Replace the project's sealed name set. Throws when the store refuses (setup reports that). */
export function sealPassEnvNames(root: string, names: readonly string[], store: TrustStore = storeFromEnv()): void {
  const projectId = projectIdForRoot(root);
  const opened = openSealed(store, { projectId, kind: KIND });
  const expectedSeq = opened.status === 'valid' && opened.envelope ? opened.envelope.seq : 0;
  sealRecord(store, { projectId, kind: KIND, amabieVersion: VERSION, payload: { schema: VERSION, names: [...new Set(names)].sort() } }, expectedSeq);
}

/**
 * The sealed variables that are set in `env` right now, for the child's environment. A sealed name
 * that is not set here is simply absent (the check then fails or skips on its own terms).
 */
export function passEnvValues(root: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of sealedPassEnvNames(root)) {
    const actual = name in env || process.platform !== 'win32' ? name : Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    const value = actual === undefined ? undefined : env[actual];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) out[name] = value;
  }
  return out;
}
