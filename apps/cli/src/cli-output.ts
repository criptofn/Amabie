import { passEnvNameProblem } from '@amabie/support';
import { TOOLCHAIN_CANDIDATES } from './sealed-toolchain.js';
import { emitEnvelope, PROTOCOL_STATUS, type ProtocolEnvelope } from './protocol.js';
import { type StepResult } from './check-runner.js';

// ---------- friendly output ----------

export class Out {
  private json: boolean;
  private ctx: Partial<ProtocolEnvelope> = {};
  constructor(private verbose: boolean, json = false) { this.json = json; }
  /** In JSON mode the human prose goes to STDERR: stdout carries exactly one
   *  JSON object, so an agent's parser never skips past sentences. Exit codes
   *  and verdicts are identical in both modes — --json changes where the words
   *  go, never what Amabie decided. */
  private line(s: string): void { if (this.json) console.error(s); else console.log(s); }
  say(s = '') { this.line(s); }
  detail(s: string) { if (this.verbose) this.line(`   ${s}`); }
  step(r: StepResult) {
    this.line(`${r.ok ? '✓' : '✗'} ${r.kind}: ${r.display}${r.exitCode === null ? ' (could not run)' : ` (exit ${r.exitCode})`}`);
    if (!r.ok && r.tail) this.line(r.tail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
  /** Facts the envelope must carry. Attach them BEFORE the verdict. */
  context(partial: Partial<ProtocolEnvelope>): void { this.ctx = { ...this.ctx, ...partial }; }
  // CONNECTED / NOT CONNECTED are the amabie status (read-only) family: state
  // facts, deliberately NOT READY (only a completed plan run earns READY).
  verdict(v: 'READY' | 'PARTIAL' | 'NOT PROVEN' | 'CONNECTED' | 'NOT CONNECTED' | 'NEEDS ATTENTION' | 'UNSUPPORTED' | 'SETUP ELIGIBLE' | 'SETUP NEEDS ATTENTION', why: string, next?: string) {
    this.line('');
    this.line(v === 'READY' ? `READY — ${why}` : `${v} — ${why}`);
    if (next) this.line(`next: ${next}`);
    if (!this.json) return;
    // READY and CONNECTED are the only non-blocking verdicts; every other one
    // is a refusal, which is exit 2 across Amabie's command surface.
    const exitCode = this.ctx.exitCode ?? ((v === 'READY' || v === 'CONNECTED' || v === 'SETUP ELIGIBLE') ? 0 : 2);
    const env: ProtocolEnvelope = {
      schema: this.ctx.schema ?? PROTOCOL_STATUS, ...this.ctx,
      command: this.ctx.command ?? 'amabie', status: v, exitCode,
    };
    if (next !== undefined) env.next = next;
    emitEnvelope(env);
  }
}

export interface GlobalOpts { verbose: boolean; yes: boolean; json: boolean; fast: boolean }

export function parseGlobals(args: string[]): { opts: GlobalOpts; rest: string[] } {
  const opts: GlobalOpts = {
    verbose: args.includes('--verbose') || !!process.env.AMABIE_VERBOSE || !!process.env.AMABIE_VERBOSE,
    yes: args.includes('--yes'),
    json: args.includes('--json'),
    fast: args.includes('--fast'),
  };
  return { opts, rest: args.filter((a) => a !== '--verbose' && a !== '--yes' && a !== '--json' && a !== '--fast') };
}

/** The directory argument = first non-flag token, anywhere in the args. Never mistake --run for a path. */
export function dirArg(rest: string[]): string | undefined { return rest.find((a) => !a.startsWith('--')); }

// ---------- commands ----------

/**
 * v1.5 BLOCKER 6 — INTAKE FOR THE OPERATOR-AUTHORIZED TOOLCHAIN DIRECTORIES.
 *
 * Taken out of the args BEFORE `dirArg`, which reads the first non-flag token as the project
 * directory: `amabie setup --toolchain-dir "C:\Program Files\Git\cmd"` would otherwise treat the
 * toolchain directory as the project and answer UNSUPPORTED. The pairs are removed, so the rest of
 * setup's parsing sees exactly what it saw before this flag existed.
 *
 * `--clear-toolchain-dirs` is the explicit REVOCATION: without it, a re-run of setup keeps the
 * directories already sealed here (silently dropping authority a human granted is exactly the
 * failure this repository treats as worse than a refusal).
 */
export function takeToolchainDirs(args: string[]): { dirs: string[]; tools: string[]; rest: string[]; problems: string[]; clear: boolean } {
  const dirs: string[] = [];
  const tools: string[] = [];
  const rest: string[] = [];
  const problems: string[] = [];
  let clear = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === '--clear-toolchain-dirs') { clear = true; continue; }
    if (a === '--toolchain' || a.startsWith('--toolchain=')) {
      const value = a === '--toolchain' ? args[i + 1] : a.slice('--toolchain='.length);
      if (value === undefined || value.startsWith('--')) { problems.push('--toolchain needs a tool name (nothing was authorized)'); continue; }
      if (a === '--toolchain') i += 1;
      if (!(TOOLCHAIN_CANDIDATES as readonly string[]).includes(value)) problems.push(`unknown toolchain "${value}"; supported tools: ${TOOLCHAIN_CANDIDATES.join(', ')}`);
      else tools.push(value);
      continue;
    }
    if (a === '--toolchain-dir') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) { problems.push('--toolchain-dir needs a directory after it (nothing was authorized)'); continue; }
      dirs.push(value); i += 1; continue;
    }
    if (a.startsWith('--toolchain-dir=')) { dirs.push(a.slice('--toolchain-dir='.length)); continue; }
    rest.push(a);
  }
  return { dirs, tools, rest, problems, clear };
}

/**
 * `--pass-env NAME` (repeatable) names a variable of YOUR shell that checks may receive; the value is
 * read when a check runs and never stored. `--clear-pass-env` revokes every earlier name. Loader and
 * runtime-control names are refused here, before anything is sealed.
 */
export function takePassEnv(args: string[]): { names: string[]; rest: string[]; problems: string[]; clear: boolean } {
  const names: string[] = [];
  const rest: string[] = [];
  const problems: string[] = [];
  let clear = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === '--clear-pass-env') { clear = true; continue; }
    if (a === '--pass-env' || a.startsWith('--pass-env=')) {
      const value = a === '--pass-env' ? args[i + 1] : a.slice('--pass-env='.length);
      if (value === undefined || value.startsWith('--')) { problems.push('--pass-env needs a variable name (nothing was authorized)'); continue; }
      if (a === '--pass-env') i += 1;
      const problem = passEnvNameProblem(value);
      if (problem !== null) problems.push(problem); else names.push(value);
      continue;
    }
    rest.push(a);
  }
  return { names, rest, problems, clear };
}
