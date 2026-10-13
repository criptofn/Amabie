# Amabie 2.0.0 release candidate

Unpublished candidate, 12 October 2026. **READY FOR FINAL APPROVAL for the supported LOCAL npm workflow. This document does not authorise publication.** The authoritative gate ledger is `docs/RELEASE-CHECKLIST.md`; the website's `docs/AMABIE-RELEASE-READINESS.md` records the final evidence and limitations.

## What this release changes

Canary becomes Amabie: package identity `@amabie/cli`, executable `amabie`, renamed MCP tools and project documentation. The `canary` executable and legacy project formats/data discovery remain where needed for migration. Existing global Canary packages can conflict with the compatibility bin; follow the tested upgrade procedure rather than forcing an overwrite.

The mission also fixes linked project scopes escaping the declared repository, inherited ecosystem names being treated as adapters, and everyday checks leaving descendant processes after normal exit or timeout. Scope discovery and execution now validate canonical containment; unavailable cleanup measurement cannot produce a successful check. This is user-space cleanup, not an OS sandbox.

The test-runner authority fixture now pins its reviewed canonical Git LF bytes. Exact-byte integrity validation remains intact. Go provisioning verifies the official archive digest before extraction, preserves sibling toolchains and refuses a corrupted archive. Release automation now depends on the test workflow, uses the exact checked artifact and requires configured release approval; its hosted execution remains unverified until an approved push.

The npm package includes a runnable consumer Quickstart, a three-file example and its Apache-2.0 licence. Website source uses Apache-2.0 with Amabie brand assets reserved separately. The official static website provides an illustrative Evidence Desk and accurately separates available LOCAL capabilities from unavailable HARDENED isolation.

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
| Windows full units | 1,414/1,418 passed before the final startup guard, four POSIX leaf skips, zero failures; final affected runtime checks 6/6 |
| Native Ubuntu/WSL units | 1,354/1,360 passed including the startup guard, six Windows/8.3 leaf skips, zero failures; native Node, Python/pytest and Go |
| Windows cleanroom | Seven acceptance steps passed, including real installed aliases and literal hook execution |
| Package rehearsals | Windows and Linux: discriminating change READY, genuine regression NEEDS ATTENTION, unchanged green checks NOT PROVEN, forged saved success and corrupted config refused |
| Documentation-only AI user | 60 commands: installation, meaningful change, regression, proof gap and recovery; friction corrected and the exact fresh-example procedure retested |
| Website | Clean build/lint/audit; 117 browser cases passed across three engines and three widths; screenshots inspected, automated WCAG checks clean |
| Productization | Reconciled original 110 definitions: 105 PASS / 5 explicit SKIP. M1–M11 reused from the corrected run; M12/M13 caught in bounded isolated runs. All 35 outstanding gates attempted, 33 PASS / 2 SKIP after the pytest fixture fix. No new full uninterrupted battery is claimed |
| Artifact reproduction | Three identical packages per OS and byte-identical Windows/Linux final archives; canonical CLI mode0755 and portable gzip verified |

Exact logs, source identity, final checksum and reconciled gate verdicts are recorded in the final manifest and report. Skips remain unverified: Rust E2E without a Rust toolchain, actual OS PTY allocation on Windows and paid live-Claude diagnostics. Native Rust discovery is implemented; Rust workflow release validation is not claimed. Historical test totals and Axios fixture observations are not substitutes for current release tests.

Final local package: 243,810 bytes, SHA256 `0befdba10360cfb785aca441f5b712784d215616317e03079cb788331c97c85d`. The Node >=22 startup refusal is integrated and verified on actual unsupported Node20, with six affected Windows regressions passing and a full supported native Linux run. Final cleanroom and package/MCP rehearsals pass on both systems; a fresh Windows cleanroom and rehearsal after blocker resolution confirm the same exact artifact. The last changes affect test orchestration and a renamed test import, not product runtime. Execution stops at this handoff.

## Known limits and open investigation

- LOCAL runs checks with the developer's user permissions. Same-user processes can replace authority storage, issuer keys and history, or reseal a plan. No HARDENED boundary is available in this candidate.
- Signed authority records and everyday evidence are different. Everyday bundles carry tamper-evidence self-hashes, not independent signatures. Their check-plan status does not settle completion obligations; use the full doctor/result proof envelope. Retention can fail and must be reported honestly.
- Project commands and check coverage define the proof scope. Worker-authored checks carry a caveat. Green tests, tool bindings and observed execution do not guarantee semantic correctness or honest test assertions.
- A historical hosted v1.5 descendant-cleanup incident remains OPEN/UNEXPLAINED. Later snapshot fixes and current local stress/regression results do not identify its original cause. Cleanup is bounded and best effort; escaping session/lineage and same-user races are outside an OS isolation guarantee.
- Claude/Codex integrations require their host's consent/trust steps. Written configuration and literal-hook simulations do not prove a live hosted session is gated. Other CLI agents are advisory.
- The optional AI explanation package ships a no-op provider. It is not a live AI service, and explanations cannot override deterministic decisions.
- Standalone executables remain experimental, with smoke-only verification and absent provider sidecars disclosed. The supported release distribution is the Node npm bundle; do not promote standalone parity.
- Actual hosted CI, npm scope/account access, Cloudflare delivery/HTTPS/headers, DNS and final legal/privacy disclosures need owner/account actions. No publication, push, deployment, DNS change or additional paid service was performed.

## Approval boundary

Before public release: review the complete report and exact tested source/artifact hashes, configure account-level release approval, and approve publication separately. Hosted CI must verify the approved pushed source before publishing. Legal pages are drafts; personal operator data is kept in ignored private website build configuration. Generated legal HTML and the local website ZIP are private until explicit publication approval.
