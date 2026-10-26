#!/usr/bin/env node
/**
 * T33 isolated first-user test. A fresh agent process gets ONLY the user docs
 * (README.md, QUICKSTART.md) and the prepared tarball in an empty temp dir, with the
 * global npm prefix redirected into that dir (nothing machine-wide is touched).
 * The agent's report is printed for reading; the PASS/FAIL lines are measured by this
 * probe itself, not taken from the agent. Needs `node tooling/pack.mjs` first.
 * Limit: the agent runs under the user's own agent profile, so global instructions
 * of that profile are not removed; the prompt tells it to use the two documents only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = path.join(ROOT, 'pack', 'npm');
const CLAUDE = process.env.AMABIE_CLAUDE_EXE ?? 'claude';
const MODEL = process.env.AMABIE_T33_MODEL ?? 'claude-sonnet-5-5';
const tgz = path.join(PKG, 'amabie-cli-2.0.0.tgz');
if (!fs.existsSync(tgz)) { console.error('FAIL run node tooling/pack.mjs first'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-t33-'));
const work = path.join(tmp, 'work'), prefix = path.join(tmp, 'npm-global'), cache = path.join(tmp, 'npm-cache');
fs.mkdirSync(work); fs.mkdirSync(prefix);
for (const f of ['README.md', 'QUICKSTART.md']) fs.copyFileSync(path.join(ROOT, f), path.join(work, f));
fs.copyFileSync(tgz, path.join(work, 'amabie-cli-2.0.0.tgz'));
const sha = path.join(PKG, 'amabie-cli-2.0.0.tgz.sha256');
if (fs.existsSync(sha)) fs.copyFileSync(sha, path.join(work, 'amabie-cli-2.0.0.tgz.sha256'));

const env = { ...process.env, npm_config_prefix: prefix, npm_config_cache: cache, PATH: prefix + path.delimiter + (process.env.PATH ?? '') };
const prompt = [
  'You are a first-time user of a tool called Amabie. This directory holds ONLY its user documents (README.md, QUICKSTART.md) and the prepared package tarball.',
  'Use only these two documents; ignore anything you may know about the tool from elsewhere. Do not open files outside this directory.',
  'Task: follow QUICKSTART.md as a user would: verify the checksum, install the package, create the tiny example project from the installed package, run setup and doctor, then make the documented change with a discriminating check.',
  'Run every step for real. Do not ask me questions; if something is unclear, say how you resolved it.',
  'Finish with a report: (1) steps that worked, (2) every place where the docs were wrong, unclear, missing, or contradicted what happened (quote the sentence), (3) the exact final `amabie doctor --json` status you saw.',
].join('\n');

const t0 = Date.now();
const out = await new Promise(res => {
  let buf = '';
  const p = spawn(CLAUDE, ['-p', prompt, '--model', MODEL, '--allowedTools', 'Bash,Read,Write,Edit', '--permission-mode', 'acceptEdits', '--max-turns', '80'], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', d => (buf += d)); p.stderr.on('data', d => (buf += d));
  const kill = setTimeout(() => p.kill(), 25 * 60_000);
  p.on('close', () => { clearTimeout(kill); res(buf); });
});
console.log(`----- agent report (${Math.round((Date.now() - t0) / 1000)} s) -----\n${out}\n----- end report -----`);

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++; };
const bin = path.join(prefix, process.platform === 'win32' ? 'amabie.cmd' : 'bin/amabie');
const v = fs.existsSync(bin) ? spawnSync(bin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', env }) : { stdout: '' };
check(/amabie 2\.0\.0/.test(v.stdout), 'the package was installed into the redirected prefix from the docs');
const example = fs.readdirSync(work, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(work, d.name)).find(d => fs.existsSync(path.join(d, 'greeting.js')));
check(!!example, 'an example project was created');
if (example) {
  const d = spawnSync(bin, ['doctor', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', cwd: example, env });
  console.log('independent doctor exit:', d.status, (d.stdout ?? '').slice(0, 400).replace(/\s+/g, ' '));
  check(fs.existsSync(path.join(example, '.amabie')), 'setup left Amabie state in the example (measured here)');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `FAIL ${failed} failed` : 'PASS first-user run completed; read the report for doc gaps');
process.exit(failed ? 1 : 0);
