import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, it } from 'node:test';
import { materialDigest } from '../src/authorization.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-p2e-cli-'));
process.env.AMABIE_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-p2e-trust-'));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(process.env.AMABIE_TRUST_STORE!, { recursive: true, force: true });
});

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, env: process.env });
}

function makeProject(name: string, options: { fixture?: 'f-pass.js' | 'f-controlled.js'; includeBindings: number }): { root: string; goal: string; requirements: string[] } {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.email', 'amabie-test@example.invalid'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['config', 'user.name', 'Amabie Test'], { cwd: root }).status, 0);
  const requirements = [
    'Registration rejects an invalid email address.',
    'Passwords are stored using the configured password hash.',
  ];
  const goal = requirements.join('\n');
  const proofs = Object.fromEntries(requirements.slice(0, options.includeBindings).map(text => [materialDigest(text), 'test']));
  const fixture = path.join(FIXTURES, options.fixture ?? 'f-pass.js').replace(/\\/gu, '/');
  const marker = path.join(root, '.amabie', 'controlled-failure').replace(/\\/gu, '/');
  const testCommand = options.fixture === 'f-controlled.js' ? `node "${fixture}" "${marker}"` : `node "${fixture}"`;
  const manifest = { name, scripts: { test: testCommand }, amabie: { proofs } };
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(spawnSync('git', ['add', 'package.json'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0);
  return { root, goal, requirements };
}

function writeRequest(root: string, goal: string, requirements: string[], claim?: string): string {
  let cursor = 0;
  const request = {
    schema: 'amabie-prompt-evidence/1',
    goal: { taskType: 'coding', text: goal },
    ...(claim === undefined ? {} : { agentClaim: claim }),
    requirements: requirements.map(text => {
      const start = goal.indexOf(text, cursor);
      if (start < 0) throw new Error(`test fixture requirement is not present in its goal: ${text}`);
      const end = start + text.length;
      cursor = end + 1;
      return {
        text,
        sourceRef: { kind: 'goal', start, end, excerpt: text },
        clarity: 'clear',
        criteria: [{
          statement: `A sealed project check proves: ${text}`,
          adapterId: 'amabie.coding.sealed-plan',
          evidenceType: 'sealed-check-run',
          predicate: { path: '/ok', equals: true },
        }],
      };
    }),
  };
  const dir = path.join(root, '.amabie');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prompt-evidence.json');
  fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`);
  return path.relative(root, file);
}

function prepareProject(options: Parameters<typeof makeProject>[1], name: string) {
  const project = makeProject(name, options);
  const setup = run(['setup', '--yes'], project.root);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const task = run(['task', project.goal, ...project.requirements.flatMap(r => ['--requirement', r])], project.root);
  assert.equal(task.status, 0, task.stderr || task.stdout);
  return project;
}

it('Scenario A: the CLI includes requirement-level evidence from the fresh sealed plan run', () => {
  const project = prepareProject({ includeBindings: 2 }, 'scenario-a');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout) as { status: string; evidencePath?: string; promptEvidence?: { verdict: string; coverage: { total: number; met: number }; requirements: Array<{ status: string }>; evidence: Array<{ provenance: string; facts: { checkId?: string } }> } };
  assert.equal(envelope.status, 'READY');
  assert.equal(envelope.promptEvidence?.verdict, 'PASS');
  assert.deepEqual(envelope.promptEvidence?.coverage, { total: 2, met: 2, unmet: 0, unproven: 0, blocked: 0 });
  assert.ok(envelope.promptEvidence?.evidence.every(e => e.provenance === 'verifier-collected' && e.facts.checkId === 'test'));
  assert.ok(envelope.evidencePath);
  const saved = JSON.parse(fs.readFileSync(path.join(envelope.evidencePath!, 'verification.json'), 'utf8')) as { promptEvidence?: { requirements: Array<Record<string, unknown>> } };
  assert.ok(saved.promptEvidence?.requirements.every(r => !Object.hasOwn(r, 'text')), 'persisted evidence omits user requirement prose');
});

it('prompt-evidence draft emits review-required, source-linked requirements without writing project state', () => {
  const root = path.join(TMP, 'draft-intake');
  fs.mkdirSync(root, { recursive: true });
  const goal = 'Implement registration:\n- Validate email input.\n- Hash passwords.';
  const result = run(['prompt-evidence', 'draft', goal, '--json'], root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const request = JSON.parse(result.stdout) as { schema: string; goal: { text: string }; requirements: Array<{ text: string; clarity: string; criteria: unknown[]; sourceRef: { start: number; end: number; excerpt: string } }> };
  assert.equal(request.schema, 'amabie-prompt-evidence/1');
  assert.equal(request.goal.text, goal);
  assert.deepEqual(request.requirements.map(requirement => requirement.text), ['Implement registration:', 'Validate email input.', 'Hash passwords.']);
  assert.ok(request.requirements.every(requirement => requirement.clarity === 'unclear' && requirement.criteria.length === 0));
  assert.ok(request.requirements.every(requirement => goal.slice(requirement.sourceRef.start, requirement.sourceRef.end) === requirement.sourceRef.excerpt));
  assert.match(result.stderr, /DRAFT ONLY.*NOT PROVEN/u);
  assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
});

it('doctor rejects a request whose task domain differs from the registered coding task', () => {
  const project = prepareProject({ includeBindings: 2 }, 'task-domain-mismatch');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const absoluteRequest = path.join(project.root, request);
  const data = JSON.parse(fs.readFileSync(absoluteRequest, 'utf8')) as { goal: { taskType: string } };
  data.goal.taskType = 'document';
  fs.writeFileSync(absoluteRequest, `${JSON.stringify(data, null, 2)}\n`);

  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 3);
  const envelope = JSON.parse(result.stdout) as { status: string; problems?: string[] };
  assert.equal(envelope.status, 'NEEDS ATTENTION');
  assert.match(envelope.problems?.join(' ') ?? '', /task type does not match/u);
});

it('Scenario B/C: green checks and an agent done claim do not cover an unbound requirement', () => {
  const project = prepareProject({ includeBindings: 1 }, 'scenario-b');
  const request = writeRequest(project.root, project.goal, project.requirements, 'All requirements are complete.');
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout) as { status: string; promptEvidence?: { verdict: string; requirements: Array<{ status: string; criteria: Array<{ note: string }> }> } };
  assert.equal(envelope.status, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.verdict, 'NOT PROVEN');
  assert.deepEqual(envelope.promptEvidence?.requirements.map(r => r.status), ['met', 'unproven']);
  assert.match(envelope.promptEvidence?.requirements[1]?.criteria[0]?.note ?? '', /no operator-sealed proof binding/u);
});

it('a green check cannot hide original-goal text omitted from the registered requirement set', () => {
  const project = makeProject('unmapped-goal', { includeBindings: 1 });
  const setup = run(['setup', '--yes'], project.root);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const task = run(['task', project.goal, '--requirement', project.requirements[0]!], project.root);
  assert.equal(task.status, 0, task.stderr || task.stdout);
  const request = writeRequest(project.root, project.goal, [project.requirements[0]!]);
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout) as { status: string; promptEvidence?: { verdict: string; sourceCoverage: { complete: boolean }; issues: string[] } };
  assert.equal(envelope.status, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.verdict, 'NOT PROVEN');
  assert.equal(envelope.promptEvidence?.sourceCoverage.complete, false);
  assert.match(envelope.promptEvidence?.issues.join(' ') ?? '', /uncovered non-whitespace/u);
});

it('Scenario D: a real failing sealed check is reported as contradictory evidence', () => {
  const project = prepareProject({ fixture: 'f-controlled.js', includeBindings: 2 }, 'scenario-d');
  fs.writeFileSync(path.join(project.root, '.amabie', 'controlled-failure'), 'fail');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const result = run(['doctor', '--prompt-evidence', request, '--json'], project.root);
  assert.equal(result.status, 2);
  const envelope = JSON.parse(result.stdout) as { status: string; promptEvidence?: { verdict: string; coverage: { unmet: number } } };
  assert.equal(envelope.status, 'NEEDS ATTENTION');
  assert.equal(envelope.promptEvidence?.verdict, 'FAIL');
  assert.equal(envelope.promptEvidence?.coverage.unmet, 2);
});

it('the command refuses selected-check and fast paths that cannot establish full requirement coverage', () => {
  const project = prepareProject({ includeBindings: 2 }, 'no-partial');
  const request = writeRequest(project.root, project.goal, project.requirements);
  const partial = run(['doctor', '--prompt-evidence', request, '--check', 'tests'], project.root);
  assert.equal(partial.status, 3);
  assert.match(partial.stdout, /cannot be combined with --check/u);
  const fast = run(['doctor', '--prompt-evidence', request, '--fast'], project.root);
  assert.equal(fast.status, 3);
  assert.match(fast.stdout, /cannot be combined with --fast/u);
});
