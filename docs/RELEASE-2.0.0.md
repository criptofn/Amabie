# Amabie 2.0.0 release candidate

Latest checkpoint,25 October: exact `0390b5f` [CI40168699922](https://github.com/criptofn/Amabie/actions/runs/40168699922) failed two Windows cases (1,633 passed/eight skipped); Linux1,624 passed/17skipped and the other four jobs passed. The [observer/root PID collision correction](WINDOWS-OBSERVER-ROOT-IDENTITY-2026-10-25.md) independently reproduced and refuses one wrong-ancestry case before any kill. Complete affected files passed Windows64/64 and Linux51PASS/13explicit Windows-specificSKIP. A separate controlled probe still demonstrates wrong termination authority for a different later owner of the numeric root: **general root-PID reuse remains a release blocker**. The protocol fixture retains failed CLI output without changing assertions. These local corrections are not a successful current full gate or final package. Release remains NOT READY; native failure causality is unproven.

Current checkpoint,25 October: exact source `a16a7e5` Hosted Windows failed three cases (1,630 passed/eight skipped), while the other five jobs passed. The [ordered-plan fail-stop correction](PLAN-FAIL-STOP-2026-10-25.md) fixes an independently reproduced continuation after unmeasured cleanup: setup, doctor, checkpoint and candidate/control batches now stop before launching another project check. All seven affected files passed locally on Windows146/146 and Linux144/144, without skips; after isolating the new setup test's trust store, its complete file passed again6/6 on each OS. Exact-current full Hosted validation remains required. Neither this correction nor the preceding [owned test fixture cleanup](TEST-FIXTURE-CLEANUP-2026-10-25.md) is claimed to solve the native process incident. Public release is still BLOCKED; older results below retain their original source identities.

Current repair: [25 October pipeline containment correction](PIPELINE-CONTAINMENT-2026-10-25.md). Exact `c8c6043` Hosted CI and its installed package passed, but detailed trace review exposed an independently reproduced propagation gap outside measurement rounds. The correction requires its own exact-source validation; release remains blocked. Earlier records below retain their original source identities.

Latest checkpoint: [24 October Git diagnostics](WINDOWS-GIT-DIAGNOSTICS-2026-10-24.md) records the current failed Hosted gate and pending diagnostic validation. Older results below retain their original source and artifact identities.

Unpublished local candidate; latest checkpoint 24 October 2026. Parent source `9cd1cac` has a complete local Windows pass (1,680 passed, zero failed, seven skipped) but its latest Hosted Windows run failed during Git worktree creation before the authority assertion. The diagnostic follow-up has focused Windows/Linux passes; its exact-source Hosted validation remains pending. Earlier suites and fresh installed-package rehearsals retain their original source/artifact identities and do not automatically validate later changes. The [earlier joint validation](JOINT-QUALITY-2026-10-23.md) and [process-fix closure](WINDOWS-CLOSURE-2026-10-23.md) remain historical records. Public release remains BLOCKED on current validation, open functional acceptance gates, and separately owned publication/account approvals. Live Codex/Claude correction runs recorded for 2026-10-21 are historical. This document does not authorise publication.

## Latest joint validation — 23 October 2026

Public release remains **BLOCKED**. Draft [PR #11](https://github.com/criptofn/Amabie/pull/11) is for current CI and review; it is not a public package release.

### Follow-up — 24 October 2026

Hosted diagnostic run [40027699342](https://github.com/criptofn/Amabie/actions/runs/40027699342), source `0e47726`, completed with Windows 1,606 passed, 4 failed and 8 skipped (1,618 tests); the other five jobs passed. One retained PowerShell sweep invocation exited 2148734499 before its first script trace, with no overlapping retained kill request. This identifies the failing phase, not its root cause. There is still no proven cross-sweep host kill, and incomplete stderr coverage prevents refutation.

The scoped manifest failure now has a locally reproduced cause: `scopeDir` returned a native canonical path, but the subsequent manifest/root comparison used JavaScript `realpathSync`, which can retain a Windows 8.3 short alias. A real OS-created short alias reproduced the refusal before the fix. Both sides of that comparison now use native canonical paths. The regression also verifies exact scoped script authority, unchanged seals, and refusal after redirecting the scope outside the repository. No containment rule is removed. Temporary filesystem observation wrappers were removed after obtaining the diagnosis; the original assertions remain.

Local affected targets passed 69/69 with no skips, plus the scoped setup/checkpoint target 1/1. Complete validation of the corrected runtime is pending. The separate Node child exit 0xFFFFFFFF and PowerShell startup failures remain unresolved. No final package or release readiness is claimed from these focused checks.

- Latest complete local Windows run, source `47cb988`: 1,678 tests, 1,670 passed, 1 failed, 7 skipped, 0 cancelled. The confined regression pipeline returned INFRASTRUCTURE_FAILURE after cleanup could not be confirmed. A retained Windows CLR event reports a PowerShell console startup failure (0xE9); its underlying cause remains unverified.
- Latest complete hosted run, [40022437581](https://github.com/criptofn/Amabie/actions/runs/40022437581), source `47cb988`: Windows 1,618 tests, 1,607 passed, 3 failed, 8 skipped. The three failures are empty checkpoint JSON, a scoped manifest read failure, and a cleanroom Node child exiting 0xFFFFFFFF. They are not assumed to have a single cause. The other five jobs passed.
- Opt-in sweep traces contain no exact PID/creation-time match showing another sweep host being killed. Captured stderr does not cover every nested invocation, so this does not refute the interference hypothesis. A conhost kill request also occurs in a passing lifecycle control; its name alone is not evidence of interference. A separate 128-launch read-only PowerShell control had no failures or timeout kills, which does not exclude a rare startup fault.
- The next diagnostic checkpoint records parent-side invocation PID, phase and exit metadata, including failures before the first PowerShell script line. The three failing hosted tests retain the original failure details and stronger setup/output assertions. No process selection, kill authority, retry policy, caps or verdict rules change. The full lifecycle target passed 32/32; the scoped checkpoint and installed-package targets passed 2/2; the scoped manifest target passed 1/1. These focused results are not a complete release gate. Hosted validation of this checkpoint is pending.

Earlier validation and artifact provenance:

- Complete local Windows suite on executable source `5aa1abe`: 1,674 tests, 1,667 passed, 0 failed, 7 skipped, 0 cancelled. The subsequent `bd56f86` fixture fix changes no production code. Its 36 affected tests passed on Windows and on Linux with an empty user profile.
- Hosted Ubuntu core on `bd56f86`, run `40001202809`: 1,612 tests, 1,598 passed, 0 failed, 14 skipped. All three hosted standalone executable jobs passed (Windows, Linux and macOS); this is not a full native macOS suite.
- The superseded hosted Windows run `39964104115` recorded real assertion failures caused by Windows PowerShell 5.1 CIM sweep timeouts before its cancellation. A cancelled run is not a pass. Explicit PowerShell 7 selection passed the real hosted preflight in run `40003899202`, but the complete Windows suite then failed: 1,614 tests, 1,596 passed, 10 failed, 8 skipped. A process still reported as a survivor was absent and dead in the subsequent diagnostic snapshot. The follow-up requires fresh termination confirmation within the existing ten-pass/60-second caps, without repeating a kill for the same identity. Two new deterministic regressions failed before that fix; all 30 local lifecycle checks pass with it. Complete validation of this follow-up is pending; neither the failed hosted run nor the unknown 5.1 root cause is claimed resolved.
- Most recently validated local CLI package: `@amabie/cli@2.0.0`, 293,430 bytes, executable source `5aa1abe`, SHA-256 `21f242b8c3163edc8dd4d102497fc6afe3144872c55b9d0c2a5e38582965a21a`. Three builds were byte-identical. Fresh Windows/Linux installed-package rehearsals and original-byte diagnostic checks passed. The new runtime termination-confirmation fix requires a new tested package before release; this older artifact is not silently relabelled as containing it.
- Fresh held-out live correction acceptance and the ordinary correction CLI's connection to the enforced authorization gateway remain open. An ordinary-process execution label is disclosure, not completion of gateway enforcement. Experiments remain opt-in and LOCAL.
- The complete 5,147-byte held-out booking task reproducibly exceeds the automatic draft's 64-candidate limit (exit 3, no request emitted). Manual source-span review is a separate workflow, not successful automatic extraction. Shared sealed checks cannot justify false attribution to an individual requirement; unobserved safety and semantic obligations remain NOT PROVEN even if observed checks pass.

The Linux fixture failure was reproduced with an empty home directory and fixed by explicitly declaring project-local harnesses in the affected fixtures. No verdict assertion, test skip, process timeout or production security rule was weakened.

## What this release changes

The product is renamed to Amabie: package identity `@amabie/cli`, executable `amabie`, renamed MCP tools and project documentation. Legacy project formats and data discovery remain where needed for migration. An existing global installation of the historical package (`@canary-rn/cli`) owns the same bin name and can conflict; follow the tested upgrade procedure in `QUICKSTART.md` rather than forcing an overwrite.

The mission also fixes linked project scopes escaping the declared repository, inherited ecosystem names being treated as adapters, and everyday checks leaving descendant processes after normal exit or timeout. Scope discovery and execution now validate canonical containment; unavailable cleanup measurement cannot produce a successful check. This is user-space cleanup, not an OS sandbox.

The test-runner authority fixture now pins its reviewed canonical Git LF bytes. Exact-byte integrity validation remains intact. Go provisioning verifies the official archive digest before extraction, preserves sibling toolchains and refuses a corrupted archive. Release automation now depends on the test workflow, uses the exact checked artifact and requires configured release approval; its hosted execution remains unverified until an approved push.

The npm package includes a runnable consumer Quickstart, a three-file example and its Apache-2.0 licence. Website source uses Apache-2.0 with Amabie brand assets reserved separately. The official static website provides an illustrative Evidence Desk and accurately separates available LOCAL capabilities from unavailable HARDENED isolation.

`docs/NORTH_STAR.md` records Phase 1 Coding-Agent Verification, Phase 2 Prompt-to-Evidence, and Phase 3 Universal Agent Assurance with explicit acceptance criteria. Phase 3 is a future direction and is not claimed as achieved. The Prompt-to-Evidence commands in this stable candidate (`amabie prompt-evidence draft`, `amabie prompt-evidence loop` and `amabie doctor --prompt-evidence`) are EXPERIMENTAL, labelled as such in the CLI help, and are not a stable, supported capability of this release. Their requirement splitter is measured against an 18-case hand-written corpus (16 agree, 2 limits pinned; not a reliability rate): see [the extraction corpus record](P2E-EXTRACTION-CORPUS.md).

## Installation and migration

The version is prepared locally; do not assume it is published on npm. Require Node.js 22+, npm and Git. Verify the supplied tarball SHA-256, then install the exact local tarball:

```sh
npm install -g ./amabie-cli-2.0.0.tgz
amabie --version
amabie --help
```

Follow `QUICKSTART.md`. In a source checkout, compilation does not create a global executable: use `node apps/cli/dist/src/main.js` or pack and install the tarball. After migrating a prior project, rerun setup and a fresh full doctor check; a saved result is not fresh verification. Stop agent sessions during the replacement window. Preserve existing project changes and unrelated integration settings.

## Verification evidence so far

| Gate | Current observed evidence |
| --- | --- |
| Windows full units | 1,425 passed, 6 explicit platform/filesystem skips, 0 failed on the exact dirty candidate at 09805551 (224 suites), using the explicit PowerShell Core 7.6.5 override; this does not validate the default PowerShell host. Checksummed log is in _canary-data/release-logs/stable-windows-final-candidate-2026-10-17/ |
| Native Ubuntu/WSL units | 1,362 passed, 8 test-case skips, 0 failed (1,370 counted tests; 225 suites) on the exact dirty-source mirror; five Windows-only suites had no child tests and are not passes. Details in _canary-data/release-logs/stable-full-suite-current-2026-10-17/ |
| Windows cleanroom | Exact current tarball: 7/7 with explicit PowerShell Core override. A separate default-host cleanroom on this machine failed closed with 4 failed checks after powershell.exe exited 0xC0000005; it emitted no verification PASS. |
| Package rehearsals | Older full verification rehearsals passed regression and NOT PROVEN cases. The exact current tarball passed Linux cleanroom 7/7; the default Windows-host run remains failed closed as above. |
| Documentation-only AI user | 60 commands: installation, meaningful change, regression, proof gap and recovery; friction corrected and the exact fresh-example procedure retested |
| Website | Clean build/lint/audit; 117 browser cases passed across three engines and three widths; screenshots inspected, automated WCAG checks clean |
| Productization | Latest complete Windows run: 117 PASS / 5 explicit SKIP / 0 FAIL or INCOMPLETE. The older detailed ledger is 105 PASS / 5 SKIP across 110 definitions; it remains historical. The latest aggregate did not capture raw per-gate logs |
| Packed first-run journey | 66 PASS / 0 FAIL / 0 PENDING-REBUILD / 0 SKIP on the recorded 15 October local package; evidence is in the prior run record. This is not the exact current artifact |
| Artifact reproduction | Three exact current Windows package builds matched (247,006 bytes, SHA-256 506f71de9fe38ddd23a98d5c48af51bd044cbab98222bf4897a471791fbac5e7). Linux package equivalence is limited to byte-identical executable text after excluding build-path module comments; see the current manifest. |

Exact logs, source identity, final checksum and reconciled gate verdicts are recorded in the final manifest and report. The five Windows-run skips remain explicit: Rust E2E could not link because MSVC link.exe was unavailable; actual OS PTY allocation on Windows was not exercised in two acceptance batteries; and two live-Claude diagnostics require paid provider usage. Separately, an isolated Ubuntu 24.04 Rust E2E follow-up passed 3/3 assertions using Rust 1.99.0 and explicit `--toolchain-dir`: cargo check/test/build ran, a green crate reached READY, and an intentional regression was rejected. That follow-up does not change the Windows skip or the historical 117 PASS / 5 SKIP aggregate. Historical test totals and Axios fixture observations are not substitutes for current release tests.

One earlier full run on the same Windows candidate had a single `taskkill /T` access-denied failure while ending the live-broker fixture (1,422 pass, 1 fail, 4 skipped). The affected case then passed alone, the full 61-case native activation suite passed, and the exact full suite passed on retry with concurrency 8. No code or assertions were changed between those runs. The event was not reproduced; its cause remains unknown and is retained as a process-cleanup flakiness risk.
Skip accounting: the seven reporter-counted skipped cases are one native-confinement “unmeasured off Windows” sentinel, two 8.3 alias checks that the Ubuntu filesystem could not exercise, one native-Windows PATH-shape check, and three Windows process-snapshot checks. The Linux log also marks five Windows-native suites skipped at suite level; Node omits those suite nodes and their unexecuted child tests from its `tests` and `skipped` case totals. The five suites cover production activation, custody/deployment controls, raw-control behavior, retired/malformed evidence, and saved-evidence live-broker checks. They passed in the native Windows full suite; the Windows process and 8.3 alias cases also passed there. These remain platform-specific skips on Linux, not Linux passes.

Historical local package (15 October): 243,772 bytes, SHA-256 7d790bdebef57baf9b436dc3aff262f86181cff04282f043efb0f2f8c348efc8. This older package is superseded by the exact-current tarball below.

## Known limits and open investigation

- LOCAL runs checks with the developer's user permissions. Same-user processes can replace authority storage, issuer keys and history, or reseal a plan. No HARDENED boundary is available in this candidate.
- Signed authority records and everyday evidence are different. Everyday bundles carry tamper-evidence self-hashes, not independent signatures. Their check-plan status does not settle completion obligations; use the full doctor/result proof envelope. Retention can fail and must be reported honestly.
- Project commands and check coverage define the proof scope. Worker-authored checks carry a caveat. Green tests, tool bindings and observed execution do not guarantee semantic correctness or honest test assertions.
- A historical hosted v1.5 descendant-cleanup incident remains OPEN/UNEXPLAINED. Later snapshot fixes and current local stress/regression results do not identify its original cause. Cleanup is bounded and best effort; escaping session/lineage and same-user races are outside an OS isolation guarantee.
- One 2026-10-15 Windows full-suite run reported access denied for a descendant during the broker fixture's `taskkill /T`; the affected test and full suite passed on isolated/retry runs without changes. This is not a reproduced security failure, but its cause is unknown and should be watched on the next hosted Windows run.
- Claude/Codex integrations require their host's consent/trust steps. Written configuration and literal-hook simulations do not prove a live hosted session is gated. Other CLI agents are advisory.
- The optional AI explanation package ships a no-op provider. It is not a live AI service, and explanations cannot override deterministic decisions.
- Standalone executables remain experimental, with smoke-only verification and absent provider sidecars disclosed. The supported release distribution is the Node npm bundle; do not promote standalone parity.
- Hosted CI on the patched source and npm CLI access remain release blockers. The old hosted runs failed before this fix; the Go provisioning retry applies to that old source only. No product push, merge, tag or npm publication was performed.

## Approval boundary

Before public release: review the complete report and exact tested source/artifact hashes, configure account-level release approval, and approve publication separately. Hosted CI must verify the approved pushed source before publishing. Legal pages are drafts; personal operator data is kept in ignored private website build configuration. Generated legal HTML and the local website ZIP are private until explicit publication approval.

The four containment-harness skips in the Windows report were evaluated on Linux using the same hash-verified stable test and implementation: all four POSIX cases passed in Ubuntu 24.04. The native-Windows-shape case was skipped only in that Linux run and passed in the exact-head Windows full suite. This closes the cross-platform coverage gap for those specific tests; each platform's result still records its own skips accurately. Evidence: `_canary-data/release-logs/p2e-posix-shim-cross-platform-2026-10-15/stable-containment-linux-result.md`.

### Hosted CI and npm registry recheck — 2026-10-16

The current public [PR #10](https://github.com/criptofn/Canary/pull/10) is open at head `685f8233f24471aa9ebebd9b791b77d8512d3391`. Its latest hosted run is [run 38328628517](https://github.com/criptofn/Canary/actions/runs/38328628517), created 2026-10-13 against that same pre-patch head. Ubuntu, the Axios regression proof, and all three standalone smoke jobs passed; the Windows build/unit job failed after 3 h 33 min with 1,111 passed, 245 failed, and 5 skipped test cases. The log repeatedly reports `powershell.exe ETIMEDOUT` during descendant sweeps, including the test helper's cleanup path.

The local release worktree is ahead at `09805551f3ebb11474699f84ce03ab6e020b06c4`. It includes `6ccf35d` (`Fix Windows process sweep scaling`), which replaces repeated full-snapshot filtering per descendant with a single process-identity index and adds a large-snapshot regression. On this patched local source, the focused Windows lifecycle suite passed **12/12**, including the live descendant, snapshot-refresh, and large-snapshot cases; `tooling/test-support/run-probe.test.mjs` passed **1/1**. The hosted timeout is consistent with the pre-patch quadratic sweep path, but the patched commit has not yet been verified on GitHub. Hosted CI on the exact patched head remains open and needs an approved push; the separate historical `taskkill /T` access-denied event remains unexplained.

The read-only npm registry check found no CLI authentication on this machine (`npm whoami` returned `ENEEDAUTH`). The unauthenticated `npm view @amabie/cli@2.0.0` request returned `E404`, which does not distinguish an unpublished package from a private or inaccessible one; public package status is therefore unverified. No credential was changed and nothing was published. Registry login and publication require their respective operator actions and approvals.

## Documentation-first Windows cleanroom follow-up — 17 October 2026

A first-time-user rehearsal from only the published-style README/Quickstart/example materials installed the prior local tarball (`7d790bde…f2f8c348efc8`) and ran its example test successfully. Setup and doctor could not complete: the example test itself passed, but the trusted Windows PowerShell 5.1 `Get-CimInstance Win32_Process` process sweep exited `0xC0000005`. A direct minimal query reproduced the crash; the locally available PowerShell 7.6.5 query passed, but its user-runtime path was used for diagnosis only and was not added to Amabie's trusted process-sweeper resolution.

The result remains fail-closed. Doctor previously described the sweep failure as an unavailable npm executable. The local candidate now reports that descendant cleanup could not be confirmed, rejects the probe result, and tells the operator to resolve the sweep issue rather than rerun setup. A focused regression test pins both the containment diagnosis and the existing missing-manager diagnosis. `npm run build:force` passed and the new diagnostic test passed 2/2.

The local tarball was rebuilt, checksum-verified, installed into a fresh npm prefix, and its version/help commands passed. On a clean package rehearsal, the example's test passed 1/1 but setup exited 2 on the same host sweep failure; packaged `doctor --json` returned NEEDS ATTENTION with the corrected diagnosis. This does not count as a successful end-to-end Amabie verification. The updated artifact, sidecar, source hashes and complete sanitized run record are in `_canary-data/release-logs/p2e-first-user-2026-10-17/` (candidate SHA-256 `50a8521f1332169f943f4079548a7560105a4e2767a21981e3e17290d98bdfcd`).

Quickstart now shows an actual PowerShell checksum comparison, explains the task example's expected no-obligation notice, distinguishes local hook files from live agent integration, and documents the Windows host failure. The exact-source Ubuntu mirror completed npm test with 1,362 PASS / 8 SKIP / 0 FAIL (1,370 counted tests; Ubuntu 24.04 / WSL2, Node 22.23.3, npm 10.9.9); Python 3.12.3 / Pytest 9.1.1 and Go 1.27.2 were available, and targeted Python/Go-dependent tests passed 51/51. The exact dirty-source Windows suite later completed with 1,425 PASS / 6 SKIP / 0 FAIL under an explicit PowerShell Core override. These are distinct results: the exact current package's default-host Windows cleanroom failed closed with four checks after powershell.exe exited 0xC0000005. Linux skips and Windows-only empty suites are not passes. Hosted CI, live Codex/Claude correction, and npm authentication remain separate blockers; no push, publish, merge, or infrastructure change was made.

### Windows containment environment recheck — 17 October 2026

The exact stable `sweepDescendants` path was called with a nonexistent PID, so it could not terminate a process. Its sanitized Windows PowerShell 5.1 invocation still failed closed with exit `0xC0000005` and empty output. One read-only `Get-CimInstance Win32_Process` query passed under the current shell environment, while the same query failed under Amabie's sanitized environment. Supplying the current shell's `PSModulePath` made that one query pass; that path includes a user-scoped module directory and is not a safe product fallback. A later Windows PowerShell 5.1 attempt to inspect `Get-Command Get-CimInstance` and the loaded `CimCmdlets` module crashed with `0xC0000005` under the inherited environment too, so the earlier pass is not repeatable evidence. A system-only module-path attempt also failed: the exact sweep returned `0xC0000005` after about 2.2 seconds under the full 60-second product timeout. No environment policy or security boundary was changed.

The differential confirms an unreliable local Windows PowerShell/CIM process boundary, but does not isolate the fault to the sanitized environment or identify a portable safe correction. The twelve most recent matching Windows Application Error events checked in the last three hours all report Windows PowerShell `10.0.26100.9549`, faulting module `clr.dll` `4.8.9337.0`, exception `0xc0000005`, and the same fault offset `0x000000000008151b`. This corroborates a repeated host CLR crash; it does not identify why the CLR faults. Windows setup/doctor therefore remains **BLOCKED** on this host. The focused diagnostic regression passed **2/2** under Ubuntu 24.04 / WSL2 and **2/2** on Windows (Node 26.7.0, npm 11.19.0) after npm run build:force; it validates message classification only and does not execute the Windows CIM containment sweep. Recheck evidence: `_canary-data/release-logs/p2e-windows-sweep-env-recheck-2026-10-17/`.


## Previous local release candidate artifact — superseded by exact-current package evidence below (17 October 2026)

A prior stable-candidate snapshot produced pack/npm/amabie-cli-2.0.0.tgz (246,956 bytes, SHA-256 9b3581a050580ac3a7d6e4a0f151799759fa08561df5dc76a45dfce0009001b2); it is superseded by the exact-current 247,006-byte artifact below.

That previous artifact remains local and unpublished. The later exact-current package and its default-host failure are recorded below.

## Exact-current candidate and release gate status — 17 October 2026

The current local @amabie/cli@2.0.0 candidate is 247,006 bytes, SHA-256 506f71de9fe38ddd23a98d5c48af51bd044cbab98222bf4897a471791fbac5e7, reproduced 3/3. The exact tarball passed the Linux packed-artifact cleanroom 7/7 and Windows packed-artifact cleanroom 7/7 when the explicitly configured PowerShell Core override was available.

On Windows with AMABIE_POWERSHELL_CORE_PATH unset, that exact package failed closed in 4 cleanroom assertions. powershell.exe exited 0xC0000005 during descendant cleanup; setup/READY, doctor/READY and green-project hook acceptance did not pass, while the regression block and safety-preservation checks remained active. This is a host-specific validation blocker, not evidence of a universal clean-Windows product defect. See the checksummed CANDIDATE-MANIFEST.json and logs under _canary-data/release-logs/stable-exact-current-cleanroom-2026-10-17/.

The current Windows full suite is 1,425 PASS / 6 SKIP / 0 FAIL using the explicit PowerShell Core override. The exact-source Ubuntu suite is 1,362 PASS / 8 SKIP / 0 FAIL; those skips and five Windows-only suites are not passes. The productization aggregate is 117 PASS / 5 SKIP / 0 FAIL/INCOMPLETE, with skip limitations documented in the checklist. The exact-source hosted CI has not run on this unpushed candidate. npm whoami remains ENEEDAUTH, and unauthenticated registry lookup returns E404 (which alone does not distinguish unpublished, private, or inaccessible package state). The one authorized Codex and Claude correction attempt each ended FAIL 5/10 without project changes; their root causes remain unknown and no repeat is authorized.

Release status: NOT READY. Outstanding gates are exact-candidate hosted CI, clean-default-Windows validation, and npm CLI authentication/publication readiness. Live Codex/Claude correction runs for the experimental workflow are recorded below (2026-10-21; two controlled runs, not a reliability estimate). No push, package publish, deployment, DNS change, or additional provider request occurred.

## Pre-publication inventory — 2026-10-22

Re-verified locally on the rename worktree; nothing was pushed, published, tagged or deployed.

| Item | Observed |
| --- | --- |
| Reproducible package | `tooling/probes/release-package-reproducibility.mjs`: three builds, one from an unrelated caller directory, byte-identical; SHA-256 `353fad4b55cc2da12d24eeef25e7af17caf4b49976f913e4044f1f8b1bf34fa7` for `amabie-cli-2.0.0.tgz` at the commit that carries this section. Any later source change changes the hash: re-record it at the freeze. The earlier hashes in this document are historical. |
| Package identity | `@amabie/cli` 2.0.0, bin `amabie` → `dist/main.js`, Apache-2.0, `engines.node >=22`, no runtime dependencies. |
| Package contents | `LICENSE`, `THIRD-PARTY-NOTICES.txt`, `QUICKSTART.md`, `README.md`, `examples/quickstart/` (three files), `dist/main.js`, Windows boundary tooling and fixtures. |
| Install and first use | Isolated first-user run from README, Quickstart and tarball only: install, example change in a new test file, independent `amabie doctor --json` READY. Rewriting the sealed example test is NOT PROVEN by design and is documented. Probes `cleanroom-packed-artifact`, `release-package-rehearsal`, `release-quickstart-proof-gap`, `v13-doc-first-path` and `v12-doc-consistency` pass against the tarball. |
| Upgrade / rollback | `QUICKSTART.md` upgrade section: identify and remove only `@canary-rn/cli`, install the checksum-verified tarball, rerun `amabie setup`; no `--force`. |
| Remaining legacy strings | The GitHub URLs in `.github/ISSUE_TEMPLATE/config.yml` point at the current repository name and change only with a repository rename; `@canary-rn/cli` is the historical package name used for upgrade detection. Both are intentional. |

Still open and not decidable locally: hosted CI on the exact pushed candidate, npm authentication and publication, operator approval of the legal copy, default-host Windows PowerShell 5.1 validation (`0xC0000005`), and the release decision itself.

### Live-provider correction runs — 2026-10-21

Both runs used a new multi-requirement task with an intentional omission and a hidden regression, independent oracles, and the bounded correction loop. Provider tokens and cost are not reported by the loop and are not claimed.

| Provider | Result |
| --- | --- |
| Codex CLI 0.162.1 | verified, 10/10 checks, one correction, base unchanged, the agent's own claim not accepted as evidence. Known gap: the agent also modified `README.md` and `package.json`. |
| Claude 2.1.306 | Attempt 1: limit reached, NOT PROVEN (the hidden regression remained). Attempt 2 on a fresh base: verified, 10/10 checks, one correction. No permission downgrade, no check weakened. |

These are two controlled runs, not a reliability estimate. They address the open gate "successful live Codex/Claude correction acceptance" named in the status lines above; the other gates listed there stay open.
