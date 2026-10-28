# Joint quality validation — 23 October 2026

**Public release: BLOCKED.** This records a tested local improvement, not completion of Universal Agent Assurance, promotion of experimental features to stable, or publication approval.

Codex and the existing Claude Code session coordinated separate worktrees, exchanged reviews and retained the conversation locally. Claude supplied the extraction corpus/fix; Codex supplied opt-in diagnostics and the Candidate warning correction. Claude identified an invalid-UTF-8 retention defect; Codex reproduced and fixed it, and Claude approved the correction read-only. No reviewer built or mutated the other worker's checkout.

## Changes

- The deterministic splitter agrees with 16 of 18 hand-written corpus cases, up from 9. Seven concrete gaps are corrected; elliptical clauses and non-English prompts remain explicit gaps. Candidates still start unclear, with no criteria and NOT PROVEN. This is not a reliability rate or semantic-completeness proof; see [the corpus record](../P2E-EXTRACTION-CORPUS.md).
- `--retain-agent-output` explicitly opts into persistent LOCAL diagnostic bundles. Original process bytes, hashes and failure metadata are retained without exporting raw text in normal JSON or using claims as proof. Linked storage is refused and requested retention failures stop the loop. Default behavior does not retain raw agent text; see [privacy and retention limits](../P2E-AGENT-DIAGNOSTICS.md).
- Invalid UTF-8 is retained before decoding: 400,000 bytes of `0xff` no longer falsely exceed the unchanged 1 MiB process limit after replacement-character expansion. Unit, CLI and freshly installed bundle checks verify byte identity and the true process failure reason.
- The warning now correctly explains that Git-visible working-tree changes seed a disposable candidate; ignored files are excluded and no result is automatically adopted. This remains separate from an OS isolation boundary.

## Identified results

Executable source: `8790ee2297b7d6295baeba223fd35be052db588f`; executable correction `321c8b7`, diagnostics `c07ebeb`, imported corpus/fix `287529e` / `c38efd7`. The commit containing this document changes documentation only.

| Executed check | Actual result |
| --- | --- |
| Final Windows full suite | **1,674 tests: 1,667 PASS, 0 FAIL, 7 SKIP, 0 cancelled**, 229 suites, 735,066 ms; original concurrency 8, real Python/Go, no diagnostic preload or Core override |
| Earlier integrated full suite, before byte fix | 1,672 tests: 1,665 PASS, 0 FAIL, 7 SKIP; retained as historical evidence, not the final byte-fix validation |
| Package reproducibility | Three byte-identical builds, including unrelated caller directory; **293,334 bytes** |
| Windows and Linux fresh offline package rehearsals | Both PASS: version/help/setup, meaningful change, actual regression despite false claim, forged saved success, repair, false green/NOT PROVEN, corrupt config, evidence digests/logs and installed MCP handshake/live doctor relay |
| Installed diagnostic option | Both Windows and Linux PASS; original invalid bytes retained, raw text absent from JSON, actual failure preserved, missing proof stays NOT PROVEN; synthetic executor, zero live-provider test calls |
| Targeted Linux tests | **85 tests: 75 PASS, 0 FAIL, 10 Windows-specific SKIP**, including corpus, diagnostics, lifecycle, Python alias and POSIX containment |
| Stable-scope consistency | 9/9: experimental commands remain labelled as such |
| Current System PowerShell 5.1 read-only query | 3/3 successful snapshots with own-process positive control; historical crash cause remains unexplained |

The seven Windows case skips are exercised on Linux. The ten Linux skips are Windows-specific and remain skips there, covered by the Windows run. No new full Linux suite, native macOS run or live frontier-agent acceptance was performed.

Final local npm artifact `amabie-cli-2.0.0.tgz`, `@amabie/cli@2.0.0`, SHA-256:

`158ec849d13f664e2f6de70de2f0ca9ecc7e99d8e20564dd3ea4510d0ffb2916`

This supersedes the earlier same-day `717c3609…` artifact, which did not contain this joint improvement. Raw logs, exact source/tree IDs, reproduction records, artifact and checksum are retained under `_canary-data/release-logs/joint-quality-2026-10-23/` in the primary checkout. Review messages and RED/guard-mutation records are private local coordination evidence, not published product claims.

## Still required

- Hosted CI must test the actual approved pushed candidate; PR #10 still points at the old October 13 source. Native macOS remains unvalidated. No public push is authorized by this record.
- npm CLI authentication currently returns ENEEDAUTH. Account actions and publication need the operator; no credential was modified.
- The earlier 132-step productization ledger remains historical (125 PASS / 6 SKIP / 1 FAIL). Its old unit failure is superseded by the current full unit gate; the whole 132-step battery was not relabelled as a fresh run. Live Codex, cost-gated Claude after-tool, Windows Rust linker, two actual Windows PTY measurements and cost-gated token ledger remain explicit prior gate skips.
- A fresh held-out multi-requirement correction acceptance with both real providers remains unexecuted. Historical controlled successes are not a reliability rate. No additional paid acceptance calls were made.
- D03 must remain a stopped-run incident independently of outcome success. An ordinary process adapter/Candidate is not an enforced gateway or sandbox. A combined acceptance must distinguish these paths and use fresh independent evidence.
- Human acceptance, separately owned website/T34 work and publication/legal approvals remain separate. Neither an AI review nor these tests simulate `amabie accept`.

Both product pillars and the [North Star](../NORTH_STAR.md) remain intact. This increment improves their testability and requirement intake; it does not establish the full product vision.
