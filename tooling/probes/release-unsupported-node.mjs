import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [tarballArg, reportArg] = process.argv.slice(2);
assert.ok(tarballArg && reportArg, 'usage: node release-unsupported-node.mjs <frozen.tgz> <report.json>');
assert.equal(process.platform, 'win32', 'this probe uses the official Windows x64 Node 20 archive');
assert.equal(process.arch, 'x64');
const tarball = path.resolve(tarballArg);
const reportFile = path.resolve(reportArg);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-node20-'));
const report = { schema: 'amabie-unsupported-node-audit/1', at: new Date().toISOString(), tarballSha256: crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'), runs: [] };
const fetchBytes = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
try {
  const official = 'https://nodejs.org/dist/latest-v20.x/';
  const sums = await fetchBytes(`${official}SHASUMS256.txt`);
  const entry = sums.toString('utf8').split('\n').map(line => /^([0-9a-f]{64})\s+(node-(v20\.\d+\.\d+)-win-x64\.zip)$/.exec(line)).find(Boolean);
  assert.ok(entry, 'official manifest must name exactly a Node 20 Windows x64 archive');
  const bytes = await fetchBytes(`${official}${entry[2]}`);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, entry[1], 'official runtime archive must match Node.org SHA256 before extraction or execution');
  report.runtime = { version: entry[3], archiveUrl: `${official}${entry[2]}`, checksumUrl: `${official}SHASUMS256.txt`, expectedSha256: entry[1], actualSha256: digest };
  const archive = path.join(scratch, entry[2]);
  fs.writeFileSync(archive, bytes);
  const extract = spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', scratch], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  assert.equal(extract.status, 0, extract.stderr);
  const runtimeDir = path.join(scratch, entry[2].replace(/\.zip$/, ''));
  const node = path.join(runtimeDir, 'node.exe');
  const npm = path.join(runtimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const config = path.join(scratch, 'empty.npmrc');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(config, '');
  const env = { ...process.env, AMABIE_TRUST_STORE: path.join(scratch, 'trust'), HOME: home, USERPROFILE: home,
    npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_userconfig: config, GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig') };
  const run = (name, exe, args, cwd = scratch) => {
    const result = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const observed = { name, executable: exe, args, status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
    report.runs.push(observed);
    console.log(`${name}: exit ${result.status}`);
    return observed;
  };
  assert.equal(run('runtime-version', node, ['--version']).stdout.trim(), entry[3]);
  const install = (name, strict) => {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true }));
    const result = run(name, node, [npm, 'install', tarball, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', `--engine-strict=${strict}`], dir);
    return { dir, result };
  };
  const strict = install('strict-install', true);
  assert.notEqual(strict.result.status, 0, 'engine-strict must refuse a below-minimum runtime');
  assert.match(`${strict.result.stdout}${strict.result.stderr}`, /EBADENGINE/);
  console.log('PASS engine-strict refuses unsupported Node');
  const ordinary = install('ordinary-install', false);
  assert.equal(ordinary.result.status, 0, ordinary.result.stderr);
  const pkgDir = path.join(ordinary.dir, 'node_modules', 'amabie-cli');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  report.package = { name: pkg.name, version: pkg.version, engines: pkg.engines };
  assert.equal(pkg.engines?.node, '>=22');
  const entryFile = path.join(pkgDir, pkg.bin.amabie);
  run('cli-help', node, [entryFile, '--help']);
  run('cli-version', node, [entryFile, '--version']);
  const project = path.join(scratch, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'unsupported-runtime-fixture', private: true, scripts: { test: 'node --test checks.test.cjs' } }));
  fs.writeFileSync(path.join(project, 'checks.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('real assertion', () => assert.equal(2 + 2, 4));\n");
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{}\n');
  const gitArgs = [['init', '-b', 'main'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Release Fixture'], ['add', '.'], ['commit', '-m', 'fixture baseline']];
  for (const args of gitArgs) assert.equal(run(`git-${args[0]}`, 'git', args, project).status, 0);
  run('cli-setup', node, [entryFile, 'setup', '--yes'], project);
  run('cli-doctor', node, [entryFile, 'doctor', '--json'], project);
  const setup = report.runs.find(item => item.name === 'cli-setup');
  const doctor = report.runs.find(item => item.name === 'cli-doctor');
  let doctorStatus = null;
  try { doctorStatus = JSON.parse(doctor.stdout).status; } catch { /* malformed output cannot prove READY */ }
  report.readyBelowMinimum = (setup.status === 0 && /^READY\s+—/m.test(setup.stdout)) || (doctor.status === 0 && doctorStatus === 'READY');
  report.behavior = report.readyBelowMinimum ? 'unsupported runtime can produce READY' : 'no READY observed on unsupported runtime';
  assert.equal(report.readyBelowMinimum, false, 'CLI below its supported Node minimum must not emit READY');
  for (const result of [setup, doctor]) {
    assert.notEqual(result.status, 0, `${result.name}: unsupported runtime must be refused before verification`);
    assert.match(`${result.stdout}${result.stderr}`, /(?:requires?|unsupported|not supported)/i);
    assert.match(`${result.stdout}${result.stderr}`, /22/, 'refusal must state the supported minimum');
  }
  console.log('PASS unsupported runtime refused with its required minimum');
} finally {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  const relative = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(scratch));
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
