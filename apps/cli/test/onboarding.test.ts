/**
 * Productization contract tests (setup / doctor / uninstall / checkpoint).
 *
 * Mirrors cli.test.ts: pure logic in-process; user-visible behavior against
 * the BUILT CLI as a subprocess in throwaway git repos. Guards the promises
 * the onboarding doctrine makes: READY only with executed proof, exact-match
 * removal of Amabie-owned entries only, malformed config never overwritten,
 * checkpoint blocks the agent on failure and never fakes green on infra.
 *
 * Project "scripts" under test reference fixture FILES in
 * tooling/test-support/fixtures by absolute path — never inline `node -e`
 * programs (approval-free workflow rule: automated tests execute known local
 * scripts, not dynamically constructed interpreter snippets).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { materialDigest } from '../src/authorization.js';
process.env.AMABIE_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-trust-')); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import {
  detectPm, detectPlan, planWithFreshTests, isSafeScriptName, stepArgv, buildHookCommand, hasAmabieEntry, containedRealPath,
  writeConfig, readConfig, installClaudeHooks,
  type AmabieConfig,
} from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = process.env.AMABIE_TEST_CLI
  ? path.resolve(process.env.AMABIE_TEST_CLI)
  : path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-onb-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function makeProject(name: string, opts: { testScript?: string; extraScripts?: Record<string, string>; claudeDir?: boolean; settings?: unknown | 'corrupt' } = {}): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot only needs .git presence
  const scripts: Record<string, string> = { test: opts.testScript ?? fx('f-pass.js'), ...opts.extraScripts };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, scripts }, null, 2));
  if (opts.claudeDir !== false) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    if (opts.settings === 'corrupt') fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{not json');
    else if (opts.settings) fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(opts.settings, null, 2));
  }
  return root;
}

const cfgFile = (root: string): string => path.join(root, '.amabie', 'amabie.local.json');
const readCfg = (root: string): AmabieConfig => JSON.parse(fs.readFileSync(cfgFile(root), 'utf8')) as AmabieConfig;
const writeCfg = (root: string, cfg: AmabieConfig): void => fs.writeFileSync(cfgFile(root), JSON.stringify(cfg));
const cpFile = (root: string): string => path.join(root, '.amabie', 'last-checkpoint.json');

function amabie(args: string[], cwd?: string, input?: string, env?: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: 'utf8', timeout: 120_000, env: env ? { ...process.env, ...env } : undefined,
  });
}
const eventCommands = (root: string, event: string): string[] => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
    hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return (doc.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
};
const stopCommands = (root: string): string[] => eventCommands(root, 'Stop');

describe('detection (pure)', () => {
  it('lockfiles pick the package manager, first match wins in declared order', () => {
    const r = fs.mkdtempSync(path.join(TMP, 'pm-'));
    fs.writeFileSync(path.join(r, 'pnpm-lock.yaml'), '');
    assert.equal(detectPm(r).pm, 'pnpm');
    fs.writeFileSync(path.join(r, 'package-lock.json'), '');
    assert.equal(detectPm(r).pm, 'npm'); // npm-listed first — deterministic
    assert.equal(detectPm(fs.mkdtempSync(path.join(TMP, 'pm0-'))).pm, 'npm'); // no lockfile -> honest default
  });
  it('plan is conservative, ordered, and exact-name only', () => {
    const plan = detectPlan({ build: 'x', test: 'x', lint: 'x', pretest: 'x', 'type-check': 'x' });
    assert.deepEqual(plan.map((s) => s.kind), ['typecheck', 'build', 'tests']);
    assert.deepEqual(detectPlan({ lint: 'x' }), []);
  });
  it('legacy test-before-build plans repeat only their sealed tests after the final build', () => {
    const current = detectPlan({ build: 'x', test: 'x', 'type-check': 'x' });
    assert.deepEqual(planWithFreshTests(current), current, 'current discovery must not add work');
    const tests = current.find((step) => step.kind === 'tests')!;
    const build = current.find((step) => step.kind === 'build')!;
    const legacy = [tests, build];
    assert.deepEqual(planWithFreshTests(legacy), [tests, build, tests]);
    assert.deepEqual(legacy, [tests, build], 'sealed plan remains unchanged');
    assert.deepEqual(planWithFreshTests([tests]), [tests], 'no build means no repeat');
    assert.deepEqual(planWithFreshTests([build, tests, build]), [build, tests, build, tests]);
  });
  it('shell-shaped script names never enter a plan', () => {
    for (const bad of ['te;st', 'a b', 'x&&y', 'q"uote', '']) assert.ok(!isSafeScriptName(bad), bad);
    assert.throws(() => stepArgv('npm', 'rm -rf /'), /refused unsafe/);
    assert.throws(() => stepArgv('bash', 'test'), /refused unsafe/);
    assert.deepEqual(stepArgv('npm', 'test'), ['npm', 'run', 'test']);
  });
  it('a shell-expanding CLI path cannot be embedded in a hook command', () => {
    assert.equal(buildHookCommand('C:\\p"ath\\main.js'), null);
    assert.equal(buildHookCommand('C:\\p%PATH%\\main.js'), null);
    assert.equal(buildHookCommand('C:\\p!PATH!\\main.js'), null);
    assert.equal(buildHookCommand('C:\\p\nmain.js'), null);
    assert.equal(buildHookCommand('/tmp/amabie$(touch owned)/main.js'), null);
    assert.equal(buildHookCommand('/tmp/amabie`touch owned`/main.js'), null);
    assert.equal(buildHookCommand('C:\\p\\main.js\r'), null);
    assert.equal(buildHookCommand('C:\\plain path\\main.js'), 'node "C:\\plain path\\main.js" checkpoint');
    assert.equal(buildHookCommand('C:\\A&B (test)\\main.js'), 'node "C:\\A&B (test)\\main.js" checkpoint');
  });
  it('containedRealPath: inside stays inside, outside resolves to null (S3 floor)', () => {
    const root = makeProject('contain');
    assert.ok(containedRealPath(root, path.join(root, '.amabie', 'not-yet.json'))); // missing tail is safe once ancestor is contained
    assert.equal(containedRealPath(root, path.join(TMP, 'victim-x.json')), null); // exists outside root
    assert.equal(containedRealPath(root, path.join(root, '..', 'escape.json')), null); // outside even if missing
  });
});

describe('setup', () => {
  it('explains the task-scope limit when no acceptance criteria were registered', () => {
    const root = makeProject('setup-no-task-criteria');
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    assert.match(setup.stdout, /READY/);
    assert.match(setup.stdout, /no task acceptance criteria are registered/);
    assert.match(setup.stdout, /cannot assess requirements it was never given/);
    assert.match(setup.stdout, /bind them to an existing check/);
    assert.match(setup.stdout, /--reseal/);

    const registered = amabie(['task', 'fix the behavior', '--requirement', 'preserve the documented result'], root);
    assert.equal(registered.status, 0, `${registered.stdout} ${registered.stderr}`);
    const withRequirement = amabie(['setup', '--yes', root]);
    assert.equal(withRequirement.status, 0, `${withRequirement.stdout} ${withRequirement.stderr}`);
    assert.doesNotMatch(withRequirement.stdout, /no task acceptance criteria are registered/);
    assert.match(withRequirement.stdout, /registered 1 requirement/);
  });

  it('build-dependent tests pass on first setup and completion after clean, while compiled regressions stay blocked', () => {
    const root = makeProject('build-dependent', {
      testScript: `${fx('build-dependent-check.cjs')} test`,
      extraScripts: { build: `${fx('build-dependent-check.cjs')} build` },
    });
    fs.writeFileSync(path.join(root, 'implementation.json'), 'true\n');
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    assert.deepEqual(readCfg(root).plan.map((s) => s.kind), ['build', 'tests']);
    const orderFile = path.join(root, 'check-order.txt');
    assert.equal(fs.readFileSync(orderFile, 'utf8'), 'build\ntest\n');
    fs.rmSync(path.join(root, 'dist'), { recursive: true });
    const hookInput = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root });
    assert.equal(amabie(['checkpoint'], root, hookInput).stdout.trim(), '');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
    // A stale passing artifact must be rebuilt, then fail the real assertion.
    fs.writeFileSync(path.join(root, 'implementation.json'), 'false\n');
    const blocked = amabie(['checkpoint'], root, hookInput);
    assert.equal(JSON.parse(blocked.stdout).decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    assert.equal(fs.readFileSync(path.join(root, 'dist/implementation.json'), 'utf8'), 'false\n');
    fs.writeFileSync(path.join(root, 'implementation.json'), 'true\n');
    assert.equal(amabie(['doctor', root]).status, 0, 'repair rebuilds before testing stale failing output');
    // A build failure stays red even if an older artifact passes its tests.
    fs.writeFileSync(path.join(root, 'implementation.json'), 'BUILD_ERROR\n');
    const badBuild = amabie(['checkpoint'], root, hookInput);
    assert.equal(JSON.parse(badBuild.stdout).decision, 'block');
    const failed = JSON.parse(fs.readFileSync(cpFile(root), 'utf8'));
    assert.equal(failed.status, 'fail');
    assert.deepEqual(failed.checks.map((s: { ok: boolean }) => s.ok), [false, true]);
    assert.equal(fs.readFileSync(orderFile, 'utf8'), 'build\ntest\n'.repeat(5));
  });

  it('an explicitly ordered test-before-build plan cannot certify stale artifacts at setup, doctor or Stop', () => {
    const root = path.join(TMP, 'declared-legacy-order');
    for (const dir of ['.git', '.claude', 'dist']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const fixture = path.join(FIXTURES, 'build-dependent-check.cjs');
    fs.writeFileSync(path.join(root, 'amabie.project.json'), JSON.stringify({
      schema: 'amabie-project/1', scopes: [{ path: '.', checks: [
        { name: 'tests', kind: 'tests', argv: [process.execPath, fixture, 'test'] },
        { name: 'build', kind: 'build', argv: [process.execPath, fixture, 'build'] },
      ] }],
    }));
    fs.writeFileSync(path.join(root, 'implementation.json'), 'true\n');
    fs.writeFileSync(path.join(root, 'dist/implementation.json'), 'true\n');
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.deepEqual(readCfg(root).plan.map((step) => step.kind), ['tests', 'build']);
    const originalConfig = fs.readFileSync(cfgFile(root));
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).checks.map((step: { ok: boolean }) => step.ok), [true, true, true]);
    fs.writeFileSync(path.join(root, 'implementation.json'), 'false\n');
    const doctor = amabie(['doctor', root]);
    assert.equal(doctor.status, 2, doctor.stdout + doctor.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).checks.map((step: { ok: boolean }) => step.ok), [true, true, false]);
    fs.writeFileSync(path.join(root, 'dist/implementation.json'), 'true\n');
    const hook = amabie(['checkpoint'], root, JSON.stringify({ cwd: root, stop_hook_active: false }));
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).decision, 'block');
    assert.deepEqual(fs.readFileSync(cfgFile(root)), originalConfig, 'execution cannot reseal the ordered plan');
  });

  it('colored Vitest collection failure reports the missing build and retains a block', () => {
    const root = makeProject('colored-vitest-collection', { testScript: `${fx('vitest-color-check.cjs')} collection` });
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    fs.writeFileSync(path.join(root, '.fixture-fail'), 'trigger collection failure');
    const r = amabie(['checkpoint'], root, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root }));
    assert.equal(r.status, 0, r.stderr);
    const response = JSON.parse(r.stdout);
    assert.equal(response.decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    assert.match(response.reason, /help-drift\.test\.ts \[ tests\/unit\/cli\/help-drift\.test\.ts \]/);
    assert.match(response.reason, /Error: dist CLI not found\. Run npm run build before npm test\./);
    assert.match(response.reason, /help-drift\.test\.ts:37:9/);
    assert.doesNotMatch(response.reason, /expected caught error|passing\.test\.ts/);
  });

  it('colored Vitest completion failure names the test and source location while preserving the red gate and raw log', () => {
    const root = makeProject('colored-vitest-failure', { testScript: fx('vitest-color-check.cjs') });
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, `${setup.stdout} ${setup.stderr}`);
    fs.writeFileSync(path.join(root, '.fixture-fail'), 'trigger the controlled failure');
    const r = amabie(['checkpoint'], root, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: root }));
    assert.equal(r.status, 0, r.stderr);
    const response = JSON.parse(r.stdout);
    assert.equal(response.decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    assert.match(response.reason, /failure-ids\.test\.ts > extractFailureIds > preserves hyphenated params/);
    assert.match(response.reason, /AssertionError: expected false to be true/);
    assert.match(response.reason, /failure-ids\.test\.ts:42:9/);
    assert.ok(response.reason.includes(`${buildHookCommand(CLI)!.replace(/ checkpoint$/, '')} doctor --check test`), response.reason);
    assert.doesNotMatch(response.reason, /passing\.test\.ts/);
    const log = response.reason.split('full output: ')[1]?.split('\n')[0];
    assert.ok(log && fs.existsSync(log));
    assert.ok(fs.readFileSync(log, 'utf8').includes('\x1b[41m'), 'raw evidence keeps the runner color bytes');
  });

  it('startup context gives a finish workflow without executing checks, survives retry and preserves foreign startup hooks', () => {
    const userStart = 'echo user-startup';
    const root = makeProject('startup-context', { settings: { theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: userStart }] }] } } });
    const marker = path.join(root, 'startup-ran-check.txt');
    const runner = path.join(root, 'check.cjs');
    fs.copyFileSync(path.join(FIXTURES, 'setup-check-marker.js'), runner);
    const pkg = { scripts: { test: `node "${runner}" "${marker}"` } };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    for (const n of [1, 2]) { const r = amabie(['setup', '--yes', root]); assert.equal(r.status, 0, `setup ${n}: ${r.stdout} ${r.stderr}`); }
    fs.rmSync(marker);
    const before = fs.readFileSync(cpFile(root));
    const invoke = () => amabie(['checkpoint', '--session-start'], root, JSON.stringify({ hook_event_name: 'SessionStart', cwd: root }));
    const r = invoke();
    assert.equal(r.status, 0, r.stderr);
    const output = JSON.parse(r.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /finish.*normally/i);
    assert.match(context, /scripts\.test/);
    assert.match(context, /not a verification result/i);
    assert.match(context, /At the start of each new project request, call Amabie MCP mcp__amabie__amabie_task before project changes/i);
    assert.match(context, /every stated criterion copied verbatim; use requirements: \[\] when none were stated/i);
    assert.match(context, /AGENT_REPORTED input only/i);
    assert.match(context, /continue authorized implementation and tests even when an objective criterion lacks a sealed proof/i);
    assert.match(context, /keep it NOT PROVEN and let the completion hook report the operator binding hint/i);
    assert.match(context, /Subjective-only duties may continue to human acceptance/i);
    assert.match(context, /blocks Claude Code shell, write, agent-delegation and MCP calls until that request is registered; after registration, proof gaps do not block project work/i);
    assert.match(context, /Keep every unbound criterion NOT PROVEN/i);
    assert.match(context, /Amabie runs the sealed base comparison itself; do not switch, reset, or restore this branch/i);
    assert.match(context, /task tool is missing or unavailable, stop and ask the operator to restore Amabie MCP/i);
    assert.match(context, /shell commands are blocked until registration succeeds/i);
    assert.match(context, /file or case filter for early feedback/i);
    assert.match(context, /full sealed checks at completion/i);
    assert.ok(context.includes(CLI), 'repair command must name the installed CLI');
    assert.equal(fs.existsSync(marker), false, 'startup must not execute the sealed check');
    assert.deepEqual(fs.readFileSync(cpFile(root)), before, 'startup must not write a verification result');
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    const starts = settings.hooks.SessionStart.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks);
    assert.equal(starts.filter((hook: { command: string }) => hook.command.endsWith('checkpoint --session-start')).length, 1);
    assert.equal(starts.filter((hook: { command: string }) => hook.command === userStart).length, 1);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node unsealed.js' } }));
    assert.equal(invoke().stdout.trim(), '', 'startup must not advertise a changed command as sealed');
    assert.deepEqual(fs.readFileSync(cpFile(root)), before);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    assert.equal(amabie(['uninstall', root]).status, 0);
    const remaining = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    assert.equal(remaining.theme, 'dark');
    assert.deepEqual(remaining.hooks.SessionStart.flatMap((group: { hooks: unknown[] }) => group.hooks), [{ type: 'command', command: userStart }]);
  });

  it('startup preflight refuses malformed SessionStart hooks without replacing user settings', () => {
    const root = makeProject('startup-malformed', { settings: { hooks: { SessionStart: 'not a list' } } });
    const file = path.join(root, '.claude/settings.json'), before = fs.readFileSync(file);
    const result = amabie(['setup', '--yes', root]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /SessionStart/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(cfgFile(root)), false);
  });

  it('startup guidance cannot clear a failing completion gate', () => {
    const root = makeProject('startup-red-gate', { testScript: fx('f-boom.js') });
    assert.equal(amabie(['setup', '--yes', root]).status, 2);
    const before = fs.readFileSync(cpFile(root));
    const startup = amabie(['checkpoint', '--session-start'], root, JSON.stringify({ hook_event_name: 'SessionStart' }));
    assert.equal(JSON.parse(startup.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.deepEqual(fs.readFileSync(cpFile(root)), before);
    const stopped = amabie(['checkpoint'], root, JSON.stringify({ cwd: root, hook_event_name: 'Stop', stop_hook_active: false }));
    assert.equal(JSON.parse(stopped.stdout).decision, 'block');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
  });

  it('setup --check is read-only and never executes the planned project command', () => {
    const root = makeProject('preflight');
    const marker = path.join(root, 'project-command-ran.txt');
    const script = path.join(root, 'setup-check-marker.js');
    fs.copyFileSync(path.join(FIXTURES, 'setup-check-marker.js'), script);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.test = `node "${script}" "${marker}"`;
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    const r = amabie(['setup', '--check', '--json', root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const env = JSON.parse(r.stdout) as { schema: string; status: string; setupCheck: { plan: unknown[]; harnesses: unknown[]; limitations: string[] } };
    assert.equal(env.schema, 'amabie-setup-check/1');
    assert.equal(env.status, 'SETUP ELIGIBLE');
    assert.equal(env.setupCheck.plan.length, 1);
    assert.ok(env.setupCheck.harnesses.length > 0);
    assert.ok(env.setupCheck.limitations.some((x) => /project command was run/i.test(x)));
    assert.equal(fs.existsSync(marker), false, 'preflight must not run the planned test script');
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false, 'preflight must not create Amabie state');
    assert.equal(fs.existsSync(path.join(root, '.claude', 'settings.json')), false, 'preflight must not install a hook');
    assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false, 'preflight must not write MCP settings');
  });

  it('setup --check reports hook and MCP merge conflicts without changing either file', () => {
    const root = makeProject('preflight-conflicts', { settings: 'corrupt' });
    const settings = path.join(root, '.claude', 'settings.json');
    const mcp = path.join(root, '.mcp.json');
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { amabie: { command: 'node', args: ['foreign.js'] } } }));
    const beforeSettings = fs.readFileSync(settings, 'utf8');
    const beforeMcp = fs.readFileSync(mcp, 'utf8');
    const r = amabie(['setup', '--check', '--json', root]);
    assert.equal(r.status, 2);
    const env = JSON.parse(r.stdout) as { status: string; problems: string[] };
    assert.equal(env.status, 'SETUP NEEDS ATTENTION');
    assert.ok(env.problems.some((x) => /Claude Code hook/.test(x)));
    assert.ok(env.problems.some((x) => /MCP tools/.test(x)));
    assert.equal(fs.readFileSync(settings, 'utf8'), beforeSettings);
    assert.equal(fs.readFileSync(mcp, 'utf8'), beforeMcp);
    assert.equal(fs.existsSync(path.join(root, '.amabie')), false);
  });

  it('restores every integration file when authority sealing fails after setup writes them', () => {
    const root = makeProject('setup-rollback', { settings: { theme: 'dark' } });
    const codexDir = path.join(root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const codexHooks = path.join(codexDir, 'hooks.json');
    const codexDoc = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-codex' }] }] } };
    fs.writeFileSync(codexHooks, JSON.stringify(codexDoc));
    const settings = path.join(root, '.claude', 'settings.json');
    const mcp = path.join(root, '.mcp.json');
    const mcpDoc = { mcpServers: { teammate: { command: 'node', args: ['teammate.js'] } } };
    fs.writeFileSync(mcp, JSON.stringify(mcpDoc));
    const before = [settings, codexHooks, mcp].map((file) => fs.readFileSync(file));
    const blockedStore = path.join(TMP, 'trust-store-is-a-file');
    fs.writeFileSync(blockedStore, 'not a directory');

    const result = amabie(['setup', '--yes', root], undefined, undefined, { AMABIE_TRUST_STORE: blockedStore });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /could not store its verification record/i);
    assert.match(result.stdout, /verified NOTHING: no project checks were run/i);
    for (const [index, file] of [settings, codexHooks, mcp].entries()) {
      assert.deepEqual(fs.readFileSync(file), before[index], `${path.basename(file)} must be restored byte-for-byte`);
    }
    assert.equal(fs.existsSync(cfgFile(root)), false, 'failed setup must not leave an active Amabie config');
  });

  it('an explicitly selected expert MCP profile survives setup re-runs', () => {
    const root = makeProject('expert-profile');
    const first = amabie(['setup', '--mcp-profile', 'expert', '--yes', root]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /MCP tools: expert profile \(4 everyday tools plus 3 expert tools: agents, work, finish\)/);
    const mcpPath = path.join(root, '.mcp.json');
    const readProfile = (): string[] => ((JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as {
      mcpServers: { amabie: { args: string[] } };
    }).mcpServers.amabie.args);
    assert.deepEqual(readProfile().slice(-2), ['--profile', 'expert']);
    const cfg = JSON.parse(fs.readFileSync(cfgFile(root), 'utf8')) as AmabieConfig;
    assert.equal(cfg.mcpProfile, 'expert');
    const second = amabie(['setup', '--yes', root]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.deepEqual(readProfile().slice(-2), ['--profile', 'expert']);
  });

  it('happy path: READY, hook registered, evidence written, user repo untouched otherwise', () => {
    const root = makeProject('ok', { extraScripts: { build: fx('f-pass.js') }, settings: { hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo user-pre-tool' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo user-prompt' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-post-tool' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'echo user-session-end' }] }],
    } } });
    const r = amabie(['setup', '--yes', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    assert.match(r.stdout, /✓ tests: npm run test/);
    const cmds = stopCommands(root);
    assert.equal(cmds.filter((c) => c.includes('checkpoint')).length, 1);
    assert.equal(cmds.filter((c) => c === 'echo user-hook').length, 1); // merge, not clobber
    const preTool = eventCommands(root, 'PreToolUse');
    assert.equal(preTool.filter((c) => c === 'echo user-pre-tool').length, 1);
    assert.equal(preTool.filter((c) => c === readCfg(root).hookCommand).length, 1);
    const preToolGroup = (JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as any).hooks.PreToolUse
      .find((group: { hooks: Array<{ command: string }> }) => group.hooks.some((hook) => hook.command === readCfg(root).hookCommand));
    assert.equal(preToolGroup.matcher, 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|Workflow|mcp__.*');
    for (const [event, userCommand] of [['UserPromptSubmit', 'echo user-prompt'], ['PostToolUse', 'echo user-post-tool'], ['SessionEnd', 'echo user-session-end']] as const) {
      const commands = eventCommands(root, event);
      assert.equal(commands.filter((command) => command === userCommand).length, 1, `${event}: preserve the user's hook`);
      assert.equal(commands.filter((command) => command === readCfg(root).hookCommand).length, 1, `${event}: install one Amabie hook`);
    }
    const postToolGroup = (JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as any).hooks.PostToolUse
      .find((group: { hooks: Array<{ command: string }> }) => group.hooks.some((hook) => hook.command === readCfg(root).hookCommand));
    assert.equal(postToolGroup.matcher, 'mcp__amabie__amabie_task');
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
    assert.equal(readCfg(root).mcpProfile, 'everyday');
    const mcpArgs = ((JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: { amabie: { args: string[] } };
    }).mcpServers.amabie.args);
    assert.deepEqual(mcpArgs.slice(-2), ['--profile', 'everyday']);
    assert.equal(fs.readFileSync(path.join(root, '.amabie', '.gitignore'), 'utf8'), '*\n');
  });
  it('re-run is idempotent: one Amabie entry, no duplicates, user entry preserved', () => {
    const root = makeProject('idem');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cmds = stopCommands(root);
    assert.equal(cmds.filter((c) => c.includes('checkpoint')).length, 1);
    assert.equal(eventCommands(root, 'PreToolUse').filter((c) => c === readCfg(root).hookCommand).length, 1);
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
      assert.equal(eventCommands(root, event).filter((command) => command === readCfg(root).hookCommand).length, 1);
    }
  });
  it('malformed settings.json: refuse, exit NEEDS ATTENTION, bytes untouched', () => {
    const root = makeProject('corrupt', { settings: 'corrupt' });
    const before = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
    const r = amabie(['setup', '--yes', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /not valid JSON/);
    assert.match(r.stdout, /NEEDS ATTENTION/);
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), before);
  });
  it('S5: valid JSON with a non-list hooks section gets a plain-words refusal, not an internal crash', () => {
    for (const [name, settings] of [['s5a', { hooks: 'nope' }], ['s5b', { hooks: { Stop: 'nope' } }], ['s5c', { hooks: { PreToolUse: 'nope' } }]] as const) {
      const root = makeProject(name, { settings });
      const before = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
      const r = amabie(['setup', '--yes', root]);
      assert.equal(r.status, 2, `${name}: expected refusal, got ${r.status}: ${r.output.join('')}`);
      assert.doesNotMatch(r.stderr, /TypeError|not a function/); // was: exit 3 "stop.push is not a function"
      assert.match(r.stdout, name === 's5a' ? /"hooks" section that is not a settings object/ : name === 's5b' ? /"hooks\.Stop" that is not a list/ : /"hooks\.PreToolUse" that is not a list/);
      assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), before);
    }
  });
  it('failing project checks never print READY (NO PROOF, NO DONE)', () => {
    const root = makeProject('failing', { testScript: fx('f-boom.js') });
    const r = amabie(['setup', '--yes', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /NEEDS ATTENTION/);
    assert.doesNotMatch(r.stdout, /^READY/m);
    assert.match(r.stdout, /boom: expected 1, got 2/); // loud, shows why
    assert.match(r.stdout, /your project's own checks did not pass/);
    // the evidence names WHAT failed (M6 pin: never an empty failed list)
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; failed: string[] };
    assert.equal(cp.status, 'fail');
    assert.ok(cp.failed.includes('tests'), `failed kinds: ${JSON.stringify(cp.failed)}`);
    // a repo whose checks fail must never read as protected — doctor agrees
    const d = amabie(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /NEEDS ATTENTION/);
    assert.doesNotMatch(d.stdout, /READY/);
    const cp2 = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; failed: string[] };
    assert.equal(cp2.status, 'fail');
    assert.ok(cp2.failed.includes('tests')); // doctor records real kinds too
  });
  it('unattended without --yes: the smoke test RUNS (like doctor always does) — READY only because checks actually passed', () => {
    // Master-pass S1: this branch used to write all state then exit 2 demanding
    // --yes. The flag guarded nothing doctor does not already do unasked.
    const root = makeProject('noyes');
    const r = amabie(['setup', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    assert.deepEqual(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
    // executing is not forgiving: a failing project still never reads READY
    const bad = makeProject('noyes-fail', { testScript: fx('f-boom.js') });
    const rb = amabie(['setup', bad]);
    assert.equal(rb.status, 2);
    assert.doesNotMatch(rb.stdout, /^READY/m);
  });
  it('S4: re-setup under byte-identical authority keeps the stamps; a real script change re-seals with fresh ones', () => {
    const root = makeProject('stamps');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cfgPath = path.join(root, '.amabie', 'amabie.local.json');
    const c1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { installedAt: string; planAuthority: { at: string }; baseline: { at: string } };
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const c2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as typeof c1;
    assert.equal(c2.installedAt, c1.installedAt); // approval timestamps record the APPROVAL, not the last invocation
    assert.equal(c2.planAuthority.at, c1.planAuthority.at);
    assert.equal(c2.baseline.at, c1.baseline.at);
    // sealed script TEXT changes = a genuine re-seal = honest fresh stamps
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.test = fx('f-boom.js');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    assert.equal(amabie(['setup', '--yes', root]).status, 2); // boom runs, fails; config was already rewritten
    const c3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as typeof c1;
    assert.notEqual(c3.installedAt, c1.installedAt);
    assert.notEqual(c3.planAuthority.at, c1.planAuthority.at);
  });
  it('no supported harness: explicit message, not a fake integration', () => {
    const root = makeProject('noharness', { claudeDir: false });
    const fakeHome = path.join(TMP, 'empty-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const env = process.platform === 'win32' ? { USERPROFILE: fakeHome } : { HOME: fakeHome };
    const r = amabie(['setup', '--yes', root], undefined, undefined, env);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no supported AI harness/i);
  });
  it('Windows path quoting survives E2E: a project path containing spaces onboards and self-checks', () => {
    const root = path.join(TMP, 'sp ace dir', 'my project');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sp-aced', scripts: { test: fx('f-pass.js') } }, null, 2));
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    assert.match(amabie(['doctor', root]).stdout, /READY/);
  });
});

describe('checkpoint (harness entry)', () => {
  const hookInput = (root: string, active = false) => JSON.stringify({ cwd: root, stop_hook_active: active, hook_event_name: 'Stop' });
  it('pass -> silent allow (human never interrupted)', () => {
    const root = makeProject('cp-ok');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const r = amabie(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; checks: Array<{ ok: boolean }>; hookResponse: string; sessionEnd: string };
    assert.equal(cp.status, 'pass');
    assert.deepEqual(cp.checks.map((x) => x.ok), [true]);
    assert.equal(cp.hookResponse, 'continued');
    assert.equal(cp.sessionEnd, 'unknown');
  });
  it('failure -> decision:block with the reason (agent gets a repair turn)', () => {
    const root = makeProject('cp-fail', { testScript: fx('f-needs.js') });
    amabie(['setup', '--yes', root]);
    const r = amabie(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(out.decision, 'block');
    // The reason is the MODEL-VISIBLE repair instruction, and it is bounded on purpose
    // (`failure-payload.ts`): 4000 characters of raw runner output became a compact payload.
    // The assertion therefore pins what the payload PROMISES the model — the failing check,
    // the command and exit code, a repair instruction, and where the full log is — rather
    // than the old prose wording it used to carry.
    assert.match(out.reason, /Amabie verification failed/);
    assert.match(out.reason, /tests/);
    assert.match(out.reason, /npm run test/);
    assert.match(out.reason, /exit 1/);
    assert.match(out.reason, /Fix this before finishing/);
    assert.ok(out.reason.includes(`${buildHookCommand(CLI)!.replace(/ checkpoint$/, '')} doctor --check test`), out.reason);
    assert.ok(!out.reason.includes('amabie doctor --check test'), out.reason);
    assert.match(out.reason, /full output: .+\.log/);
    assert.ok(out.reason.length <= 1200, `the model-visible payload must stay bounded, got ${out.reason.length} chars`);
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; checks: Array<{ ok: boolean }>; hookResponse: string };
    assert.equal(cp.status, 'fail');
    assert.deepEqual(cp.checks.map((x) => x.ok), [false]);
    assert.equal(cp.hookResponse, 'blocked');
  });
  it('loop guard: stop_hook_active allows with an honest systemMessage, never re-blocks', () => {
    const root = makeProject('cp-loop', { testScript: fx('f-fail.js') });
    amabie(['setup', '--yes', root]);
    const r = amabie(['checkpoint'], root, hookInput(root, true));
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage ?? '', /still failing/);
    const cp = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { status: string; hookResponse: string; sessionEnd: string };
    assert.equal(cp.status, 'fail');
    assert.equal(cp.hookResponse, 'message-and-continue');
    assert.equal(cp.sessionEnd, 'unknown');
  });
  it('scoped failures keep separate logs and recover through PARTIAL rechecks to a full proven completion', () => {
    const root = makeProject('cp-scoped-repair');
    fs.rmSync(path.join(root, 'package.json'));
    const scopes = ['backend', 'front end'];
    for (const scope of scopes) {
      const dir = path.join(root, scope);
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: scope.replace(/ /g, '-'), version: '1.0.0', scripts: { test: fx('f-regression.cjs') } }));
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = false;\n');
      fs.writeFileSync(path.join(dir, 'tests', 'regression.expected.json'), 'true\n');
    }
    fs.writeFileSync(path.join(root, 'amabie.scopes.json'), JSON.stringify({ schema: 'amabie-scopes/1', scopes: scopes.map((path) => ({ path, ecosystem: 'node' })) }));
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Amabie Repair'], ['config', 'user.email', 'repair@amabie.local'], ['add', '.'], ['commit', '-m', 'baseline']]) {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr);
    }
    const setup = amabie(['setup', '--yes', root]);
    const setupDiagnostic = JSON.stringify({ pid: setup.pid, status: setup.status, signal: setup.signal,
      error: setup.error?.message, stdout: setup.stdout, stderr: setup.stderr });
    assert.equal(setup.status, 2, `the sealed baseline fails both assertions: ${setupDiagnostic}`);
    assert.ok(fs.existsSync(cfgFile(root)), `setup must seal the failing baseline before checkpoint: ${setupDiagnostic}`);
    const checkpoint = amabie(['checkpoint'], root, hookInput(root));
    assert.ok(checkpoint.stdout.trim(), `checkpoint must emit its JSON decision: ${JSON.stringify({
      pid: checkpoint.pid, status: checkpoint.status, signal: checkpoint.signal,
      error: checkpoint.error?.message, stderr: checkpoint.stderr,
    })}`);
    const first = JSON.parse(checkpoint.stdout) as { decision: string; reason: string };
    assert.equal(first.decision, 'block');
    const cliPrefix = buildHookCommand(CLI)!.replace(/ checkpoint$/, '');
    assert.ok(first.reason.includes(`${cliPrefix} doctor --check backend::test`), first.reason);
    assert.ok(first.reason.includes(`${cliPrefix} doctor --check 'front end::test'`), first.reason);
    const logs = [...first.reason.matchAll(/full output: (.+)$/gm)].map((match) => match[1]!);
    assert.equal(new Set(logs).size, 2);
    for (const [i, file] of logs.entries()) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.includes(scopes[i]!.replace(/ /g, '-')), `each pointer must show its own scoped run:\n${text}`);
      assert.match(text, /false !== true/);
    }
    const manifest = path.join(root, 'backend', 'package.json');
    const manifestBefore = fs.readFileSync(manifest);
    const marker = path.join(root, 'unsealed-command-ran');
    const changed = JSON.parse(manifestBefore.toString());
    changed.scripts.test = `${fx('setup-check-marker.js')} "${marker}"`;
    fs.writeFileSync(manifest, JSON.stringify(changed));
    const drift = JSON.parse(amabie(['checkpoint'], root, hookInput(root)).stdout);
    assert.equal(drift.decision, 'block');
    assert.match(drift.reason, /verification authority changed/);
    assert.match(drift.reason, /backend::test.*changed since setup sealed it/);
    const unrelated = amabie(['doctor', '--check', 'front end::test', '--json', root]);
    assert.equal(unrelated.status, 2, 'a partial recheck must not hide drift in another scoped check');
    assert.notEqual(JSON.parse(unrelated.stdout).status, 'PARTIAL');
    assert.equal(fs.existsSync(marker), false, 'the unsealed command must never run');
    fs.writeFileSync(manifest, manifestBefore);
    fs.writeFileSync(path.join(root, 'backend', 'src', 'app.js'), 'module.exports = true;\n');
    const beforePartial = fs.readFileSync(cpFile(root));
    const partial = amabie(['doctor', '--check', 'backend::test', '--json', root]);
    assert.equal(partial.status, 0, partial.stdout + partial.stderr);
    assert.equal(JSON.parse(partial.stdout).status, 'PARTIAL');
    assert.deepEqual(fs.readFileSync(cpFile(root)), beforePartial);
    const stillRed = amabie(['doctor', root]);
    assert.equal(stillRed.status, 2, stillRed.stdout + stillRed.stderr);
    assert.ok(stillRed.stdout.includes(`${cliPrefix} doctor --check 'front end::test'`));
    const handoff = JSON.parse(amabie(['checkpoint'], root, hookInput(root, true)).stdout);
    assert.match(handoff.systemMessage, /still failing/);
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail');
    fs.writeFileSync(path.join(root, 'front end', 'src', 'app.js'), 'module.exports = true;\n');
    const complete = amabie(['checkpoint'], root, hookInput(root, true));
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(complete.stdout.trim(), '', 'the real regression check discriminates both fixes');
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'pass');
  });
  it('repo without Amabie wiring: exit 0, silent (stay out of the way)', () => {
    const root = makeProject('cp-none');
    const r = amabie(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
  it('S2: a config written by a different installation never executes — loud UNVERIFIED instead', () => {
    const root = makeProject('cp-distrust', { testScript: fx('f-boom.js') });
    assert.equal(amabie(['setup', '--yes', root]).status, 2); // plan fails, but config is written
    const cfg = readCfg(root);
    cfg.cliPath = path.join(FIXTURES, 'not-amabie.js'); // a clone's / another install's record
    writeCfg(root, cfg);
    const r = amabie(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined); // nothing ran, so nothing could fail into a block
    assert.match(out.systemMessage ?? '', /does not trust/);
    assert.match(out.systemMessage ?? '', /UNVERIFIED/);
    assert.doesNotMatch(r.stdout, /boom/); // proof the plan was NOT executed
  });
  it('S7: a parseable-but-wrong-shape config is treated as corrupt everywhere, never a crash', () => {
    const root = makeProject('s7');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(cfgFile(root), '{}'); // the old TypeError/exit-3 brick
    const d = amabie(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /unreadable/);
    assert.doesNotMatch(d.stderr, /TypeError|is not a function/);
    const c = amabie(['checkpoint'], root, JSON.stringify({ cwd: root, hook_event_name: 'Stop' }));
    assert.equal(c.status, 0);
    // GLM F-1 changed this pin: a corrupt config is NOT absence — silence here
    // was a silent allow through damaged authority. Must now be loud UNVERIFIED.
    const cout = JSON.parse(c.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(cout.decision, undefined); // never a fake block on unreadable bytes
    assert.match(cout.systemMessage ?? '', /unreadable/);
    assert.match(cout.systemMessage ?? '', /UNVERIFIED/);
    const u = amabie(['uninstall', root]);
    assert.equal(u.status, 2);
    assert.match(u.stdout, /unreadable/);
    assert.match(amabie(['setup', '--yes', root]).stdout, /READY/); // self-heal: setup rewrites it
  });
  it('F-1: a half-written (truncated) config is loud UNVERIFIED at checkpoint, never silent; doctor stays NEEDS ATTENTION', () => {
    const root = makeProject('cp-trunc');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(cfgFile(root), '{"version": "product-0.1", "install'); // the interrupted-write shape (F-2's failure mode)
    const r = amabie(['checkpoint'], root, hookInput(root));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined); // no evidence => no fake block; no silence => no silent allow
    assert.match(out.systemMessage ?? '', /unreadable/);
    assert.match(out.systemMessage ?? '', /UNVERIFIED/);
    assert.match(out.systemMessage ?? '', /amabie setup/);
    const d = amabie(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /NEEDS ATTENTION/);
  });
});

describe('atomic config writes (GLM F-2)', () => {
  const cfgOf = (pm: string): AmabieConfig => ({
    version: 'test-0.1', installedAt: '2026-09-07T00:00:00.000Z', pm,
    plan: [{ kind: 'tests', script: 'test' }], cliPath: CLI, hookCommand: 'h', hookCommands: ['h'], touched: [],
  });
  it('leaves no temp residue and round-trips exactly', () => {
    const root = path.join(TMP, 'atomic-clean');
    writeConfig(root, cfgOf('npm'));
    assert.deepEqual(readConfig(root), cfgOf('npm'));
    assert.deepEqual(fs.readdirSync(path.join(root, '.amabie')).filter((f) => f.includes('.amabie-tmp')), []);
  });
  it('a crash before the final rename leaves the PREVIOUS config byte-intact, never a corrupt half-file', () => {
    const root = path.join(TMP, 'atomic-crash');
    writeConfig(root, cfgOf('npm'));
    const before = fs.readFileSync(cfgFile(root), 'utf8');
    const realRename = fs.renameSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      // match by ARGUMENT, not call count: survives write-order changes and
      // any extra renames the helper grows (mutation-tested 2026-09-07)
      if (typeof args[0] === 'string' && /amabie[.]local[.]json[.][0-9]+[.]amabie-tmp$/.test(args[0])) {
        throw new Error('simulated crash before config rename');
      }
      return realRename(...args);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => writeConfig(root, cfgOf('pnpm')), /simulated crash/);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(fs.readFileSync(cfgFile(root), 'utf8'), before); // old COMPLETE file, not truncated bytes
    assert.notEqual(readConfig(root), 'corrupt'); // the loud-UNVERIFIED path stays reserved for real damage
    assert.deepEqual(fs.readdirSync(path.join(root, '.amabie')).filter((f) => f.includes('.amabie-tmp')), []); // self-cleaned
  });
  it('every write is fsync-ed BEFORE its publish rename (durable-then-visible order is pinned)', () => {
    const root = path.join(TMP, 'atomic-order');
    const order: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    fs.fsyncSync = ((fd: number) => { order.push('fsync'); return realFsync(fd); }) as typeof fs.fsyncSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      if (/[.]gitignore$|amabie[.]local[.]json$/.test(String(args[1]))) order.push('rename');
      return realRename(...args);
    }) as typeof fs.renameSync;
    try {
      writeConfig(root, cfgOf('npm')); // two atomic writes: .gitignore, then config
    } finally {
      fs.fsyncSync = realFsync;
      fs.renameSync = realRename;
    }
    assert.deepEqual(order, ['fsync', 'rename', 'fsync', 'rename']);
  });
  it('a crash during the settings write surfaces as a problem — original untouched, backup kept, no residue', () => {
    const root = path.join(TMP, 'atomic-settings');
    const settings = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"theme":"user-value"}\n'); // a stranger's file with real content
    const before = fs.readFileSync(settings, 'utf8');
    const realRename = fs.renameSync;
    fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
      if (typeof args[0] === 'string' && /settings[.]json[.][0-9]+[.]amabie-tmp$/.test(args[0])) {
        throw new Error('simulated crash before settings rename');
      }
      return realRename(...args);
    }) as typeof fs.renameSync;
    let res: { ok: boolean; problem?: string };
    try {
      res = installClaudeHooks(root, 'amabie-hook-cmd', new Set(), path.join(root, '.amabie', 'backups'));
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(res.ok, false);
    assert.match(res.problem ?? '', /left exactly as it was/);
    assert.equal(fs.readFileSync(settings, 'utf8'), before); // never truncated, never half-written
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(settings, 'utf8'))).join(), 'theme'); // intact, no hook entry
    assert.deepEqual(fs.readdirSync(path.dirname(settings)).filter((f) => f.includes('.amabie-tmp')), []);
    const backups = path.join(root, '.amabie', 'backups');
    assert.ok(fs.readdirSync(backups).some((f) => f.endsWith('-settings.json'))); // the claimed backup really exists
  });
});

describe('Claude per-request task-registration guard', () => {
  const markerPath = (root: string, sessionId: string): string => path.join(root, '.amabie', 'task', 'sessions', `${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
  const hook = (root: string, event: string, sessionId: string, toolName?: string, toolInput?: unknown) => amabie(['checkpoint'], root, JSON.stringify({
    hook_event_name: event, cwd: root, session_id: sessionId,
    ...(toolName ? { tool_name: toolName } : {}), ...(toolInput !== undefined ? { tool_input: toolInput } : {}),
  }));
  const startRequest = (root: string, sessionId = 'session') => hook(root, 'UserPromptSubmit', sessionId);
  const invoke = (root: string, tool: string, sessionId = 'session', toolInput: unknown = {}) => hook(root, 'PreToolUse', sessionId, tool, toolInput);
  const registerTask = (root: string, intent: string, requirements: string[] = [], sessionId = 'session') => {
    const input = { intent, requirements };
    const pre = invoke(root, 'mcp__amabie__amabie_task', sessionId, input);
    assert.equal(pre.stdout, '', `task intake should be allowed before registration: ${pre.stdout}`);
    const args = ['task', intent, ...requirements.flatMap((requirement) => ['--requirement', requirement])];
    const registered = amabie(args, root);
    assert.equal(registered.status, 0, `${registered.stdout}\n${registered.stderr}`);
    const post = hook(root, 'PostToolUse', sessionId, 'mcp__amabie__amabie_task', input);
    assert.equal(post.status, 0, post.stderr);
    return { pre, registered, post };
  };

  it('resets task scope for every prompt and runs no checkpoint outside Stop', () => {
    const root = makeProject('per-request-reset');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const checkpointBefore = fs.readFileSync(cpFile(root));
    const sessionId = 'session-reset';

    const noTurn = JSON.parse(invoke(root, 'Edit', sessionId).stdout);
    assert.equal(noTurn.hookSpecificOutput.permissionDecision, 'deny');
    const prompt = JSON.parse(startRequest(root, sessionId).stdout);
    assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(prompt.hookSpecificOutput.additionalContext, /fresh task scope/i);
    assert.deepEqual(fs.readFileSync(cpFile(root)), checkpointBefore, 'UserPromptSubmit must not run the completion gate');

    assert.equal(amabie(['task', 'old request'], root).status, 0);
    const beforeRegistration = JSON.parse(invoke(root, 'Edit', sessionId).stdout);
    assert.equal(beforeRegistration.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(beforeRegistration.hookSpecificOutput.permissionDecisionReason, /registration is missing for this request/i);
    assert.equal(JSON.parse(invoke(root, 'Workflow', sessionId).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(invoke(root, 'mcp__amabie__amabie_result', sessionId).stdout.length > 0, true);

    registerTask(root, 'new request', [], sessionId);
    assert.equal(invoke(root, 'Edit', sessionId).stdout, '', 'the current request is allowed after its own MCP registration');
    assert.equal(invoke(root, 'Workflow', sessionId).stdout, '', 'registered project work may start a Claude workflow');
    const first = JSON.parse(fs.readFileSync(markerPath(root, sessionId), 'utf8')) as { promptId: string; registeredPromptId: string | null; task: { taskDigest: string } | null };
    assert.equal(first.registeredPromptId, first.promptId);
    assert.equal(first.task?.taskDigest, materialDigest('new request'));

    assert.equal(startRequest(root, sessionId).status, 0);
    const second = JSON.parse(fs.readFileSync(markerPath(root, sessionId), 'utf8')) as { promptId: string; registeredPromptId: string | null; task: null };
    assert.notEqual(second.promptId, first.promptId);
    assert.equal(second.registeredPromptId, null);
    assert.equal(second.task, null);
    const stale = JSON.parse(invoke(root, 'Edit', sessionId).stdout);
    assert.equal(stale.hookSpecificOutput.permissionDecision, 'deny', 'a previous task file cannot authorize the next prompt');
    assert.deepEqual(fs.readFileSync(cpFile(root)), checkpointBefore, 'prompt and tool hooks must not run the completion gate');
  });

  it('registers only the task returned by the successful MCP call and rejects replacement within a turn', () => {
    const root = makeProject('per-request-registration-match');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const sessionId = 'session-match';
    startRequest(root, sessionId);
    const toolInput = { intent: 'recorded task', requirements: [] };
    assert.equal(invoke(root, 'mcp__amabie__amabie_task', sessionId, toolInput).stdout, '');
    assert.equal(amabie(['task', 'different stored task'], root).status, 0);
    const mismatched = JSON.parse(hook(root, 'PostToolUse', sessionId, 'mcp__amabie__amabie_task', toolInput).stdout);
    assert.match(mismatched.hookSpecificOutput.additionalContext, /could not bind this task registration/i);
    assert.equal(JSON.parse(invoke(root, 'Edit', sessionId).stdout).hookSpecificOutput.permissionDecision, 'deny');

    registerTask(root, 'recorded task', [], sessionId);
    assert.equal(invoke(root, 'mcp__amabie__amabie_task', sessionId, toolInput).stdout, '', 'an identical registration is idempotent');
    const replacement = JSON.parse(invoke(root, 'mcp__amabie__amabie_task', sessionId, { intent: 'weaker task', requirements: [] }).stdout);
    assert.equal(replacement.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(invoke(root, 'Edit', sessionId).stdout, '');
  });

  it('keeps task snapshots separate across Claude sessions and removes them at SessionEnd', () => {
    const root = makeProject('per-request-session-isolation');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const sessionA = 'session-a', sessionB = 'session-b';
    startRequest(root, sessionA);
    const requirementA = 'the API responds within 42 ms';
    registerTask(root, 'task A', [requirementA], sessionA);
    startRequest(root, sessionB);
    const missingB = JSON.parse(invoke(root, 'Edit', sessionB).stdout);
    assert.equal(missingB.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(invoke(root, 'Edit', sessionA).stdout, '', 'one session registration does not authorize another');
    registerTask(root, 'task B', ['the command prints the project root'], sessionB);

    const completionA = amabie(['checkpoint'], root, JSON.stringify({ cwd: root, session_id: sessionA, hook_event_name: 'Stop' }));
    assert.equal(completionA.status, 0, completionA.stderr);
    const checkpoint = JSON.parse(fs.readFileSync(cpFile(root), 'utf8')) as { proof?: { registeredRequirements?: number; obligations?: Array<{ id: string }> } };
    assert.equal(checkpoint.proof?.registeredRequirements, 1);
    assert.ok(checkpoint.proof?.obligations?.some((item) => item.id.includes(materialDigest(requirementA))),
      'Stop must evaluate this session snapshot even after another session replaces current.json');

    const marker = markerPath(root, sessionB);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(hook(root, 'SessionEnd', sessionB).stdout, '');
    assert.equal(fs.existsSync(marker), false);
  });

  it('allows mixed, subjective-only and already-bound tasks after current-request intake', () => {
    const mixed = makeProject('pretool-mixed');
    assert.equal(amabie(['setup', '--yes', mixed]).status, 0);
    const objective = 'the API returns exactly 42 for input 41';
    const subjective = 'the dialog looks nicer';
    startRequest(mixed);
    registerTask(mixed, 'fix the API and polish the dialog', [objective, subjective]);
    assert.equal(invoke(mixed, 'Write').stdout, '');

    const subjectiveOnly = makeProject('pretool-subjective');
    assert.equal(amabie(['setup', '--yes', subjectiveOnly]).status, 0);
    startRequest(subjectiveOnly);
    registerTask(subjectiveOnly, 'polish the dialog', [subjective]);
    assert.equal(invoke(subjectiveOnly, 'Edit').stdout, '');

    const bound = makeProject('pretool-bound');
    const packageFile = path.join(bound, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as Record<string, unknown>;
    manifest.amabie = { proofs: { [materialDigest(objective)]: 'test' } };
    fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2));
    assert.equal(amabie(['setup', '--yes', bound]).status, 0);
    startRequest(bound);
    registerTask(bound, 'fix the API result', [objective]);
    assert.equal(invoke(bound, 'Edit').stdout, '', 'bound objective criteria remain actionable');
  });

  it('fails closed on missing or unreadable local authority', () => {
    const root = makeProject('pretool-corrupt-config');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    startRequest(root);
    fs.writeFileSync(cfgFile(root), '{broken');
    const decision = JSON.parse(invoke(root, 'Bash').stdout);
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /configuration is unreadable/);

    const taskRoot = makeProject('pretool-corrupt-task');
    assert.equal(amabie(['setup', '--yes', taskRoot]).status, 0);
    startRequest(taskRoot);
    const taskFile = path.join(taskRoot, '.amabie', 'task', 'current.json');
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(taskFile, '{broken');
    const taskCall = invoke(taskRoot, 'mcp__amabie__amabie_task', 'session', { intent: 'repair task scope', requirements: [] });
    assert.equal(taskCall.stdout, '', 'a new MCP registration can replace a stale malformed global task file');
    const registered = amabie(['task', 'repair task scope'], taskRoot);
    assert.equal(registered.status, 0, `${registered.stdout}\n${registered.stderr}`);
    assert.equal(hook(taskRoot, 'PostToolUse', 'session', 'mcp__amabie__amabie_task', { intent: 'repair task scope', requirements: [] }).stdout, '');
    assert.equal(invoke(taskRoot, 'Edit').stdout, '');
  });
});

describe('doctor + uninstall', () => {
  it('a passing focused check reports PARTIAL and leaves the full checkpoint unchanged', () => {
    const root = makeProject('doctor-focused', { extraScripts: { build: 'placeholder' } });
    const buildScript = path.join(root, 'mutable-build.js');
    fs.copyFileSync(path.join(FIXTURES, 'f-pass.js'), buildScript);
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.build = `node "${buildScript}"`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const checkpointBefore = fs.readFileSync(cpFile(root));

    fs.copyFileSync(path.join(FIXTURES, 'f-boom.js'), buildScript);
    const focused = amabie(['doctor', '--check', 'test', '--json', root]);
    assert.equal(focused.status, 0, focused.stdout + focused.stderr);
    const envelope = JSON.parse(focused.stdout) as {
      schema: string; status: string; partialCheck: { id: string; passed: boolean; ran: boolean };
    };
    assert.equal(envelope.schema, 'amabie-doctor-partial/1');
    assert.equal(envelope.status, 'PARTIAL');
    assert.deepEqual(envelope.partialCheck, { id: 'test', passed: true, ran: true, exitCode: 0 });
    assert.doesNotMatch(focused.stdout, /READY/);
    assert.deepEqual(fs.readFileSync(cpFile(root)), checkpointBefore, 'a diagnostic must not replace the completion checkpoint');

    const unknown = amabie(['doctor', '--check', 'not-sealed', '--json', root]);
    assert.equal(unknown.status, 3);
    assert.match(unknown.stdout, /available ids: build, test/);
    assert.deepEqual(fs.readFileSync(cpFile(root)), checkpointBefore, 'an unknown id must not execute or alter a result');

    const full = amabie(['doctor', root]);
    assert.equal(full.status, 2, full.stdout + full.stderr);
    assert.match(full.stdout, /checks just failed \(build\)/i);
    assert.ok(full.stdout.includes(`focused recheck after repair: ${buildHookCommand(CLI)!.replace(/ checkpoint$/, '')} doctor --check build`));
    assert.equal(JSON.parse(fs.readFileSync(cpFile(root), 'utf8')).status, 'fail', 'the full gate still records the other failed check');
  });

  it('READY after a green setup; either missing Claude hook is detected loudly; --run still works', () => {
    const root = makeProject('doc');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const first = amabie(['doctor', root]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /READY/);
    assert.match(first.stdout, /running the verification plan/); // S4: doctor runs NOW, not from a record
    const sfile = path.join(root, '.claude', 'settings.json');
    const preToolDoc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { PreToolUse: unknown[] } };
    preToolDoc.hooks.PreToolUse = [];
    fs.writeFileSync(sfile, JSON.stringify(preToolDoc));
    const noPreTool = amabie(['doctor', root]);
    assert.equal(noPreTool.status, 2);
    assert.match(noPreTool.stdout, /PreToolUse task-intake guard.*project changes can proceed without a registered task/i);
    assert.equal(amabie(['setup', '--yes', root]).status, 0, 'setup restores the guard');
    const narrowedDoc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { PreToolUse: Array<{ matcher?: string }> } };
    narrowedDoc.hooks.PreToolUse[0]!.matcher = 'Bash';
    fs.writeFileSync(sfile, JSON.stringify(narrowedDoc));
    const narrowed = amabie(['doctor', root]);
    assert.equal(narrowed.status, 2);
    assert.match(narrowed.stdout, /PreToolUse task-intake guard.*project changes can proceed without a registered task/i);
    assert.equal(amabie(['setup', '--yes', root]).status, 0, 'setup restores the required matcher');
    const promptDoc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { UserPromptSubmit: unknown[] } };
    promptDoc.hooks.UserPromptSubmit = [];
    fs.writeFileSync(sfile, JSON.stringify(promptDoc));
    const noPromptReset = amabie(['doctor', root]);
    assert.equal(noPromptReset.status, 2);
    assert.match(noPromptReset.stdout, /UserPromptSubmit turn reset.*previous task can satisfy the next request/i);
    assert.equal(amabie(['setup', '--yes', root]).status, 0, 'setup restores the prompt reset');
    const postDoc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { PostToolUse: Array<{ matcher?: string }> } };
    postDoc.hooks.PostToolUse[0]!.matcher = 'Bash';
    fs.writeFileSync(sfile, JSON.stringify(postDoc));
    const noTaskReceipt = amabie(['doctor', root]);
    assert.equal(noTaskReceipt.status, 2);
    assert.match(noTaskReceipt.stdout, /PostToolUse task registration.*cannot be confirmed/i);
    assert.equal(amabie(['setup', '--yes', root]).status, 0, 'setup restores the task receipt matcher');
    const endDoc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { SessionEnd: unknown[] } };
    endDoc.hooks.SessionEnd = [];
    fs.writeFileSync(sfile, JSON.stringify(endDoc));
    const noCleanup = amabie(['doctor', root]);
    assert.equal(noCleanup.status, 2);
    assert.match(noCleanup.stdout, /SessionEnd cleanup.*task-session state may remain/i);
    assert.equal(amabie(['setup', '--yes', root]).status, 0, 'setup restores session cleanup');
    // tamper: strip Amabie's completion entry, keep the file
    const doc = JSON.parse(fs.readFileSync(sfile, 'utf8')) as { hooks: { Stop: unknown[] } };
    doc.hooks.Stop = [];
    fs.writeFileSync(sfile, JSON.stringify(doc));
    const t = amabie(['doctor', root]);
    assert.equal(t.status, 2);
    assert.match(t.stdout, /no longer registered/);
    // self-heal via setup re-run
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const run = amabie(['doctor', '--run', root]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /READY/);
  });
  it('S4: a FORGED or stale checkpoint file can never produce READY — only this run can', () => {
    const root = makeProject('s4-forged');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    fs.writeFileSync(cpFile(root), JSON.stringify({ at: '2020-01-01T00:00:00.000Z', status: 'fail', failed: ['tests'], source: 'hand-edit' }));
    const d = amabie(['doctor', root]);
    assert.equal(d.status, 0, d.output.join('')); // old behavior: NEEDS off the stale record
    assert.match(d.stdout, /READY/);
    assert.match(d.stdout, /just ran and passed/); // READY cites THIS invocation's execution
  });
  it('never set up -> NEEDS ATTENTION with the one command; outside git -> UNSUPPORTED', () => {
    const root = makeProject('doc-fresh');
    const r = amabie(['doctor', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /amabie setup --yes/);
    const loose = fs.mkdtempSync(path.join(TMP, 'nogit-'));
    const u = amabie(['doctor', loose]);
    assert.equal(u.status, 2);
    assert.match(u.stdout, /UNSUPPORTED/);
  });

  it('1.1: a project with NO package.json is set up from its own ecosystem and pinned', () => {
    // A Python project, end to end, with no Node project in sight. The fake
    // `python` on PATH stands in for the interpreter: setup is the one moment a
    // real toolchain is resolved, and what it seals is the ABSOLUTE path.
    const root = fs.mkdtempSync(path.join(TMP, 'pyproj-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "x"\n[tool.pytest.ini_options]\n');

    const toolDir = fs.mkdtempSync(path.join(TMP, 'toolchain-'));
    const py = path.join(toolDir, process.platform === 'win32' ? 'python.cmd' : 'python');
    const pass = path.join(FIXTURES, 'f-pass.js');
    fs.writeFileSync(py, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${pass}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${pass}" "$@"\n`);
    if (process.platform !== 'win32') fs.chmodSync(py, 0o755);

    const before = process.env.PATH;
    process.env.PATH = `${toolDir}${path.delimiter}${before ?? ''}`;
    try {
      const r = amabie(['setup', '--yes', root]);
      assert.equal(r.status, 0, r.output.join(''));
      assert.match(r.stdout, /READY/);
      const cfg = readCfg(root);
      assert.equal(cfg.plan.length, 1);
      const step = cfg.plan[0]!;
      assert.equal(step.adapter, 'python');
      assert.equal(step.script, 'pytest');
      assert.deepEqual(step.argv!.slice(1), ['-m', 'pytest']);
      assert.ok(path.isAbsolute(step.argv![0]!), `the toolchain must be sealed as an absolute path, got ${step.argv![0]}`);
      // and the sealed authority is what status/doctor judge against
      assert.equal(amabie(['status', root]).status, 0);
      const d = amabie(['doctor', root]);
      assert.equal(d.status, 0, d.output.join(''));
      assert.match(d.stdout, /READY/);
    } finally {
      process.env.PATH = before;
    }
  });
  it('uninstall removes exactly Amabie, preserves everything else; repeat is safe', () => {
    const userHook = 'node "tools/custom-checkpoint.js" checkpoint';
    const userPreTool = 'node "tools/custom-pre-tool.js"';
    const root = makeProject('uninst', { settings: { $schema: 'https://x', hooks: {
      Stop: [{ hooks: [{ type: 'command', command: userHook }] }],
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: userPreTool }] }],
    } } });
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const r = amabie(['uninstall', root]);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /READY/);
    const cmds = stopCommands(root);
    assert.ok(!cmds.some((c) => cfg.hookCommands.includes(c)), 'amabie command fully gone');
    assert.equal(cmds.filter((c) => c === userHook).length, 1, 'user hook intact and not mistaken for Amabie');
    assert.deepEqual(eventCommands(root, 'PreToolUse'), [userPreTool], 'foreign pre-tool hook remains after uninstall');
    const doc = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(doc.$schema, 'https://x', 'unrelated keys preserved');
    assert.ok(!fs.existsSync(path.join(root, '.amabie')));
    assert.equal(amabie(['uninstall', root]).status, 0); // idempotent
    assert.match(amabie(['uninstall', root]).stdout, /not installed/);
    // reinstall works
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    assert.equal(stopCommands(root).filter((c) => c === readCfg(root).hookCommand).length, 1);
  });
  it('setup refuses to stack a hook from a different Amabie installation', () => {
    const foreign = 'node "C:/old/node_modules/@amabie/cli/dist/main.js" checkpoint';
    const root = makeProject('setup-foreign-hook', { settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } } });
    const settings = path.join(root, '.claude', 'settings.json');
    const before = fs.readFileSync(settings);
    const check = amabie(['setup', '--check', root]);
    assert.equal(check.status, 2, check.stdout);
    assert.match(check.stdout, /Amabie hooks from another installation/i);
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.ok(!fs.existsSync(cfgFile(root)));
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 2, setup.stdout);
    assert.match(setup.stdout, /another Amabie installation/i);
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.ok(!fs.existsSync(cfgFile(root)));
  });
  it('setup detects an unowned Amabie PreToolUse hook before writing settings', () => {
    const foreign = 'node "C:/old/node_modules/@amabie/cli/dist/main.js" checkpoint';
    const root = makeProject('setup-foreign-pretool', { settings: { hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: foreign }] }],
    } } });
    const settings = path.join(root, '.claude', 'settings.json');
    const before = fs.readFileSync(settings);
    const result = amabie(['setup', '--check', root]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /Amabie hooks from another installation.*PreToolUse/i);
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.ok(!fs.existsSync(cfgFile(root)));
  });
  it('uninstall reports and preserves an unowned hook from another Amabie installation', () => {
    const root = makeProject('uninst-foreign-hook');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const foreign = 'node "C:/old/node_modules/@amabie/cli/dist/main.js" checkpoint';
    const settings = path.join(root, '.claude', 'settings.json');
    const doc = JSON.parse(fs.readFileSync(settings, 'utf8')) as { hooks: { Stop: Array<{ hooks: Array<Record<string, unknown>> }> } };
    doc.hooks.Stop.push({ hooks: [{ type: 'command', command: foreign }] });
    fs.writeFileSync(settings, JSON.stringify(doc, null, 2));

    const result = amabie(['uninstall', root]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /unowned Amabie hook/i);
    assert.doesNotMatch(result.stdout, /Amabie is fully removed/);
    assert.deepEqual(stopCommands(root), [foreign]);
    assert.ok(!stopCommands(root).includes(cfg.hookCommand));
    for (const event of ['PreToolUse', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
      assert.deepEqual(eventCommands(root, event), [], `${event}: owned hook removed`);
    }
    assert.ok(!fs.existsSync(cfgFile(root)));
  });
  it('uninstall reports and preserves an unowned Amabie PreToolUse hook', () => {
    const root = makeProject('uninst-foreign-pretool');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const foreign = 'node "C:/old/node_modules/@amabie/cli/dist/main.js" checkpoint';
    const settings = path.join(root, '.claude', 'settings.json');
    const doc = JSON.parse(fs.readFileSync(settings, 'utf8')) as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }> } };
    doc.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: foreign }] });
    fs.writeFileSync(settings, JSON.stringify(doc, null, 2));
    const result = amabie(['uninstall', root]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /unowned Amabie hook/i);
    assert.deepEqual(eventCommands(root, 'PreToolUse'), [foreign]);
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
      assert.deepEqual(eventCommands(root, event), [], `${event}: owned hook removed`);
    }
  });
  it('S1: an out-of-repo touched path in the config is refused, untouched, loudly', () => {
    const root = makeProject('s1');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const victim = path.join(TMP, 's1-victim-settings.json');
    const cfg = readCfg(root);
    const originalTouched = cfg.touched;
    fs.writeFileSync(victim, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cfg.hookCommand }] }] } }, null, 2));
    const before = fs.readFileSync(victim);
    cfg.touched = [{ path: victim, created: false }]; // a doctored record steering writes outward
    writeCfg(root, cfg);
    const r = amabie(['uninstall', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /resolves outside this repository/);
    assert.deepEqual(fs.readFileSync(victim), before); // not one byte changed
    assert.ok(fs.existsSync(cfgFile(root)), 'ownership record kept for the retry');
    // honest record -> honest removal
    cfg.touched = originalTouched;
    writeCfg(root, cfg);
    assert.equal(amabie(['uninstall', root]).status, 0);
    const localSettings = path.join(root, '.claude', 'settings.json');
    assert.ok(!fs.existsSync(localSettings) || !stopCommands(root).includes(cfg.hookCommand));
  });
  it('S6: partial cleanup keeps .amabie so the promised retry can actually finish', () => {
    const root = makeProject('s6');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    const sfile = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(sfile, '{ broken'); // user's file is currently unrepairable
    const r = amabie(['uninstall', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /ownership record \(\.amabie\) is kept/);
    assert.ok(fs.existsSync(cfgFile(root)), 'record survived the failed pass');
    // fix the file, repeat exactly as promised -> completes
    fs.writeFileSync(sfile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: cfg.hookCommand }] }] } }, null, 2));
    assert.equal(amabie(['uninstall', root]).status, 0);
    assert.ok(!fs.existsSync(path.join(root, '.amabie')));
  });
  it('S2-adjacent: uninstall of a foreign-cliPath config is refused (cannot prove ownership)', () => {
    const root = makeProject('uninst-distrust');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    cfg.cliPath = path.join(FIXTURES, 'not-amabie.js');
    writeCfg(root, cfg);
    const r = amabie(['uninstall', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /does not trust/);
    assert.ok(fs.existsSync(path.join(root, '.claude', 'settings.json')));
    assert.ok(stopCommands(root).some((c) => c.includes('checkpoint'))); // nothing was pruned
  });
});

describe('degenerate empty plan (hand-edited config must not fake green)', () => {
  it('checkpoint: zero checks executed -> UNVERIFIED systemMessage, never a silent pass; doctor flags it', () => {
    const root = makeProject('emptyplan');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cfg = readCfg(root);
    cfg.plan = [];
    writeCfg(root, cfg);
    const cp = amabie(['checkpoint'], root, JSON.stringify({ cwd: root, stop_hook_active: false, hook_event_name: 'Stop' }));
    assert.equal(cp.status, 0);
    const out = JSON.parse(cp.stdout) as { decision?: string; systemMessage?: string };
    assert.equal(out.decision, undefined); // never blocks on vacuous "all 0 passed"
    assert.match(out.systemMessage ?? '', /UNVERIFIED/);
    const d = amabie(['doctor', root]);
    assert.equal(d.status, 2);
    assert.match(d.stdout, /plan is empty/);
    assert.doesNotMatch(d.stdout, /READY/);
  });
});

describe('link containment (S3)', () => {
  it('checkpoint evidence is never written through a link pointing outside the repo', (t) => {
    const root = makeProject('s3');
    assert.equal(amabie(['setup', '--yes', root]).status, 0);
    const cp = cpFile(root);
    fs.rmSync(cp);
    let target: string;
    try {
      target = fs.mkdtempSync(path.join(TMP, 's3-outside-'));
      fs.symlinkSync(path.join(target, 'last-checkpoint.json'), cp, 'file'); // dangling outward — the write would escape
    } catch {
      t.skip('OS denies symlink creation (Windows without dev mode / privileges)');
      return;
    }
    const r = amabie(['doctor', root]); // doctor writes evidence every run now
    assert.equal(r.status, 0, r.output.join(''));
    assert.deepEqual(fs.readdirSync(target), [], 'no evidence escaped through the link');
    assert.ok(fs.lstatSync(cp).isSymbolicLink(), 'the user link is left exactly as it was');
  });
  it('setup refuses outright when a managed file is a link (dangling included)', (t) => {
    const root = makeProject('s3b');
    let target: string;
    try {
      target = fs.mkdtempSync(path.join(TMP, 's3b-out-'));
      fs.symlinkSync(path.join(target, 'settings.json'), path.join(root, '.claude', 'settings.json'), 'file');
    } catch {
      t.skip('OS denies symlink creation (Windows without dev mode / privileges)');
      return;
    }
    const r = amabie(['setup', '--yes', root]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /is a link/);
    assert.match(r.stdout, /Nothing was changed|will not write through links/);
    assert.deepEqual(fs.readdirSync(target), [], 'setup never created its file through the link');
  });
});

describe('hook entry shape + ownership', () => {
  it('hasAmabieEntry matches exact command only', () => {
    const cmd = 'node "C:/x/main.js" checkpoint';
    const doc = { hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd }] }] } } as Record<string, unknown>;
    assert.ok(hasAmabieEntry(doc, new Set([cmd])));
    assert.ok(!hasAmabieEntry(doc, new Set(['node "C:/y/main.js" checkpoint']))); // moved install is NOT silently owned
    assert.ok(!hasAmabieEntry({ hooks: {} }, new Set([cmd])));
  });
});

describe('mixed Node and universal proof declarations', () => {
  const requirement = 'preserve the documented contract';
  const digest = materialDigest(requirement);
  function mixed(name: string, nodeProofs: unknown = {}, manifestProofs: unknown = {}): string {
    const root = makeProject(name);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    pkg.amabie = { proofs: nodeProofs };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(root, 'amabie.project.json'), JSON.stringify({
      schema: 'amabie-project/1',
      scopes: [{ path: '.', checks: [{ name: 'contract-check', kind: 'tests', argv: [process.execPath, path.join(FIXTURES, 'f-pass.js')] }] }],
      proofs: manifestProofs,
    }));
    return root;
  }
  it('setup seals both declared proof surfaces without requiring duplicate bindings', () => {
    const nativeDigest = materialDigest('preserve the native behavior');
    const root = mixed('mixed-proof-surfaces', { [nativeDigest]: 'test' }, { [digest]: 'contract-check' });
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.deepEqual(readCfg(root).planAuthority?.proofBindings, { [nativeDigest]: 'test', [digest]: 'contract-check' });
  });
  it('a binding written by bind into the universal manifest survives the next setup seal', () => {
    const root = mixed('mixed-bind-reseal');
    const initial = amabie(['setup', '--yes', root]);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const bound = amabie(['bind', 'contract-check', '--requirement', requirement], root);
    assert.equal(bound.status, 0, bound.stdout + bound.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'amabie.project.json'), 'utf8'));
    assert.equal(manifest.proofs[digest], 'contract-check');
    assert.equal(readCfg(root).planAuthority?.proofBindings?.[digest], undefined, 'a declaration alone must never change sealed authority');
    const reseal = amabie(['setup', '--yes', root]);
    assert.equal(reseal.status, 0, reseal.stdout + reseal.stderr);
    assert.equal(readCfg(root).planAuthority?.proofBindings?.[digest], 'contract-check');
  });
  it('conflicting declarations refuse setup rather than choosing an authority source', () => {
    const root = mixed('mixed-conflicting-proofs', { [digest]: 'test' }, { [digest]: 'contract-check' });
    const setup = amabie(['setup', '--yes', '--verbose', root]);
    assert.equal(setup.status, 2, setup.stdout + setup.stderr);
    assert.match(setup.stdout + setup.stderr, /conflicting proof bindings/i);
    assert.equal(fs.existsSync(cfgFile(root)), false);
  });
  it('bind selects the root Node script declaration beside a universal manifest', () => {
    const root = mixed('mixed-native-bind-reseal');
    const initial = amabie(['setup', '--yes', root]);
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    const bound = amabie(['bind', 'test', '--requirement', requirement], root);
    assert.equal(bound.status, 0, bound.stdout + bound.stderr);
    const reseal = amabie(['setup', '--yes', root]);
    assert.equal(reseal.status, 0, reseal.stdout + reseal.stderr);
    assert.equal(readCfg(root).planAuthority?.proofBindings?.[digest], 'test');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).amabie.proofs[digest], 'test');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'amabie.project.json'), 'utf8')).proofs, {});
  });
  it('matching duplicated declarations remain valid and yield one sealed binding', () => {
    const root = mixed('mixed-matching-proofs', { [digest]: 'contract-check' }, { [digest]: 'contract-check' });
    const setup = amabie(['setup', '--yes', root]);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.deepEqual(readCfg(root).planAuthority?.proofBindings, { [digest]: 'contract-check' });
  });
  it('an invalid universal proof declaration is not hidden by a valid Node project', () => {
    const root = mixed('mixed-invalid-proofs', {}, { invalid: 'contract-check' });
    const setup = amabie(['setup', '--yes', '--verbose', root]);
    assert.equal(setup.status, 2, setup.stdout + setup.stderr);
    assert.match(setup.stdout + setup.stderr, /64-hex requirement digest/);
    assert.equal(fs.existsSync(cfgFile(root)), false);
  });
  it('setup --check reports invalid manifest authority without wiring the project', () => {
    const root = mixed('mixed-invalid-proof-preflight', {}, { invalid: 'contract-check' });
    const check = amabie(['setup', '--check', '--json', root]);
    assert.equal(check.status, 2, check.stdout + check.stderr);
    assert.match(check.stdout + check.stderr, /64-hex requirement digest/);
    assert.equal(fs.existsSync(cfgFile(root)), false);
  });
  it('malformed native bindings cannot be hidden or polluted during the merge', () => {
    for (const [name, proofs] of [
      ['array', []], ['prototype', Object.fromEntries([['__proto__', { polluted: true }]])],
    ] as const) {
      const root = mixed(`mixed-native-${name}`, proofs, { [digest]: 'contract-check' });
      const setup = amabie(['setup', '--yes', '--verbose', root]);
      assert.equal(setup.status, 2, setup.stdout + setup.stderr);
      assert.match(setup.stdout + setup.stderr, /proofs/);
      assert.equal(fs.existsSync(cfgFile(root)), false);
    }
  });
});
