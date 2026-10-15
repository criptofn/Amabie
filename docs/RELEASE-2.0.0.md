# Amabie 2.0.0 release candidate

Unpublished candidate, 13 October 2026. **BLOCKED pending hosted validation of the patched source and npm CLI authentication. This document does not authorise publication.** `docs/RELEASE-CHECKLIST.md` is the current checklist; the website's `docs/AMABIE-RELEASE-READINESS.md` records detailed evidence and limitations.

## What this release changes

Canary becomes Amabie: package identity `@amabie/cli`, executable `amabie`, renamed MCP tools and project documentation. The `canary` executable and legacy project formats/data discovery remain where needed for migration. Existing global Canary packages can conflict with the compatibility bin; follow the tested upgrade procedure rather than forcing an overwrite.

The mission also fixes linked project scopes escaping the declared repository, inherited ecosystem names being treated as adapters, and everyday checks leaving descendant processes after normal exit or timeout. Scope discovery and execution now validate canonical containment; unavailable cleanup measurement cannot produce a successful check. This is user-space cleanup, not an OS sandbox.

The test-runner authority fixture now pins its reviewed canonical Git LF bytes. Exact-byte integrity validation remains intact. Go provisioning verifies the official archive digest before extraction, preserves sibling toolchains and refuses a corrupted archive. Release automation now depends on the test workflow, uses the exact checked artifact and requires configured release approval; its hosted execution remains unverified until an approved push.

The npm package includes a runnable consumer Quickstart, a three-file example and its Apache-2.0 licence. Website source uses Apache-2.0 with Amabie brand assets reserved separately. The official static website provides an illustrative Evidence Desk and accurately separates available LOCAL capabilities from unavailable HARDENED isolation.

`docs/NORTH_STAR.md` records Phase 1 Coding-Agent Verification, Phase 2 Prompt-to-Evidence, and Phase 3 Universal Agent Assurance with explicit acceptance criteria. Phase 3 is a future direction and is not claimed as achieved. The Prompt-to-Evidence prototype remains on its separate experimental worktree and is not included in this stable candidate.

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
| Windows full units | 1,423 passed, 4 POSIX-only skipped, 0 failed after the process-sweep fix |
| Native Ubuntu/WSL units | 1,358 passed, 7 skipped test cases, 0 failed (1,365 test cases) on the post-patch release source snapshot under Node 22.23.3; five Windows-native suites also skipped at suite level |
| Windows cleanroom | Seven acceptance steps passed on the exact rebuilt local tarball, including installed aliases and literal hook execution |
| Package rehearsals | The exact final tarball passed fresh Windows and Linux cleanroom/verification rehearsals: discriminating change READY, genuine regression NEEDS ATTENTION, unchanged green checks NOT PROVEN, forged saved success and corrupted config refused |
| Documentation-only AI user | 60 commands: installation, meaningful change, regression, proof gap and recovery; friction corrected and the exact fresh-example procedure retested |
| Website | Clean build/lint/audit; 117 browser cases passed across three engines and three widths; screenshots inspected, automated WCAG checks clean |
| Productization | Latest complete Windows run: 117 PASS / 5 explicit SKIP / 0 FAIL or INCOMPLETE. The older detailed ledger is 105 PASS / 5 SKIP across 110 definitions; it remains historical. The latest aggregate did not capture raw per-gate logs |
| Artifact reproduction | Three identical packages from both patched Windows and fresh Linux snapshots; Linux and Windows package bytes match |

Exact logs, source identity, final checksum and reconciled gate verdicts are recorded in the final manifest and report. The five Windows-run skips remain explicit: Rust E2E could not link because MSVC link.exe was unavailable; actual OS PTY allocation on Windows was not exercised in two acceptance batteries; and two live-Claude diagnostics require paid provider usage. Separately, an isolated Ubuntu 24.04 Rust E2E follow-up passed 3/3 assertions using Rust 1.99.0 and explicit `--toolchain-dir`: cargo check/test/build ran, a green crate reached READY, and an intentional regression was rejected. That follow-up does not change the Windows skip or the historical 117 PASS / 5 SKIP aggregate. Historical test totals and Axios fixture observations are not substitutes for current release tests.
Skip accounting: the seven reporter-counted skipped cases are one native-confinement “unmeasured off Windows” sentinel, two 8.3 alias checks that the Ubuntu filesystem could not exercise, one native-Windows PATH-shape check, and three Windows process-snapshot checks. The Linux log also marks five Windows-native suites skipped at suite level; Node omits those suite nodes and their unexecuted child tests from its `tests` and `skipped` case totals. The five suites cover production activation, custody/deployment controls, raw-control behavior, retired/malformed evidence, and saved-evidence live-broker checks. They passed in the native Windows full suite; the Windows process and 8.3 alias cases also passed there. These remain platform-specific skips on Linux, not Linux passes.

Final local package: 243,772 bytes, SHA256 `7d790bdebef57baf9b436dc3aff262f86181cff04282f043efb0f2f8c348efc8`. The Windows sweep indexes exact process identities once instead of re-filtering the full snapshot per descendant. Its large-snapshot regression, 12/12 lifecycle suite, 12/12 idle/loaded stress attempts, full Windows suite, three-build reproducibility check, and exact-package cleanroom 7/7 pass. On 2026-10-15, the fresh native Ubuntu 24.04 snapshot completed the full suite (1,358 pass, 7 skipped test cases, 0 fail; see skip accounting above), three identical package builds, cleanroom and full verification rehearsal. The Linux package is byte-identical to the Windows candidate. Raw logs, environment/source hashes, rehearsal JSON and Linux tarball are in `_canary-data/release-logs/amabie-2.0-linux-package-2026-10-15/`. Hosted CI still needs to validate the patched source.

## Known limits and open investigation

- LOCAL runs checks with the developer's user permissions. Same-user processes can replace authority storage, issuer keys and history, or reseal a plan. No HARDENED boundary is available in this candidate.
- Signed authority records and everyday evidence are different. Everyday bundles carry tamper-evidence self-hashes, not independent signatures. Their check-plan status does not settle completion obligations; use the full doctor/result proof envelope. Retention can fail and must be reported honestly.
- Project commands and check coverage define the proof scope. Worker-authored checks carry a caveat. Green tests, tool bindings and observed execution do not guarantee semantic correctness or honest test assertions.
- A historical hosted v1.5 descendant-cleanup incident remains OPEN/UNEXPLAINED. Later snapshot fixes and current local stress/regression results do not identify its original cause. Cleanup is bounded and best effort; escaping session/lineage and same-user races are outside an OS isolation guarantee.
- Claude/Codex integrations require their host's consent/trust steps. Written configuration and literal-hook simulations do not prove a live hosted session is gated. Other CLI agents are advisory.
- The optional AI explanation package ships a no-op provider. It is not a live AI service, and explanations cannot override deterministic decisions.
- Standalone executables remain experimental, with smoke-only verification and absent provider sidecars disclosed. The supported release distribution is the Node npm bundle; do not promote standalone parity.
- Hosted CI on the patched source and npm CLI access remain release blockers. The old hosted runs failed before this fix; the Go provisioning retry applies to that old source only. No product push, merge, tag or npm publication was performed.

## Approval boundary

Before public release: review the complete report and exact tested source/artifact hashes, configure account-level release approval, and approve publication separately. Hosted CI must verify the approved pushed source before publishing. Legal pages are drafts; personal operator data is kept in ignored private website build configuration. Generated legal HTML and the local website ZIP are private until explicit publication approval.