import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { canonicalPathOrNull } from '@amabie/support';
import { CLI_ENTRY } from './cli-runtime.js';
import { CONFIG_DIR } from './local-config.js';
import { containedRealPath } from './local-files.js';
import { readSessionRegistry } from './session-registry.js';

const OPERATOR_COMMANDS = new Set(['setup', 'bind', 'accept', 'uninstall']);
const isOperator = (word: string): boolean => word.startsWith('\0');

// Only literal shell words are eligible for the registration escape hatch.
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) {
        if (quote === "'" && command[i + 1] === "'") { word += "'"; i++; }
        else quote = '';
      } else if (char === '\\' && quote === '"' && /["\\]/.test(command[i + 1] ?? '')) word += command[++i];
      else if (quote === '"' && /[$`]/.test(char)) return null;
      else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/[$`]/.test(char)) return null;
    else if (/[;&|<>\r\n]/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
      words.push(`\0${char}`);
    }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

function cliCommand(words: string[], allowPackageRunner = true): string[] | null {
  const executable = path.basename((words[0] ?? '').replace(/\\/g, '/')).toLowerCase();
  if (/^(?:amabie|canary)(?:\.cmd|\.exe)?$/.test(executable)) return words.slice(1);
  if (/^node(?:\.exe)?$/.test(executable) && words[1] && path.resolve(words[1]) === path.resolve(CLI_ENTRY)) return words.slice(2);
  if (allowPackageRunner && /^(?:npx|npm)(?:\.cmd)?$/.test(executable)) {
    const index = words.findIndex(word => /^(?:amabie-cli|amabie|canary)(?:@[^\s]+)?$/.test(word));
    if (index > 0) return words.slice(index + 1);
  }
  return null;
}

export function isTaskRegistration(command: string, sessionId: string): boolean {
  const words = shellWords(command);
  if (words?.some(isOperator)) return false;
  const args = words && cliCommand(words, false);
  if (!args || args[0] !== 'task') return false;
  const sessions = args.flatMap((arg, index) => arg === '--session' ? [args[index + 1]] : []);
  return sessions.length === 1 && sessions[0] === sessionId;
}

function protectedPath(root: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const absolute = path.resolve(root, value);
  const target = containedRealPath(root, absolute) ?? absolute;
  const relative = path.relative(canonicalPathOrNull(root) ?? root, target).replace(/\\/g, '/').toLowerCase();
  return relative === '.amabie' || relative.startsWith('.amabie/')
    || ['.claude', '.claude/settings.json', '.claude/settings.local.json', '.codex', '.codex/hooks.json', '.mcp.json'].includes(relative);
}

export function agentToolProblem(root: string, tool: string, input: unknown): string | null {
  const data = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) || /^mcp__.*(?:write|edit|delete|remove|move|rename|create|apply_patch)/i.test(tool)) {
    if ([data.file_path, data.path, data.notebook_path, data.source, data.destination].some(value => protectedPath(root, value))) {
      return 'Amabie authority and hook files are protected during an agent session. An operator must review changes from a human terminal.';
    }
  }
  if (tool !== 'Bash' && tool !== 'PowerShell' && !/^mcp__.*(?:exec|command|bash|powershell)/i.test(tool)) return null;
  const command = typeof data.command === 'string' ? data.command : '';
  const words = shellWords(command);
  const commands = words ? words.reduce<string[][]>((list, word) => {
    if (isOperator(word)) list.push([]);
    else list[list.length - 1]!.push(word);
    return list;
  }, [[]]) : [];
  if (commands.some(commandWords => {
    const args = cliCommand(commandWords);
    return args && OPERATOR_COMMANDS.has(args[0] ?? '') && !(args[0] === 'setup' && args.includes('--check'));
  })) {
    return 'Amabie setup, bind, accept and uninstall are operator actions, unavailable to an agent session. Ask the human to review the plan in a terminal.';
  }
  // LOCAL guard for explicit targets, not a sandbox for arbitrary scripts or same-user processes.
  const targets = words ?? command.match(/[^\s"';&|<>]+/g) ?? [];
  if (targets.some(value => protectedPath(root, value.replace(/^--?[^=]+=/, '')))) {
    const readOnly = words && !words.some(isOperator)
      && (/^(?:cat|Get-Content|type|echo|printf)$/i.test(words[0] ?? '')
        || (words[0] === 'git' && /^(?:status|diff|log|show|ls-files)$/.test(words[1] ?? '') && !words.some(word => word.startsWith('--output'))));
    if (!readOnly) return 'Amabie authority and hook paths are protected during an agent session. Restore or reseal them only as a human operator.';
  }
  return null;
}

export async function operatorSessionProblem(root: string | null, command: string): Promise<string | null> {
  if (process.env.CLAUDECODE === '1') return 'This operator action cannot run inside a Claude agent session. Run it from a human terminal after reviewing the verification plan.';
  if (!root) return null;
  const sessions = path.join(root, CONFIG_DIR, 'task', 'sessions');
  let active = false;
  try { active = fs.readdirSync(sessions).some(file => file.endsWith('.json')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'Amabie could not inspect active agent sessions; operator changes were refused.';
  }
  // The same fact, kept outside the repository: deleting `.amabie` (with any interpreter) and unsetting
  // the agent markers must not make a session that is still open look closed.
  const registry = readSessionRegistry(root);
  if (registry.state === 'unreadable') return `Amabie could not inspect its record of open agent sessions (${registry.reason}); operator changes were refused. Repair the trust store, or remove the damaged record as a human operator.`;
  if (registry.state === 'active') active = true;
  if (!active) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'An agent session is open. Close it before changing verification authority, or review and confirm this action in a human terminal.';
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`An agent session is open. This changes its verification authority. After reviewing the plan, type "${command}" to continue: `);
    return answer.trim() === command ? null : 'Operator action cancelled; verification authority was not changed.';
  } finally { terminal.close(); }
}
