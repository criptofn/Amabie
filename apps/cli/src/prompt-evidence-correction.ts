import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { retainAgentProcessOutput, type AgentOutputStage, type RetainedAgentOutput } from './agent-process-output.js';
import {
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
import { isolateCreate, loadRecord, verifyCandidate, type CandidateRecord } from './candidate.js';
import { CLI_ENTRY, Out, containedRealPath, findRepoRoot, planDigest, planWithFreshTests, readConfig, readTaskRecord, type AmabieConfig, type StepResult } from './onboarding.js';
import { CODING_SEALED_PLAN_ADAPTER, createCodingSealedPlanAdapter, type SealedStepResult } from './prompt-evidence.js';
import {
  buildCorrectionAgentEnvironment,
  AGENT_HELP_PROBES,
  missingAgentFlags,
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
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_AGENT_PREFLIGHT_OUTPUT_BYTES = 4 * 1024;
const FORCE_CLOSE_MS = 2_000;

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutRaw?: Buffer;
  stderrRaw?: Buffer;
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
    stdoutBytes: result.stdoutRaw?.length ?? Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: result.stderrRaw?.length ?? Buffer.byteLength(result.stderr, 'utf8'),
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
      const stdoutRaw = Buffer.concat(stdout);
      const stderrRaw = Buffer.concat(stderr);
      resolve({
        exitCode,
        stdout: stdoutRaw.toString('utf8'),
        stderr: stderrRaw.toString('utf8'),
        stdoutRaw,
        stderrRaw,
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

/** Make a fresh candidate worktree (committed HEAD) equal to the base's Git-visible working tree, so the
 *  first evaluation judges the work in progress. Returns a reason on failure, null on success. */
function seedCandidateFromWorkingTree(root: string, candidateRoot: string): string | null {
  const git = (cwd: string, args: string[], input?: Buffer) => spawnSync('git', ['-C', cwd, ...args], { input, maxBuffer: 256 * 1024 * 1024 });
  const diff = git(root, ['diff', 'HEAD', '--binary']);
  if (diff.status !== 0) return 'Amabie could not read the working-tree changes to seed the candidate';
  if (diff.stdout.length > 0 && git(candidateRoot, ['apply', '--binary', '--whitespace=nowarn'], diff.stdout).status !== 0) {
    return 'Amabie could not apply the working-tree changes inside the candidate';
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.status !== 0) return 'Amabie could not list untracked files to seed the candidate';
  for (const rel of untracked.stdout.toString('utf8').split('\0').filter(Boolean)) {
    if (rel === '.amabie' || rel.startsWith('.amabie/')) continue; // the base's own request/authority stays with the base
    const target = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, rel), target);
  }
  if (git(candidateRoot, ['add', '-A']).status !== 0) return 'Amabie could not stage the seeded candidate';
  if (git(candidateRoot, ['status', '--porcelain']).stdout.length === 0) return null;
  const committed = git(candidateRoot, ['-c', 'user.name=Amabie', '-c', 'user.email=amabie@localhost', 'commit', '-m', 'Seed candidate from working tree']);
  return committed.status === 0 ? null : 'Amabie could not commit the seeded candidate';
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

function parseOptions(args: string[]): { request?: string; executable?: string; agent?: BuiltinCorrectionAgent; agentArgs: string[]; authorized: boolean; json: boolean; maxCorrections?: number; retainAgentOutput?: boolean; problem?: string } {
  let request: string | undefined;
  let executable: string | undefined;
  let agent: BuiltinCorrectionAgent | undefined;
  let maxCorrections: number | undefined;
  const agentArgs: string[] = [];
  let authorized = false;
  let json = false;
  let retainAgentOutput = false;
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
    else if (argument === '--retain-agent-output') retainAgentOutput = true;
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
    retainAgentOutput,
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
    console.log('Execution: ordinary process in a disposable candidate (no OS confinement, not an enforced gateway).');
    if (result.stopReason) console.log(`Stopped: ${result.stopReason}`);
    const cand = (value as { candidate?: { diffCommand: string } | null }).candidate;
    if (cand) console.log(`Candidate diff (nothing adopted): ${cand.diffCommand}`);
  }
}

export async function cmdPromptEvidenceLoop(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.problem) {
    console.error(`usage: amabie prompt-evidence loop --request FILE (--agent codex|claude | --agent-executable PROGRAM [--agent-arg ARG]...) --authorize-corrections [--max-corrections 1..${MAX_CORRECTION_CYCLES}] [--retain-agent-output] [--json]\n${options.problem}`);
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

  const agentInvocation = options.agent
    ? buildCorrectionAgentInvocation(options.agent, root)
    : { executable: options.executable!, args: options.agentArgs };
  const agentEnvironment = options.agent
    ? buildCorrectionAgentEnvironment(process.env, options.agent)
    : process.env;
  const agentProcessDiagnostics: AgentProcessDiagnostic[] = [];
  const agentOutputLogs: RetainedAgentOutput[] = [];
  const retainOutput = (cycle: number, stage: AgentOutputStage, output: ProcessResult): string | null => {
    if (!options.retainAgentOutput) return null;
    try {
      const retained = retainAgentProcessOutput(root, cycle, stage, output);
      agentOutputLogs.push(retained);
      console.error(`[P2E] Local agent diagnostics retained at ${retained.directory}; these may contain sensitive text and are not verification evidence.`);
      return null;
    } catch (error) {
      return `agent output retention failed; correction stopped: ${boundedReason(error instanceof Error ? error.message : String(error))}`;
    }
  };
  let claudeVersionPreflightPassed = false;
  let agentHelpPreflightPassed = false;
  // The correction agent only ever edits a disposable candidate worktree of the
  // base's committed HEAD; the base project is never touched by the loop.
  let candidate = null as { name: string; rec: CandidateRecord; cfg: AmabieConfig } | null;
  const sealedAdapter = (cfg: AmabieConfig, results: StepResult[]): VerifierAdapter => {
    const resultsByScript = new Map<string, SealedStepResult[]>();
    planWithFreshTests(cfg.plan).forEach((step, index) => {
      const result = results[index];
      if (!result) return;
      resultsByScript.set(step.script, [...(resultsByScript.get(step.script) ?? []), {
        ok: result.ok,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        execDigest: result.exec.digest,
        stdout: result.stdout,
        stderr: result.stderr,
      }]);
    });
    return createCodingSealedPlanAdapter({
      plan: cfg.plan,
      proofBindings: cfg.planAuthority?.proofBindings ?? {},
      resultsByScript,
      refusedScripts: new Set(),
      planDigest: planDigest(cfg.plan),
      baselineDigest: cfg.baseline?.head ?? null,
    });
  };
  const adapter: VerifierAdapter = {
    id: CODING_SEALED_PLAN_ADAPTER,
    taskType: 'coding',
    async collect(validated, criteria, context): Promise<AdapterCollection> {
      const blockAll = (reason: string): AdapterCollection => ({ evidence: [], blocked: criteria.map(({ criterion }) => ({ criterionId: criterion.id, reason })) });
      const currentScope = localScopeDigest(root, requestPath);
      let currentCliDigest: string;
      try { currentCliDigest = hash(fs.readFileSync(expectedCliPath)); }
      catch { currentCliDigest = ''; }
      if (currentScope !== expectedScope || currentCliDigest !== cliDigest) {
        return blockAll('the request, registered task, sealed plan, or Amabie CLI changed during the correction loop');
      }
      const quiet = new Out(false, true);
      if (!candidate) {
        const cfg = readConfig(root);
        if (!cfg || cfg === 'corrupt') return blockAll('the project has no readable Amabie configuration, so no candidate can be created');
        const name = `p2e-${randomUUID().slice(0, 8)}`;
        if (isolateCreate(root, cfg, quiet, name, 'HEAD', null) !== 0) return blockAll('Amabie could not create the disposable candidate worktree');
        const rec = loadRecord(root, name);
        if (rec === 'missing' || rec === 'invalid') return blockAll('the disposable candidate record is not readable');
        candidate = { name, rec, cfg };
        console.error(`[P2E] Candidate ${name} created at ${rec.root}.`);
        const seeded = seedCandidateFromWorkingTree(root, rec.root);
        if (seeded) return blockAll(seeded);
      } else {
        const git = (args: string[]) => spawnSync('git', ['-C', candidate!.rec.root, ...args], { encoding: 'utf8' });
        const dirty = git(['status', '--porcelain']);
        if (dirty.status !== 0) return blockAll('Amabie could not read the candidate status');
        if (dirty.stdout.trim()) {
          const staged = git(['add', '-A']);
          const committed = staged.status === 0
            ? git(['-c', 'user.name=Amabie', '-c', 'user.email=amabie@localhost', 'commit', '-m', `Apply correction ${context.attempt}`])
            : staged;
          if (committed.status !== 0) return blockAll('Amabie could not commit the correction inside the candidate');
        }
      }
      console.error('[P2E] Running the complete sealed plan on the candidate for fresh evidence.');
      const sink = { results: [] as StepResult[], open: [] as string[] };
      const outcome = verifyCandidate(root, candidate.cfg, quiet, candidate.name, sink);
      const collection = await sealedAdapter(candidate.cfg, sink.results).collect(validated, criteria, context);
      const unmet = collection.evidence.some((item: EvidenceDraft) => typeof item.facts === 'object' && item.facts !== null && !Array.isArray(item.facts) && (item.facts as { ok?: JsonValue }).ok === false);
      if (outcome.code !== 0 && !unmet) {
        const open = sink.open.length ?`; open total obligations: ${sink.open.join(' | ')}` : '';
        return { evidence: [], unproven: criteria.map(({ criterion }) => ({ criterionId: criterion.id, reason: `the overall candidate gate did not return PASS${open}` })) };
      }
      return collection;
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
      if (!candidate) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'no disposable candidate exists to receive the correction' };
      const cand = candidate;
      const before = repoWorkspaceDigest(cand.rec.root);
      const baseBefore = repoWorkspaceDigest(root);
      if (before === null || baseBefore === null) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Amabie could not fingerprint Git-visible project files before invoking the correction agent' };
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
        const retentionProblem = retainOutput(cycle, 'version-preflight', versionRun);
        if (retentionProblem) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: retentionProblem };
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
        if (localScopeDigest(root, requestPath) !== expectedScope || repoWorkspaceDigest(root) !== baseBefore) {
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
      if (options.agent && !agentHelpPreflightPassed) {
        const probe = AGENT_HELP_PROBES[options.agent];
        const helpRun = await runBoundedProcess(
          agentInvocation.executable, probe.args, root, '',
          AGENT_PREFLIGHT_TIMEOUT_MS, MAX_AGENT_PREFLIGHT_OUTPUT_BYTES * 16, agentEnvironment,
        );
        const retentionProblem = retainOutput(cycle, 'capability-preflight', helpRun);
        if (retentionProblem) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: retentionProblem };
        if (helpRun.timedOut || helpRun.outputExceeded || helpRun.sweepFailed || helpRun.error || helpRun.exitCode !== 0) {
          const cause = helpRun.timedOut ? 'timed out' : helpRun.outputExceeded ? 'exceeded its output limit'
            : helpRun.sweepFailed ? 'could not be cleaned up' : helpRun.error ? boundedReason(helpRun.error)
              : `exited ${helpRun.exitCode ?? 'without an exit code'}`;
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `${options.agent} capability preflight ${cause}; no correction request was sent` };
        }
        if (localScopeDigest(root, requestPath) !== expectedScope || repoWorkspaceDigest(root) !== baseBefore) {
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `the project changed during ${options.agent} capability preflight; no correction request was sent` };
        }
        const missing = missingAgentFlags(options.agent, `${helpRun.stdout} ${helpRun.stderr}`);
        if (missing.length > 0) {
          return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `${options.agent} does not advertise required option(s) ${missing.join(', ')}; no correction request was sent` };
        }
        agentHelpPreflightPassed = true;
      }
      console.error('[P2E] Safety warning: The correction agent edits a disposable candidate worktree, not this project. Git-visible working-tree changes are copied into the candidate; ignored files are not copied. Inspect the candidate diff before adopting anything. This is not an OS isolation boundary.');
      const agentInput = options.agent ? renderCorrectionAgentPrompt(correctionInput) : correctionInput;
      console.error(`[P2E] Correction ${cycle}/${maxCorrections}: invoking ${options.agent ?? path.basename(agentInvocation.executable)} with the scoped report.`);
      // A built-in profile must work in the candidate, not the base, so its working-directory option is rebuilt per cycle.
      const invocation = options.agent ? buildCorrectionAgentInvocation(options.agent, cand.rec.root) : agentInvocation;
      const agent = await runBoundedProcess(invocation.executable, invocation.args, cand.rec.root, agentInput, AGENT_TIMEOUT_MS, MAX_AGENT_OUTPUT_BYTES, agentEnvironment);
      agentProcessDiagnostics.push(summarizeAgentProcess(cycle, agent));
      const retentionProblem = retainOutput(cycle, 'correction', agent);
      if (retentionProblem) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: retentionProblem };
      const afterScope = localScopeDigest(root, requestPath);
      if (afterScope !== expectedScope) return { outcome: 'applied', scopeDigest: 'changed-by-correction-agent' };
      if (repoWorkspaceDigest(root) !== baseBefore) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'the correction agent modified the authoritative project outside its candidate' };
      if (agent.timedOut) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'correction agent timed out and was terminated' };
      if (agent.outputExceeded) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'correction agent exceeded the output limit and was terminated' };
      if (agent.sweepFailed) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Amabie could not confirm cleanup of the correction agent process tree' };
      if (agent.error) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `correction agent could not run: ${agent.error}` };
      if (agent.exitCode !== 0) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: `correction agent exited ${agent.exitCode ?? 'without an exit code'}; its claims are not evidence` };
      const after = repoWorkspaceDigest(cand.rec.root);
      if (after === null) return { outcome: 'blocked', scopeDigest: request.scopeDigest, reason: 'Amabie could not fingerprint Git-visible project files after the correction agent ran' };
      if (after === before) return { outcome: 'no-change', scopeDigest: request.scopeDigest, reason: 'correction agent reported success but made no Git-visible candidate change' };
      console.error(`[P2E] Correction ${cycle} changed the candidate; Amabie will rerun every sealed check.`);
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
    execution: { adapter: 'ordinary-process', osConfinement: false, enforcedGateway: false },
    agentProcessDiagnostics,
    ...(options.retainAgentOutput ? { agentOutputLogs } : {}),
    candidate: candidate ? { name: candidate.name, path: candidate.rec.root, baseHead: candidate.rec.baseHead, diffCommand: `git -C "${candidate.rec.root}" diff ${candidate.rec.baseHead}` } : null,
  };
  emitResult(envelope, options.json, maxCorrections);
  return result.status === 'verified' && result.verification.verdict === 'PASS' ? 0 : 2;
}
