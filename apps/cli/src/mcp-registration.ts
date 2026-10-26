import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';
import { parseJsonOrNull } from './project.js';
import { type TouchedFile } from './local-config.js';
import { assertPlainTarget, rel, writeFileAtomic } from './local-files.js';

// ---------- v1.3 §C: the MCP server, wired by setup instead of by hand ----------
//
// WHY THIS IS INSTALLED AND NOT MERELY DOCUMENTED. The completion gate already tells the agent, at the
// END, that a green suite which cannot discriminate the change proves nothing (measured: the everyday
// Stop hook BLOCKS it). What the agent cannot do is ASK. So it runs its own tests instead — measured
// on the long fixture, ~36 of 57 confined execs were the model re-running its own checks and building
// a fuzz/mutation rig as whole-file writes, which is ~70% of that arm's token cost and is the single
// largest reason a long task costs more than the unguarded arm.
//
// `amabie mcp` already exists, already refuses `accept` deliberately, and already exposes only thin
// argv templates over operations the CLI had before it (mcp.ts:67-164). The missing piece was that a
// user had to discover and configure an MCP client by hand. This closes that gap with the same
// discipline as the Stop hook: parse first, refuse to write through a link, back up, prune only our
// OWN prior entry, write atomically, and record exactly what we touched so `uninstall` can undo it.
//
// It grants NO new authority: the server can only REQUEST `result`/`status`/`agents`/`doctor`/`work`/
// `finish`, each of which runs the same CLI and is judged by the same gates.
const MCP_SERVER_KEY = 'amabie';

export const MCP_CONFIG_BASENAME = '.mcp.json';

export function mcpConfigPath(root: string): string { return path.join(root, MCP_CONFIG_BASENAME); }

/** The exact program a client should run: this Amabie, serving MCP.
 *
 *  Deliberately PINNED to the Node that is running setup, unlike the hook command, which spells bare
 *  `node` and therefore depends on the harness's PATH. That difference is intentional: a completion
 *  hook is executed BY a shell, so PATH is its native mechanism and is already required; an MCP server
 *  is spawned DIRECTLY by the editor, and a GUI-launched editor routinely has a different PATH than
 *  the user's terminal. Pinning removes a whole class of "the server never started" reports that would
 *  otherwise be blamed on Amabie. */
export function mcpServerCommand(cliPath: string): string { return sea.isSea() ? cliPath : process.execPath; }

export type McpProfile = 'everyday' | 'expert';

export function mcpServerArgs(cliPath: string, profile: McpProfile = 'everyday'): string[] {
  return [...(sea.isSea() ? ['mcp'] : [cliPath, 'mcp']), '--profile', profile];
}

export const mcpArgSignature = (args: readonly string[]): string => JSON.stringify([...args]);

/** Is OUR entry present — matched by argv signature, never by the key alone? */
export function hasMcpEntry(doc: Record<string, unknown>, owned: Set<string>): boolean {
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_KEY];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const args = (entry as { args?: unknown }).args;
  return Array.isArray(args) && owned.has(mcpArgSignature(args.map(String)));
}

/** Remove ONLY entries this installation wrote, matched by argv signature. Anything else under the
 *  key — a stranger's `amabie` server, a hand-written one — is left exactly as it was. */
export function pruneOwnedMcp(doc: Record<string, unknown>, owned: Set<string>): number {
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 0;
  const map = servers as Record<string, unknown>;
  const entry = map[MCP_SERVER_KEY];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 0;
  const args = (entry as { args?: unknown }).args;
  if (!Array.isArray(args) || !owned.has(mcpArgSignature(args.map(String)))) return 0;
  delete map[MCP_SERVER_KEY];
  if (Object.keys(map).length === 0) delete doc.mcpServers;
  return 1;
}

/**
 * Install the Amabie MCP server into <root>/.mcp.json.
 *
 * Refusals are plain and Nothing Is Changed: a symlinked file, invalid JSON, a `mcpServers` that is
 * not an object, or a `amabie` key that exists but was NOT written by this installation. That last
 * one is the confused-deputy guard — Amabie will not silently replace a server it did not create.
 */
export function installMcpServer(
  root: string, cliPath: string, priorSignatures: Set<string>, backupsDir: string,
  profile: McpProfile = 'everyday', dryRun = false,
): { ok: boolean; touched?: TouchedFile; problem?: string } {
  const file = mcpConfigPath(root);
  try { assertPlainTarget(file); } catch {
    return { ok: false, problem: `${rel(root, file)} is a symbolic link — Amabie will not write through links. Replace it with a real file, then run setup again. Nothing was changed.` };
  }
  const existed = fs.existsSync(file);
  let doc: Record<string, unknown> = {};
  if (existed) {
    const parsed = parseJsonOrNull(file);
    if (!parsed) return { ok: false, problem: `${rel(root, file)} is not valid JSON — fix it and re-run setup. Nothing was changed.` };
    doc = parsed;
  }
  if (doc.mcpServers !== undefined && (typeof doc.mcpServers !== 'object' || doc.mcpServers === null || Array.isArray(doc.mcpServers))) {
    return { ok: false, problem: `${rel(root, file)} has an "mcpServers" section that is not an object — fix it and re-run setup. Nothing was changed.` };
  }
  const args = mcpServerArgs(cliPath, profile);
  const signature = mcpArgSignature(args);
  const owned = new Set([signature, ...priorSignatures]);
  const existing = (doc.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_KEY];
  if (existing !== undefined && !hasMcpEntry(doc, owned)) {
    return {
      ok: false,
      problem: `${rel(root, file)} already defines an MCP server named "${MCP_SERVER_KEY}" that Amabie did not write. Amabie will not replace a server it does not own — rename or remove that entry (or point it elsewhere), then run setup again. Nothing was changed.`,
    };
  }
  pruneOwnedMcp(doc, owned);
  // RE-ACQUIRE the map: pruning the last server deletes `mcpServers` itself, so a reference taken
  // before the prune would write our entry into a detached object and silently produce a file with no
  // servers at all. (A test caught exactly that: a re-run left the document empty.)
  const map = (doc.mcpServers ??= {}) as Record<string, unknown>;
  map[MCP_SERVER_KEY] = { command: mcpServerCommand(cliPath), args };

  if (dryRun) return { ok: true, touched: { path: file, created: !existed, kind: 'mcp' } };

  if (existed) {
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsDir, `${stamp}-mcp.json`);
    try { assertPlainTarget(dest); fs.copyFileSync(file, dest); } catch (e) {
      return { ok: false, problem: `could not back up ${rel(root, file)} (${String(e).slice(0, 140)}) — nothing was changed.` };
    }
  }
  try {
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    return { ok: false, problem: `could not update ${rel(root, file)} (${String(e).slice(0, 140)}) — ${existed ? 'your file was left exactly as it was, and the backup is in place' : 'nothing was created'}. Re-run setup.` };
  }
  return { ok: true, touched: { path: file, created: !existed, kind: 'mcp' } };
}
