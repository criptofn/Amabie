import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const cli = path.join(repo, 'apps', 'cli', 'dist', 'src', 'main.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-runtime-minimum-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const driver = path.join(scratch, 'reported-node20.mjs');
// The package probe additionally executes official Node 20; this test pins the early-refusal contract on every CI host.
fs.writeFileSync(driver, [
  "import { pathToFileURL } from 'node:url';",
  "Object.defineProperty(process.versions, 'node', { value: '20.20.2' });",
  'const [entry, ...args] = process.argv.slice(2);',
  'process.argv = [process.execPath, entry, ...args];',
  'await import(pathToFileURL(entry).href);',
].join('\n'));

for (const args of [['setup', '--yes'], ['doctor', '--json'], ['checkpoint'], ['mcp'], ['--help']]) {
  it(`refuses ${args.join(' ')} below the Node minimum before changing state`, () => {
    const project = path.join(scratch, args[0]!);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"runtime-refusal-fixture","private":true}\n');
    const trust = path.join(scratch, `${args[0]}-trust`);
    const metrics = path.join(scratch, `${args[0]}-metrics.jsonl`);
    const result = spawnSync(process.execPath, [driver, cli, ...args], {
      cwd: project, env: { ...process.env, AMABIE_TRUST_STORE: trust, AMABIE_METRICS: metrics },
      input: '{"stop_hook_active":true}', encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /UNSUPPORTED.*requires Node\.js 22.*20\.20\.2/);
    assert.match(result.stderr, /nothing was verified/);
    assert.match(result.stderr, /Install Node\.js 22/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\bREADY\b/);
    assert.deepEqual(fs.readdirSync(project), ['package.json']);
    assert.equal(fs.existsSync(trust), false, 'refusal must not mint trust material');
    assert.equal(fs.existsSync(metrics), false, 'refusal occurs before opt-in metrics writes');
    if (args.includes('--json')) {
      const lines = result.stdout.trim().split('\n');
      assert.equal(lines.length, 1);
      const envelope = JSON.parse(lines[0]!);
      assert.equal(envelope.schema, 'amabie-status/1');
      assert.equal(envelope.status, 'UNSUPPORTED');
      assert.equal(envelope.exitCode, result.status);
      assert.match(envelope.next, /Node\.js 22/);
    } else assert.equal(result.stdout, '');
  });
}

it('supported runtime retains normal CLI help and version', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'run the suite with the documented supported runtime');
  for (const arg of ['--help', '--version']) {
    const result = spawnSync(process.execPath, [cli, arg], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /amabie/);
    assert.doesNotMatch(result.stderr, /UNSUPPORTED/);
  }
});
