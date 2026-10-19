import { spawnSync } from 'node:child_process';

/**
 * The git executable the caller's PATH resolves to, as an absolute path.
 * Probes used to hard-code `C:\Program Files\Git\cmd\git.exe`, which exists on
 * no Linux host, so every fixture died at `git init` before testing anything.
 * Same resolution as m8-promotion.mjs and m9-authority.mjs.
 */
export function hostGit() {
  const found = process.platform === 'win32'
    ? spawnSync('where', ['git.exe'], { encoding: 'utf8', timeout: 15_000 })
    : spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 15_000 });
  const first = (found.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (found.status !== 0 || first === undefined) throw new Error('git is not resolvable on the caller PATH');
  return first;
}
