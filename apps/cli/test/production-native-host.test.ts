import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { productionNativePowerShellExecutable } from '../src/provider/production-measurement.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-native-host-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe('production native PowerShell host', () => {
  it('keeps the inbox host as the default', () => {
    assert.equal(productionNativePowerShellExecutable({}),
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('uses only an explicit absolute regular pwsh.exe override', () => {
    const executable = path.join(tempRoot, 'pwsh.exe');
    fs.writeFileSync(executable, 'operator-selected host');
    assert.equal(productionNativePowerShellExecutable({ AMABIE_POWERSHELL_CORE_PATH: executable }), executable);
  });

  it('rejects malformed or absent overrides instead of silently choosing another host', () => {
    assert.throws(() => productionNativePowerShellExecutable({ AMABIE_POWERSHELL_CORE_PATH: 'pwsh.exe' }), /absolute/);
    assert.throws(() => productionNativePowerShellExecutable({ AMABIE_POWERSHELL_CORE_PATH: 'C:\\tools\\powershell.exe' }), /pwsh.exe/);
    assert.throws(() => productionNativePowerShellExecutable({ AMABIE_POWERSHELL_CORE_PATH: path.join(tempRoot, 'missing', 'pwsh.exe') }), /regular.*file/);
  });
});
