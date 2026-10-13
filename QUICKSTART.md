# Amabie 2.0 quickstart

**Your agent says done. Amabie checks the change.** It runs your declared checks
independently and refuses to treat an agent's success claim as proof.

This is the local release candidate. Do not assume `@amabie/cli@2.0.0` is available in the public npm registry before a release is approved.

Requirements: Node.js 22 or newer, npm, Git and a terminal. Amabie runs project commands with your local user permissions: inspect untrusted projects before setup. The available capability is LOCAL, not an OS sandbox or HARDENED.

## Install the prepared package

Place the release tarball and its `.sha256` file in your working directory. Compare the recorded SHA256 with `Get-FileHash ./amabie-cli-2.0.0.tgz -Algorithm SHA256` in PowerShell, or `sha256sum --check amabie-cli-2.0.0.tgz.sha256` on Linux. A mismatch must stop installation.

```sh
npm install -g ./amabie-cli-2.0.0.tgz
amabie --version
amabie --help
```

Expected version: `amabie 2.0.0`. The bundle has no runtime npm dependencies. The `canary` command remains a compatibility alias; existing Canary global installations need the upgrade steps below before replacement.

For a source checkout, `npm ci` and `npm run build:force` build the CLI but do not create a global executable. Use `node apps/cli/dist/src/main.js --help` or prepare and install the tarball with `node tooling/pack.mjs`.

## Upgrade an existing Canary npm installation

Stop active agent sessions and record the repositories using Canary hooks. Back
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
canary --version
```

Both commands should print `amabie 2.0.0`. A direct install while the historical
package owns the `canary` bin can fail with `EEXIST`; do not use `--force` or delete
an unidentified global executable. For another installation method or package
name, inspect it before removing it.

In each recorded repository, inspect your current work and run `amabie setup`.
Review the checks before accepting this operator reseal, then run
`amabie doctor --json` for a fresh verdict. Setup preserves unrelated hooks and
migrates safe untracked `.canary` state; tracked or conflicting legacy state
needs the explicit recovery instruction it prints. Preserve legacy trust stores,
keys and evidence directories. Upgrading the executable does not prove your
project passes, and old hooks need setup to point at the new installation.

## Try a tiny project

The installed package includes `examples/quickstart/`: package.json, greeting.js and greeting.test.js. Use a project outside the package's installation directory.

PowerShell:

```powershell
New-Item -ItemType Directory -Path amabie-example | Out-Null
Set-Location amabie-example
$exampleSource = Join-Path (npm root -g) '@amabie/cli/examples/quickstart'
Copy-Item -LiteralPath "$exampleSource/package.json", "$exampleSource/greeting.js", "$exampleSource/greeting.test.js" -Destination .
```

Linux:

```sh
mkdir amabie-example
cd amabie-example
example_source="$(npm root -g)/@amabie/cli/examples/quickstart"
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

In greeting.js, change `String(name)` to `String(name).trim()`. Add this case to greeting.test.js:

```js
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
Amabie's verdict comes from its own checks, not the claim. A test authored in the
same worker session remains worker-authored evidence, which Amabie reports as a
provenance caveat; READY is not an independent review of that test's completeness.
Inspect the evidence path printed by doctor. This everyday workflow uses
READY / NEEDS ATTENTION / NOT PROVEN; the attested experiment pipeline has its own
classification labels and Evidence Bundle contract.

Explicit acceptance criteria need sealed proof bindings. For example, register `--requirement "greeting trims surrounding whitespace"` and have the operator bind the exact text to the declared test script with `amabie bind test --requirement "greeting trims surrounding whitespace" --reseal` before handing off work. Read the bind output: resealing requires an otherwise clean project and commits the binding declaration. Unbound requirements stay NOT PROVEN.

## Verify failure and false-green behavior

Change greeting.js to return the wrong greeting and run `amabie doctor --json`. It must report NEEDS ATTENTION and exit nonzero. Restore the implementation and rerun the full doctor gate; a focused `amabie doctor --check <id>` returns PARTIAL and cannot certify completion.

For the false-green demonstration, use a **second fresh copy** rather than
restoring and resealing the changed first example. This avoids uncommitted
generated wiring or Git index state becoming a dirty baseline.

In PowerShell, return to the parent directory of the first example:

```powershell
Set-Location ..
New-Item -ItemType Directory -Path amabie-proof-gap | Out-Null
Set-Location amabie-proof-gap
$exampleSource = Join-Path (npm root -g) '@amabie/cli/examples/quickstart'
Copy-Item -LiteralPath "$exampleSource/package.json", "$exampleSource/greeting.js", "$exampleSource/greeting.test.js" -Destination .
```

On Linux:

```sh
cd ..
mkdir amabie-proof-gap
cd amabie-proof-gap
example_source="$(npm root -g)/@amabie/cli/examples/quickstart"
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

## Recover and inspect

Run `amabie setup --check` to inspect missing scripts/tools without executing project checks. Declare external tools with `--toolchain <name>` when setup reports they are needed. This authorizes their executable directory, not just one binary. Do not authorize a repository directory as a trusted toolchain.

Read the named failing check and evidence path. `amabie result --json` reads known state; it does not run fresh verification. `amabie doctor --json` does. `amabie uninstall` removes only Amabie's recorded integration entries and preserves unrelated settings.

`verification.json` records the executed check plan; `status: "pass"` there means
those checks passed. It does not override an insufficient completion proof.
Read the doctor/result envelope and completion checkpoint too: candidate and
baseline plans can both pass while completion correctly remains NOT PROVEN.

License: Apache-2.0; the package includes the full text in `LICENSE`. This
demonstration is local verification, not an independent security audit or proof
of protection against another process running as your OS user.
