import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const PROBE = path.resolve(import.meta.dirname, '..', 'probes', 'v14-codex-stop-hook.mjs');
const GATE = 'AMABIE_ALLOW_CODEX_PROVIDER_USAGE';

/** A fake `codex` on PATH: every invocation appends its argv to `marker`, so a test can tell whether
 *  the probe started a provider-capable process at all. Both spellings the probe resolves are written. */
function makeCodexShim(dir, marker) {
  const bin = path.join(dir, 'shim-bin');
  const pkgBin = path.join(bin, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(pkgBin, { recursive: true });
  const body = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');\n`
    + "process.stdout.write('codex-cli 0.0.0-shim\\n');\n";
  fs.writeFileSync(path.join(pkgBin, 'codex.js'), body);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  return bin;
}

/** Run the probe with a shimmed codex and an isolated home holding a dummy auth file, so the
 *  "operator has credentials" precondition is met and only the opt-in decides whether codex runs. */
function runProbe(optIn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-codex-gate-test-'));
  try {
    const marker = path.join(temp, 'codex-invocations.log');
    const shimBin = makeCodexShim(temp, marker);
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
    env[pathKey] = `${shimBin}${path.delimiter}${env[pathKey] ?? ''}`;
    delete env[GATE];
    if (optIn) env[GATE] = '1';
    const r = spawnSync(process.execPath, [PROBE], { env, encoding: 'utf8', timeout: 600_000 });
    const invoked = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [];
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status, invoked };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('without an explicit opt-in the probe never starts a codex process, even with a CLI and credentials present', () => {
  const { out, invoked } = runProbe(false);
  assert.deepEqual(invoked, [], 'no codex invocation (not even --version) may happen without the operator opt-in');
  assert.match(out, new RegExp(`SKIP v14-end-to-end: NOT RUN .*${GATE}=1`), 'the skipped live arm names the required opt-in');
  assert.doesNotMatch(out, /^FAIL v14-end-to-end/m, 'the unapproved live arm is a SKIP, not a failure');
});

test('with the explicit opt-in the probe runs the live codex arm (authorized control)', () => {
  const { out, invoked } = runProbe(true);
  assert.ok(invoked.length > 0, `codex was invoked once the operator opted in\n${out}`);
  assert.ok(invoked.some(argv => argv.split(' ').includes('exec')), `the live arm starts a codex exec session\n${out}`);
  assert.match(out, /INFO codex entry point:/, 'the probe reports which codex entry point it used');
});
