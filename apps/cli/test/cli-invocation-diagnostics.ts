import type { SpawnSyncReturns } from 'node:child_process';

/** Preserve failed fixture CLI output that a status-only assertion would otherwise discard. */
export function retainCliInvocation(run: () => SpawnSyncReturns<string>): SpawnSyncReturns<string> {
  const startedAt = new Date().toISOString(), start = performance.now();
  const result = run();
  if (process.env.AMABIE_TRACE_WINDOWS_SWEEP === '1' && (result.status !== 0 || result.error)) {
    process.stderr.write(`amabie-cli-test-invocation ${JSON.stringify({
      schema: 'amabie-cli-test-invocation/1', diagnosticOnly: true,
      callerPid: process.pid, childPid: result.pid, startedAt, finishedAt: new Date().toISOString(),
      durationMs: performance.now() - start, status: result.status, signal: result.signal,
      errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
      errorMessage: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr,
    })}\n`);
  }
  return result;
}
