# Amabie 2.0 release candidate checklist

Mission started 2026-10-12. Current status: **BLOCKED** pending hosted validation of the patched source and npm CLI authentication. Previous test and artifact evidence remains retained; no publication is authorised.

This isolated worktree snapshots the existing renamed source; it does not replace or reset any other worktree. The authoritative cross-project checklist/progress log is `docs/RELEASE-MISSION.md` in the website repository. Exact source snapshot is recorded under that repository's ignored `artifacts/release/` directory.

- [x] Source snapshot and original HEAD identified; prior changes preserved. The candidate patch is isolated in this release branch; the separate release-readiness worktree remains untouched.
- [x] Source-backed architecture/security/reliability audit complete within documented LOCAL scope.
- [x] Confirmed release defects fixed with meaningful regression checks, including final actual Node20 refusal.
- [x] Windows full test suite and separate productization battery complete on the current local source; see the limitations below.
- [x] Full native Ubuntu 24.04 verification on the post-patch release snapshot: 1,358 passed, 7 skipped test cases, 0 failed (1,365 cases; Node 22.23.3). Five Windows-native suites are also skipped at suite level and excluded from TAP case totals; all five passed in the native Windows full suite. The seven counted skips and their Windows/host-specific reasons are itemized in `docs/RELEASE-2.0.0.md`; none count as a pass.
- [x] CLI help, setup recovery, installed stdio MCP and literal integration contracts verified; hosted consent/trust remains unverified.
- [x] Final local tarball name/version, exact21files, aliases, license and checksum verified.
- [x] Windows cleanroom 7/7 and fresh native Linux cleanroom plus verification rehearsal passed on the exact local release tarball.
- [x] Final package-based discrimination, regression, NOT PROVEN, forged-record and corrupt-configuration scenarios pass on both OS.
- [x] Three identical package artifacts from the current patched Windows worktree.
- [x] Post-patch Linux package reproduction and byte comparison passed. Three Linux builds matched each other and the Windows candidate byte-for-byte; details and raw logs are in `_canary-data/release-logs/amabie-2.0-linux-package-2026-10-15/`.
- [x] CI/release gates prepared and actionlint clean; the old-source Ubuntu retry passed after Go/pytest provisioning. The old-source Windows hosted job failed; patched-source hosted CI remains unverified.
- [x] README/Quickstart, tested migration, release notes, limitations and unpublished launch materials prepared.
- [x] Website full117matrix plus final18affected docs/accessibility, build/lint, screenshots and local preview verified.
- [x] Private operator/legal drafts and human publication/account gates documented.

The latest local Windows `npm test` run completed with 1,423 passed, 4 POSIX-only skipped, and 0 failed. The latest complete Windows `verify:productization` run completed with 117 PASS, 5 explicit SKIP, and 0 FAIL/INCOMPLETE. M12/M13 both triggered their original owning assertions. Five skips remain unverified: two optional live-Claude cost checks, Rust E2E without a Rust toolchain, and native OS PTY allocation in two Windows acceptance batteries. The prior detailed ledger still records 105 PASS / 5 SKIP across its 110 gate definitions and must be read as historical; the latest aggregate run did not capture per-gate raw logs. The current npm package is 243,772 bytes, SHA256 `7d790bdebef57baf9b436dc3aff262f86181cff04282f043efb0f2f8c348efc8`. Local supported-runtime gates pass, but release readiness remains blocked because hosted CI has not tested the patched source and npm CLI auth returns `ENEEDAUTH`.

## Resumed blocker resolution

- M12/M13 isolated baselines completed: acceptance193.8s (explicit Windows PTY limitation), subjectivity102.3s. Mutants caught by unchanged owning assertions: M12 exit1/201.0s, M13 exit1/95.7s. No timeout; compiled target bytes were restored. Logs: website artifacts/release/blocker-resolution/m12-m13/.
- Confirmed runner cause: a whole-battery2700s cap accumulated five baseline owners plus thirteen repeated owner suites; it cut off later faults although individual suites completed. Default orchestration now schedules each fault separately with the original finite budget; owner900s limits and all assertions remain unchanged.
- Recorded process runner streams logs, distinguishes infrastructure/timeout from a caught mutation, contains descendants and handles cancellation before restoring files. Runner/selection tests pass2/2, including timed-out descendant termination and all35remaining-gate preservation.
- Exact remaining35gate inventory and serial prerequisites: website artifacts/release/blocker-resolution-remaining-35.json. Each execution writes independent stdout/stderr/result JSON; a failed destructive gate stops the chain after restoration. Paid live diagnostics remain excluded.
- Resume commands: `node tooling/verify-productization.mjs --from "<exact gate label>" --raw-log-dir <new absolute directory>`; one gate: `--gate "<exact gate label>"`; plan: `--list-json`. Selected runs never claim unrequested gates were executed.

No public push, release, npm publishing, deployment or DNS changes are authorized. An unverified or skipped gate remains unverified; LOCAL is not HARDENED.

## Final blocker handoff

- [x] M12/M13 completed with unchanged security assertions; targets restored byte-for-byte.
- [x] All 35 following gates attempted separately with retained raw logs. First pass 32 PASS / 2 SKIP / 1 FAIL; the only failure was the probe importing an unshipped renamed pytest module. It now imports the shipped `PYTEST_PLUGIN_MODULE`, requires the attack fixture to exit successfully, and still requires exactly one `no-run` rejection. Rerun passes all 7 cases; no runtime/security semantics changed.
- [x] Budget/cascade regression and process-runner/gate-selection self-checks pass: 2/2 on Windows and native Linux. Linux correctly omits the native Windows provider gate (34 follow-ups versus Windows35); its original failed test assumption and corrected rerun are retained. Each mutation keeps the original finite budget and each owner keeps 900s; cancellation and descendants are contained before restoring files.
- [x] Fresh final Windows cleanroom 7/7 and real package/MCP rehearsal pass: READY, genuine regression NEEDS ATTENTION, false-green NOT PROVEN, forged stored PASS refused, invalid configuration refused and evidence hashes checked.
- [x] The confirmed Windows cleanup timeout was caused by repeatedly filtering the entire WMI snapshot for each descendant. Exact `(PID, CreationDate)` identities are now indexed once; the existing fail-closed checks remain. A large-snapshot regression, Windows lifecycle suite 12/12, stress test 12/12, and full Windows suite pass.
- [x] Three packages built from the patched Windows worktree are byte-identical; the exact tarball passes the cleanroom journey 7/7. New package SHA: `7d790bdebef57baf9b436dc3aff262f86181cff04282f043efb0f2f8c348efc8`.
- [x] The base source snapshot and four-file source delta are preserved with hashes in the website candidate manifest. The delta also carries `docs/NORTH_STAR.md` and its binding `AGENTS.md` reference; concurrent worktrees remain untouched.
- [x] Source-integrity recheck on 2026-10-15 passed against the current product-progress worktree: reconstructed source tree `5751a7916bda9196d13bad060072ade395de212a`; zero unmatched tracked changes, new source files, or deleted baseline files; both original untracked C# source files match by hash; both default Git indexes unchanged. The current release snapshot differs from PR #10's tree in seven paths: the four-file North Star/process-sweep patch plus three local release documents. The two code changes are the indexed Windows process-sweep fix and its large-snapshot regression. Evidence: `_canary-data/release-logs/source-integrity-final-2026-10-15.json`.
- [ ] Hosted CI on the patched source and npm CLI authentication remain unverified. The prior hosted Ubuntu retry tested the old source; it does not validate the hotfix. Local post-patch Linux tests and package verification now pass, but do not replace hosted CI.