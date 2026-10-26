import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const adapter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'aider-correction-adapter.mjs');
const validRequest = {
  schema: 'amabie-correction-request/1',
  cycle: 1,
  goal: { text: 'Keep account creation safe.' },
  report: { unresolved: [{ status: 'unproven', requirementId: 'req-test', reason: 'fresh evidence is missing' }] },
};

function withProject(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-aider-adapter-test-'));
  fs.writeFileSync(path.join(root, 'target.mjs'), 'export const value = 1;\n', 'utf8');
  try { run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function runAdapter(root, args, request = validRequest, env = {}) {
  return spawnSync(process.execPath, [adapter, ...args], {
    cwd: root,
    env: { ...process.env, OLLAMA_API_BASE: 'http://127.0.0.1:11434', ...env },
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
}

test('the Aider correction adapter requires explicit target files', () => {
  withProject(root => {
    const result = runAdapter(root, []);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provide 1 to 16 project-relative target files/u);
  });
});

test('the Aider correction adapter rejects POSIX and Windows target paths outside the project', () => {
  withProject(root => {
    for (const target of ['../outside.mjs', '..\\outside.mjs', 'C:\\outside.mjs', '\\\\server\\share\\outside.mjs']) {
      const result = runAdapter(root, [target]);
      assert.equal(result.status, 1, `${target} must be refused`);
      assert.match(result.stderr, /every Aider file must be below the project root/u, target);
    }
  });
});

test('the Aider correction adapter refuses remote Ollama endpoints before starting Aider', () => {
  withProject(root => {
    const result = runAdapter(root, ['target.mjs'], validRequest, {
      OLLAMA_API_BASE: 'https://example.invalid',
      AMABIE_AIDER_EXECUTABLE: 'this-must-not-be-started',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only permits local Ollama HTTP/u);
  });
});

test('the Aider correction adapter rejects non-Ollama model providers', () => {
  withProject(root => {
    const result = runAdapter(root, ['target.mjs'], validRequest, {
      AMABIE_AIDER_MODEL: 'openai/example-model',
      AMABIE_AIDER_EXECUTABLE: 'this-must-not-be-started',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only supports local Ollama model identifiers/u);
  });
});

test('the Aider correction adapter rejects cloud model identifiers', () => {
  withProject(root => {
    const result = runAdapter(root, ['target.mjs'], validRequest, {
      AMABIE_AIDER_MODEL: 'ollama_chat/qwen3.5:cloud',
      AMABIE_AIDER_EXECUTABLE: 'this-must-not-be-started',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cloud model identifiers are not allowed/u);
  });
});

test('the Aider correction adapter rejects PASS claims as correction targets', () => {
  withProject(root => {
    const request = structuredClone(validRequest);
    request.report.unresolved[0].status = 'met';
    const result = runAdapter(root, ['target.mjs'], request);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only unmet or unproven requirements can be sent for correction/u);
  });
});

test('the Aider correction adapter refuses to place its temporary profile inside the project', () => {
  withProject(root => {
    const result = runAdapter(root, ['target.mjs'], validRequest, { AMABIE_AIDER_TEMP_ROOT: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Aider state must be outside the subject project/u);
  });
});

test('the Aider correction adapter resolves temporary-directory junctions before checking containment', () => {
  withProject(root => {
    const junction = `${root}-alias`;
    fs.symlinkSync(root, junction, 'junction');
    try {
      const result = runAdapter(root, ['target.mjs'], validRequest, { AMABIE_AIDER_TEMP_ROOT: junction });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Aider state must be outside the subject project/u);
      assert.equal(fs.existsSync(path.join(root, 'target.mjs')), true, 'removing the alias must not remove the project');
    } finally {
      fs.rmSync(junction);
    }
  });
});
