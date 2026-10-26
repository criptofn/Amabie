#!/usr/bin/env node
/**
 * STABLE-SCOPE CONSISTENCY PROBE — does the stable 2.0 release note describe the Prompt-to-Evidence
 * commands the same way the CLI labels them?
 *
 * The CLI registers `prompt-evidence draft`, `prompt-evidence loop` and `doctor --prompt-evidence`
 * and labels each one EXPERIMENTAL in its help text. The release note must not describe that surface
 * as absent from the stable candidate, and it must name the same three commands as experimental.
 *
 * Usage: node tooling/probes/stable-scope-consistency.mjs
 * Exit: 0 only when every check passes; 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const mainSource = read('apps/cli/src/main.ts');
const releaseNote = read('docs/RELEASE-2.0.0.md');

const commands = ['prompt-evidence draft', 'prompt-evidence loop', '--prompt-evidence'];
const results = [];
const check = (name, ok) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

for (const command of commands) {
  check(`CLI registers ${command}`, mainSource.includes(command));
}

const experimentalLabels = mainSource.match(/EXPERIMENTAL:/g) ?? [];
check('CLI labels the Prompt-to-Evidence help text EXPERIMENTAL (at least three labels)', experimentalLabels.length >= 3);

check(
  'release note no longer says the Prompt-to-Evidence prototype is absent from the stable candidate',
  !/not included in this stable candidate/i.test(releaseNote) && !/remains on its separate experimental worktree/i.test(releaseNote),
);

const releaseLine = releaseNote.split('\n').find(line => line.includes('Prompt-to-Evidence commands in this stable candidate')) ?? '';
for (const command of commands) {
  check(`release note names ${command} as experimental`, releaseLine.includes(command) && /EXPERIMENTAL/.test(releaseLine));
}

check('release note does not present Prompt-to-Evidence as a stable capability', /not a stable, supported capability/.test(releaseLine));

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
