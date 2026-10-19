#!/usr/bin/env node
/**
 * M1 PACKAGING — produces the distributable Amabie tarball (gpv.10).
 *
 * esbuild (devDep, never shipped) bundles the compiled dist into ONE
 * self-contained ESM file named main.js. The name is load-bearing: the CLI
 * derives its own entry path as path.join(dirname(import.meta.url), 'main.js')
 * (CLI_ENTRY in onboarding.ts), and the Stop-hook command is built from it.
 *
 * The staging manifest drops private:true and every "*" workspace dependency:
 * the bundle has zero runtime deps, so the tarball installs in any repo on any
 * machine. Nothing is published — `npm pack` only writes the .tgz into pack/
 * (gitignored scratch) for the clean-room probe to install from.
 *
 * Staging happens in a fresh OS-temp dir ON PURPOSE: inside this repo, npm
 * anchors file paths at the workspace root and the repo .gitignore (`dist/`)
 * silently excludes the bundle from the tarball. A temp staging dir has no
 * parent project, so the manifest's `files` allowlist governs, exactly as it
 * will when the package ships standalone.
 *
 * First-class script (repo workflow rule): deterministic, self-cleaning,
 * explicit exit code. Run after `npm run build`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { canonicalPackageTarball } from './package-tarball.mjs';
import { bundledPackages, thirdPartyNotices } from './third-party-notices.mjs';

const AMABIE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(AMABIE, 'apps', 'cli', 'dist', 'src', 'main.js');
// OWN SUBDIRECTORY, not the whole `pack/`: `tooling/standalone.mjs` writes
// `pack/standalone/`, and wiping the parent (which this used to do) deleted the
// single-executable artifact as a side effect of packing the tarball — a real
// defect: two distribution paths must be able to coexist, and one build step must
// never silently destroy another's deliverable.
const OUT = path.join(AMABIE, 'pack', 'npm');

if (!fs.existsSync(ENTRY)) { console.error('FAIL: no compiled CLI — run `npm run build` first'); process.exit(1); }

const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-pack-'));
const copyText = (relative, destination = relative) => {
  fs.mkdirSync(path.dirname(path.join(STAGE, destination)), { recursive: true });
  // Git's Windows CRLF conversion must not change release bytes across build hosts.
  fs.writeFileSync(path.join(STAGE, destination), fs.readFileSync(path.join(AMABIE, relative), 'utf8').replace(/\r\n/g, '\n'));
};
try {
  // The compiled entry already starts with #!/usr/bin/env node (tsc preserves
  // it); adding a banner then yields a SECOND shebang on line 2, which Node
  // does not strip — SyntaxError. Only add one if the source lacks it.
  const hasShebang = fs.readFileSync(ENTRY, 'utf8').startsWith('#!');
  const { metafile } = await build({
    absWorkingDir: AMABIE,
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    define: { AMABIE_PACKAGED: 'true' },
    outfile: path.join(STAGE, 'dist', 'main.js'), // esbuild creates the parent dir
    ...(hasShebang ? {} : { banner: { js: '#!/usr/bin/env node' } }),
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  const out = fs.readFileSync(path.join(STAGE, 'dist', 'main.js'), 'utf8');
  if (!out.startsWith('#!/') || out.slice(0, out.indexOf('\n', out.indexOf('\n') + 1) + 1).includes('\n#!')) {
    console.error('FAIL: bundle must start with exactly one shebang line (double shebang = SyntaxError at load)');
    process.exit(1);
  }

  // The ESM bundle includes CommonJS dependencies (notably cross-spawn). Let
  // esbuild's dynamic-require helper resolve Node built-ins through Node's
  // native require while keeping the executable itself ESM and self-contained.
  // Keep the shebang as byte one: npm's Windows and POSIX bin shims both rely on it.
  const shebangEnd = out.indexOf('\n');
  if (shebangEnd < 0) { console.error('FAIL: CLI bundle has no newline after its shebang'); process.exit(1); }
  const nodeRequireBridge = "import { createRequire as __amabieCreateRequire } from 'node:module';\nconst require = __amabieCreateRequire(import.meta.url);\n";
  const executable = `${out.slice(0, shebangEnd + 1)}${nodeRequireBridge}${out.slice(shebangEnd + 1)}`;
  fs.writeFileSync(path.join(STAGE, 'dist', 'main.js'), executable);

  const cliPkg = JSON.parse(fs.readFileSync(path.join(AMABIE, 'apps', 'cli', 'package.json'), 'utf8'));
  const manifest = {
    name: '@amabie/cli',
    version: cliPkg.version,
    description: 'Amabie: pre-finish verification for coding agents (self-contained bundle).',
    license: 'Apache-2.0',
    type: 'module',
    bin: { amabie: 'dist/main.js', canary: 'dist/main.js' },
    engines: { node: '>=22' },
    files: ['dist/main.js', 'tools/windows-boundary', 'tooling/test-support/fixtures', 'QUICKSTART.md', 'examples/quickstart', 'THIRD-PARTY-NOTICES.txt'],
  };
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Apache-2.0 §4(a): a recipient of this artifact must receive a copy of the License.
  // The manifest's `license` field is a declaration, not the license text, so the file
  // itself ships in the tarball and is asserted by the cleanroom probe.
  copyText('LICENSE');
  // esbuild strips license comments (legalComments: 'none'), so the notices for the code it
  // copied in ship as text, built from the packages the metafile actually lists.
  const notices = thirdPartyNotices(bundledPackages(metafile, AMABIE));
  if (notices.missing.length > 0) { console.error(`FAIL: bundled packages ship no license file: ${notices.missing.join(', ')}`); process.exit(1); }
  fs.writeFileSync(path.join(STAGE, 'THIRD-PARTY-NOTICES.txt'), notices.text);
  // The consumer receives the runnable first-run guide, without monorepo-only links.
  copyText('QUICKSTART.md', 'README.md');
  copyText('QUICKSTART.md');
  for (const name of ['package.json', 'greeting.js', 'greeting.test.js']) {
    copyText(path.join('examples', 'quickstart', name));
  }
  for (const name of ['AmabieConfinedLauncher.cs', 'AmabieBroker.cs', 'production-native.ps1', 'production-child.cjs', 'production-tool.cjs', 'production-host.ps1', 'production-heartbeat.ps1']) {
    const relative = path.join('tools/windows-boundary', name);
    copyText(relative);
  }
  for (const name of ['boundary-native-child.cs', 'boundary-native-parent.cs', 'boundary-native-run.ps1', 'confined-listener.cjs', 'confined-caller.cjs', 'medium-pipe.ps1']) {
    const relative = path.join('tooling/test-support/fixtures', name);
    copyText(relative);
  }

  const packed = spawnSync('npm pack --silent', { cwd: STAGE, encoding: 'utf8', shell: true, timeout: 120_000 });
  if (packed.status !== 0) { console.error('FAIL: npm pack failed\n' + ((packed.stdout ?? '') + (packed.stderr ?? ''))); process.exit(1); }
  const tgzs = fs.readdirSync(STAGE).filter((f) => f.endsWith('.tgz'));
  if (tgzs.length !== 1) { console.error('FAIL: expected exactly one tarball, found ' + JSON.stringify(tgzs)); process.exit(1); }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dest = path.join(OUT, tgzs[0]);
  fs.writeFileSync(dest, canonicalPackageTarball(fs.readFileSync(path.join(STAGE, tgzs[0]))));
  const hash = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  fs.writeFileSync(`${dest}.sha256`, `${hash}  ${tgzs[0]}\n`);
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`PASS: packed ${path.relative(AMABIE, dest)} (${kb} KB, bundle ${Math.round(fs.statSync(path.join(STAGE, 'dist', 'main.js')).size / 1024)} KB)`);
} finally {
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch { /* OS-temp scratch; leak is inert */ }
}
