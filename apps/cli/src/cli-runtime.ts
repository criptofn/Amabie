import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sea from 'node:sea';
import { doctorCheckCommand } from './failure-payload.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The absolute path of the built CLI entry — what harness hooks invoke. */
export const CLI_ENTRY = sea.isSea() ? process.execPath : path.join(HERE, 'main.js');

/** argv that runs THIS Amabie with `args`.
 *
 *  In a single-executable build there is no `main.js` on disk — the executable
 *  IS the CLI — so spawning `process.execPath` with the CLI path as its first
 *  argument would feed the binary its own path as a command name. `import.meta
 *  .url` cannot be used to detect this either: inside a SEA it resolves to the
 *  BUILD-time path, not the installed binary's. `sea.isSea()` is the supported
 *  signal, and this function is the ONE place that turns it into an argv, so no
 *  caller can get the standalone case wrong. */
export function selfArgv(args: readonly string[]): string[] {
  return sea.isSea() ? [...args] : [CLI_ENTRY, ...args];
}

/** Build the hook command; null when a supported shell could interpret the CLI path. */
export function buildHookCommand(cliPath: string): string | null {
  // This command is embedded in Claude/Codex hook settings and evaluated by a host shell.
  // Double quotes preserve spaces, but not shell expansion: `$()` / PowerShell backticks,
  // `%VAR%` in cmd.exe, and `!VAR!` with delayed expansion can rewrite or execute the path.
  if (/["\r\n$`%!]/.test(cliPath)) return null;
  // A single-executable Amabie IS the command: prefixing `node` would demand a
  // Node installation, which is exactly what the standalone build removes.
  return sea.isSea() ? `"${cliPath}" checkpoint` : `node "${cliPath}" checkpoint`;
}

/** Reuse the installed CLI path from the hook for agent-visible repair commands. */
export function installedCliPrefix(): string | null {
  const hook = buildHookCommand(CLI_ENTRY);
  return hook === null ? null : hook.replace(/ checkpoint$/, '');
}

export function installedDoctorCommand(checkId?: string): string {
  const prefix = installedCliPrefix();
  if (prefix === null) return checkId === undefined
    ? 'the configured Amabie MCP full verification tool'
    : 'Amabie MCP amabie_doctor(check)';
  return checkId === undefined
    ? `${prefix} doctor`
    : doctorCheckCommand(checkId, process.platform, prefix);
}
