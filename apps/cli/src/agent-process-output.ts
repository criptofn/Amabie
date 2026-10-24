import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type AgentOutputStage = 'version-preflight' | 'capability-preflight' | 'correction';
interface ProcessOutput {
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

export interface RetainedAgentOutput {
  directory: string;
  diagnosticOnly: true;
  cycle: number;
  stage: AgentOutputStage;
}

/** Opt-in LOCAL diagnostics, never verifier evidence. A same-user process can still tamper with these files. */
export function retainAgentProcessOutput(root: string, cycle: number, stage: AgentOutputStage, output: ProcessOutput): RetainedAgentOutput {
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 3) throw new Error('invalid correction cycle');
  if (!['version-preflight', 'capability-preflight', 'correction'].includes(stage)) throw new Error('invalid process stage');
  const stdoutBytes = output.stdoutRaw ?? Buffer.from(output.stdout, 'utf8');
  const stderrBytes = output.stderrRaw ?? Buffer.from(output.stderr, 'utf8');
  if (stdoutBytes.length + stderrBytes.length > 1024 * 1024) throw new Error('agent output exceeds the retention limit');
  let parent = root;
  for (const name of ['.amabie', 'agent-output']) {
    parent = path.join(parent, name);
    try { fs.mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('agent output directory must not be a link or non-directory');
  }
  const directory = fs.mkdtempSync(path.join(parent, `cycle-${cycle}-${stage}-`));
  const write = (name: string, bytes: Buffer) => {
    const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return { file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const stdout = write('stdout.log', stdoutBytes);
  const stderr = write('stderr.log', stderrBytes);
  write('process.json', Buffer.from(JSON.stringify({
    schema: 'amabie-agent-process-diagnostics/1', diagnosticOnly: true, cycle, stage,
    exitCode: output.exitCode, timedOut: output.timedOut, outputExceeded: output.outputExceeded,
    sweepFailed: output.sweepFailed, ...(output.error ? { error: output.error } : {}), stdout, stderr,
  }, null, 2) + '\n', 'utf8'));
  return { directory, diagnosticOnly: true, cycle, stage };
}
