import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { SpawnSyncReturns } from 'node:child_process';
import type { SweepResult } from './index.js';

export interface WindowsSyncOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

type Failure = { message: string; code: string };
type Result = { pid: number; status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Failure };
type Message = { type: 'held'; pid: number; spawnedAtMs: number } | { type: 'result'; result: Result };
type Request = WindowsSyncOptions & { file: string; args: string[] };

/** Closure-free source-owned bootstrap, so esbuild/SEA need no executable sidecar. */
function bootstrap(nodeRequire: NodeRequire): void {
  // A parameter keeps ESM bundlers from rewriting these into an outer __require
  // closure that would not exist in the independent Worker realm.
  const { workerData } = nodeRequire('node:worker_threads') as typeof import('node:worker_threads');
  const { spawn } = nodeRequire('node:child_process') as typeof import('node:child_process');
  const data = workerData as { request: Request; control: SharedArrayBuffer; port: import('node:worker_threads').MessagePort };
  const control = new Int32Array(data.control);
  const request = data.request;
  const send = (message: Message): void => {
    data.port.postMessage(message);
    Atomics.add(control, 0, 1);
    Atomics.notify(control, 0);
  };
  if (Atomics.load(control, 2) !== 0) {
    send({ type: 'result', result: { pid: 0, status: null, signal: null, stdout: '', stderr: '',
      error: { code: 'ETIMEDOUT', message: 'Windows process bridge cancelled before spawn' } } });
    data.port.close();
    return;
  }
  let child: import('node:child_process').ChildProcessWithoutNullStreams;
  try {
    child = spawn(request.file, request.args, { cwd: request.cwd, env: request.env,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
  } catch (error) {
    send({ type: 'result', result: { pid: 0, status: null, signal: null, stdout: '', stderr: '',
      error: { code: (error as NodeJS.ErrnoException).code ?? 'EIO', message: String((error as Error).message) } } });
    data.port.close();
    return;
  }
  const spawnedAtMs = Date.now();
  let failure: Failure | undefined;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let stdoutSize = 0, stderrSize = 0;
  const stop = (error: Failure): void => {
    failure ??= error;
    // The ChildProcess object still owns the original native handle. No numeric kill.
    try { child.kill('SIGTERM'); } catch { /* the result remains unconfirmed */ }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    const room = Math.max(0, request.maxBuffer - stdoutSize);
    if (room) stdout.push(chunk.subarray(0, room));
    stdoutSize += chunk.length;
    if (stdoutSize > request.maxBuffer) stop({ code: 'ENOBUFS', message: 'stdout maxBuffer exceeded' });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const room = Math.max(0, request.maxBuffer - stderrSize);
    if (room) stderr.push(chunk.subarray(0, room));
    stderrSize += chunk.length;
    if (stderrSize > request.maxBuffer) stop({ code: 'ENOBUFS', message: 'stderr maxBuffer exceeded' });
  });
  child.on('error', error => { failure ??= { code: (error as NodeJS.ErrnoException).code ?? 'EIO', message: error.message }; });
  const timer = setTimeout(() => stop({ code: 'ETIMEDOUT', message: 'project command timed out' }), request.timeout);
  const cancellation = setInterval(() => {
    if (Atomics.load(control, 2)) stop({ code: 'ETIMEDOUT', message: 'Windows process bridge cancelled' });
  }, 10);
  child.on('exit', () => {
    clearTimeout(timer);
    clearInterval(cancellation);
    if (child.pid !== undefined) {
      send({ type: 'held', pid: child.pid, spawnedAtMs });
      // Returning would allow libuv to close the ORIGINAL kernel process object.
      // The parent releases this only after its bounded kill-capable sweep returns.
      while (Atomics.load(control, 1) === 0) Atomics.wait(control, 1, 0);
    }
  });
  child.on('close', (status, signal) => {
    clearTimeout(timer);
    clearInterval(cancellation);
    send({ type: 'result', result: { pid: child.pid ?? 0, status: child.pid === undefined ? null : status, signal,
      stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
      ...(failure === undefined ? {} : { error: failure }) } });
    data.port.close();
  });
}

/** @internal Synchronous caller, asynchronous child whose original identity survives cleanup. */
export function windowsSyncProcess(file: string, args: readonly string[], options: WindowsSyncOptions,
  helperEnv: NodeJS.ProcessEnv, cleanup: (pid: number, spawnedAtMs: number) => SweepResult): SpawnSyncReturns<string> {
  if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0 || !Number.isSafeInteger(options.maxBuffer) || options.maxBuffer <= 0) {
    throw new RangeError('Windows process bridge requires positive bounded timeout and output limits');
  }
  const channel = new MessageChannel();
  const control = new Int32Array(new SharedArrayBuffer(12));
  let worker: Worker | undefined;
  let result: Result | undefined;
  let held = false, cleanupFailed = false;
  // The command's OWN timer is unchanged. This also bounds startup/transport failure.
  let deadline = performance.now() + options.timeout + 5_000;
  try {
    worker = new Worker(`(${bootstrap.toString()})(require);`, { eval: true, execArgv: [], env: helperEnv,
      workerData: { port: channel.port2, control: control.buffer, request: { ...options, file, args: [...args] } },
      transferList: [channel.port2] });
    // Main-thread event callbacks cannot run while this synchronous bridge waits.
    // Missing transport is handled by the bounded control deadline, never a pass.
    worker.on('error', () => {});
    while (result === undefined) {
      const seen = Atomics.load(control, 0);
      const message = receiveMessageOnPort(channel.port1)?.message as Message | undefined;
      if (!message) {
        if (performance.now() >= deadline) {
          Atomics.store(control, 2, 1);
          throw new Error('Windows process bridge did not confirm command completion');
        }
        Atomics.wait(control, 0, seen, Math.min(20, Math.max(1, deadline - performance.now())));
        continue;
      }
      if (message.type === 'held') {
        if (held || !Number.isSafeInteger(message.pid) || message.pid <= 0 || !Number.isFinite(message.spawnedAtMs)) {
          throw new Error('invalid Windows process lifetime handshake');
        }
        held = true;
        const sweepStarted = performance.now();
        try { cleanupFailed = cleanup(message.pid, message.spawnedAtMs).failed; }
        catch { cleanupFailed = true; }
        finally {
          Atomics.store(control, 1, 1);
          Atomics.notify(control, 1);
        }
        // Existing cleanup has its own caps; do not charge its time to the project command.
        deadline = Math.max(deadline + performance.now() - sweepStarted, performance.now() + 5_000);
      } else if (message.type === 'result') result = message.result;
      else throw new Error('invalid Windows process bridge message');
    }
  } catch (error) {
    result = { pid: 0, status: null, signal: null, stdout: '', stderr: '',
      error: { code: 'EIO', message: String((error as Error).message) } };
    cleanupFailed = true;
  } finally {
    // No sweep is active here: its synchronous call has returned through finally.
    Atomics.store(control, 2, 1);
    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1);
    channel.port1.close();
    channel.port2.close();
    void worker?.terminate().catch(() => {});
  }
  const error = result.error === undefined ? undefined : Object.assign(new Error(result.error.message), { code: result.error.code });
  const finalError = error ?? ((cleanupFailed || (result.pid > 0 && !held))
    ? new Error('post-run containment sweep could not confirm zero surviving descendants') : undefined);
  return { pid: result.pid, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    output: [null, result.stdout, result.stderr], ...(finalError === undefined ? {} : { error: finalError }) };
}
