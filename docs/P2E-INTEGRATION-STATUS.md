# Prompt-to-Evidence integration status

This document records the local integration of the experimental Prompt-to-Evidence work with the Amabie 2.0 stable-candidate changes. It is an integration record, not a release-readiness approval.

## Integration snapshot

- Branch: `codex/p2e-amabie-integration`
- Worktree: `_canary-data/worktrees/amabie-p2e-integrated-2026-10-18`
- Starting merge commit: `5d89f823a2e33da82cec04d3e08c06c510b63453`
- Included committed bases: Prompt-to-Evidence `30ca264` and Amabie 2.0 candidate `0980555`.
- Also integrated the current uncommitted snapshots from the Prompt-to-Evidence and stable-candidate worktrees. Those source worktrees remain intact and were not reset or edited by this integration.
- The independently researched shared-assurance contract from `68c5709` was copied selectively, with its import updated for this tree. The adapter test is mock-only; it does not claim a second production task domain.
- This branch has not been pushed, published, or deployed.

## Conflict decisions

- Adopted the newer stable-candidate native-provider policy that does not retry side-effectful native PowerShell operations after a process crash.
- Kept the stable-candidate trusted PowerShell host selection and exact broker reflection/ACL changes.
- Preserved Prompt-to-Evidence's bounded `Wait-Process -Timeout 2` sweep wait and lifecycle assertion while taking the stable-candidate process-sweep implementation.
- Kept the narrower `AccessControlSections.Access` update for the confined launcher.
- Removed the Prompt-to-Evidence-only native-runner fallback test from this integrated tree because the selected no-retry provider policy makes that fallback obsolete. The original test remains in its source worktree.
- Merged the release checklist with the experimental Prompt-to-Evidence recheck addendum. Stable 2.0 remains marked BLOCKED for its outstanding hosted CI, default-Windows-host, registry-authentication, and live-provider acceptance gates.

## Validation on this integrated snapshot

- `npm run clean`: passed.
- `npm run build:force`: passed.
- Focused combined Node test run after the stable-candidate overlay: **126 tests, 126 passed, 0 failed, 0 skipped**, 320,979 ms. It covered requirement extraction and evidence evaluation, correction limits, local Codex/Claude process shims, manipulation and failure cases, Windows broker/host and process-sweep behavior, plus the shared-assurance mock adapter.
- The Codex and Claude cases used local executable shims. No live provider sessions or API requests were made.
- The full product suite, productization gates, final package cleanroom, hosted CI, and final live-provider correction acceptance were not rerun on this combined snapshot. Historical results in `docs/RELEASE-CHECKLIST.md` remain historical and do not clear those gates.
- The shared-assurance non-coding verifier is an architecture compatibility test only. Universal Agent Assurance is not implemented or claimed as complete.

## Release and scope status

Prompt-to-Evidence remains experimental and separate from the stable Amabie 2.0 candidate. Requirements without independent evidence remain unresolved; agent completion claims do not establish PASS. The integrated branch is ready for code review and further local validation, but **Amabie 2.0 is not declared release-ready by this integration**.

## Second domain: CSV report (T32)

A second, non-coding task domain now runs through the same, unchanged task-neutral core (`@amabie/prompt-evidence`) and the same domain-neutral double gate (`apps/cli/src/double-gate.ts`).

- **Task:** the agent turns a pinned `sales.csv` into `out/summary.csv` (per-region totals) and `out/report.md` (`Grand total`, `Top region`).
- **Independent evidence:** `apps/cli/src/report-evidence.ts` recomputes the totals in exact cents from the sha256-pinned source and reads the delivered files itself. The agent's text is never evidence; a changed source or an oversized/unsafe artifact is BLOCKED.
- **Real executors:** `tooling/probes/v32-second-domain.mjs` (`AMABIE_T32_AGENT=claude|codex`) drives a real agent through the confined production gateway. Measured on this snapshot, for both Claude and Codex: natural delivery PASS with 0 corrections; a seeded omission plus false claim repaired through the unchanged bounded loop; an attempt to overwrite the source stopped by the gateway before its effect (D03), so the outcome is NOT_ELIGIBLE even with a PASS report. 4 passed, 0 failed per agent.
- **Offline test:** `apps/cli/test/report-evidence.test.ts` (positive, negative, BLOCKED, scripted loop, double gate).

Limits, stated plainly: this is **one** second domain, evidence level LOCAL, on the Windows AppContainer reference environment, with a single task shape. Further long-term domains, other platforms and hostile-agent isolation (the broker is a local authorization kernel, not a sandbox) remain open. This is the evidence for the Phase 3 gate as far as it goes; it is not a claim of general Universal Agent Assurance.
