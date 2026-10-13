import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { killTree, sweepDescendants } from '../../packages/support/dist/src/index.js';

/** Record live output and contain the owned child before restoring mutated files. */
export function runProbe(command, args, { cwd, timeout, prefix, shell = false } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const files = prefix ? [fs.openSync(`${prefix}.stdout.log`, 'wx'), fs.openSync(`${prefix}.stderr.log`, 'wx')] : [];
    let stdout = '', stderr = '', error, timedOut = false, cleaned = false;
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    let timer;
    const child = spawn(command, args, { cwd, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (child.pid && sweepDescendants(child.pid, startedAt).failed) error ??= Object.assign(new Error('Probe descendant cleanup could not be confirmed'), { code: 'ECLEANUP' });
    };
    const stop = () => { if (child.exitCode === null && child.pid) { killTree(child.pid); child.kill('SIGKILL'); } };
    const interrupted = () => { error = Object.assign(new Error('Probe interrupted'), { code: 'EINTR' }); stop(); cleanup(); };
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.on('data', bytes => {
        if (files[index] !== undefined) fs.writeSync(files[index], bytes);
        if (index === 0) stdout += decoders[0].write(bytes); else stderr += decoders[1].write(bytes);
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024 * 1024) {
          error ??= Object.assign(new Error('Probe output exceeded 64 MiB'), { code: 'ENOBUFS' }); stop();
        }
      });
    }
    child.once('error', e => { error = e; });
    child.once('exit', cleanup);
    child.once('close', (status, signal) => {
      clearTimeout(timer); cleanup();
      stdout += decoders[0].end(); stderr += decoders[1].end();
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      for (const fd of files) fs.closeSync(fd);
      resolve({ status, signal, stdout, stderr, error, timedOut, durationMs: Date.now() - startedAt });
    });
    timer = setTimeout(() => {
      timedOut = true;
      error = Object.assign(new Error(`Probe exceeded ${timeout} ms`), { code: 'ETIMEDOUT' });
      stop(); cleanup();
    }, timeout);
  });
}
