import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { CLI_ENTRY } from '../src/cli-runtime.js';

/**
 * The hook and tool files setup writes record THIS machine's absolute path to Amabie. Setup must say they are
 * per-machine (not for committing), and a clone that carries another machine's copy must be told where it came from.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-machine-'));
process.env.AMABIE_TRUST_STORE = path.join(TMP, 'store');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function amabie(root: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, env });
}

test('setup says the files it wrote are per-machine; a copied foreign hook is explained, not overwritten', () => {
  const root = path.join(TMP, 'p');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'm', private: true, scripts: { test: 'node -e 0' } }));
  const foreign = 'node "/home/teammate/amabie/apps/cli/dist/src/main.js" checkpoint';
  const settings = path.join(root, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } }));
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-m', 'x']]) {
    assert.equal(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).status, 0);
  }

  const refused = amabie(root, 'setup', '--yes');
  const refusedOut = `${refused.stdout}${refused.stderr}`;
  assert.equal(refused.status, 2, refusedOut);
  assert.match(refusedOut, /another machine's committed copy/);
  assert.match(refusedOut, /\.git\/info\/exclude/);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command, foreign, 'the entry Amabie does not own was left alone');

  fs.writeFileSync(settings, '{}');
  const ok = amabie(root, 'setup', '--yes');
  const okOut = `${ok.stdout}${ok.stderr}`;
  assert.equal(ok.status, 0, okOut);
  assert.match(okOut, /per-machine/);
  assert.match(okOut, /do not commit them/);
  assert.doesNotMatch(okOut, /commit them and a checkout/);
});
