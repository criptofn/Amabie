# Local release closure — 23 October 2026

The local merge candidate has passed its required corrected-code Windows suite and installed-package rehearsals. This is not public release approval or completion of the full Amabie vision. Public release status: **BLOCKED** pending hosted CI on the actual candidate and separately owned account/publication steps.

## Corrected code

Executable source commit: `ea3681322923f27907d18a9b7ffb3dcc76d1e9fb` (parent `8506d75491f704c277bffff6713e36895f56ec6d`). Only `packages/support/src/index.ts` and its lifecycle tests changed. The documentation commit containing this record does not change executable code or package inputs.

The Windows sweep previously abandoned late-visible descendants and could lose ancestry after an already observed parent vanished. Two new tests failed on the original code. Cleanup now retains observed ancestry, excludes visibly reused ancestor identities, and gives newly visible descendants a kill-and-confirm opportunity on the same selected host. A maximum of ten cleanup passes bounds execution; persistent survivors, uncertain identity, caps, and host errors still fail closed. Each identity is attempted at most once. No cross-host retry after a kill-capable execution was added.

No assertion was weakened, full-suite concurrency remains eight, and no timeout was raised. These two demonstrated gaps are fixed; this does not establish the original cause of every historical child-process incident or provide OS isolation.

## Executed results

| Check | Actual result and conditions |
| --- | --- |
| Focused Windows lifecycle | 24 passed, 0 failed, 0 skipped; includes real child cleanup, late visibility, disappearing ancestry, PID reuse and finite-budget regressions |
| Full Windows `npm test` | 1,629 tests: 1,622 passed, 0 failed, 7 skipped, 0 cancelled; 229 suites; 721,110 ms reporter duration; Node 26.7.0, concurrency 8, actual Windows Python/Go toolchains, no diagnostic preload or PowerShell Core override |
| npm artifact reproducibility | Three byte-identical builds, including an unrelated caller directory; 291,919 bytes |
| Fresh Windows package rehearsal | PASS: offline private-prefix install, version/help, authorized setup, meaningful change, regression despite success claim, forged saved success, repair, NOT PROVEN for false green, corrupt configuration, evidence hashes/logs, and installed MCP handshake/live doctor relay |
| Fresh Linux package rehearsal | PASS on Ubuntu 24.04 / WSL2, Node 22.23.4: same final Windows-produced tarball, same rehearsal assertions; no source-checkout CLI fallback |
| Linux lifecycle and Python alias tests | 26 tests: 17 passed, 0 failed, 9 Windows-specific skips |
| Linux POSIX containment tests | 17 tests: 16 passed, 0 failed, 1 native-Windows-shape skip; includes the retained-201-helper and no-controlling-terminal cases |
| Retained standalone example | PASS: fresh private installation and authorized `setup --yes`, real regression, false claim, forged record and repair; synthetic hook configuration, zero live agent calls, no global npm replacement |

The seven Windows skips are five POSIX harness cases, one Linux 201-helper case and the Python3-only alias case. Each actually passes in the targeted Linux runs above. The Linux runs retain their own Windows-specific skips; none are counted as passes. This is targeted cross-platform validation, not a newly executed full Linux suite.

Final local artifact: `amabie-cli-2.0.0.tgz`, package `@amabie/cli@2.0.0`, executable `amabie`.

SHA-256: `717c36094d26eef49926995fef27f21055a161115e3df00e71de1e53bbf14b74`.

This supersedes the older `353fad4b…34fa7` and other historical hashes in the release notes. Those historical artifacts do not contain the correction.

## Evidence and remaining boundaries

Local evidence directory, relative to the primary checkout: `_canary-data/release-logs/codex-sweep-fix-2026-10-23/`. It retains source identity, full raw unit logs, reproducibility records, the final tarball/checksum, installed-rehearsal JSON/logs, focused Linux logs, and the final artifact manifest. Prior results remain in `codex-closure-8506d75-2026-10-22/`.

The earlier 132-step productization ledger was 125 PASS / 6 SKIP / 1 FAIL on the parent source. M1–M13 and both mutation batteries actually completed there; the failed full-unit gate is superseded by the corrected-code full run above. The entire 132-step battery was not re-run or relabelled as exact-current-source evidence. Six prior gate skips remain explicit: live Codex, cost-gated Claude after-tool, Windows Rust linker, two real Windows PTY measurements, and the cost-gated token ledger.

Earlier full Linux raw logs were lost from temporary storage. The new retained Linux installed-package and targeted results above replace only their stated scope; they do not recreate a historical full-suite proof. Hosted CI and native macOS remain unverified on the corrected source. npm authentication/publication have not been repeated in this closure. Live Codex/Claude acceptance is historical; no paid calls were made.

LOCAL remains user-space execution with same-user and lineage race limitations, not a general HARDENED boundary. Persistent or uncertain cleanup remains a refusal. The historical hosted process incident remains unexplained. Website/deployment work (T34), legal approval, and operator acceptance of the combined pillars are separate; no push, tag, publication, DNS change, or deployment is authorized by this record.
