import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [targetRelativePath] = process.argv.slice(2);
const projectRoot = fs.realpathSync(process.cwd());
const targetPath = path.resolve(projectRoot, targetRelativePath ?? '');
const targetRelative = path.relative(projectRoot, targetPath);
const requestBytes = fs.readFileSync(0);
if (requestBytes.length > 512 * 1024) throw new Error('correction request exceeds the fixture input limit');
const request = JSON.parse(requestBytes.toString('utf8'));
assert.equal(request.schema, 'amabie-correction-request/1');
assert.equal(typeof request.goal?.text, 'string');
assert.equal(Array.isArray(request.report?.unresolved), true);
assert.equal(request.report.unresolved.length, 1, 'this local E2E fixture handles exactly one scoped gap');
assert.match(request.report.unresolved[0].status, /^(?:unmet|unproven)$/u);
assert.equal(path.isAbsolute(targetRelative), false);
assert.notEqual(targetRelative, '..');
assert.equal(targetRelative.startsWith(`..${path.sep}`), false);

const targetStat = fs.lstatSync(targetPath);
assert.equal(targetStat.isFile(), true, 'the target must be a regular file');
assert.equal(targetStat.isSymbolicLink(), false, 'the target must not be a symbolic link');
assert.ok(targetStat.size <= 256 * 1024, 'the target must be no larger than 256 KiB');
const before = fs.readFileSync(targetPath, 'utf8');
const model = process.env.AMABIE_LOCAL_MODEL ?? 'qwen3.5:9b';
const endpoint = new URL(process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434');
assert.equal(endpoint.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Ollama endpoint must be loopback-only');
assert.equal(endpoint.username, '');
assert.equal(endpoint.password, '');
assert.ok(endpoint.pathname === '/' || endpoint.pathname === '', 'OLLAMA_HOST must be an origin, without a path');
assert.equal(endpoint.search, '');
assert.equal(endpoint.hash, '');

const outputSchema = {
  type: 'object',
  properties: { content: { type: 'string' } },
  required: ['content'],
  additionalProperties: false,
};
const correctionContext = {
  originalGoal: request.goal.text,
  onlyUnresolvedRequirement: request.report.unresolved[0],
  currentFile: { path: targetRelative, content: before },
  instruction: 'Return the complete corrected content for this one file. Do not claim other requirements are fixed. Do not return a diff or commentary.',
};
const startedAt = performance.now();
const response = await fetch(new URL('/api/chat', endpoint), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are a local coding agent correcting one verified gap. The report is authoritative for what remains unresolved. Return only the requested structured file content.' },
      { role: 'user', content: JSON.stringify(correctionContext) },
    ],
    stream: false,
    format: outputSchema,
    options: { temperature: 0 },
  }),
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok) throw new Error(`local Ollama returned HTTP ${response.status}`);
const responseText = await response.text();
if (Buffer.byteLength(responseText, 'utf8') > 1024 * 1024) throw new Error('local Ollama response exceeds the fixture output limit');
const envelope = JSON.parse(responseText);
assert.equal(envelope.done, true, 'local Ollama must return a complete non-streamed response');
assert.equal(envelope.model, model, 'local Ollama must report the requested model');
const generated = JSON.parse(envelope.message?.content ?? 'null');
assert.equal(typeof generated?.content, 'string');
assert.ok(generated.content.trim().length > 0 && generated.content.length <= 256 * 1024);
if (generated.content === before) {
  console.log(JSON.stringify({ status: 'NO_CHANGE', model }));
  process.exit(0);
}

const currentTarget = fs.lstatSync(targetPath);
assert.equal(currentTarget.isFile(), true);
assert.equal(currentTarget.isSymbolicLink(), false);
assert.equal(currentTarget.size <= 256 * 1024, true);
const temporaryPath = path.join(path.dirname(targetPath), `.amabie-local-agent-${createHash('sha256').update(targetRelative).digest('hex').slice(0, 12)}.tmp`);
fs.writeFileSync(temporaryPath, generated.content, { flag: 'wx' });
fs.renameSync(temporaryPath, targetPath);

const metricsPath = process.env.AMABIE_LOCAL_AGENT_METRICS;
if (metricsPath) {
  const resolvedMetrics = path.resolve(projectRoot, metricsPath);
  const relativeMetrics = path.relative(projectRoot, resolvedMetrics);
  assert.ok(relativeMetrics === '.amabie' || relativeMetrics.startsWith(`.amabie${path.sep}`), 'metrics must remain under .amabie');
  fs.writeFileSync(resolvedMetrics, `${JSON.stringify({
    model: envelope.model,
    promptTokens: envelope.prompt_eval_count,
    responseTokens: envelope.eval_count,
    inferenceDurationMs: Number.isFinite(envelope.total_duration) ? Math.round(envelope.total_duration / 1_000_000) : Math.round(performance.now() - startedAt),
  }, null, 2)}\n`);
}

console.log(JSON.stringify({ status: 'MODEL_RESPONSE_APPLIED', model: envelope.model }));
