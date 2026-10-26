import fs from 'node:fs';
import path from 'node:path';

/** Case-exact path equality (win32 paths are case-insensitive). */
export function samePath(a: string, b: string): boolean {
  const [x, y] = process.platform === 'win32' ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
  return x === y;
}

/** realpath containment: resolve p without ever escaping root. Symlinks AND
 *  Windows junctions are followed by realpath, so a committed
 *  `.amabie -> /somewhere/else` (or `.gitignore -> ../../.gitignore`) resolves
 *  outside root and returns null (S3). Non-existent final components are safe
 *  to re-join once their nearest existing ancestor is contained. */
export function containedRealPath(root: string, p: string): string | null {
  try {
    // v1.4 — MEASURED: this must canonicalise 8.3 SHORT names, or every containment
    // comparison silently compares two spellings of one directory and refuses.
    //
    // Found on GitHub Actions Windows (run 35530519454, job 106130188538): ~119 tests failed
    // with `isolate: the trusted base identity is unresolvable (broken .git?)`. Ground truth
    // from the runner (probe v14-windows-identity-diag.mjs): git resolved FINE
    // (`C:\Program Files\Git\cmd\git.exe`), but `os.tmpdir()` and `fs.realpathSync()` both
    // returned `C:\Users\RUNNER~1\...` while `git rev-parse --show-toplevel` returned
    // `C:/Users/runneradmin/...`. `inside()` then compared `runner~1` against `runneradmin`,
    // concluded "not this repo", and refused an identity that was never in doubt.
    //
    // It is invisible on a machine whose path components all fit 8.3: `Johannes` is exactly
    // 8 characters, so short and long forms are byte-identical there. The runner's
    // `runneradmin` (11) becomes `RUNNER~1`, and a real user's temp or repo path can do the
    // same. Reproduced offline and deterministically by tooling/probes/v14-shortname-repro.mjs.
    //
    // `realpathSync.native` is Node's OS call (`GetFinalPathNameByHandle` on Windows) and DOES
    // expand the short form — measured: short `...\CAA02B~1\A-LONG~1` -> long
    // `...\amabie-shortname-iZPuS2\a-long-directory-name`. Symlink and junction following is
    // unchanged, so the containment property this helper exists for is not weakened: it is
    // now enforced against canonical paths instead of two unequally-spelled ones.
    const canon = (q: string): string => fs.realpathSync.native(q);
    const r = canon(root);
    const inside = (t: string) => process.platform === 'win32'
      ? (t.toLowerCase() === r.toLowerCase() || t.toLowerCase().startsWith(r.toLowerCase() + path.sep))
      : (t === r || t.startsWith(r + path.sep));
    if (fs.existsSync(p)) return inside(canon(p)) ? canon(p) : null;
    let cur = path.resolve(p);
    const tail: string[] = [];
    while (!fs.existsSync(cur)) {
      tail.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
    const anc = canon(cur);
    return inside(anc) ? path.join(anc, ...tail) : null;
  } catch { return null; }
}

/**
 * Atomic replace (GLM F-2): full bytes to a temp sibling -> fsync -> close ->
 * rename over the target. An interrupted or crashed write can only ever leave
 * the PREVIOUS complete file or the NEW complete file — never a half-written
 * config that readConfig would call 'corrupt'. fs.renameSync replaces an
 * existing target on Windows (MoveFileEx REPLACE_EXISTING) and POSIX.
 * Callers keep their own containment pre-checks; this preserves them:
 * assertPlainTarget on BOTH final and temp (no dangling-link landing pads),
 * and a failed attempt removes its temp and rethrows — bytes untouched.
 * Ceiling (ponytail): no parent-directory fsync (not portable on Windows);
 * the rename itself is the atomic step, so the worst crash window is a
 * surviving temp sibling, which self-heals on the next write.
 */
export function writeFileAtomic(p: string, data: string): void {
  assertPlainTarget(p);
  const tmp = `${p}.${process.pid}.amabie-tmp`;
  assertPlainTarget(tmp);
  try {
    // 'wx' exclusive create: a planted hardlink at the predictable temp name
    // fails EEXIST instead of being written through (closes the check->open
    // TOCTOU window assertPlainTarget alone cannot see).
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort; a surviving temp is inert */ }
    throw e;
  }
}

/** Refuse to create-or-follow a symlink for the final component (S3, second
 *  half): containedRealPath only sees links whose target EXISTS — a dangling
 *  `.amabie/last-checkpoint.json -> /somewhere/else` passes the ancestor walk,
 *  then writeFileSync would CREATE the external file through the link. Every
 *  path Amabie writes to must be a plain file (or not exist at all). */
export function assertPlainTarget(p: string): void {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`refused to write through symlink: ${p}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // absent = safe to create
    throw e;
  }
}

/** A path rides human-facing notes ONLY in this shape (odd names collapse —
 *  classification never sees this layer: git probes answer in -z raw bytes). */
export function safePath(p: string): string {
  const q = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return /^[A-Za-z0-9 ._\-/:@+~]{1,160}$/.test(q) ? q : '<odd path>';
}

export function rel(root: string, p: string): string { return path.relative(root, p) || '.'; }

/** A hand-edited non-object must never become a declaration or crash a binding write. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
