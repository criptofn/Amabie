import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installedCliEnvironment } from './probes/v15-installed-cli-env.mjs';

for (const name of ['amabie-cli', '@amabie/cli']) {
  test(`explicit installed CLI environment resolves ${name} without a global fallback`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie installed layout '));
    try {
      const packageRoot = path.join(root, 'node_modules', name);
      const bin = path.join(root, 'node_modules', '.bin');
      fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, bin: { amabie: 'dist/main.js' } }));
      const cli = path.join(packageRoot, 'dist', 'main.js');
      fs.writeFileSync(cli, '// fixture, never executed\n');
      const shims = process.platform === 'win32' ? ['amabie', 'amabie.cmd', 'amabie.ps1'] : ['amabie'];
      for (const shim of shims) fs.writeFileSync(path.join(bin, shim), 'fixture');
      const env = installedCliEnvironment(cli, { Path: 'ambient-path', PATH: 'other-path' });
      assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
      assert.equal(env.PATH.split(path.delimiter)[0], bin);
      fs.unlinkSync(path.join(bin, shims[0]));
      assert.throws(() => installedCliEnvironment(cli, { PATH: 'global-fallback' }), /installed package aliases required/);
      fs.writeFileSync(path.join(bin, shims[0]), 'fixture');
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'unrelated-package', bin: { amabie: 'dist/main.js' } }));
      assert.throws(() => installedCliEnvironment(cli, {}), /Amabie package identity/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
