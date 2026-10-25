# Amabie 2.0 quickstart

**Your agent says done. Amabie checks the change.** It runs your declared checks
independently and refuses to treat an agent's success claim as proof.

The public npm package is `amabie-cli`; the executable is `amabie`. Internal workspace names such as `@amabie/cli` are not installation commands.

Requirements: Node.js 22 or newer, npm, Git and a terminal. Amabie runs project commands with your local user permissions: inspect untrusted projects before setup. The available capability is LOCAL, not an OS sandbox or HARDENED.

The 2.0 release validation covers Windows and Linux. macOS has standalone build and version-smoke evidence, not a full native product-suite result. Prompt-to-Evidence and authorization experiments remain opt-in; this release does not claim Universal Agent Assurance or reliable autonomous correction for arbitrary tasks.

## Install

For the public release, install the pinned version from npm:

```sh
npm install --global amabie-cli@2.0.0
amabie --version
amabie --help
```

Before publication, or when reviewing a supplied release candidate, use the local tarball instead. Registry availability can be checked with `npm view amabie-cli@2.0.0 version`; a missing version is not a successful installation.

### Install a prepared local package

Place the release tarball and its `.sha256` sidecar in the same working directory. In PowerShell, compare the two values explicitly:

```powershell
$expected = ((Get-Content -Raw .\amabie-cli-2.0.0.tgz.sha256).Trim() -split '\s+')[0]
$actual = (Get-FileHash .\amabie-cli-2.0.0.tgz -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected.ToLowerInvariant()) { throw 'Amabie package checksum mismatch; do not install it.' }
'Checksum verified.'
```

On Linux or in Git Bash (the `sh` snippets below also run in Git Bash on Windows), `sha256sum --check amabie-cli-2.0.0.tgz.sha256` performs the comparison. Stop if the files do not match.

```sh
npm install -g ./amabie-cli-2.0.0.tgz
amabie --version
amabie --help
```

Expected version: `amabie 2.0.0`. If `amabie` was already on your PATH, check which one runs (`where amabie` in PowerShell, `which -a amabie` on Linux) and that it is the one you just installed (the first `where` entry runs; compare it with `npm prefix -g`, because `--version` is identical for both). The bundle has no runtime npm dependencies. An existing global installation of an earlier release needs the upgrade steps below before replacement.

For a source checkout, `npm ci` and `npm run build:force` build the CLI but do not create a global executable. Use `node apps/cli/dist/src/main.js --help` or prepare and install the tarball with `node tooling/pack.mjs`.

## Upgrade an existing Amabie npm installation

Stop active agent sessions and record the repositories using Amabie hooks. Back
up their integration settings and local state without deleting them. Verify the
new tarball checksum before replacing anything, then identify the old package:

```sh
npm list -g --depth=0
```

If the output lists the tested historical package `@canary-rn/cli`, remove only
that package and install the verified Amabie tarball:

```sh
npm uninstall -g @canary-rn/cli
npm install -g ./amabie-cli-2.0.0.tgz
amabie --version
```

The command should print `amabie 2.0.0`. A direct install while the historical
package owns the `amabie` bin can fail with `EEXIST`; do not use `--force` or delete
an unidentified global executable. For another installation method or package
name, inspect it before removing it.

In each recorded repository, inspect your current work and run `amabie setup`.
Review the checks before accepting this operator reseal, then run
`amabie doctor --json` for a fresh verdict. Setup preserves unrelated hooks and
migrates safe untracked `.amabie` state; tracked or conflicting legacy state
needs the explicit recovery instruction it prints. Preserve legacy trust stores,
keys and evidence directories. Upgrading the executable does not prove your
project passes, and old hooks need setup to point at the new installation.

## Try a tiny project

The installed package includes `examples/quickstart/`: package.json, greeting.js and greeting.test.js. Use a project outside the package's installation directory.

PowerShell:

```powershell
New-Item -ItemType Directory -Path amabie-example | Out-Null
Set-Location amabie-example
$exampleSource = Join-Path (npm root -g) 'amabie-cli/examples/quickstart'
Copy-Item -LiteralPath "$exampleSource/package.json", "$exampleSource/greeting.js", "$exampleSource/greeting.test.js" -Destination .
```

Linux:

```sh
mkdir amabie-example
cd amabie-example
example_source="$(npm root -g)/amabie-cli/examples/quickstart"
cp "$example_source/package.json" "$example_source/greeting.js" "$example_source/greeting.test.js" .
```

Setup requires a detected Claude Code or Codex CLI integration. Open this example
inside the installed agent before continuing. If you only want to rehearse the
local CLI and hook contract without a hosted agent session, create an empty
`.claude` project configuration directory (`New-Item -ItemType Directory .claude`
in PowerShell, `mkdir .claude` on Linux). This declares a demonstration
configuration; it does not install Claude Code or demonstrate a live agent gate.

```sh
git init
git config --local user.name "Amabie example"
git config --local user.email "example@example.invalid"
git add package.json greeting.js greeting.test.js
git commit -m "Start verification example"
git status --short
npm test
amabie setup --check
amabie setup --yes
amabie doctor --json
```

The Git name/email commands set a test-only identity inside this disposable
example; they do not change your global identity or credentials. `setup --check`
is read only. Real setup runs the checks, seals the plan, writes local evidence
and adds project integration files. It can execute arbitrary commands declared
by the project.

Before the first setup, `git status --short` should print nothing. After setup,
generated `.claude`, `.codex` and `.mcp.json` files may appear as untracked changes;
that is expected wiring, not a failed setup. Review them before sharing them in
a real repository. Do not reseal a changed example merely to make a verdict pass.

The unchanged baseline can be healthy; that does not prove any new change.

## Make a change with a discriminating check

Register the new request:

```sh
amabie task "Trim whitespace around greeting names" --kind bugfix
```

In greeting.js, change `String(name)` to `String(name).trim()`. Add this case in a **new file**, greeting-trim.test.js (the example's `npm test` runs every `*.test.js`). Do not edit the sealed greeting.test.js: an existing check rewritten by the worker is reported as NOT PROVEN:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { greeting } from './greeting.js';

test('trims whitespace', () => {
  assert.equal(greeting('  Ada  '), 'Hello, Ada!');
});
```

```sh
npm test
amabie claim "The greeting change is done"
amabie doctor --json
amabie result --json
```

The new case fails against the sealed baseline and passes with the change.
Because this task command has no explicit acceptance criterion, it may also say
that no obligation was derived. That is expected here: task registration records
intent, while the new regression test supplies the discriminating evidence. The
explicit-requirement example below shows how to register and bind a criterion.
Amabie's verdict comes from its own checks, not the claim. A test file created in the
same worker session remains worker-authored evidence, which Amabie reports as a
provenance caveat; READY is not an independent review of that test's completeness.
If you instead rewrite the existing sealed greeting.test.js, doctor says NOT PROVEN
(`regression-evidence`) until an operator-bound check or a human `amabie accept`
covers the change.
`--json` prints only the JSON envelope on stdout; the human-readable text goes to stderr. `amabie claim` is recorded as an untrusted hint and never changes the verdict. The `regression-evidence` caveat on a READY verdict is expected here. Inspect the evidence path printed by doctor. This everyday workflow uses
READY / NEEDS ATTENTION / NOT PROVEN; the attested experiment pipeline has its own
classification labels and Evidence Bundle contract.

Explicit acceptance criteria need sealed proof bindings. For example, register `--requirement "greeting trims surrounding whitespace"` and have the operator bind the exact text to the declared test script with `amabie bind test --requirement "greeting trims surrounding whitespace" --reseal` **before** you edit any other file. Read the bind output: resealing requires an otherwise clean project and commits the binding declaration; on a dirty tree it is refused and the declaration is still written to package.json, so commit or revert that file yourself. When you are the only user, you are the operator. Unbound requirements stay NOT PROVEN.

## Verify failure and false-green behavior

Change greeting.js to return the wrong greeting and run `amabie doctor --json`. It must report NEEDS ATTENTION and exit nonzero. Restore the implementation and rerun the full doctor gate; a focused `amabie doctor --check <id>` (the id of the example's check is `test`) returns PARTIAL and cannot certify completion.

For the false-green demonstration, use a **second fresh copy** rather than
restoring and resealing the changed first example. This avoids uncommitted
generated wiring or Git index state becoming a dirty baseline.

In PowerShell, return to the parent directory of the first example:

```powershell
Set-Location ..
New-Item -ItemType Directory -Path amabie-proof-gap | Out-Null
Set-Location amabie-proof-gap
$exampleSource = Join-Path (npm root -g) 'amabie-cli/examples/quickstart'
Copy-Item -LiteralPath "$exampleSource/package.json", "$exampleSource/greeting.js", "$exampleSource/greeting.test.js" -Destination .
```

On Linux:

```sh
cd ..
mkdir amabie-proof-gap
cd amabie-proof-gap
example_source="$(npm root -g)/amabie-cli/examples/quickstart"
cp "$example_source/package.json" "$example_source/greeting.js" "$example_source/greeting.test.js" .
```

If you used the test-only `.claude` directory for the first example, create it in
this copy too; otherwise open this copy inside your installed agent. Commit the
pristine files and check the baseline **before the first setup**:

```sh
git init
git config --local user.name "Amabie proof-gap example"
git config --local user.email "example@example.invalid"
git add package.json greeting.js greeting.test.js
git commit -m "Start uncovered-change example"
git status --short
amabie setup --yes
amabie task "Change the greeting for Grace" --kind bugfix
```

Stop if `git status --short` is nonempty before setup; resolve that state in this
disposable example first. Do not run setup again after making the change. Replace
greeting.js with this uncovered behavior and leave greeting.test.js unchanged:

```js
export const greeting = name => name === 'Grace' ? 'Hello, stranger!' : `Hello, ${String(name)}!`;
```

```sh
npm test
amabie claim "The greeting change is done"
amabie doctor --json
amabie result --json
```

The unchanged test remains green, but doctor must report NOT PROVEN and exit
nonzero because its own checks also pass against the clean sealed baseline.
Do not waive or weaken the check to get a pass.

## Connect the coding agent

- Claude Code: review the project-scoped MCP entry once. At each new request, use `amabie_task` to register intent and stated criteria; setup installs completion hooks. Test the literal hook contract rather than treating the written file as proof of an active hosted session.
- Codex CLI: setup writes a Stop hook. Review and trust it with `/hooks`; it cannot gate until that human trust step is complete.
- Other CLI agents: advisory status, not automatic completion blocking.

Creating an empty `.claude` directory or checking the generated hook file only
tests local wiring. It does not prove that Claude Code or Codex accepted and ran
the hook; that requires a real session in the project after the relevant host
approval/trust step.

## Recover and inspect

Run `amabie setup --check` to inspect missing scripts/tools without executing project checks. Declare external tools with `--toolchain <name>` when setup reports they are needed. This authorizes their executable directory, not just one binary. Do not authorize a repository directory as a trusted toolchain.

Read the named failing check and evidence path. `amabie result --json` reads known state; it does not run fresh verification. `amabie doctor --json` does. `amabie uninstall` removes only Amabie's recorded integration entries and preserves unrelated settings.

`verification.json` records the executed check plan; `status: "pass"` there means
those checks passed. It does not override an insufficient completion proof.
Read the doctor/result envelope and completion checkpoint too: candidate and
baseline plans can both pass while completion correctly remains NOT PROVEN.

### Windows process-sweep failures

If setup or doctor prints `containment sweep could not run` or says descendant
cleanup could not be confirmed, Amabie has not accepted that probe or
verification result. A project test that passed before this error does not
produce READY. This is a Windows host process-inventory/cleanup failure, not
proof that npm is missing. Re-running setup alone will not repair it; resolve
the host error shown above and rerun `amabie doctor --json`. Windows native
provider operations use inbox Windows PowerShell by default. If the operator
has explicitly selected a trusted PowerShell Core installation, set
`AMABIE_POWERSHELL_CORE_PATH` to its absolute `pwsh.exe` path in the current
PowerShell session before running Amabie. That host is used directly; Amabie
does not replay a native run or broker operation after a process failure.
Process sweeps use the explicit host first; otherwise they can recover from an
unavailable or access-violating inbox host with PowerShell Core. Ordinary query
failures, timeouts, incomplete results, and surviving descendants still fail
closed. This process cleanup does not grant HARDENED isolation; see
`docs/SECURITY.md` for the host trust boundary.

License: Apache-2.0; the package includes the full text in `LICENSE`. This
demonstration is local verification, not an independent security audit or proof
of protection against another process running as your OS user.
