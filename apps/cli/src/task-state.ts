import fs from 'node:fs';
import path from 'node:path';
import { canonicalTask, materialDigest, type TaskIdentity, type AuthorizationSubject, subjectDigest } from './authorization.js';
import { sha256 } from './project.js';
import { type VerificationReport } from '@amabie/prompt-evidence';
import { CONFIG_DIR, TASK_FILE } from './local-config.js';
import { assertPlainTarget, containedRealPath, writeFileAtomic } from './local-files.js';

const CLAUDE_TURN_STATE_DIR = path.join('task', 'sessions');

export const CLAUDE_TASK_TOOL = 'mcp__amabie__amabie_task';

/** Strict canonical declaration reader. Incomplete/legacy records return null;
 * candidate completion then has no usable task authority and fails closed.
 * Isolation freezes this exact representation for the shared monotonic guard. */
export function readTaskRecord(root: string): TaskIdentity | null {
  try {
    const p = path.join(root, CONFIG_DIR, TASK_FILE);
    if (containedRealPath(root, p) === null) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return (v?.schema === 'amabie-task/2' || v?.schema === 'amabie-task/2') ? canonicalTask(v) : null;
  } catch { return null; }
}

export interface ClaudeTurnState {
  schema: 'amabie-turn/1';
  sessionDigest: string;
  promptId: string;
  registeredPromptId: string | null;
  task: TaskIdentity | null;
  /** HEAD when the request started. Scopes the Stop verdict only together with `startClean`; otherwise earlier-task provenance wording. */
  startHead?: string;
  /** The tree and index matched `startHead` (ignoring Amabie's own files) when the request started: the task boundary is provable. */
  startClean?: boolean;
}

function claudeTurnStatePath(root: string, sessionId: string): string {
  return path.join(root, CONFIG_DIR, CLAUDE_TURN_STATE_DIR, `${sha256(sessionId)}.json`);
}

export function readClaudeTurnState(root: string, sessionId: string): ClaudeTurnState | null {
  try {
    const p = claudeTurnStatePath(root, sessionId);
    if (containedRealPath(root, p) === null) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const task = v?.task === null ? null : canonicalTask(v?.task);
    if ((v?.schema !== 'amabie-turn/1' && v?.schema !== 'amabie-turn/1') || v.sessionDigest !== sha256(sessionId)
      || typeof v.promptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.promptId)
      || (v.registeredPromptId !== null && v.registeredPromptId !== v.promptId)
      || (v.registeredPromptId === v.promptId && task === null)
      || (v.registeredPromptId === null && v.task !== null)) return null;
    return { schema: 'amabie-turn/1', sessionDigest: v.sessionDigest, promptId: v.promptId,
      registeredPromptId: v.registeredPromptId as string | null, task,
      ...(typeof v.startHead === 'string' && /^[0-9a-f]{40,64}$/i.test(v.startHead) ? { startHead: v.startHead } : {}),
      ...(v.startClean === true ? { startClean: true } : {}) };
  } catch { return null; }
}

export function writeClaudeTurnState(root: string, sessionId: string, state: ClaudeTurnState): boolean {
  const p = claudeTurnStatePath(root, sessionId);
  try {
    if (containedRealPath(root, path.dirname(p)) === null || containedRealPath(root, p) === null) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    assertPlainTarget(p);
    writeFileAtomic(p, JSON.stringify(state, null, 2) + '\n');
    return true;
  } catch { return false; }
}

export function removeClaudeTurnState(root: string, sessionId: string): void {
  const p = claudeTurnStatePath(root, sessionId);
  try {
    if (containedRealPath(root, p) === null) return;
    assertPlainTarget(p);
    fs.rmSync(p, { force: true });
  } catch { /* session shutdown must not fail because local state could not be cleaned */ }
}

// P0:22 — the latest user prompt, bound at the harness intake. Only SHA-256 digests of each
// normalised line are stored, never the raw prompt. LOCAL and same-user: a process that can write
// .amabie can rewrite the record; this proves the intake-to-doctor path, not worker-independent trust.
const ORIGINAL_PROMPT_SCHEMA = 'amabie-original-prompt/1';

const ORIGINAL_PROMPT_FILE = path.join(CONFIG_DIR, 'original-prompt.json');

function promptLineDigests(text: string): string[] {
  const lines = text.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')).filter(line => line !== '');
  return [...new Set(lines.map(sha256))];
}

export function recordOriginalPrompt(root: string, prompt: string, promptId: string): void {
  const p = path.join(root, ORIGINAL_PROMPT_FILE);
  try {
    if (containedRealPath(root, path.dirname(p)) === null || containedRealPath(root, p) === null) throw new Error('refused');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    assertPlainTarget(p);
    writeFileAtomic(p, JSON.stringify({ schema: ORIGINAL_PROMPT_SCHEMA, promptId, lineDigests: promptLineDigests(prompt) }, null, 2) + '\n');
  } catch {
    // a failed write must not leave the previous prompt's record standing in for this one
    try { if (containedRealPath(root, p) !== null) { assertPlainTarget(p); fs.rmSync(p, { force: true }); } } catch { /* absence is labelled at doctor */ }
  }
}

export function readOriginalPrompt(root: string): string[] | null {
  try {
    const p = path.join(root, ORIGINAL_PROMPT_FILE);
    if (containedRealPath(root, p) === null) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (v?.schema !== ORIGINAL_PROMPT_SCHEMA || !Array.isArray(v.lineDigests) || !v.lineDigests.every(d => typeof d === 'string')) return null;
    return v.lineDigests.length > 0 ? v.lineDigests as string[] : null;
  } catch { return null; }
}

/** The harness-minted id of the request the recorded prompt belongs to (null when no hook recorded one). */
function readPromptEpoch(root: string): string | null {
  try {
    const p = path.join(root, ORIGINAL_PROMPT_FILE);
    if (containedRealPath(root, p) === null) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return v?.schema === ORIGINAL_PROMPT_SCHEMA && typeof v.promptId === 'string' && /^[0-9a-f-]{36}$/i.test(v.promptId) ? v.promptId : null;
  } catch { return null; }
}

// T11 — append-only, hash-chained log of every task registration. Registering overwrites the task
// record, so without this a dropped requirement leaves no trace. A change inside ONE request (same
// harness promptId) can only weaken the duties silently; a new request is the authorized revision.
// LOCAL and same-user, like the original-prompt record: it makes silent edits visible, not impossible.
const TASK_REVISIONS_FILE = path.join(CONFIG_DIR, 'task-revisions.jsonl');

const lineDigest = (line: string): string => sha256(line);

function readRevisionLines(root: string): string[] {
  try {
    const p = path.join(root, TASK_REVISIONS_FILE);
    if (containedRealPath(root, p) === null) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(line => line !== '');
  } catch { return []; }
}

export function appendTaskRevision(root: string, task: TaskIdentity): void {
  const p = path.join(root, TASK_REVISIONS_FILE);
  if (containedRealPath(root, p) === null) throw new Error('revision log resolves outside the repository');
  assertPlainTarget(p);
  const lines = readRevisionLines(root);
  fs.appendFileSync(p, JSON.stringify({
    schema: 'amabie-task-revision/1', n: lines.length + 1, at: new Date().toISOString(),
    taskDigest: task.taskDigest, requirementDigests: task.requirementDigests,
    epoch: readPromptEpoch(root), prev: lines.length ? lineDigest(lines[lines.length - 1]!) : null,
  }) + '\n');
}

/** Reasons the registered task is not the authorized one; empty when the chain is intact and every in-request change only adds. */
export function taskRevisionIssues(root: string, task: TaskIdentity): string[] {
  const lines = readRevisionLines(root);
  if (lines.length === 0) return ['No task revision log exists for this project, so the registered task has no recorded origin; manual operator confirmation is required.'];
  const issues: string[] = [];
  let previous: { taskDigest: string; requirementDigests: string[]; epoch: string | null } | null = null;
  for (const [i, line] of lines.entries()) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(line) as Record<string, unknown>; } catch { return [...issues, `Task revision ${i + 1} is unreadable, so the revision chain is broken.`]; }
    const digests = Array.isArray(v.requirementDigests) && v.requirementDigests.every(d => typeof d === 'string') ? v.requirementDigests as string[] : null;
    if (v.schema !== 'amabie-task-revision/1' || v.n !== i + 1 || typeof v.taskDigest !== 'string' || digests === null
      || v.prev !== (i === 0 ? null : lineDigest(lines[i - 1]!))) return [...issues, `Task revision ${i + 1} does not chain onto the previous one, so the revision history was edited.`];
    const epoch = typeof v.epoch === 'string' ? v.epoch : null;
    if (previous !== null && epoch !== null && epoch === previous.epoch) {
      const dropped = previous.requirementDigests.filter(d => !digests.includes(d)).length;
      if (dropped > 0) issues.push(`Task revision ${i + 1} dropped or replaced ${dropped} requirement(s) within the same request; only a new request authorizes that.`);
    }
    previous = { taskDigest: v.taskDigest, requirementDigests: digests, epoch };
  }
  if (previous !== null && (previous.taskDigest !== task.taskDigest
    || previous.requirementDigests.join() !== task.requirementDigests.join())) issues.push('The registered task is not the last recorded revision, so it was changed outside amabie task.');
  return issues;
}

/**
 * T10 — the recorded original prompt must belong to a request this project actually saw. Turn states
 * hold the harness-minted promptId of every live session; a record whose promptId matches none of
 * them (copied from another project, or replayed) is not the current request. No turn state at all
 * (CLI-only use) means nothing to compare, so the check is silent there. LOCAL and same-user: a
 * record replayed from a still-present session state would match.
 */
export function promptEpochIssues(root: string): string[] {
  const epoch = readPromptEpoch(root);
  if (epoch === null) return [];
  const dir = path.join(root, CONFIG_DIR, CLAUDE_TURN_STATE_DIR);
  const ids: string[] = [];
  try {
    if (containedRealPath(root, dir) === null) return [];
    for (const name of fs.readdirSync(dir)) {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
        if (typeof v?.promptId === 'string') ids.push(v.promptId);
      } catch { /* an unreadable state proves nothing either way */ }
    }
  } catch { return []; }
  return ids.length === 0 || ids.includes(epoch) ? []
    : ['The recorded original prompt belongs to a request that is not the current one in any session of this project, so it may be a replay.'];
}

export function bindTaskRevisions(report: VerificationReport, issues: string[]): VerificationReport {
  return issues.length === 0 ? report : { ...report, verdict: report.verdict === 'PASS' ? 'NOT PROVEN' : report.verdict, issues: [...report.issues, ...issues] };
}

/**
 * Every line of the recorded original prompt must still be a line of the request goal. A missing
 * line is NOT PROVEN (FAIL stays FAIL); no record is not silent — it is labelled as unbound.
 */
export function bindOriginalPrompt(report: VerificationReport, recorded: string[] | null, goalText: string): VerificationReport {
  if (recorded === null) return { ...report, issues: [...report.issues, 'No original-prompt record exists for this project, so the original prompt is unbound; manual operator confirmation is required.'] };
  const goal = new Set(promptLineDigests(goalText));
  const missing = recorded.filter(digest => !goal.has(digest)).length;
  if (missing === 0) return report;
  return { ...report, verdict: report.verdict === 'PASS' ? 'NOT PROVEN' : report.verdict,
    issues: [...report.issues, `The original prompt has ${missing} line(s) the request goal does not carry verbatim, so the original prompt is not bound.`] };
}

export const sameTask = (left: TaskIdentity | null, right: TaskIdentity | null): boolean =>
  left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);

export function mcpInputMatchesTask(task: TaskIdentity, input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const { intent, requirements } = input as { intent?: unknown; requirements?: unknown };
  if (typeof intent !== 'string' || !Array.isArray(requirements)
    || !requirements.every((requirement) => typeof requirement === 'string')) return false;
  const expectedRequirements = requirements.map((requirement) => materialDigest(requirement as string)).sort();
  return task.taskDigest === materialDigest(intent)
    && JSON.stringify(task.requirementDigests) === JSON.stringify(expectedRequirements);
}

export function taskFromMcpInput(root: string, input: unknown): TaskIdentity | null {
  const task = readTaskRecord(root);
  return task && mcpInputMatchesTask(task, input) ? task : null;
}

// ---------- blocker 3: ACCEPTANCE FROM AN INTERACTIVE TERMINAL (the subjective completion path) ----------
/** Acceptance is the human-authority boundary, never a promotion shortcut:
 *  it can close ONLY non-objective duties, never an objective proof. The
 *  record binds to the exact candidate, the exact base HEAD it was verified
 *  against, the exact committed bytes reviewed, the frozen task state, AND
 *  the acceptance-eligible DUTY SET as it stood when the judgment was made
 *  (GLM F-3) — any of those moving makes it STALE (the duties reopen).
 *  Claim stated exactly (no more, no less): Amabie refuses the normal
 *  NON-INTERACTIVE acceptance path and requires an interactive terminal for
 *  the supported acceptance flow. A TTY is not cryptographic human identity:
 *  a same-UID process able to drive a PTY (e.g. `script -qec`) or to write
 *  this file directly remains inside Amabie's documented local forgery
 *  ceiling (M2). The gate takes the USUAL agent path away; it is policy /
 *  friction, not an OS security boundary.
 *  It lives OUTSIDE .amabie/evidence by design: the evidence tree is inside
 *  M9's fingerprint window, and an acceptance written between windows must
 *  not look like authority-drift. */
export const ACCEPTANCE_SUBDIR = 'acceptance';

export interface AcceptanceRecord {
  schema: 'amabie-acceptance/3'; at: string; candidate: string;
  subject: AuthorizationSubject;
  subjectDigest: string;
  acceptedBy: 'tty-human';
}

export function readAcceptance(root: string, name: string): AcceptanceRecord | null {
  try {
    const p = path.join(root, CONFIG_DIR, ACCEPTANCE_SUBDIR, `${name}.json`);
    if (containedRealPath(root, p) === null) return null; // linked dirs: never read through
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<AcceptanceRecord> | null;
    if (typeof v !== 'object' || v === null) return null;
    if ((v.schema !== 'amabie-acceptance/3' && v.schema !== 'amabie-acceptance/3') || typeof v.at !== 'string' || v.candidate !== name || v.acceptedBy !== 'tty-human') return null;
    const sub = v.subject;
    if (!sub || sub.candidate !== name || !canonicalTask(sub.frozenTask) || !canonicalTask(sub.liveTask)
      || ![sub.candidateCommit, sub.candidateTree, sub.baseHead, sub.baseTree].every(x => typeof x === 'string' && /^[0-9a-f]{40,64}$/.test(x))
      || typeof sub.baseAuthorityIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(sub.baseAuthorityIdentity)
      || !Array.isArray(sub.subjectiveDuties) || !sub.subjectiveDuties.every(x => typeof x === 'string')
      || typeof v.subjectDigest !== 'string' || v.subjectDigest !== subjectDigest(sub)) return null;
    return v as AcceptanceRecord;
  } catch { return null; }
}

export function writeAcceptance(root: string, rec: AcceptanceRecord): boolean {
  try {
    const dir = path.join(root, CONFIG_DIR, ACCEPTANCE_SUBDIR);
    if (containedRealPath(root, dir) === null) return false;
    const p = path.join(dir, `${rec.candidate}.json`);
    if (containedRealPath(root, p) === null) return false;
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(p, JSON.stringify(rec, null, 2) + '\n');
    return true;
  } catch { return false; }
}
