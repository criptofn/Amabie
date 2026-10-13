#!/usr/bin/env node
/**
 * Workspace-local toolchain provisioning for the Rust and Go observation
 * adapters (v1.1 Phase 2).
 *
 * WHY THIS EXISTS: the previous session reported Rust and Go as
 * IMPLEMENTED_BUT_HOST_UNVERIFIED because neither toolchain was installed. That
 * is a *validation* gap, not a design one — and it is closable, because both
 * toolchains can be installed **user-locally with no administrator rights and
 * without altering any global machine state**:
 *
 *   - Go ships as a relocatable archive. Extract it under `_toolchains/go` and
 *     drive it with explicit `GOROOT`/`GOTOOLCHAIN`, never a system PATH edit.
 *   - Rust ships `rustup-init`, which is fully relocatable when `CARGO_HOME` and
 *     `RUSTUP_HOME` point into the workspace and `--no-modify-path` is passed.
 *
 * Nothing here runs elevated, writes to Program Files, touches the registry, or
 * calls `setx`. Every environment value it produces is returned to the caller for
 * a single child process, so a machine that never runs this file is unaffected.
 *
 * It is a TOOL, not a gate: it provisions, prints what it produced, and exits
 * non-zero only if provisioning failed. Verification lives in the probes that
 * then execute real test runs (`tooling/probes/runner-observation-*.mjs`).
 *
 * Only the host platform is supported on purpose: a Windows host cannot produce
 * or validate a Linux toolchain, and pretending otherwise is the exact failure
 * mode this repository refuses.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(REPO, '_toolchains');

const log = (s) => console.log(s);
function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

async function download(url, dest) {
  log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** Recursively locate the first file with the given basename under `dir`. */
function findFile(dir, name) {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
}

// ─────────────────────────────────── Go ───────────────────────────────────
/**
 * Install a relocatable Go into `_toolchains/go`. Returns the env a caller must
 * pass to a child to use it (GOROOT + PATH prefixed with <goroot>/bin), or null.
 */
export function extractVerifiedGoArchive(archive, expectedSha256, goroot) {
  const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actual !== expectedSha256) {
    throw new Error(`Go archive SHA-256 mismatch: expected ${expectedSha256}, observed ${actual}; nothing extracted or replaced`);
  }
  const parent = path.dirname(goroot);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.go-stage-'));
  try {
    const un = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', stage], { encoding: 'utf8', timeout: 900_000, windowsHide: true });
    if (un.status !== 0) throw new Error(`Go archive extraction failed: ${un.stderr || un.status}`);
    const extracted = path.join(stage, 'go');
    if (!fs.existsSync(path.join(extracted, 'bin', process.platform === 'win32' ? 'go.exe' : 'go'))) throw new Error('Go archive contains no host executable');
    // Only replace Go after a verified archive extracted; sibling toolchains are independent.
    fs.rmSync(goroot, { recursive: true, force: true });
    fs.renameSync(extracted, goroot);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function ensureGo(requestedVersion) {
  const goroot = path.join(ROOT, 'go');
  const goExe = path.join(goroot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
  if (fs.existsSync(goExe)) {
    const v = spawnSync(goExe, ['version'], { encoding: 'utf8', timeout: 120_000 });
    if (v.status === 0 && (!requestedVersion || (v.stdout ?? '').startsWith(`go version go${requestedVersion} `))) {
      log(`go already provisioned: ${(v.stdout ?? '').trim()}`);
      return { goroot, version: (v.stdout ?? '').trim(), env: goEnv(goroot) };
    }
  }
  if (!['win32', 'linux'].includes(process.platform)) { log('go: only native Windows and Linux archives are provisioned here'); return null; }

  log('provisioning Go (user-local, relocatable)...');
  const response = await fetch(`https://go.dev/dl/?mode=json${requestedVersion ? '&include=all' : ''}`);
  if (!response.ok) throw new Error(`Go release metadata HTTP ${response.status}`);
  const idx = await response.json();
  const release = idx.find(r => requestedVersion ? r.version === `go${requestedVersion}` : r.stable === true);
  const platform = process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const file = release?.files.find(f => f.os === platform && f.arch === arch && f.kind === 'archive');
  if (!file || !/^go[0-9.]+\.(windows|linux)-[a-z0-9]+\.(zip|tar\.gz)$/.test(file.filename)) throw new Error(`no Go ${requestedVersion ?? 'stable'} archive for ${platform}/${arch}`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-go-download-'));
  try {
    const archive = path.join(stage, file.filename);
    const bytes = await download(`https://go.dev/dl/${file.filename}`, archive);
    extractVerifiedGoArchive(archive, file.sha256, goroot);
    log(`  VERIFIED ${file.filename} (${Math.round(bytes / 1024 / 1024)} MB), sha256 ${file.sha256}`);
    fs.writeFileSync(path.join(goroot, 'amabie-install-evidence.json'), JSON.stringify({ version: release.version, filename: file.filename, sha256: file.sha256, bytes }, null, 2) + '\n');
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  if (!fs.existsSync(goExe)) fail(`Go archive extracted but ${goExe} is missing`);
  const v = spawnSync(goExe, ['version'], { encoding: 'utf8', timeout: 120_000 });
  if (v.status !== 0) fail(`provisioned Go does not run: ${(v.stderr ?? '').trim()}`);
  log(`  ${(v.stdout ?? '').trim()}`);
  return { goroot, version: (v.stdout ?? '').trim(), env: goEnv(goroot) };
}
function goEnv(goroot) {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    GOROOT: goroot,
    GOPATH: path.join(ROOT, 'gopath'),
    GOCACHE: path.join(ROOT, 'gocache'),
    GOTOOLCHAIN: 'local', // never silently download a different toolchain mid-verification
    PATH: `${path.join(goroot, 'bin')}${sep}${process.env.PATH ?? ''}`,
  };
}

// ─────────────────────────────────── Rust ───────────────────────────────────
/**
 * Install a relocatable Rust (rustup + stable toolchain, minimal profile) into
 * `_toolchains/rust/{cargo,rustup}`. `--no-modify-path` guarantees the user's
 * environment is untouched.
 */
async function ensureRust() {
  const cargoHome = path.join(ROOT, 'rust', 'cargo');
  const rustupHome = path.join(ROOT, 'rust', 'rustup');
  const cargoExe = path.join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  if (fs.existsSync(cargoExe)) {
    const v = spawnSync(cargoExe, ['--version'], { encoding: 'utf8', timeout: 120_000, env: rustEnv(cargoHome, rustupHome) });
    if (v.status === 0) { log(`rust already provisioned: ${(v.stdout ?? '').trim()}`); return { cargoHome, rustupHome, env: rustEnv(cargoHome, rustupHome) }; }
  }
  if (process.platform !== 'win32') { log('rust: non-Windows host — this tool only provisions the host platform'); return null; }

  log('provisioning Rust (user-local rustup, minimal profile, --no-modify-path)...');
  // The basename MUST be exactly `rustup-init.exe`: rustup decides whether it is
  // the installer or a proxy from argv[0], and `amabie-rustup-init.exe` made it
  // report "unknown proxy name" and exit 1. A dedicated temp dir keeps that name.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rustup-stage-'));
  const exe = path.join(stage, 'rustup-init.exe');
  await download('https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe', exe);
  fs.mkdirSync(path.join(ROOT, 'rust'), { recursive: true });
  const r = spawnSync(exe, ['-y', '--profile', 'minimal', '--default-toolchain', 'stable', '--no-modify-path'], {
    encoding: 'utf8', timeout: 1_800_000, windowsHide: true,
    env: { ...process.env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, RUSTUP_INIT_SKIP_PATH_CHECK: 'yes' },
  });
  fs.rmSync(stage, { recursive: true, force: true });
  if (r.status !== 0) fail(`rustup-init failed (${r.status}): ${((r.stdout ?? '') + (r.stderr ?? '')).slice(-1200)}`);
  if (!fs.existsSync(cargoExe)) fail(`rustup reported success but ${cargoExe} is missing`);
  const v = spawnSync(cargoExe, ['--version'], { encoding: 'utf8', timeout: 120_000, env: rustEnv(cargoHome, rustupHome) });
  if (v.status !== 0) fail(`provisioned cargo does not run: ${(v.stderr ?? '').trim()}`);
  log(`  ${(v.stdout ?? '').trim()}`);
  return { cargoHome, rustupHome, env: rustEnv(cargoHome, rustupHome) };
}
function rustEnv(cargoHome, rustupHome) {
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    CARGO_TERM_COLOR: 'never',
    RUSTUP_TOOLCHAIN: 'stable',
    PATH: `${path.join(cargoHome, 'bin')}${sep}${path.join(rustupHome, 'toolchains')}${sep}${process.env.PATH ?? ''}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const which = process.argv[2] ?? 'all';
if (!['all', 'go', 'rust'].includes(which)) fail('usage: node tooling/toolchains.mjs [all|go|rust] [--go-version=<major.minor.patch>]');
const requestedVersion = process.argv.slice(3).find(arg => arg.startsWith('--go-version='))?.slice('--go-version='.length);
if (requestedVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(requestedVersion)) fail('Go version must be major.minor.patch');
log(`workspace-local toolchains under ${ROOT}`);
const result = { schema: 'amabie-toolchains/1', root: ROOT, go: null, rust: null };
if (which === 'all' || which === 'go') result.go = await ensureGo(requestedVersion);
if (which === 'all' || which === 'rust') result.rust = await ensureRust();
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(REPO, '_toolchains', 'toolchains.json'), JSON.stringify({
  ...result,
  go: result.go ? { goroot: result.go.goroot, version: result.go.version, pathPrefix: path.join(result.go.goroot, 'bin') } : null,
  rust: result.rust ? { cargoHome: result.rust.cargoHome, rustupHome: result.rust.rustupHome } : null,
}, null, 2) + '\n');
log(`\nwrote _toolchains/toolchains.json`);
log(`go:   ${result.go ? 'READY' : 'not provisioned'}`);
log(`rust: ${result.rust ? 'READY' : 'not provisioned'}`);
}
