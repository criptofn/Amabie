# Amabie 2.0 release candidate checklist

Mission started 2026-10-12. Current status: BLOCKED pending exact-candidate hosted validation, clean-default-Windows validation, npm CLI authentication, and successful live provider correction acceptance. No publication is authorised.

This isolated worktree snapshots the existing renamed source; it does not replace or reset any other worktree. The authoritative cross-project checklist/progress log is `docs/RELEASE-MISSION.md` in the website repository. Exact source snapshot is recorded under that repository's ignored `artifacts/release/` directory.

- [x] Source snapshot and original HEAD identified; prior changes preserved. The candidate patch is isolated in this release branch; the separate release-readiness worktree remains untouched.
- [x] Source-backed architecture/security/reliability audit complete within documented LOCAL scope.
- [x] Confirmed release defects fixed with meaningful regression checks, including final actual Node20 refusal.
- [x] Full Stable suite on the exact current working-tree snapshot in Ubuntu 24.04 / WSL2: 1,362 PASS, 8 test-case SKIP, 0 FAIL (1,370 counted tests; Node 22.23.3 / npm 10.9.9). Python 3.12.3 / Pytest 9.1.1 and Go 1.27.2 were available; targeted Python/Go-dependent suites passed 51/51 with 0 skips. The eight counted skips and five Windows-only suites are not passes; details are in _canary-data/release-logs/stable-full-suite-current-2026-10-17/.
- [x] Earlier native Ubuntu 24.04 verification on a prior post-patch release snapshot: 1,358 passed, 7 skipped test cases, 0 failed (1,365 cases; Node 22.23.3). Historical evidence only; the exact-current working-tree result above supersedes it.
- [x] CLI help, setup recovery, installed stdio MCP and literal integration contracts verified; hosted consent/trust remains unverified.
- [x] Final local tarball name/version, exact21files, aliases, license and checksum verified.
- [x] Windows packed cleanroom 7/7 with the explicit trusted PowerShell Core override; the exact package's separate default-host attempt failed closed on this machine (four assertions), documented below.
- [x] Final package-based discrimination, regression, NOT PROVEN, forged-record and corrupt-configuration scenarios pass on both OS.
- [x] Three identical package artifacts from the current patched Windows worktree.
- [x] Post-patch Linux package reproduction and byte comparison passed. Three Linux builds matched each other and the Windows candidate byte-for-byte; details and raw logs are in `_canary-data/release-logs/amabie-2.0-linux-package-2026-10-15/`.
- [x] CI/release gates prepared and actionlint clean; the old-source Ubuntu retry passed after Go/pytest provisioning. The old-source Windows hosted job failed; patched-source hosted CI remains unverified.
- [x] README/Quickstart, tested migration, release notes, limitations and unpublished launch materials prepared.
- [x] Website full117matrix plus final18affected docs/accessibility, build/lint, screenshots and local preview verified.
- [x] Private operator/legal drafts and human publication/account gates documented.

The latest exact-candidate Windows npm test completed with 1,425 PASS / 6 test-case SKIP / 0 FAIL / 0 cancelled (224 suites; Node 26.7.0 / npm 11.19.0) using the explicit PowerShell Core 7.6.5 override. The exact-source Ubuntu run completed with 1,362 PASS / 8 SKIP / 0 FAIL; neither platform's skips count as passes. The latest complete productization aggregate remains 117 PASS / 5 explicit SKIP / 0 FAIL or INCOMPLETE; its per-gate raw output was not retained. The exact current 247,006-byte package is SHA-256 506f71de9fe38ddd23a98d5c48af51bd044cbab98222bf4897a471791fbac5e7, reproducible 3/3. Its Linux cleanroom and Windows override cleanroom each passed 7/7, but the Windows default-host cleanroom failed closed with four failed checks after powershell.exe exited 0xC0000005. Release remains NOT READY; see current artifact, hosted CI, registry-auth, and provider-correction blockers below.

## Five explicit Windows productization SKIPs — individually reconciled

None of these five outcomes counts as PASS. The latest complete 117 PASS / 5 SKIP aggregate did not retain per-gate raw logs, so the current skip definitions were rerun one gate at a time on the Windows candidate. The two provider gates were confirmed as `SKIP / NOT RUN`; the runner's `COST_GATED` map prevents starting Claude because its spend limit is not reliable. No live Claude session or provider request was made.

1. `v1.3 posttool feedback (DIAGNOSTIC live-integration; deterministic properties gate)` — cost-gated; live-provider behavior remains unverified. The runner reports the skip before launching a subprocess, so no per-step JSON is emitted. Manual summary of the individual run: `amabie-web/artifacts/release/five-skip-reconciliation-2026-10-15/cost-gated-skip-summary.json`.
2. `benchmark: agent-driven token ledger (stream-json parsed for phase cost + visible bytes)` — cost-gated for the same reason; live token/cost ledger remains unverified. No provider process started and no per-step JSON was emitted. Manual summary of the individual run: `amabie-web/artifacts/release/five-skip-reconciliation-2026-10-15/cost-gated-skip-summary.json`.
3. `probe: real Rust project end-to-end (setup -> doctor)` — current Windows rerun skipped before any Rust check because no rustup toolchain was installed (**0 checks executed**). A separate Ubuntu 24.04 Rust E2E passed 3/3 assertions, but does not convert this Windows result to PASS. Raw result: `amabie-web/artifacts/release/five-skip-reconciliation-2026-10-15/rust-windows-03/`.
4. `probe: acceptance growth (real git + pty)` — all **10 product checks executed and passed**; the OS-level PTY allocation was explicitly skipped because this host had no drivable PTY. The overall gate remains SKIP. Raw result: `amabie-web/artifacts/release/five-skip-reconciliation-2026-10-15/acceptance-growth-04/` (188,966 ms).
5. `probe: pre-1.0 human-acceptance battery (real git + pty)` — all **10 product checks executed and passed**; the OS-level PTY allocation was explicitly skipped for the same host limitation. The overall gate remains SKIP. Raw result: `amabie-web/artifacts/release/five-skip-reconciliation-2026-10-15/pre10-acceptance-05/` (213,449 ms).

This closes the individual classification work, not the skipped coverage: live Claude behavior, Windows Rust E2E, and native OS PTY behavior remain unverified. Separate acceptance-gate runs on the experimental P2E Linux worktree completed `ALL PASS` with a native PTY (`_canary-data/release-logs/p2e-linux-acceptance-growth-final-2026-10-15.log` and `_canary-data/release-logs/p2e-linux-pty-pre10-2026-10-14/`); they support Linux behavior but do not clear the Windows skip or prove the exact stable-candidate source. The cost-gated runner branches produce no per-step files; the individual output summary above records both `NOT RUN` outcomes.

## Resumed blocker resolution

- M12/M13 isolated baselines completed: acceptance193.8s (explicit Windows PTY limitation), subjectivity102.3s. Mutants caught by unchanged owning assertions: M12 exit1/201.0s, M13 exit1/95.7s. No timeout; compiled target bytes were restored. Logs: website artifacts/release/blocker-resolution/m12-m13/.
- Confirmed runner cause: a whole-battery2700s cap accumulated five baseline owners plus thirteen repeated owner suites; it cut off later faults although individual suites completed. Default orchestration now schedules each fault separately with the original finite budget; owner900s limits and all assertions remain unchanged.
- Recorded process runner streams logs, distinguishes infrastructure/timeout from a caught mutation, contains descendants and handles cancellation before restoring files. Runner/selection tests pass2/2, including timed-out descendant termination and all35remaining-gate preservation.
- Exact remaining35gate inventory and serial prerequisites: website artifacts/release/blocker-resolution-remaining-35.json. Each execution writes independent stdout/stderr/result JSON; a failed destructive gate stops the chain after restoration. Paid live diagnostics remain excluded.
- Resume commands: `node tooling/verify-productization.mjs --from "<exact gate label>" --raw-log-dir <new absolute directory>`; one gate: `--gate "<exact gate label>"`; plan: `--list-json`. Selected runs never claim unrequested gates were executed.

No public push, release, npm publishing, deployment or DNS changes are authorized. An unverified or skipped gate remains unverified; LOCAL is not HARDENED.

## Final blocker handoff

- [x] M12/M13 completed with unchanged security assertions; targets restored byte-for-byte.
- [x] All 35 following gate outcomes are accounted for: 34 produced individual result/log files; the live-Claude cost-gate was explicitly not started. Initial classification was 32 PASS / 2 SKIP / 1 FAIL; the only failure was the probe importing an unshipped renamed pytest module. It now imports the shipped `PYTEST_PLUGIN_MODULE`, requires the attack fixture to exit successfully, and still requires exactly one `no-run` rejection. Rerun passes all 7 cases; no runtime/security semantics changed.
- [x] Budget/cascade regression and process-runner/gate-selection self-checks pass: 2/2 on Windows and native Linux. Linux correctly omits the native Windows provider gate (34 follow-ups versus Windows35); its original failed test assumption and corrected rerun are retained. Each mutation keeps the original finite budget and each owner keeps 900s; cancellation and descendants are contained before restoring files.
- [x] Fresh final Windows cleanroom 7/7 and real package/MCP rehearsal pass: READY, genuine regression NEEDS ATTENTION, false-green NOT PROVEN, forged stored PASS refused, invalid configuration refused and evidence hashes checked.
- [x] The confirmed Windows cleanup timeout was caused by repeatedly filtering the entire WMI snapshot for each descendant. Exact `(PID, CreationDate)` identities are now indexed once; the existing fail-closed checks remain. A large-snapshot regression, Windows lifecycle suite 12/12, stress test 12/12, and full Windows suite pass.
- [x] Three packages built from the patched Windows worktree are byte-identical; the exact tarball passes the cleanroom journey 7/7. New package SHA: `7d790bdebef57baf9b436dc3aff262f86181cff04282f043efb0f2f8c348efc8`.
- [x] Fresh packed-artifact first-run journey: 66 PASS, 0 FAIL, 0 PENDING-REBUILD, 0 SKIP against the exact installed candidate tarball. Exact doctor command, evidence path, correction, NOT PROVEN behavior and user-setting preservation were exercised. Checksummed log, script and tarball: `_canary-data/release-logs/v15-first-run-final-2026-10-15/`.
- [x] The base source snapshot and four-file source delta are preserved with hashes in the website candidate manifest. The delta also carries `docs/NORTH_STAR.md` and its binding `AGENTS.md` reference; concurrent worktrees remain untouched.
- [x] Source-integrity recheck on 2026-10-15 passed against the current product-progress worktree: reconstructed source tree `5751a7916bda9196d13bad060072ade395de212a`; zero unmatched tracked changes, new source files, or deleted baseline files; both original untracked C# source files match by hash; both default Git indexes unchanged. The current release snapshot differs from PR #10's tree in seven paths: the four-file North Star/process-sweep patch plus three local release documents. The two code changes are the indexed Windows process-sweep fix and its large-snapshot regression. Evidence: `_canary-data/release-logs/source-integrity-final-2026-10-15.json`.
- [x] Read-only GitHub check on 2026-10-15 confirms PR #10 is still open at stale head `685f8233f24471aa9ebebd9b791b77d8512d3391`. Its Windows job failed on that old source with PowerShell containment-sweep `ETIMEDOUT` messages and downstream `INFRASTRUCTURE_FAILURE` results.
- [x] On the current local release head `09805551f3ebb11474699f84ce03ab6e020b06c4`, `npm run build:force` and the affected Windows `acceptance-scope` plus `attested-channel` suites pass: 39 passed, 0 failed, 0 skipped. The process-sweep fix is included; result metadata and source hashes are in `_canary-data/release-logs/windows-process-sweep-regression-2026-10-15/RESULT.json`.
- [x] Final exact-head Windows full suite rerun on `09805551f3ebb11474699f84ce03ab6e020b06c4`: `npm test` passed 1,423, skipped 4 explicit platform/harness cases (3 POSIX shell cases and 1 Windows shell-harness case), and failed 0; no suite-level skips and no source-status change. Environment: Node 26.7.0, npm 10.9.9, Python 3.12.10, Go 1.27.2. Checksummed log and result: `_canary-data/release-logs/stable-current-candidate-full-windows-retry-2026-10-15/`.
- [x] Broker termination case was checked after one full-run `taskkill /T` access-denied failure: the isolated case passed; the complete native activation suite passed 61/61; and the exact full suite passed on retry under concurrency 8, including the same case. No product code or assertion changed. The access-denied event did not reproduce; retain it as a Windows process-cleanup flakiness risk, not a passed test or a proven product defect. Logs: `_canary-data/release-logs/stable-current-candidate-full-windows-2026-10-15/`, `_canary-data/release-logs/confined-activation-alone-2026-10-15-r1/`, and `_canary-data/release-logs/stable-current-candidate-full-windows-retry-2026-10-15/`.
- [ ] Fresh read-only recheck on 2026-10-15: PR #10 remains open at remote head `685f8233f24471aa9ebebd9b791b77d8512d3391`; GitHub reports `pending` with zero status checks. Local candidate HEAD is `09805551f3ebb11474699f84ce03ab6e020b06c4`, still unpushed. `npm whoami` exits 1 (unauthenticated). Hosted CI for the patched source and npm CLI authentication remain unverified; no OTP was used and no publication occurred. Local checks do not replace hosted CI or registry authentication.
- [x] Cross-platform disposition of the four exact-head Windows containment-harness skips: all four POSIX-only cases passed in a targeted Ubuntu 24.04 run against hash-matched stable source/test/config; the one native-Windows shape case skipped only on Linux and passed in the exact-head Windows full suite. Per-run Windows skip counts remain unchanged and are not reported as Windows passes. Evidence: `_canary-data/release-logs/p2e-posix-shim-cross-platform-2026-10-15/stable-containment-linux-result.md`.
- [x] P2E POSIX agent shim hardened for constrained `PATH` and paths containing spaces/apostrophes. The apostrophe-path regression was observed failing before the quote fix and passes after it. Final current-source focused build/test passed 68/68 on both Windows and Ubuntu 24.04; no provider calls. Checksummed r2 evidence: `_canary-data/release-logs/p2e-posix-shim-cross-platform-2026-10-15-r2/`. This is experimental-worktree evidence, not a Stable 2.0 source change.
- [ ] Public-site/legal release gate: the direct `www` privacy exposure was mitigated by the approved 2026-10-16 Cloudflare Pages deployment: Legal and Privacy now serve PII-free drafts with `noindex` and are excluded from the sitemap. This gate remains open because final legal/privacy copy still needs deliberate operator/legal approval and Spaceship apex forwarding still drops requested subpaths. No DNS change was made. Deployment receipt: `amabie-web/artifacts/release/candidate/DEPLOYMENT-2026-10-16.json`.

## Focused final-candidate rechecks — 2026-10-16

- [x] On exact Stable candidate `09805551f3ebb11474699f84ce03ab6e020b06c4`, `npm run build:force` exited 0 and `node tooling/probes/runner-observation-pytest.mjs` passed all seven scenarios after the rebuild. This includes rejection of an unwatched fabricated report, printed-summary forgery resistance, injected-frame failure closure, and observer suppression. The previously recorded Pytest gate failure did not reproduce. Checksummed output and source hashes: `_canary-data/release-logs/pytest-observation-recheck-2026-10-16/`.
- [x] The Oct 12 Pytest result is reconciled as a historical harness failure, not a counted PASS. Its saved scratch fixture imports `amabie_pytest_observer`, while the observer file in that scratch directory is named `amabie_pytest_observer.py`, consistent with the test never reaching its intended forged-report assertion. The old child stderr was not retained, so that exact exception remains unverified. The current probe imports the shipped `PYTEST_PLUGIN_MODULE`; a forced build and exact Stable-candidate rerun passed all seven cases.
- [x] Website revalidation on 2026-10-16: static build and lint passed; the project Playwright suite passed 117/117 across Chromium, Firefox and WebKit at 375/768/1440 px; five documented GitHub links returned HTTP 200; screenshots were visually inspected. A fresh 31-entry static archive contains no configured operator values; legal/privacy routes are marked draft and noindex and omitted from the sitemap. Archive SHA-256: `03a6b61800446115d42da65f8c81937ce0e04796818bf6268b31937168ccfff7`.
- [ ] Registry authentication recheck on 2026-10-16 after npm's browser/email verification prompts still returned `ENEEDAUTH` (`npm whoami` exit 1); username output was suppressed. This session did not use a one-time code, change credentials, or publish.
- [x] Production privacy exposure mitigated: post-deploy checks on 2026-10-16 returned HTTP 200 for `www.amabie.eu/legal/` and `/privacy/`; both now serve PII-free drafts with `noindex` and neither appears in the sitemap. See the deployment receipt `amabie-web/artifacts/release/candidate/DEPLOYMENT-2026-10-16.json`. This does not approve the draft legal copy for publication.

## Release registry and hosted-CI state rechecked — 2026-10-16

- Read-only GitHub CLI check: PR #10 remains open at remote head 685f8233f24471aa9ebebd9b791b77d8512d3391. Run 38328628517 has five successful jobs and one failed Windows build/unit job; it tested the old remote head, not the patched local candidate. The local release candidate remains on codex/amabie-2-0-release at 09805551; its existing documentation modifications were preserved.
- The Windows log repeatedly reports PowerShell descendant-sweep timeouts. Local HEAD includes commit 6ccf35d, which indexes process identities once to avoid repeated full-snapshot filtering. On the patched source, the focused Windows lifecycle tests passed 12/12 and the run-probe cleanup test passed 1/1. This supports the local fix but does not verify it in hosted CI; the exact patched head still needs an approved push and green hosted run.
- The workspace package manifest is amabie@2.0.0 with private=true; the CLI package is @amabie/cli@2.0.0 with private=true. Local npm whoami still returns ENEEDAUTH. An unauthenticated registry lookup cannot resolve @amabie/cli@2.0.0 (E404), so public registry availability is not established.
- The private source flag is intentionally removed by tooling/pack.mjs in the staged release manifest. The exact 243,772-byte tarball (SHA-256 7d790bdebef57baf9b436dc3aff262f86181cff04282f043efb0f2f8c348efc8) has name @amabie/cli, version 2.0.0, and no private field. `npm publish --dry-run pack/npm/amabie-cli-2.0.0.tgz --registry=https://registry.npmjs.org` exited 0 and listed 21 files; npm warned that registry login is still required. This validates the tarball layout only and performed no upload.
- No GitHub push, merge, tag, npm publication or DNS action was performed. The approved static website build was deployed to Cloudflare Pages on 2026-10-16; its privacy-safe routes and live rendering are verified separately. Local package and cleanroom evidence remains separate from hosted CI and registry authentication.

## Website deployment follow-up — 2026-10-16

- The user approved the tested static build only. Cloudflare Pages production deploy to `amabie-web` completed with exit code 0 at `https://db65731e.amabie-web.pages.dev`; `https://www.amabie.eu/` and the privacy-safe draft routes returned HTTP 200 afterward. No DNS, product release, GitHub push or npm publication occurred.
- The exact 31-entry archive matched the deployed `dist`; archive SHA-256 `03a6b61800446115d42da65f8c81937ce0e04796818bf6268b31937168ccfff7`. Full website matrix: 117/117 passed before deployment; post-deploy Playwright Chromium checks at 375/768/1440 px found no overflow or uncaught page errors. Receipt and screenshot paths are documented in the website readiness report.
- Remaining website publication items are final human approval of the Legal/Privacy draft text and a path-preserving apex-domain redirect decision. These do not undo the mitigation of the previously exposed operator data.

- Follow-up read-only recheck: PR #10 remains open at remote SHA 685f8233f24471aa9ebebd9b791b77d8512d3391; both listed Actions runs failed on that stale SHA. The latest run 38329022503 passed Ubuntu but failed the Windows npm test step. Local HEAD is 09805551 and has no hosted validation because it has not been pushed. npm whoami still exits 1 with identity output suppressed. The tarball dry-run is not a registry-authentication or publication pass.
- [ ] Current read-only recheck — 2026-10-17: GitHub PR #10 remains open at remote head `685f8233f24471aa9ebebd9b791b77d8512d3391`; combined status is `pending` with zero checks. Local candidate `codex/amabie-2-0-release` remains at `09805551f3ebb11474699f84ce03ab6e020b06c4` and has no hosted validation because it is unpushed. `npm whoami --registry=https://registry.npmjs.org/` returned `ENEEDAUTH`. No login, credential change, push, publication, or DNS action was performed. Hosted validation still requires an approved push; npm publication still requires a working CLI login and separate release approval.
- Follow-up read-only registry query on 2026-10-17: `npm view @amabie/cli@2.0.0 version --json` returned `E404` from `registry.npmjs.org`. The 2.0.0 package is not publicly available. The lookup performed no authentication or registry write.

## First-time-user and Windows containment follow-up — 2026-10-17

- [x] Docs-first local tarball installation, CLI version/help and Quickstart project test exercised in a fresh temporary prefix/project.
- [x] A read-only cross-check of the retained setup evidence confirms that `npm` was resolved through the running Node installation (`node-entry`) and the project test command really ran: **1 passed / 0 failed**. The setup then failed because the post-run descendant cleanup sweep could not confirm zero surviving processes. This does not establish a separate Doctor result and does not clear the default-Windows-host blocker.
- Sanitized cross-check and checksum: `_canary-data/release-logs/first-user-npm-evidence-crosscheck-2026-10-17/` (`SUMMARY.json` SHA-256 `ab436cfa4c3314e82f1e2df2c922d7ba6d9f2f065a5d9549333826387fda67da`).
- [x] Doctor's misleading npm diagnosis corrected with a focused 2/2 regression test; forced build passed.
- [x] New local tarball installed and exercised; its sidecar hash matches (`50a8521f1332169f943f4079548a7560105a4e2767a21981e3e17290d98bdfcd`).
- [ ] Windows setup/doctor end-to-end: **BLOCKED on this host**, because the trusted system Windows PowerShell 5.1 CIM process query exits `0xC0000005`. Amabie correctly fails closed; the project test output alone is not a verification pass. PowerShell 7.6.5 succeeded in a diagnostic-only query and was not substituted into product trust resolution.
- [x] Full suite after the narrow diagnostic change completed on the exact current working-tree snapshot under Ubuntu 24.04 / WSL2: 1,362 PASS, 8 SKIP, 0 FAIL; targeted Python/Go-dependent tests: 51/51 PASS, 0 SKIP. Detailed checksummed evidence is in _canary-data/release-logs/stable-full-suite-current-2026-10-17/.
- [x] Historical “full Windows suite unverified” status superseded by the exact-current Windows full-suite result below: 1,425 PASS / 6 SKIP / 0 FAIL.
- [ ] Windows setup/doctor remains BLOCKED/UNVERIFIED on this host by the repeatable system PowerShell 5.1 CLR/CIM crash 0xC0000005. Hosted validation and npm CLI authentication/publication remain separate release blockers.

Sanitized evidence and the candidate package are retained in `_canary-data/release-logs/p2e-first-user-2026-10-17/`. No public action was taken.

### Targeted containment recheck — 17 October 2026

- [x] Focused diagnostic regression: Ubuntu 24.04 / WSL2 **2/2 PASS**; native Windows build and focused tests on Node 26.7.0 / npm 11.19.0 also **2/2 PASS**. This checks diagnosis text only and does not execute Windows CIM cleanup. Evidence: _canary-data/release-logs/stable-full-suite-current-2026-10-17/windows-focused-diagnostic-test.log.
- [ ] Exact Windows sweep with a nonexistent PID still fails closed under `containmentEnv()` with `0xC0000005`. One direct query passed with the inherited environment, but a later PowerShell 5.1 command inspecting the CIM command/module crashed there too; the pass is not repeatable evidence. Adding the shell's `PSModulePath` is unsafe because it contains a user-scoped module directory. The exact generated sweep using only the Windows system module path failed with `0xC0000005` after about 2.2 seconds. Twelve recent Windows Application Error events checked all report a `clr.dll` access violation at the same offset. No safe product change is justified by this host evidence.
- [ ] Windows setup/doctor remains blocked pending validation in a clean Windows environment with its supported system PowerShell modules. Evidence: `_canary-data/release-logs/p2e-windows-sweep-env-recheck-2026-10-17/`.

### Live website privacy recheck — 17 October 2026

- [x] Read-only requests to `www.amabie.eu/legal/`, `/privacy/`, and `/sitemap.xml` returned HTTP 200; known operator name/contact/address markers were absent, legal pages carried `noindex`, and the sitemap omitted both routes.
- [ ] Legal/Privacy copy remains a draft and still requires deliberate operator/legal approval; this marker scan is not a broad privacy guarantee.


### Prior Linux skip cross-check — historical and superseded

The earlier Ubuntu run reported seven aggregate skips. That cross-check is historical and superseded by the exact-source Ubuntu result of 1,362 PASS / 8 SKIP / 0 FAIL in section 151.

- real production activation chain — prior Windows PASS.
- one broken custody or deployment requirement closes HARDENED — prior Windows PASS.
- each required raw control cannot be replaced by claims — prior Windows PASS.
- retired schema and malformed evidence — prior Windows PASS.
- saved evidence requires a current authenticated live broker — prior Windows PASS.
- a real short alias and its long name are the same identity, by the OS — prior Windows PASS.
- a git repository resolves through either spelling (the CI symptom, pinned) — prior Windows PASS.

The retained 1,423 PASS / 4 SKIP Windows result is historical. The exact-current dirty-source Windows suite later completed at 1,425 PASS / 6 SKIP / 0 FAIL in section 133. The later suite used the explicit PowerShell Core override; it does not clear the separate default-host cleanroom failure.

## Exact-current Windows full-suite completion — 17 October 2026

- [x] The full `npm test` run completed on the current dirty stable-candidate working tree at HEAD `09805551f3ebb11474699f84ce03ab6e020b06c4`. Its `build:force` step completed and the Node runner reported **1,425 PASS / 6 test-case SKIP / 0 FAIL / 0 cancelled** (1,431 counted test cases; 224 suites; 568,605.5 ms). This supersedes the earlier “exact-current Windows suite unverified” entry for this host snapshot.
- The six counted skips are two NTFS short-name cases (this volume created no 8.3 alias) and four shell-harness cases in `packages/support/test/containment-hygiene.test.ts`. The unknown-tool Go fixture is a skipped suite with **no child tests executed** because Go is not installed on this host; do not count it as a pass or as one of the six test cases. Separate Linux Go evidence remains scoped to its recorded source snapshot.
- The run used Node 26.7.0, npm 11.19.0, Python 3.12.10 and PowerShell Core 7.6.5 through the explicit `AMABIE_POWERSHELL_CORE_PATH` operator override. The default System PowerShell 5.1 CIM crash (`0xC0000005`) remains a host-specific limitation; this run does not prove that failing host configuration works without the override.
- Full log: `_canary-data/release-logs/stable-windows-final-candidate-2026-10-17/npm-test-core-override.log` (SHA-256 `b512b45353e761449f5eFA2CF169A0CBE1340D60108A8C36B990C336CDA1A7D3`). Focused skip reconciliation: `_canary-data/release-logs/stable-windows-final-candidate-2026-10-17/windows-skip-reconciliation.log` (SHA-256 `7128554D7EB64FE9ED79706BD91E2744C081A79C5A193219E753166BDB56DC98`); it confirms the four harness cases are skips and preserves the host-specific reasons.
- [x] Current read-only GitHub MCP recheck: PR #10 remains open at stale remote head `685f8233f24471aa9ebebd9b791b77d8512d3391`; combined status is `pending` with zero checks. The local candidate remains unpushed. Hosted CI and npm publication authorization/authentication remain release blockers; no remote write was made.


## Earlier packed candidate — superseded by the exact-current package below

- [x] Historical prior candidate: @amabie/cli@2.0.0, 246,956 bytes, SHA-256 9b3581a050580ac3a7d6e4a0f151799759fa08561df5dc76a45dfce0009001b2; its sidecar matched.
- [x] Historical prior candidate was reproduced three times with matching hashes; log SHA-256 95f848f364c388c275e730f30ed0e79325a3b56f1c35802a3c8c553ab66958c4.
- [x] Historical prior candidate passed the fresh packed-artifact cleanroom 7/7 with the explicit PowerShell Core override; its log SHA-256 is 9c63879edf935af1e86f6bbb8ce399dae3f68912eaab285464e39c22b8b19770.
- This cleanroom used the explicit PowerShell Core 7.6.5 override. It does not clear the separately recorded default System PowerShell 5.1 CIM crash.
- [ ] The package remains local and unpublished. A read-only npm registry check returned E404 for `@amabie/cli@2.0.0`; `npm whoami` returned ENEEDAUTH. No account login or registry write was attempted.
- [x] Historical prior candidate manifest: _canary-data/release-logs/stable-windows-final-candidate-2026-10-17/CANDIDATE-MANIFEST.json; SHA-256 a64816855bc0cff26879be511331c28f38d272687f43281bc89b8633fd3ef7a3. The exact-current manifest is in the later 17 October section.

## Exact-source Linux release validation — 17 October 2026

- [x] The exact dirty Stable-candidate source was copied to a fresh Ubuntu 24.04 / WSL2 mirror; source archive SHA-256 `9b12edb8349f284a3c983363a7b096c01a8523a2b10c14f75c7441fcdfb629e9`. `npm ci`, `npm run build` and `npm test` completed successfully on Node 22.23.3 / npm 10.9.9. The suite reported **1,362 PASS / 8 test-case SKIP / 0 FAIL / 0 cancelled** (1,370 counted tests; 225 suites; 66,969.8 ms). The eight counted skips are two unavailable NTFS aliases, one pytest-dependent case without a workspace-local pytest interpreter, one native Windows shape, one PowerShell override test and three Windows snapshot-refresh cases. Five Windows-only suites also had no child tests in this Linux run; neither test-case nor suite-level skips count as passes. The Go fixture suite executed with Go 1.27.2. Logs: `linux-npm-test.log` (SHA-256 `3abb10eb49d6e1a51fcf1e76c05d161c059ab06126aae03e015bc80a37469809`) and `linux-build.log` (SHA-256 `fe45fbfec6448f2e44a892ac02fc246b17bba0ea915a8526b0c85a79fc1a3862`).
- [x] Linux packaging produced three byte-identical tarballs, each matching the Windows candidate: SHA-256 `9b3581a050580ac3a7d6e4a0f151799759fa08561df5dc76a45dfce0009001b2` (246,956 bytes). Linux package-reproducibility log SHA-256: `651ef0d01bef010008884655f81a697e6ba3095d40637ad573cc96fd89b10a56`.
- [x] That same-hash package passed the Linux packed-artifact cleanroom **7/7**, including offline install, shipped example, setup/READY, doctor, passing and regression-blocking hooks, and uninstall preserving unrelated user data/config. Log SHA-256: `99ad3665c0a55d00f9f90a87851d416070feb494bd78d553439146d575e20e2f`.
- The copied Linux package and logs are local-only in `_canary-data/release-logs/stable-windows-final-candidate-2026-10-17/`; `linux-evidence.sha256` indexes their hashes. This run does not clear the separate Windows PowerShell 5.1 host issue, hosted-CI blocker, npm authentication blocker, or experimental live-agent integration blocker.

### Exact-current Stable package revalidation — 17 October 2026

- [x] A dedicated packaging worktree was built from the current dirty Stable RC snapshot at base commit `09805551f3ebb11474699f84ce03ab6e020b06c4`; copied changes were preserved and hashed during setup. `npm run build:force` passed.
- [x] Three consecutive `node tooling/pack.mjs` runs produced byte-identical `@amabie/cli@2.0.0` tarballs: 247,006 bytes, SHA-256 `506f71de9fe38ddd23a98d5c48af51bd044cbab98222bf4897a471791fbac5e7`. The adjacent `.sha256` sidecar matches.
- [x] The exact candidate tarball passed the packed-artifact cleanroom at **7/7 acceptance steps**: local install of that `.tgz`, example test, setup/READY, doctor, hook pass and regression block, loop guard, and uninstall preserving unrelated files and configuration. Log SHA-256: `9c63879edf935af1e86f6bbb8ce399dae3f68912eaab285464e39c22b8b19770`.
- The cleanroom used the existing PowerShell Core override. It does not clear the separately recorded default Windows PowerShell 5.1 CIM failure (`0xC0000005`).
- Candidate manifest and checksums: `_canary-data/release-logs/stable-exact-current-cleanroom-2026-10-17/`; package: `_canary-data/worktrees/amabie-stable-rc-exact-current-2026-10-17/pack/npm/amabie-cli-2.0.0.tgz`.
- [ ] Overall Stable release gates remain open: exact-source hosted CI is still unverified, npm CLI authentication remains `ENEEDAUTH`, and the default Windows PowerShell 5.1 setup/doctor path remains blocked on this host. This package verification does not make Amabie 2.0 release-ready.

### Exact-current artifact Linux cleanroom — 17 October 2026

- [x] The exact current candidate tarball (`506f71de9fe38ddd23a98d5c48af51bd044cbab98222bf4897a471791fbac5e7`) was installed and exercised in Ubuntu 24.04 / WSL2 with Node 22.23.3. The packed-artifact checks passed **7/7**, covering the shipped example, setup/READY, doctor, pass and regression hook behavior, retry guard, and safe uninstall. The Linux harness selected the existing tarball and intentionally skipped rebuilding, so the result applies to these exact package bytes. Log: `_canary-data/release-logs/stable-exact-current-cleanroom-2026-10-17/linux-exact-package-cleanroom.log` (SHA-256 `1c4081553e96d956782d07559e544915d90e7ecbc1c99be35e7c702144cc3dd5`).
- [x] Comparison to the full Linux-tested tarball (`9b3581a050580ac3a7d6e4a0f151799759fa08561df5dc76a45dfce0009001b2`) found the same 21 archive entries and only one changed entry, `package/dist/main.js`. Its JavaScript text is identical after excluding line-leading module-label comments; 23/92 labels differ due to build-path labels. The normalized executable-text SHA-256 is `fc0e21e94fc5ea7e6fb39f83e004c8df399788577b60d58e291e5c7a5eb21f81`. Evidence: `_canary-data/release-logs/stable-exact-current-cleanroom-2026-10-17/package-linux-equivalence.log` (SHA-256 `45049187745f7263554dd38effae4923ba2d53c5e6b29c53ac58679ef84a7456`).
- This confirms exact-artifact Linux installation and smoke workflow. It does not replace the full Linux suite (whose executable source is equivalent) or clear the default Windows PowerShell 5.1 host crash, hosted-CI, npm authentication, or live-provider correction blockers. No source code changed during this revalidation.

### Exact-current package default Windows host cleanroom — 17 October 2026

- [ ] The exact current tarball (SHA-256 506f71de9fe38ddd23a98d5c48af51bd044cbab98222bf4897a471791fbac5e7) was tested on Windows Node 26.7.0 with AMABIE_POWERSHELL_CORE_PATH unset. The packed cleanroom ended CLEANROOM-PACKED-FAIL (4 failed checks): setup/READY, doctor/READY, and green-project hook acceptance did not pass. Regression block, retry guard, uninstall, and user-config preservation did pass. No verification PASS was emitted.
- powershell.exe exited 3221225477 (0xC0000005) during descendant cleanup. No trusted machine-wide PowerShell Core candidate was installed; the available PowerShell executable was in a user-profile Codex runtime and was not added to automatic product discovery. The package failed closed. This is a release-blocking clean-host validation failure on this host; it does not establish a product-wide failure on clean Windows.
- Log: _canary-data/release-logs/stable-exact-current-cleanroom-2026-10-17/windows-default-host-cleanroom.log (SHA-256 0634ed6c6b920395a68a6c087cd692848900d0de065083e3214985258254e344). Sanitized context: windows-default-host-context.txt (SHA-256 eb593cbc6c241a781cb4ab122609f86d991dd9a21ce8edd7af5cfd31e306d262). Exact artifact manifest records FAIL_CLOSED.

### Release worktree integrity comparison — 17 October 2026

- [x] Active Stable RC codex/amabie-2-0-release is at 09805551f3ebb11474699f84ce03ab6e020b06c4; it descends from the older dirty amabie-release-readiness worktree at 19f8d8179aa0b3a3e0e80b70f35c9a73ec91eb91 (merge base equals that older HEAD).
- [x] Compared the older worktree's 356 tracked changed paths plus 33 untracked paths (389-path union): 342 files are byte-identical, 45 have different bytes, zero paths exist only in the older worktree, zero only in the active RC, and two are absent in both. Selected runtime diffs were inspected and the newer RC contains the observed follow-up changes.
- Both worktrees remain intact; nothing was copied, merged, reset, or overwritten. This path-and-hash comparison does not prove semantic equivalence of all 45 differing files.
- Evidence: _canary-data/release-logs/worktree-integrity-2026-10-17/comparison.log (SHA-256 AA9A146400B25CACA709E7AC1FE4E73610DC803CE522BAC2C8DBECCA68398DD2).

## Experimental Prompt-to-Evidence package recheck — 2026-10-17

This addendum covers the dirty `codex/prompt-to-evidence-v1` worktree only. It does not merge its experimental changes into Stable 2.0 or change the separate stable candidate's hosted-CI/publication gates.

- [x] Full Windows product suite on the experimental source: 1,509 PASS / 0 FAIL / 6 SKIP (1,515 total). Skips are retained as unverified and documented in `docs/PROMPT-TO-EVIDENCE.md`.
- [x] Bundled ESM `require` startup defect reproduced, fixed, and guarded by the packed-artifact clean-room regression test.
- [x] Final local 2.0.0 tarball built twice with identical Windows bytes; current SHA-256 is recorded in `docs/PROMPT-TO-EVIDENCE.md` and the local sidecar.
- [x] Exact tarball clean-room: Windows 7/7 with the supported PowerShell Core override; Ubuntu 24.04/WSL2 installed that same tarball offline and completed setup, doctor, passing-hook, and failing-check exercises.
- [ ] Successful live Codex and Claude Code correction acceptance. Both authorized one-shot runs ended FAIL 5/10; no further provider calls are authorized by the consumed one-run approval.

The experimental Prompt-to-Evidence acceptance status is **BLOCKED** by the missing successful live correction cycle. This recheck made no npm publish, GitHub push, merge, new website deployment, or DNS change. `LOCAL` remains distinct from `HARDENED`.

Read-only publication-gate recheck on 2026-10-17: GitHub PR #10 remains open at remote head `685f8233f24471aa9ebebd9b791b77d8512d3391`; its combined status is pending with zero checks. The dirty local experimental source is not that remote revision. `npm view @amabie/cli@2.0.0 version` returned registry **E404**, so the package is not publicly available. These gates remain blocked until the exact candidate can run hosted CI and the owner authorizes any required push or publication.

### Current-source Linux suite follow-up — 2026-10-17

- [x] Fresh isolated Ubuntu 24.04 / WSL2 full `npm test` run on the current experimental source: **1,456 PASS / 0 FAIL / 10 explicit SKIP** (1,466 total; 125,760 ms), Node.js 26.7.0, Go 1.27.2, Python 3.12.3 / pytest 9.1.1. The complete log is `_canary-data/release-logs/p2e-cleanroom-bundle-fix-2026-10-17/linux-full-suite.log` and the reproducible runner is `linux-current-worktree-full-suite.sh` in the same private ignored release-log directory.
- [x] The final Linux run had its required Python/pytest and Go tools on `PATH`; no toolchain-missing test skips remain. The ten skips are Windows-only native confinement/activation and process-sweep snapshot-refresh tests, not passes.
- [x] Windows packaging regression tests remain separately verified 3/3 after the previous full Windows suite; Windows cleanroom remains 7/7. The Linux complete suite covers the current source and includes the packaging regression test.
- [x] Fresh Linux build and package of the current source is byte-identical to the Windows tarball: 277,879 bytes, SHA-256 `0efd97fdb7bfb60f2ad7aab31a7dcaa800d5065d152465ef489f586e3e0b90e0`. The run used `npm ci`, `npm run build:force`, and `node tooling/pack.mjs` in an isolated source snapshot.
- [x] Read-only installed CLI surface checked: Codex 0.162.1 and Claude Code 2.1.278 expose the built-in profile options in their actual help output. This confirms syntax only, not authentication, quota, billing, or correction success; no provider request was made. Evidence: `agent-cli-help-surface-2026-10-17.txt` in the private release-log directory.
- [ ] Experimental correction loop edits the current working tree directly and does not auto-rollback on failure or `NOT PROVEN`; ignored-only changes are not detected as progress. It remains limited to disposable/reviewable worktrees until transactional isolation and rollback are implemented and tested.
- [ ] Local Ollama model-assisted extraction recheck is unavailable in this session: the CLI is installed, but `127.0.0.1:11434` refuses connections. The runtime policy rejected starting the service as a background process; no model was downloaded or run.
- [ ] Live Codex and Claude Code successful correction cycle remains unmet. Their approved one-shot runs failed to make the required correction, so Prompt-to-Evidence remains experimental and blocked; no retry was started.

The first Linux mirror-layout attempt and second post-suite wrapper attempt are retained as failed setup records, not counted as passes. The corrected run passed all requested checks without weakening assertions or editing the product source during execution.

### Post-warning current-candidate validation — 2026-10-17

- [x] Correction agents receive a runtime warning immediately before invocation that edits remain in the current working tree and are not automatically rolled back; the focused correction loop still re-verifies independently.
- [x] The focused correction-loop regression passed 1/1 on Ubuntu 24.04 / WSL2 and 1/1 on Windows using PowerShell Core 7.6.5. The unconfigured Windows PowerShell 5.1 attempt failed closed on the host's `0xC0000005` process-sweep crash; this remains an environment limitation.
- [x] Fresh isolated Linux full suite on the post-warning source: **1,458 PASS / 0 FAIL / 8 SKIP** (1,466 total; 112,282 ms). Current log: `_canary-data/release-logs/p2e-cleanroom-bundle-fix-2026-10-17/linux-post-warning-full-suite.log`.
- [x] Windows package-tarball test file passed 3/3, including clean-room installation of the packed artifact. The final package also passed the offline Ubuntu exact-tarball clean-room workflow.
- [x] Two Windows builds and one fresh Linux build produced byte-identical `@amabie/cli@2.0.0` tarballs: 277,949 bytes, SHA-256 `206be32ffa4a2ea972607f723aeae1e0b0b105ed9fb921f3a4042b4e4a4caaf3`. The prior tarball is archived in the private release-log directory.
- [x] Full Windows `npm test` rerun after the warning with PowerShell Core 7.6.5 and isolated pytest 9.1.1: **1,522 PASS / 0 FAIL / 6 SKIP** (1,528 total; 549,007 ms). Raw log: `_canary-data/release-logs/p2e-cleanroom-bundle-fix-2026-10-17/windows-post-warning-full-suite.log`, SHA-256 `413c65757e1ae4d8e6f75d5f2bdf6c37ae52a22930e87f56eba9f33904c8c842`.
- [x] All six Windows skips individually classified: two filesystem 8.3-alias cases could not produce a distinct short name; three tests require a POSIX `sh` harness; one POSIX shell-inheritance test is intentionally unavailable on Win32. The three POSIX harness cases passed on Linux. The read-only 8.3 query was denied, and no filesystem setting was changed.
- [x] Two consecutive fresh post-warning Linux full-suite snapshots agree at 1,458 PASS / 0 FAIL / 8 SKIP (1,466 total). The older 1,456 PASS / 10 SKIP log is retained as historical evidence from an unreconciled earlier test snapshot; it is not combined with the current run, and no SKIP is counted as PASS.
- [ ] Live Codex and Claude Code successful correction acceptance remains blocked; the one authorized attempt per provider was consumed and no additional provider request was made.

The experimental track remains **BLOCKED**. The new artifact is local only; no npm publication, GitHub push/merge, website deployment, or DNS change was performed.

### Productization host-result reconciliation — 2026-10-17

- [x] The complete post-warning Windows productization battery finished in `115 PASS / 5 SKIP / 2 FAIL`. Its raw log is `_canary-data/release-logs/p2e-cleanroom-bundle-fix-2026-10-17/windows-post-warning-productization.log` (SHA-256 `92b44255b3928800914d017f31e2c43d9ee9d09809723e2ba3995379c74224cd`). Both FAILs were host-unavailable cases: this volume did not provide a distinct 8.3 short-name alias, and the host exposed no launcher able to start the confined child required to measure the optional Windows integrity boundary.
- [x] Corrected the productization harness so these conditions are represented as explicit SKIP results, never PASS. The integrity probe now exits with its documented host-skip code when no confinement launcher is available; it still fails if a control assertion or an executed boundary check fails. No product security behavior or capability claim changed.
- [x] Re-ran the two affected gates independently after that correction. `8.3 short-name suite`: 0 checks executed, 1 explicit SKIP, gate exit 0. `1.2 integrity boundary measurement`: 3 controls executed, 1 explicit SKIP, gate exit 0; it states that no integrity boundary was measured or claimed. Saved logs: `_canary-data/release-logs/p2e-cleanroom-bundle-fix-2026-10-17/classification-fix-2026-10-17/gate-8.3-short-name.log` (SHA-256 `8bf2ed22503c025e99b5e09e5e5ae2932e0aa99cb0dbc9e10a04f9b2c8b2bdca`) and `gate-integrity-boundary.log` (SHA-256 `37d5db52cd502ae2625ec1dd1fc0375494f2b12df9ecc9b557a826d60c4e01d0`); both exit-code files contain `0`.
- [x] Reconciled evidence is therefore **115 PASS / 7 SKIP / 0 verified FAIL**, derived from the completed full run plus targeted reruns of the two corrected gates. This is not represented as a fresh full-battery rerun after the harness-only classification change. The 7 SKIPs remain unverified and are not counted as passes.
- [x] The affected regression test passed (`node --test tooling/test-support/productization-selection.test.mjs`, 1/1), and the release-document consistency probe passed all 9 checks. The full Windows suite remains the separately recorded 1,522 PASS / 0 FAIL / 6 SKIP result above; it was not rerun because this change touched only the productization probe classification and test selection metadata.
- [ ] Host limitation remains: this machine cannot exercise an 8.3 short-name path or measure the optional Windows integrity boundary, so those conditions remain unverified here. This gate establishes no OS-level integrity boundary and supports no `HARDENED` claim. The live Codex and Claude Code successful correction acceptance gate also remains blocked as noted above.
- [ ] A newly approved one-attempt-per-provider run used the 10-requirement, 556/556-mapped false-done scenario. Both providers received one cycle; Codex exited 0 without a Git-visible change, and Claude exited 1. Amabie retained **FAIL 5/10** for both and used no agent claim as evidence. This does not satisfy live correction acceptance; no retry was made. Sanitized summaries and raw harness logs: `_canary-data/release-logs/p2e-complex-provider-retry-2026-10-17/`.
- [x] Provider scenario preparation succeeds with the installed PowerShell Core 7.6.5 selected by `AMABIE_POWERSHELL_CORE_PATH`; an unconfigured Windows PowerShell 5.1 attempt failed closed before any provider started (`0xC0000005`). No containment check was bypassed.

### Separate Stable 2.0 candidate status — 2026-10-17

- [ ] The Stable 2.0 candidate is a separate, dirty worktree at `09805551f3ebb11474699f84ce03ab6e020b06c4`; this Prompt-to-Evidence validation does not clear or replace its release evidence. The stable checklist and readiness report still mark it **BLOCKED** on exact-source hosted CI and Windows setup/doctor validation.
- [ ] Read-only `npm whoami --registry=https://registry.npmjs.org/` against the stable worktree exited 1; npm CLI authentication remains unverified. The latest documented GitHub recheck has PR #10 at the older remote SHA `685f8233f24471aa9ebebd9b791b77d8512d3391`, with no hosted result for the unpushed local candidate. No push, npm publication, merge, website deployment, or DNS change was made.

### P2E diagnostic classifier follow-up — 2026-10-17

- [x] Fixed CLI diagnostic priority: recognized provider errors are classified even if a process exits `0`; non-empty unknown output is distinguished from silent success. Verdict and evidence semantics are unchanged.
- [x] Three focused diagnostics regressions passed as part of the full Windows `npm test`: **1,524 PASS / 0 FAIL / 0 cancelled / 6 SKIP** (1,530 tests; 223 suites; 564,160.8 ms). The six skips remain unverified: two unavailable NTFS 8.3 alias cases and four POSIX-shell harness cases on Windows.
- [x] Full-suite log SHA-256: `E686E1A49B477CE47174856892D46C2ED2000A880F6EBED98B54C3E9160DE483`; see `_canary-data/release-logs/p2e-diagnostic-classifier-2026-10-17/p2e-full-npm-test.log`.
- [ ] Live Codex and Claude successful correction acceptance remains blocked. The earlier authorized provider runs are consumed; this diagnostic change has not been tested against a new live provider invocation.

- [x] The three diagnostic regression tests also passed under Ubuntu 24.04 / WSL2 with Node.js 26.7.0: **3/3, 0 skipped**. This is a targeted test of the current compiled artifact, not a fresh Linux build or full Linux-suite rerun. Log SHA-256: `98eef1b15949111b5e901ff489d3edef4b9a3ae5114fc84704fce24401e0a048`.

### Turn-limit diagnostic regex follow-up — 2026-10-17

- [x] Test-first reproduction confirmed that `Max turns reached` was misclassified; the whitespace regex was corrected without touching verdict or evidence semantics.
- [x] TypeScript build and four focused diagnostic tests passed on Windows and Ubuntu 24.04 / WSL2 (Node.js 26.7.0): **4/4 on each platform, 0 skipped**. Logs are `windows-diagnostic-classifier-after-max-turn-fix.log` (SHA-256 `4f585b4572d84d131f3f5474ea312aa5200ee32fd099db9f1cb68a622f1c963c`) and `linux-diagnostic-classifier-after-max-turn-fix.log` (SHA-256 `2f41e556d9904400ea99416bf34654c68db1176c85b6029a41f5a075a99a2298`) under `_canary-data/release-logs/p2e-diagnostic-classifier-2026-10-17/`.
- [x] The full Windows suite was rerun after the final narrow classifier/test change; the current result is recorded below. The earlier 1,524-pass result remains historical evidence only.

### Final Windows suite after turn-limit regex correction — 2026-10-17

- [x] The exact current Prompt-to-Evidence worktree completed `npm test` successfully: **1,525 passed / 0 failed / 0 cancelled / 6 skipped** (1,531 tests, 223 suites; 550,983.5 ms). `npm test` ran `npm run build:force` before the test runner, so this includes the `Max turns` regex correction and its new regression test.
- [x] Raw log: `_canary-data/release-logs/p2e-diagnostic-classifier-2026-10-17/p2e-full-npm-test-after-max-turn-fix.log`; SHA-256 `95ca5dadfe663cf33d18e60753edcc1a8144c9be06d46016ea5fcb718a319c88`. The adjacent `.sha256` sidecar was verified against the file.
- [ ] The six skips remain unverified: two filesystem-dependent NTFS 8.3 short-name cases and four POSIX shell-harness cases unavailable on Windows. They are not counted as passes.
- [ ] This run validates the Prompt-to-Evidence worktree only; it does not update the separate Stable 2.0 candidate evidence or clear hosted CI, npm authentication/publication, Windows system-PowerShell setup/doctor, legal approval, or live Codex/Claude correction acceptance gates.

### Live provider retry after diagnostic-classifier fixes — 17 October 2026

- [x] One newly authorized live correction attempt was run for each CLI in separate disposable projects. Each prompt mapped **556/556** non-whitespace characters into 10 requirements. Amabie independently rejected the seeded false-done candidate at **FAIL (5/10 met, 5/10 unmet)** before invoking an agent.
- [x] Codex CLI `0.162.1`: one correction cycle; agent process exit 0, no timeout or output-limit event, classifier hint `permission-or-trust`; no Git-visible files changed. Final loop status `correction-blocked`, verdict **FAIL (5/10)**, `agentClaimUsedAsEvidence: false`.
- [x] Claude Code `2.1.278`: one correction cycle; agent process exit 1, no timeout or output-limit event; stdout 73 bytes and stderr 0. Final loop status `correction-blocked`, verdict **FAIL (5/10)**, no changed files, `agentClaimUsedAsEvidence: false`.
- No unsupported PASS was emitted. The Codex diagnostic is a classifier hint, not a confirmed root cause; raw provider output was not retained. Exact account quota or cost use could not be measured.
- Sanitized results and SHA-256 manifest: `_canary-data/release-logs/p2e-complex-provider-retry-after-full-suite-2026-10-17/`.
- [ ] Successful real-provider correction acceptance remains unmet for both Codex and Claude Code. This retry used the single newly authorized attempt per CLI; no further provider call is authorized by it. Prompt-to-Evidence remains experimental and blocked at this gate.

### Read-only correction CLI option check — 2026-10-17

- [x] Local `codex exec --help` and `claude --help` were inspected without invoking either agent. The installed help exposes the options used by Amabie's built-in adapters, including Codex `--sandbox`, `--ephemeral`, `--ignore-user-config` and Claude `--restricted`, `--print`, `--input-format`, `--output-format`, `--permission-mode`, `--permission-prompts`, `--tools`, `--disallowedTools`, and `--strict-mcp-config`. Codex help explicitly says `--ignore-user-config` still uses `CODEX_HOME` for auth.
- This rules out an obviously unsupported option in the local CLI help, but does not establish why either approved correction attempt failed. Raw provider output remains unavailable, so the root cause is still **unknown**. No agent invocation was repeated; the one-attempt-per-CLI approval is consumed, and successful real-provider correction acceptance remains blocked.
- [x] The full current adapter argument vectors also parsed successfully with `--help` appended: both Codex and Claude exited 0. No prompt was supplied and no model/provider request was made. This verifies argument syntax only, not authentication, model execution, edits, or the cause of the earlier failures. Log and SHA-256 sidecar: `_canary-data/release-logs/p2e-cli-argument-preflight-2026-10-17/` (log SHA-256 `1666caecb48ac7f6e752beee925b8548486095e1f8cd304b8477f833ab2c0c1f`).

### Read-only authentication and offline adapter E2E follow-up — 2026-10-17

- [x] After `npm run build:force`, Codex and Claude authentication-status commands both exited 0 through the exact filtered child environment used by the built-in profiles. This sent no generation request and retained no account output or credential. It does not establish model access, quota, billing, or successful editing.
- [x] Focused adapter and process-diagnostic tests passed **12/12**.
- [x] The ten-requirement offline shim E2E passed **2/2** with the explicit `AMABIE_POWERSHELL_CORE_PATH` override; one local executable shim exercised each built-in profile and no provider request was sent.
- [ ] Without that override, both offline E2E profiles failed during setup before invoking a shim because the default `powershell.exe` process sweep exited `0xC0000005`. This remains an environment limitation and does not validate default-host setup.
- [ ] Successful live Codex and Claude correction acceptance remains blocked. Their one authorized live attempt each was consumed and both ended `correction-blocked / FAIL (5/10)` as recorded above; no further provider call was made.
- Sanitized result and checksum sidecar: `_canary-data/release-logs/p2e-cli-auth-preflight-2026-10-17/` and `_canary-data/release-logs/p2e-offline-agent-adapter-e2e-2026-10-17/`.

### Additional approved live correction attempt — 17 October 2026

- [x] One authorized live correction cycle ran in a separate disposable project for each CLI. Both started from the independently verified FAIL 5/10 ten-requirement candidate (556/556 prompt characters mapped).
- [x] Codex CLI 0.162.1 exited 0 without changing files; permission-or-trust is an unconfirmed diagnostic hint.
- [x] Claude Code 2.1.278 exited 1 with 73 stdout bytes and no stderr. Neither run timed out or exceeded output limits.
- [x] Amabie retained correction-blocked / FAIL 5/10 for both and agentClaimUsedAsEvidence false; no false PASS was emitted.
- [ ] Successful live correction acceptance is still blocked. Exact CLI failure causes and provider quota/cost are unknown. This explicit approval is consumed; no more calls were started.
- Sanitized summary and checksum: _canary-data/release-logs/p2e-provider-approved-retry-2026-10-17/.

### Permission-diagnostic precision follow-up — 17 October 2026

- [x] Added a regression for a false-positive `permission-or-trust` hint from ordinary prose; explicit “Permission denied” still receives that hint.
- [x] Forced TypeScript build passed; focused Codex/Claude adapter and correction-diagnostic tests passed **14/14**, 0 skipped.
- [x] Ten-requirement offline correction rehearsal passed **2/2** with the explicit, already-installed PowerShell Core executable; no provider request was made. Both profiles used one local shim correction and completed with full fixture coverage.
- [ ] Live Codex and Claude correction acceptance remains **0/2**. The previous one-attempt-per-CLI approval is consumed; exact provider failure causes are unknown. Do not count the local shim rehearsal as a live-agent pass.
- [ ] Default Windows PowerShell 5.1 still exits with `0xC0000005` during the CIM process sweep on this host. Amabie fails closed. The explicit Core override works; this is a documented environment limitation, not proof the default host works.

### Full Windows suite after diagnostic-hint correction — 17 October 2026

- [x] The exact experimental Prompt-to-Evidence worktree completed `npm test` (including forced TypeScript build): **1,527 PASS / 0 FAIL / 0 cancelled / 6 SKIP** (1,533 tests, 223 suites; 580,823 ms).
- [x] PowerShell Core 7.6.5 and isolated pytest 9.1.1 were explicitly selected. The live `powershell.exe` crash was not suppressed; this run used the documented trusted Core override.
- [ ] The six skips remain unverified: two NTFS 8.3 alias cases could not obtain a distinct short name, and four POSIX shell-harness cases are not available on Windows. The three shell cases passed in the previously recorded Linux suite; the Windows-only unavailable shell-inheritance case remains a host limitation.
- [x] Raw log SHA-256: `d5db72f21f18f6cf1557a422949229fd18e4f84bfe885bad03a500e37346fc26`; log and `.sha256` sidecar: `_canary-data/release-logs/p2e-diagnostic-classifier-2026-10-17/windows-full-suite-after-permission-hint-fix.log`.
- [ ] This validates only the experimental Prompt-to-Evidence worktree. Successful live Codex and Claude correction acceptance remains unmet; the one approved attempt per CLI was consumed and both ended `correction-blocked / FAIL (5/10)`.

### Free-prose coordinated-action extraction follow-up — 17 October 2026

- [x] Added test-first Core and Ollama-mock regressions for exact splitting of `parse …, and attach …`; they retain source offsets and never mark candidates clear or proven.
- [x] Forced build passed; focused Core passed **36/36** on Windows and Ubuntu 24.04 / WSL2; focused Ollama-mock CLI tests passed **1/1** on Windows and **3/3** on Linux.
- [x] Full Windows `npm test` on the exact experimental worktree passed **1,528 / 1,534**, with **0 failures** and **6 counted skips** (223 suites; 572,170.9846 ms), using Node 26.7.0, PowerShell Core 7.6.5 and Python 3.12.10 / pytest 9.1.1.
- [x] Log SHA-256: Windows `d63ab1b29b203cd60150f070777b7138347b971dafea02c87dbb333ff084be9a`; Linux focused `1e9098cf368beceb6f6c5f27f554faebd987e0dc603e634ced6e9b5d85607827`. Both logs have checksum sidecars under `_canary-data/release-logs/p2e-free-prose-attach-2026-10-17/`.
- [ ] The six Windows skips remain unverified (two unavailable 8.3 aliases and four POSIX-shell harness cases). The parser remains heuristic and does not establish semantic completeness. Live Codex/Claude successful correction and the separate Stable 2.0 release gates remain unresolved.

### Newly approved Codex and Claude live correction attempts — 17 October 2026

- [x] Prepared separate disposable projects with ten exact, source-linked requirements, 556/556 mapped prompt characters, an independently verified initial `FAIL 5/10`, five controlled omissions, and a seeded signed-total regression.
- [x] Used the newly approved single attempt per provider. Codex 0.162.1 exited 0 (156 stdout / 7,784 stderr bytes) but made no Git-visible changes (`exit-success-with-output`); Claude Code 2.1.278 exited 1 (73 stdout / 0 stderr bytes) (`nonzero-exit-with-output`). Both completed without timeout, output limit, or process-sweep failure.
- [x] Amabie retained `correction-blocked / FAIL 5/10` for both, with no changed project files and no agent claim used as evidence. Neither emitted a false `PASS`.
- [x] Sanitized result manifests and validated sidecars: Codex SHA-256 `4bfb675864ad7f6f7b20f31cbe08eb13e33a468801291cebff444c316a739da0`; Claude SHA-256 `23a056ce8dc8401c16086974ad9403aa0ed38dd687a33c8c9e4541ddbe0ed8d1` in the per-provider `_canary-data/release-logs/p2e-complex-*-2026-10-15/` directories.
- [ ] Exact provider failure causes remain unknown because raw outputs are not retained. The one-attempt-per-provider approval is consumed; successful live correction acceptance remains a release blocker for experimental Prompt-to-Evidence. No further provider call was made.

### Follow-up P2E extraction and fresh live attempts — 17 October 2026

- [x] After a separate new approval, ran exactly one Codex CLI 0.162.1 attempt and one Claude Code 2.1.278 attempt in separate disposable projects. Both retained the initial and final `FAIL 5/10`; Codex exited 0 with no Git-visible changes, Claude exited 1 with no changes. No timeout, output cap or process sweep failed; agent claims were not used as evidence.
- [ ] These two provider attempts also failed to complete a correction. The new approval is consumed; exact causes and quota/cost are unknown because output content is not persisted. Do not retry without fresh authorization.
- [x] Fixed a deterministic extraction gap: common third-person action forms and recognized action gerunds after `while` now create distinct exact, source-linked candidates. A free-prose draft yields **13** unresolved candidates over **499/499** non-whitespace source characters; every candidate remains `unclear` with no criteria and the verdict remains `NOT PROVEN`.
- [x] Forced build passed; Prompt-to-Evidence Core/CLI suite passed **77/77**, 0 skipped; offline Codex/Claude shim correction rehearsal passed **2/2** after updating the test fixture wording and local corrector expectation without weakening assertions.
- [ ] Ollama was not available on loopback, and Ubuntu 24.04 WSL had no Node.js executable, so no model-assisted extraction or post-change Linux test is claimed. Full Windows `npm test` was not rerun for this parser-only change; the prior full suite does not validate this diff.
- [x] Local run record and checksums: `_canary-data/release-logs/p2e-followup-live-and-extraction-2026-10-17-r1/`. The P2E live-agent acceptance gate remains **BLOCKED**; Stable 2.0 release readiness is unchanged.

### Post-change Linux Core verification — 17 October 2026

- [x] The current forced-build compiled Prompt-to-Evidence Core test artifact passed under Ubuntu 24.04 / WSL2 with temporary Node.js v26.7.0: 37 passed, 0 failed, 0 skipped.
- [x] Node.js x64 archive SHA-256 was verified against the official Node.js v26.7.0 release checksum manifest. The runtime was extracted only under WSL /tmp; no system installation was made.
- [ ] This focused run does not verify a Linux build or full Linux suite. The full Windows npm test suite was not repeated after the parser-only change. Live Codex/Claude correction acceptance remains unmet and no further provider attempt is authorized by the consumed approval.
- Evidence log: _canary-data/release-logs/p2e-followup-live-and-extraction-2026-10-17-r1/linux-prompt-evidence-core-node-26.7.0.log.
### Subject-modal extraction follow-up — 17 October 2026

- [x] Added a failing regression for a coordinated subject-modal clause; exact source-linked extraction now separates it while leaving both candidates unclear and NOT PROVEN.
- [x] Build passed; Core passed 39/39 and Prompt-to-Evidence CLI passed 26/26 with the existing PowerShell Core 7.6.5 override; offline ten-requirement Codex/Claude shim E2E passed 2/2.
- [ ] Default PowerShell 5.1 still crashed in process enumeration (0xC0000005), causing 12 CLI test setup failures; the same suite passed 26/26 with the Core override. No assertions or skips changed.
- [ ] Current Linux rerun is unverified because WSL failed to start with Wsl/Service/E_UNEXPECTED before tests ran; Docker Desktop Linux engine was stopped. The earlier 37/37 Linux result predates this parser diff.
- [ ] Full npm test was not repeated. Successful live Codex/Claude correction remains unmet; their prior one-attempt approval is consumed.
- Evidence: _canary-data/release-logs/p2e-followup-subject-modal-2026-10-17-r1/.
