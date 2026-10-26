/**
 * The python adapter's checks invoke `python`. Linux hosts often ship only `python3`, so setup's pin must
 * accept it there and seal the absolute path it resolved to. Windows keeps `python` alone (a `python3.exe`
 * can be an app-store stub), so the same case must still refuse there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
process.env.AMABIE_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-trust-')); // 1.1 P0 isolation
import { pinPlanPrograms } from '../src/onboarding.js';
import type { PlanStep } from '../src/project.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-pin-alias-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const pythonStep: PlanStep = {
  kind: 'tests',
  script: 'unittest',
  adapter: 'python',
  argv: ['python', '-m', 'unittest', 'discover', '-v'],
};

function withPath(dirs: string[], body: () => void) {
  const saved = process.env.PATH;
  process.env.PATH = dirs.join(path.delimiter);
  try { body(); } finally { process.env.PATH = saved; }
}

describe('python pin: python3 is accepted where python is absent (non-Windows)', () => {
  it('pins the python3 on PATH to an absolute path when python is missing', { skip: process.platform === 'win32' }, () => {
    const dir = path.join(TMP, 'only-python3');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'python3');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(exe, 0o755);
    withPath([dir], () => {
      const pin = pinPlanPrograms([pythonStep]);
      assert.deepEqual(pin.problems, []);
      assert.equal(pin.plan[0]!.argv![0], exe);
      assert.deepEqual(pin.plan[0]!.argv!.slice(1), ['-m', 'unittest', 'discover', '-v']);
    });
  });

  it('still refuses with a problem when neither python nor python3 is on PATH', () => {
    const empty = path.join(TMP, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    withPath([empty], () => {
      const pin = pinPlanPrograms([pythonStep]);
      assert.equal(pin.problems.length, 1);
      assert.match(pin.problems[0]!, /"python" .*not found on PATH/);
    });
  });
});
