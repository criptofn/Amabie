import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import {
  evidenceIntegrityValid,
  MAX_CORRECTION_CYCLES,
  runBoundedCorrectionLoop,
  validatePromptEvidenceRequest,
  type AdapterCollection,
  type EvidenceDraft,
  type JsonValue,
  type ValidatedPromptEvidenceRequest,
  type VerifierAdapter,
  type VerificationReport,
} from '@amabie/prompt-evidence';
import { killTree, sweepDescendants } from '@amabie/support';
import { CLI_ENTRY, containedRealPath, findRepoRoot, readConfig, readTaskRecord } from './onboarding.js';
import { CODING_SEALED_PLAN_ADAPTER } from './prompt-evidence.js';
import {
  buildCorrectionAgentEnvironment,
  buildCorrectionAgentInvocation,
  evaluateClaudeCodeVersion,
  renderCorrectionAgentPrompt,
  type BuiltinCorrectionAgent,
} from './prompt-evidence-agents.js';

const LOOP_SCHEMA = 'amabie-prompt-evidence-loop/1' as const;
const CORRECTION_SCHEMA = 'amabie-correction-request/1' as const;
const MAX_AGENT_ARGS = 32;
const MAX_AGENT_ARG_CHARS = 2_048;
const MAX_AGENT_INPUT_BYTES = 512 * 1024;
const MAX_AGENT_OUTPUT_BYTES = 1024 * 1024;
const MAX_DOCTOR_OUTPUT_BYTES = 8 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_AGENT_PREFLIGHT_OUTPUT_BYTES = 4 * 1024;
const DOCTOR_TIMEOUT_MS = 30 * 60 * 1000;
const FORCE_CLOSE_MS = 2_000;

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  sweepFailed: boolean;
  error?: string;
}

export interface AgentProcessDiagnostic {
  cycle: number;
  exitCode: number | null;
  timedOut: boolean;
  outputExceeded: boolean;
  sweepFailed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  diagnosticHint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function boundedReason(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 240);
}

export function summarizeAgentProcess(cycle: number, result: ProcessResult): AgentProcessDiagnostic {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const hasOutput = result.stdout.length > 0 || result.stderr.length > 0;
  const diagnosticHint = result.timedOut ? 'timeout'
    : result.outputExceeded ? 'output-limit'
      : result.sweepFailed ? 'process-cleanup-failed'
        : result.error ? 'launch-error'
          : /maximum.{0,20}turns?|max[-\s]+turns?|turn limit/u.test(output) ? 'turn-limit'
            : /not logged in|unauthori[sz]ed|authentication|invalid (?:api )?key/u.test(output) ? 'authentication'
              : /rate.?limit|quota|usage limit|billing|credits?/u.test(output) ? 'quota-or-billing'
                : /\b(?:permission\s+denied|access\s+denied|operation\s+not\s+permitted|not\s+trusted|trust\s+(?:is\s+)?(?:required|pending)|must\s+trust)\b/u.test(output) ? 'permission-or-trust'
                  : /unknown (?:option|argument)|invalid option|unrecognized (?:option|argument)/u.test(output) ? 'cli-configuration'
                    : /network|connection|fetch failed|could not connect|econnreset|etimedout/u.test(output) ? 'network-or-provider'
                      : result.exitCode === 0 ? hasOutput ? 'exit-success-with-output' : 'exit-success'
                        : hasOutput ? 'nonzero-exit-with-output' : 'nonzero-exit';
  return {
    cycle,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    outputExceeded: result.outputExceeded,
    sweepFailed: result.sweepFailed,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
    diagnosticHint,
  };
}

function runBoundedProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  outputLimit: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise(resolve => {
    const spawnedAtMs = Date.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = crossSpawn(executable, [...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, outputExceeded: false, sweepFailed: false, error: boundedReason(String(error)) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let received = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceClose: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, processError?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceClose) clearTimeout(forceClose);
      const sweep = child.pid ? sweepDescendants(child.pid, spawnedAtMs) : { killed: [], failed: false };
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputExceeded,
        sweepFailed: sweep.failed,
        ...(processError ? { error: boundedReason(processError) } : {}),
      });
    };

    const terminate = (reason: 'timeout' | 'output'): void => {
      if (reason === 'timeout') timedOut = true;
      else outputExceeded = true;
      if (child.pid) killTree(child.pid);
      else child.kill('SIGKILL');
      forceClose = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, reason === 'timeout' ? 'process did not close after timeout termination' : 'process did not close after output limit termination');
      }, FORCE_CLOSE_MS);
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (settled || timedOut || outputExceeded) return;
      received += chunk.length;
      if (received > outputLimit) {
        terminate('output');
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', error => finish(null, error.message));
    child.once('close', code => finish(code));
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    child.stdin.on('error', () => { /* A process may close stdin before consuming its complete request. */ });
    child.stdin.end(input);
  });
}

function repoWorkspaceDigest(root: string): string | null {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], {
    cwd: root, encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (head.status !== 0 || status.status !== 0 || typeof status.stdout === 'string') return null;
  const paths = status.stdout.toString('utf8').split('\0').filter(Boolean);
  const parts: string[] = [head.stdout.trim()];
  for (const record of paths) {
    if (record.length < 4) return null;
    const relative = record.slice(3);
    const absolute = path.resolve(root, relative);
    const resolved = path.relative(root, absolute);
    if (path.isAbsolute(resolved) || resolved === '..' || resolved.startsWith(`..${path.sep}`)) return null;
    let content: string;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) content = `symlink:${fs.readlinkSync(absolute)}`;
      else if (stat.isFile() && stat.size <= 64 * 1024 * 1024) content = hash(fs.readFileSync(absolute));
      else if (!stat.isFile()) content = stat.isDirectory() ? 'directory' : 'other';
      else return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') content = 'missing';
      else return null;
    }
    parts.push(`${record.slice(0, 2)}:${relative}:${content}`);
  }
  return hash(parts.sort().join('\n'));
}

function localScopeDigest(root: string, requestPath: string): string | null {
  const config = readConfig(root);
  const task = readTaskRecord(root);
  if (!config || config === 'corrupt' || !task) return null;
  const containedRequest = containedRealPath(root, requestPath);
  if (containedRequest === null || path.resolve(containedRequest) !== path.resolve(requestPath)) return null;
  let requestBytesDigest: string;
  try { requestBytesDigest = hash(fs.readFileSync(containedRequest)); }
  catch { return null; }
  return hash(JSON.stringify({
    requestBytesDigest,
    task,
    plan: config.plan,
    authority: config.planAuthority ?? null,
  }));
}

function doctorInvocation(): { executable: string; args: string[] } {
  return path.resolve(CLI_ENTRY) === path.resolve(process.execPath)
    ? { executable: CLI_ENTRY, args: ['doctor'] }
    : { executable: process.execPath, args: [CLI_ENTRY, 'doctor'] };
}

function parseDoctorReport(
  stdout: string,
  request: ValidatedPromptEvidenceRequest,
  runIds: Set<string>,
): { report: VerificationReport; evidence: EvidenceDraft[]; collection: AdapterCollection } | null {
  let envelope: unknown;
  try { envelope = JSON.parse(stdout) as unknown; }
  catch { return null; }
  if (!isRecord(envelope) || envelope.command !== 'doctor' || !isRecord(envelope.promptEvidence)) return null;
  const raw = envelope.promptEvidence;
  if (raw.schema !== 'amabie-prompt-evidence-report/2'
    || raw.taskType !== request.goal.taskType
    || raw.goalDigest !== request.goalDigest
    || raw.scopeDigest !== request.scopeDigest
    || typeof raw.runId !== 'string' || raw.runId.length === 0 || runIds.has(raw.runId)
    || !Number.isSafeInteger(raw.attempt) || !Array.isArray(raw.requirements)
    || !Array.isArray(raw.evidence)) return null;
  runIds.add(raw.runId);

  const expected = new Map(request.requirements.flatMap(requirement => requirement.criteria.map(criterion => [criterion.id, { requirement, criterion }] as const)));
  if (raw.requirements.length !== request.requirements.length) return null;
  for (const row of raw.requirements) {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.text !== 'string' || !Array.isArray(row.criteria)) return null;
    const declaration = request.requirements.find(requirement => requirement.id === row.id);
    if (!declaration || declaration.text !== row.text || row.criteria.length !== declaration.criteria.length) return null;
    const seenCriteria = new Set<string>();
    for (const item of row.criteria) {
      if (!isRecord(item) || typeof item.criterionId !== 'string' || !['met', 'unmet', 'unproven', 'blocked'].includes(String(item.status))) return null;
      if (!declaration.criteria.some(criterion => criterion.id === item.criterionId) || seenCriteria.has(item.criterionId)) return null;
      seenCriteria.add(item.criterionId);
    }
    if (seenCriteria.size !== declaration.criteria.length) return null;
  }

  // The per-requirement block can read PASS while the overall doctor gate refuses (regression evidence,
  // task obligations, failed sealed checks). A refused envelope that still shows an unmet criterion is a
  // real gap: its validated evidence goes through the normal path, so the loop reports FAIL and the
  // correction targets that gap. Without one, nothing in the refused envelope can be trusted, so every
  // criterion takes the refusal label.
  let hasUnmet = false;
  for (const row of raw.requirements) {
    if (!isRecord(row) || !Array.isArray(row.criteria)) return null;
    if (row.criteria.some(item => isRecord(item) && item.status === 'unmet')) hasUnmet = true;
  }
  if (envelope.status !== 'READY' && !hasUnmet) {
    // The refusal keeps the doctor's own label: NOT PROVEN stays unproven, anything else is blocked.
    const reason = `the overall doctor gate returned ${String(envelope.status)}, not READY`;
    const refusal = envelope.status === 'NOT PROVEN'
      ? { blocked: [], unproven: [...expected.keys()].map(criterionId => ({ criterionId, reason })) }
      : { blocked: [...expected.keys()].map(criterionId => ({ criterionId, reason })), unproven: [] };
    return { report: raw as unknown as VerificationReport, evidence: [], collection: { evidence: [], ...refusal } };
  }

  const evidence: EvidenceDraft[] = [];
  const seenEvidence = new Set<string>();
  for (const record of raw.evidence) {
    if (!isRecord(record) || typeof record.id !== 'string' || typeof record.requirementId !== 'string'
      || typeof record.criterionId !== 'string' || typeof record.evidenceType !== 'string'
      || record.adapterId !== CODING_SEALED_PLAN_ADAPTER || record.taskType !== request.goal.taskType
      || record.runId !== raw.runId || record.attempt !== raw.attempt || record.provenance !== 'verifier-collected'
      || !Array.isArray(record.artifactRefs) || !record.artifactRefs.every(ref => typeof ref === 'string')
      || !isRecord(record.integrity) || !evidenceIntegrityValid(record as never)
      || !isRecord(record.facts)) return null;
    const binding = expected.get(record.criterionId);
    if (!binding || binding.requirement.id !== record.requirementId || binding.criterion.evidenceType !== record.evidenceType || seenEvidence.has(record.criterionId)) return null;
    seenEvidence.add(record.criterionId);
    evidence.push({
      requirementId: record.requirementId,
      criterionId: record.criterionId,
      evidenceType: record.evidenceType,
      facts: {
        ...record.facts as Record<string, JsonValue>,
        sourceRunId: record.runId,
        sourceEvidenceId: record.id,
        sourceEvidenceDigest: record.integrity.digest as string,
      },
      artifactRefs: record.artifactRefs as string[],
    });
  }

  const blocked: Array<{ criterionId: string; reason: string }> = [];
  const unproven: Array<{ criterionId: string; reason: string }> = [];
  for (const row of raw.requirements) {
    if (!isRecord(row) || !Array.isArray(row.criteria)) return null;
    for (const item of row.criteria) {
      if (!isRecord(item) || typeof item.criterionId !== 'string') return null;
      if (seenEvidence.has(item.criterionId)) continue;
      if (item.status === 'blocked') blocked.push({ criterionId: item.criterionId, reason: 'the fresh sealed-plan doctor run could not execute this bound check' });
      else unproven.push({ criterionId: item.criterionId, reason: 'the fresh sealed-plan doctor run produced no evidence for this criterion' });
    }
  }
  return { report: raw as unknown as VerificationReport, evidence, collection: { evidence, blocked, unproven } };
}

function parseOptions(args: string[]): { request?: string; executable?: string; agent?: BuiltinCorrectionAgent; agentArgs: string[]; authorized: boolean; json: boolean; maxCorrections?: number; problem?: string } {
  let request: string | undefined;
  let executable: string | undefined;
  let agent: BuiltinCorrectionAgent | undefined;
  let maxCorrections: number | undefined;
  const agentArgs: string[] = [];
  let authorized = false;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = (): string | undefined => {
      const result = args[index + 1];
      if (result === undefined) return undefined;
      index += 1;
      return result;
    };
    if (argument === '--request') {
      if (request !== undefined) return { agentArgs, authorized, json, problem: '--request may be provided once' };
      request = value();
      if (!request) return { agentArgs, authorized, json, problem: '--request needs a path' };
    } else if (argument === '--agent') {
      if (agent !== undefined) return { agentArgs, authorized, json, problem: '--agent may be provided once' };
      const selected = value();
      if (selected !== 'codex' && selected !== 'claude') return { agentArgs, authorized, json, problem: '--agent must be codex or claude' };
      agent = selected;
    } else if (argument === '--agent-executable') {
      if (executable !== undefined) return { agentArgs, authorized, json, problem: '--agent-executable may be provided once' };
      executable = value();
      if (!executable) return { agentArgs, authorized, json, problem: '--agent-executable needs a path or executable name' };
    } else if (argument === '--agent-arg' || argument.startsWith('--agent-arg=')) {
      const item = argument.startsWith('--agent-arg=') ? argument.slice('--agent-arg='.length) : value();
      if (item === undefined) return { agentArgs, authorized, json, problem: '--agent-arg needs one literal argument' };
      agentArgs.push(item);
      if (agentArgs.length > MAX_AGENT_ARGS) return { agentArgs, authorized, json, problem: `at most ${MAX_AGENT_ARGS} --agent-arg values are allowed` };
    } else if (argument === '--authorize-corrections') authorized = true;
    else if (argument === '--max-corrections') {
      if (maxCorrections !== undefined) return { agentArgs, authorized, json, problem: '--max-corrections may be provided once' };
      const limit = value();
      if (!limit || !/^[1-3]$/u.test(limit)) return { agentArgs, authorized, json, problem: `--max-corrections must be an integer from 1 to ${MAX_CORRECTION_CYCLES}` };
      maxCorrections = Number(limit);
    }
    else if (argument === '--json') json = true;
    else return { agentArgs, authorized, json, problem: `unknown prompt-evidence loop option: ${argument}` };
  }
  if (!request) return { agentArgs, authorized, json, problem: '--request is required' };
  if (agent && (executable || agentArgs.length > 0)) return { agentArgs, authorized, json, problem: '--agent profiles cannot be combined with --agent-executable or --agent-arg' };
  if (!agent && !executable) return { agentArgs, authorized, json, problem: 'choose --agent codex|claude or provide --agent-executable' };
  if (executable && (executable.includes('\0') || executable.length > MAX_AGENT_ARG_CHARS)
    || agentArgs.some(item => item.includes('\0') || item.length > MAX_AGENT_ARG_CHARS)) {
    return { agentArgs, authorized, json, problem: 'agent executable and arguments must be NUL-free and no longer than 2,048 characters each' };
  }
  return {
    request,
    ...(executable === undefined ? {} : { executable }),
    ...(agent === undefined ? {} : { agent }),
    agentArgs,
    authorized,
    json,
    ...(maxCorrections === undefined ? {} : { maxCorrections }),
  };
}

function emitResult(value: unknown, json: boolean, maxCorrections: number): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    const result = value as { status: string; correctionAttempts: number; stopReason?: string | null; verification?: VerificationReport };
    console.log(`Prompt-to-Evidence correction loop: ${result.status.toUpperCase()}`);
    console.log(`Corrections: ${result.correctionAttempts} (maximum ${maxCorrections})`);
    if (result.verification) console.log(`Fresh verification: ${result.verification.verdict} (${result.verification.coverage.met}/${result.verification.coverage.total} requirements met)`);
    if (result.stopReason) console.log(`Stopped: ${result.stopReason}`);
  }
}

export async function cmdPromptEvidenceLoop(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.problem) {
    console.error(`usage: amabie prompt-evidence loop --request FILE (--agent codex|claude | --agent-executable PROGRAM [--agent-arg ARG]...) --authorize-corrections [--max-corrections 1..${MAX_CORRECTION_CYCLES}] [--json]\n${options.problem}`);
    return 3;
  }
  const maxCorrections = options.maxCorrections ?? MAX_CORRECTION_CYCLES;
  if (!options.authorized) {
    console.error('correction can modify this project; add --authorize-corrections only when you want this agent to change files');
    return 3;
  }

  const root = findRepoRoot(process.cwd());
  if (!root) { console.error('BLOCKED — prompt-evidence loop requires a configured Git project; no agent was started'); return 2; }
  const requestedPath = path.resolve(root, options.request!);
  const requestPath = containedRealPath(root, requestedPath);
  if (requestPath === null) { console.error('BLOCKED — request must be a regular file inside the project; no agent was started'); return 3; }

  let requestBytes: Buffer;
  let request: ValidatedPromptEvidenceRequest;
  try {
    const stat = fs.statSync(requestPath);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('request must be a regular file no larger than 256 KiB');
    requestBytes = fs.readFileSync(requestPath);
    const task = readTaskRecord(root);
    if (!task) throw new Error('no registered task exists; register the original goal and every requirement before verification');
    request = validatePromptEvidenceRequest(JSON.parse(requestBytes.toString('utf8')) as unknown, { ...task, taskType: 'coding' });
  } catch (error) {
    console.error(`BLOCKED — invalid experimental request: ${boundedReason(error instanceof Error ? error.message : String(error))}; no agent was started`);
    return 3;
  }

  const expectedScope = localScopeDigest(root, requestPath);
  const expectedCliPath = path.resolve(CLI_ENTRY);
  let cliDigest: string;
  try { cliDigest = hash(fs.readFileSync(expectedCliPath)); }
  catch { console.error('BLOCKED — Amabie could not fingerprint its CLI entry; no agent was started'); return 2; }
  if (expectedScope === null) { console.error('BLOCKED — Amabie could not fingerprint the task and sealed plan; no agent was started'); return 2; }

  const requestRelativePath = path.relative(root, requestPath);
  const agentInvocation = options.agent
    ? buildCorrectionAgentInvocation(options.agent, root)
    : { executable: options.executable!, args: options.agentArgs };
  const agentEnvironment = options.agent
    ? buildCorrectionAgentEnvironment(process.env, options.agent)
    : process.env;
  const doctor = doctorInvocation();
  const childRunIds = new Set<string>();
  const agentProcessDiagnostics: AgentProcessDiagnostic[] = [];
  let claudeVersionPreflightPassed = false;
  const adapter: VerifierAdapter = {
    id: CODING_SEALED_PLAN_ADAPTER,
    taskType: 'coding',
    async collect(_validated, criteria): Promise<AdapterCollection> {
      const currentScope = localScopeDigest(root, requestPath);
      let currentCliDigest: string;
      try { currentCliDigest = hash(fs.readFileSync(expectedCliPath)); }
      catch { currentCliDigest = ''; }
      if (currentScope !== expectedScope || currentCliDigest !== cliDigest) {
        return { evidence: [], blocked: criteria.map(({ criterion }) => ({ criterionId: criterion.id, reason: 'the request, registered task, sealed plan, or Amabie CLI changed during the correction loop' })) };
      }
      console.error('[P2E] Running the complete sealed plan for fresh evidence.');
      const run = await runBoundedProcess(
        doctor.executable,
        [...doctor.args, '--prompt-evidence', requestRelativePath, '--json'],
        root,
        '',
        DOCTOR_TIMEOUT_MS,
        MAX_DOCTOR_OUTPUT_BYTES,
      );
      if (run.exitCode === null || run.exitCode !== 0 && run.exitCode !== 2
        || run.timedOut || run.outputExceeded || run.sweepFailed) {
        const reason = run.timedOut ? 'the full sealed-plan verification timed out'
          : run.outputExceeded ? 'the Amabie doctor response exceeded its output limit'
            : run.sweepFailed ? 'Amabie could not confirm cleanup of verification child processes'
              : run.error ?? `Amabie doctor exited ${run.exitCode ?? 'without an exit code'}`;
        return { evidence: [], blocked: criteria.map(({ criterion }) => ({ criterionId: criterion.id, reason })) };
      }
      const parsed = parseDoctorReport(run.stdout, request, childRunIds);
      if (!parsed) return { evidence: [], blocked: criteria.map(({ criterion }) => ({ criterionId: criterion.id, reason: 'the fresh doctor run did not return a valid, scope-matched per-requirement evidence report' })) };
      return parsed.collection;
    },
  };

  const result = await runBoundedCorrectionLoop({
    request,
    adapters: [adapter],
    authorized: true,
    maxAttempts: maxCorrections,
    makeRunId: () => randomUUID(),
    async correct({ report, cycle }) {
      const currentScope = localScopeDigest(root, requestPath);
      if (currentScope !== expectedScope) return { outcome: 'applied', scopeDigest: 'changed-before-correction' };
      const before = repoWorkspaceDigest(root);
      if (before === null) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Amabie could not fingerprint Git-visible project files before invoking the correction agent' };
      const correctionInput = JSON.stringify({
        schema: CORRECTION_SCHEMA,
        cycle,
        goal: { taskType: request.goal.taskType, text: request.goal.text },
        report,
      }, null, 2);
      if (Buffer.byteLength(correctionInput, 'utf8') > MAX_AGENT_INPUT_BYTES) {
        return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'the structured correction report exceeded the agent input limit' };
      }
      if (options.agent === 'claude' && !claudeVersionPreflightPassed) {
        const versionRun = await runBoundedProcess(
          agentInvocation.executable,
          ['--version'],
          root,
          '',
          AGENT_PREFLIGHT_TIMEOUT_MS,
          MAX_AGENT_PREFLIGHT_OUTPUT_BYTES,
          agentEnvironment,
        );
        if (versionRun.timedOut || versionRun.outputExceeded || versionRun.sweepFailed
          || versionRun.error || versionRun.exitCode !== 0) {
          let reason: string;
          if (versionRun.timedOut) reason = 'Claude Code version preflight timed out';
          else if (versionRun.outputExceeded) reason = 'Claude Code version preflight exceeded its output limit';
          else if (versionRun.sweepFailed) reason = 'Amabie could not confirm cleanup of the Claude Code version process';
          else if (versionRun.error) reason = `Claude Code version preflight failed: ${versionRun.error}`;
          else reason = `Claude Code version preflight exited ${versionRun.exitCode ?? 'without an exit code'}`;
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `${reason}; no correction request was sent` };
        }
        if (localScopeDigest(root, requestPath) !== expectedScope || repoWorkspaceDigest(root) !== before) {
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'the project changed during Claude Code version preflight; no correction request was sent' };
        }
        const version = evaluateClaudeCodeVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
        if (!version) {
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Claude Code returned an unparseable version; version 2.1.248 or newer is required; no correction request was sent' };
        }
        if (!version.supported) {
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `Claude Code ${version.version} is unsupported; version ${version.minimumVersion} or newer is required; no correction request was sent` };
        }
        claudeVersionPreflightPassed = true;
        console.error(`[P2E] Claude Code ${version.version} satisfies the built-in profile minimum ${version.minimumVersion}.`);
      }
      console.error('[P2E] Safety warning: Correction agents edit this working tree directly; changes are not automatically rolled back. Use a disposable Git worktree and inspect the diff.');
      const agentInput = options.agent ? renderCorrectionAgentPrompt(correctionInput) : correctionInput;
      console.error(`[P2E] Correction ${cycle}/${maxCorrections}: invoking ${options.agent ?? path.basename(agentInvocation.executable)} with the scoped report.`);
      const agent = await runBoundedProcess(agentInvocation.executable, agentInvocation.args, root, agentInput, AGENT_TIMEOUT_MS, MAX_AGENT_OUTPUT_BYTES, agentEnvironment);
      agentProcessDiagnostics.push(summarizeAgentProcess(cycle, agent));
      const afterScope = localScopeDigest(root, requestPath);
      if (afterScope !== expectedScope) return { outcome: 'applied', scopeDigest: 'changed-by-correction-agent' };
      if (agent.timedOut) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'correction agent timed out and was terminated' };
      if (agent.outputExceeded) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'correction agent exceeded the output limit and was terminated' };
      if (agent.sweepFailed) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Amabie could not confirm cleanup of the correction agent process tree' };
      if (agent.error) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `correction agent could not run: ${agent.error}` };
      if (agent.exitCode !== 0) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `correction agent exited ${agent.exitCode ?? 'without an exit code'}; its claims are not evidence` };
      const after = repoWorkspaceDigest(root);
      if (after === null) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Amabie could not fingerprint Git-visible project files after the correction agent ran' };
      if (after === before) return { outcome: 'no-change', scopeDigest: request.scopeDigest, reason: 'correction agent reported success but made no Git-visible project change' };
      console.error(`[P2E] Correction ${cycle} changed the project; Amabie will rerun every sealed check.`);
      return { outcome: 'applied', scopeDigest: request.scopeDigest };
    },
  });

  const envelope = {
    schema: LOOP_SCHEMA,
    status: result.status,
    correctionAttempts: result.correctionAttempts,
    correctionReport: result.correctionReport,
    verification: result.verification,
    stopReason: result.stopReason,
    sourceCoverage: request.sourceCoverage,
    agentClaimUsedAsEvidence: false,
    agentProcessDiagnostics,
  };
  emitResult(envelope, options.json, maxCorrections);
  return result.status === 'verified' && result.verification.verdict === 'PASS' ? 0 : 2;
}
