import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_TARGET_BYTES = 256 * 1024;
const MAX_TARGETS = 16;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 4 * 60 * 1000;

function readStdin(limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Amabie correction request exceeds the Aider adapter input limit'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

function containedTarget(root, requested) {
  assert.ok(requested.length > 0 && requested.length <= 512 && !requested.includes('\0'));
  const windowsPath = path.win32.parse(requested);
  assert.ok(!path.isAbsolute(requested) && windowsPath.root === '', 'every Aider file must be below the project root');
  // Treat both separator styles as path separators on every host. Agent
  // arguments can be produced on Windows and later checked on POSIX, where
  // path.resolve would otherwise treat `..\\outside` as a literal filename.
  const target = path.resolve(root, requested.replaceAll('\\', path.sep));
  const relative = path.relative(root, target);
  assert.ok(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'every Aider file must be below the project root');
  const stat = fs.lstatSync(target);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'every Aider target must be a regular file, not a symbolic link');
  assert.ok(stat.size <= MAX_TARGET_BYTES, 'each Aider target must be no larger than 256 KiB');
  const canonical = fs.realpathSync(target);
  const canonicalRelative = path.relative(root, canonical);
  assert.ok(canonicalRelative !== '..' && !canonicalRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(canonicalRelative), 'the canonical Aider target must stay below the project root');
  return canonical;
}

function localEndpoint(value) {
  const endpoint = new URL(value);
  assert.equal(endpoint.protocol, 'http:', 'the Aider adapter only permits local Ollama HTTP');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'the Aider adapter only permits a loopback model endpoint');
  assert.equal(endpoint.username, '');
  assert.equal(endpoint.password, '');
  assert.ok(endpoint.pathname === '/' || endpoint.pathname === '');
  assert.equal(endpoint.search, '');
  assert.equal(endpoint.hash, '');
  return endpoint.origin;
}

const targets = process.argv.slice(2);
try {
  const root = fs.realpathSync(process.cwd());
  assert.ok(targets.length > 0 && targets.length <= MAX_TARGETS, `provide 1 to ${MAX_TARGETS} project-relative target files as arguments`);
  const canonicalTargets = targets.map(target => containedTarget(root, target));
  assert.equal(new Set(canonicalTargets).size, canonicalTargets.length, 'Aider target files must be unique');

  const requestBytes = await readStdin(MAX_INPUT_BYTES);
  const request = JSON.parse(requestBytes.toString('utf8'));
  assert.equal(request.schema, 'amabie-correction-request/1');
  assert.ok(Number.isSafeInteger(request.cycle) && request.cycle >= 1 && request.cycle <= 3, 'the correction cycle must stay within Amabie’s limit');
  assert.ok(typeof request.goal?.text === 'string' && request.goal.text.length > 0);
  assert.ok(Array.isArray(request.report?.unresolved) && request.report.unresolved.length > 0, 'the correction report must contain unresolved evidence');
  assert.ok(request.report.unresolved.length <= 64, 'the correction report contains too many unresolved items');
  assert.ok(request.report.unresolved.every(item => item && ['unmet', 'unproven'].includes(item.status)), 'only unmet or unproven requirements can be sent for correction');

  const endpoint = localEndpoint(process.env.OLLAMA_API_BASE ?? 'http://127.0.0.1:11434');
  const model = process.env.AMABIE_AIDER_MODEL ?? 'ollama_chat/qwen3.5:9b';
  assert.match(model, /^ollama(?:_chat)?\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u, 'the Aider adapter only supports local Ollama model identifiers');
  assert.ok(!model.toLowerCase().includes('cloud'), 'cloud model identifiers are not allowed by the local Aider adapter');
  const executable = process.env.AMABIE_AIDER_EXECUTABLE ?? 'aider';
  assert.ok(executable.length > 0 && !executable.includes('\0'));

  const tempParent = fs.realpathSync(path.resolve(process.env.AMABIE_AIDER_TEMP_ROOT ?? os.tmpdir()));
  assert.ok(fs.statSync(tempParent).isDirectory());
  const tempRelative = path.relative(root, tempParent);
  assert.ok(tempRelative === '..' || tempRelative.startsWith(`..${path.sep}`) || path.isAbsolute(tempRelative), 'Aider state must be outside the subject project');
  const agentHome = fs.mkdtempSync(path.join(tempParent, 'amabie-aider-agent-'));
  const appData = path.join(agentHome, 'AppData', 'Roaming');
  const localAppData = path.join(agentHome, 'AppData', 'Local');
  const tempDir = path.join(agentHome, 'temp');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const configPath = path.join(agentHome, 'aider.yml');
  const environmentPath = path.join(agentHome, '.env');
  const messagePath = path.join(agentHome, 'correction.md');
  const historyPaths = ['input.history', 'chat.history.md', 'llm.history.md'].map(name => path.join(agentHome, name));
  const message = [
    'Apply only corrections supported by this independent Amabie evidence report.',
    `Original task: ${request.goal.text}`,
    `Unresolved requirements and evidence: ${JSON.stringify(request.report.unresolved)}`,
    `Editable context files: ${canonicalTargets.map(file => path.relative(root, file).split(path.sep).join('/')).join(', ')}`,
    'Edit only the attached target files. Do not change the task, report that checks passed, or claim completion. Amabie will rerun the complete sealed checks independently.',
  ].join('\n\n');
  assert.ok(Buffer.byteLength(message, 'utf8') <= MAX_INPUT_BYTES, 'the rendered Aider correction message exceeds the input limit');
  fs.writeFileSync(configPath, '{}\n', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(environmentPath, '# Deliberately empty: do not load project or user credentials.\n', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(messagePath, `${message}\n`, { encoding: 'utf8', flag: 'wx' });

  const cleanEnv = Object.fromEntries(
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  Object.assign(cleanEnv, {
    USERPROFILE: agentHome,
    HOME: agentHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: tempDir,
    TMP: tempDir,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
    OLLAMA_API_BASE: endpoint,
    OLLAMA_NO_CLOUD: '1',
    AIDER_ANALYTICS: 'false',
    TERM: 'dumb',
  });

  const args = [
    '--config', configPath,
    '--env-file', environmentPath,
    '--no-git',
    '--no-analytics',
    '--no-check-update',
    '--no-show-release-notes',
    '--yes-always',
    '--no-auto-commits',
    '--no-auto-test',
    '--no-auto-lint',
    '--no-stream',
    '--no-show-model-warnings',
    '--no-restore-chat-history',
    '--input-history-file', historyPaths[0],
    '--chat-history-file', historyPaths[1],
    '--llm-history-file', historyPaths[2],
    '--model', model,
    ...canonicalTargets.flatMap(target => ['--file', target]),
    '--message-file', messagePath,
  ];
  const result = spawnSync(executable, args, {
    cwd: root,
    env: cleanEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const transcript = {
    executable,
    model,
    endpoint,
    args,
    environmentPath,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  const transcriptPath = process.env.AMABIE_AIDER_TRANSCRIPT;
  if (transcriptPath) {
    const transcriptCandidate = path.resolve(transcriptPath);
    fs.mkdirSync(path.dirname(transcriptCandidate), { recursive: true });
    const transcriptParent = fs.realpathSync(path.dirname(transcriptCandidate));
    const resolvedTranscript = path.join(transcriptParent, path.basename(transcriptCandidate));
    const relative = path.relative(root, resolvedTranscript);
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'the Aider transcript must stay outside the subject project');
    const transcriptFile = fs.openSync(resolvedTranscript, 'wx', 0o600);
    try { fs.writeFileSync(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8'); }
    finally { fs.closeSync(transcriptFile); }
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Aider exited ${result.status ?? result.signal ?? 'without a status'}; its claims are not verification evidence`);
  console.log(JSON.stringify({ status: 'AIDER_COMPLETED', model, cycle: request.cycle, targetCount: canonicalTargets.length }));
} catch (error) {
  console.error(`Aider correction adapter failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
