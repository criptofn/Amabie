/**
 * Third-party notices for the code esbuild copies into a bundle.
 *
 * `legalComments: 'none'` strips license headers, so a shipped bundle carries no
 * copyright notice for the npm packages it inlined. The notice file is built from the
 * build metafile instead: exactly the packages the bundle reads, with their own
 * license files, so it cannot drift from what was bundled.
 */
import fs from 'node:fs';
import path from 'node:path';

const NODE_MODULES = 'node_modules/';
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-.].*)?$/i;

/** Package directories (deduplicated, sorted) of every third-party input in the metafile. */
export function bundledPackages(metafile, root) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const posix = input.split(path.sep).join('/');
    const at = posix.lastIndexOf(NODE_MODULES);
    if (at < 0) continue;
    const [first, second] = posix.slice(at + NODE_MODULES.length).split('/');
    const name = first.startsWith('@') ? `${first}/${second}` : first;
    // First-party workspace packages are covered by the root LICENSE, not a third-party notice.
    if (name.startsWith('@amabie/')) continue;
    dirs.add(path.resolve(root, posix.slice(0, at), NODE_MODULES, name));
  }
  return [...dirs].sort();
}

/**
 * The notice text for the given package directories. `missing` lists every package that
 * ships no license file: a bundle must not inline code whose terms it cannot reproduce.
 */
export function thirdPartyNotices(packageDirs) {
  const missing = [];
  const sections = [];
  for (const dir of packageDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const files = fs.readdirSync(dir)
      .filter(file => LICENSE_FILE.test(file) && fs.statSync(path.join(dir, file)).isFile())
      .sort();
    const id = `${manifest.name}@${manifest.version}`;
    if (files.length === 0) { missing.push(id); continue; }
    const declared = typeof manifest.license === 'string' ? manifest.license : (manifest.license?.type ?? 'see license text');
    const texts = files.map(file => `----- ${file} -----\n${fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trimEnd()}`);
    sections.push(`${id} (${declared})\n\n${texts.join('\n\n')}`);
  }
  const header = [
    'Third-party notices',
    '',
    'This Amabie bundle includes the code of the third-party packages listed below.',
    'Each package is reproduced under its own license, reproduced in full underneath it.',
    'The license of Amabie itself is in LICENSE.',
  ].join('\n');
  const separator = `\n\n${'='.repeat(72)}\n\n`;
  return { text: `${header}${separator}${sections.join(separator)}\n`, missing };
}
