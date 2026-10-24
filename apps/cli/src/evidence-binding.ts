/**
 * T18 — evidence is bound to the EXACT subject it was measured on, goes stale when anything it depends on
 * changes, and survives routine retention while an open mission still references it.
 *
 *   snapshotDigest   HEAD + tree + a digest of every uncommitted byte (changed, deleted and untracked files),
 *                    so the same HEAD with different dirty bytes is a different subject
 *   put / get        content-addressed entries; `get` re-derives the id and the payload digest, so a rewritten
 *                    file or binding is refused rather than trusted
 *   staleDimensions  task, oracle, policy, environment, subject and snapshot: a changed OR unknown dimension is stale
 *   retain           removes only unreferenced entries older than the age limit; an unreadable entry is kept
 *   purge            explicit deletion; refused while referenced unless forced
 *
 * Keep the store OUTSIDE the checked tree (an untracked store would change the very snapshot it describes).
 * LOCAL custody only: a same-UID worker can rewrite the store; `get` makes that detectable, not impossible.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DIMENSIONS = ['snapshot', 'task', 'oracle', 'policy', 'env', 'subject'] as const;
export type Dimension = typeof DIMENSIONS[number];
export type Binding = { kind: string } & Record<Dimension, string>;
export interface Entry { id: string; binding: Binding; payloadSha: string; at: number; payload: string }

const sha = (b: crypto.BinaryLike): string => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const names = (cwd: string, args: string[]): string[] => git(cwd, args).split('\0').filter(Boolean);

/** `<head>:<tree>:<digest of all uncommitted bytes>`; throws when the subject cannot be identified (no guessing). */
export function snapshotDigest(worktree: string): string {
  const head = git(worktree, ['rev-parse', 'HEAD']).trim();
  const tree = git(worktree, ['rev-parse', 'HEAD^{tree}']).trim();
  const files = [...new Set([...names(worktree, ['diff', '--name-only', '-z', 'HEAD']), ...names(worktree, ['ls-files', '-o', '--exclude-standard', '-z'])])].sort();
  const lines = files.map(f => {
    const abs = path.join(worktree, f);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { return `${f}\0deleted\0`; }
    if (st.isSymbolicLink()) return `${f}\0link\0${sha(fs.readlinkSync(abs))}`;
    if (!st.isFile()) return `${f}\0other\0`;
    return `${f}\0${st.mode & 0o111 ? 'exec' : 'file'}\0${sha(fs.readFileSync(abs))}`;
  });
  return `${head}:${tree}:${sha(lines.join('\n'))}`;
}

const idOf = (b: Binding, payloadSha: string): string => sha(JSON.stringify([b.kind, ...DIMENSIONS.map(d => b[d]), payloadSha]));
const file = (dir: string, id: string): string => path.join(dir, `${id}.json`);

export function put(dir: string, binding: Binding, payload: string | Buffer, at: number): string {
  if (!binding.kind) throw new Error('evidence binding lacks kind');
  for (const d of DIMENSIONS) if (typeof binding[d] !== 'string' || !binding[d]) throw new Error(`evidence binding lacks ${d}`);
  const body = Buffer.from(payload);
  const payloadSha = sha(body);
  const id = idOf(binding, payloadSha);
  const entry: Entry = { id, binding: { kind: binding.kind, ...Object.fromEntries(DIMENSIONS.map(d => [d, binding[d]])) } as Binding, payloadSha, at, payload: body.toString('base64') };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file(dir, id)}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entry));
  fs.renameSync(tmp, file(dir, id));
  return id;
}

/** Verified read. Throws when the file is missing, malformed, or does not hash to what it claims. */
export function get(dir: string, id: string): Entry {
  const e = JSON.parse(fs.readFileSync(file(dir, id), 'utf8')) as Entry;
  const body = Buffer.from(String(e.payload), 'base64');
  if (e.id !== id || sha(body) !== e.payloadSha || idOf(e.binding, e.payloadSha) !== id) throw new Error(`evidence ${id.slice(0, 12)} does not match its own digest (rewritten or damaged)`);
  return e;
}

/** Dimensions in which `entry` can no longer be trusted for `current`. A dimension the caller cannot supply is stale. */
export function staleDimensions(binding: Binding, current: Partial<Record<Dimension, string>>): Dimension[] {
  return DIMENSIONS.filter(d => { const c = current[d]; return !c || c === 'unknown' || binding[d] === 'unknown' || c !== binding[d]; });
}

const ids = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/.test(n)).map(n => n.slice(0, 64)) : [];

/** Routine retention: unreferenced entries older than `maxAgeMs` go; referenced and unreadable ones stay. */
export function retain(dir: string, o: { referenced: Set<string>; maxAgeMs: number; now: number }): { kept: string[]; removed: string[] } {
  const kept: string[] = [], removed: string[] = [];
  for (const id of ids(dir)) {
    let old = false;
    try { old = o.now - get(dir, id).at > o.maxAgeMs; } catch { /* unreadable: never delete what cannot be understood */ }
    if (old && !o.referenced.has(id)) { fs.unlinkSync(file(dir, id)); removed.push(id); } else kept.push(id);
  }
  return { kept, removed };
}

/** Explicit deletion. A referenced entry needs `force` — the caller then owns the consequence. */
export function purge(dir: string, id: string, o: { referenced: Set<string>; force?: boolean }): void {
  if (o.referenced.has(id) && !o.force) throw new Error(`evidence ${id.slice(0, 12)} is still referenced by an open mission`);
  fs.unlinkSync(file(dir, id));
}
