# Experimental Prompt-to-Evidence Integration Status

Date: 2026-10-18

This branch is a local experimental integration of the committed Prompt-to-Evidence baseline and the committed Amabie 2.0 candidate. It is not a stable release branch.

## Source and scope

- Prompt-to-Evidence source: `codex/prompt-to-evidence-v1` at `30ca264`.
- Amabie 2.0 candidate source: `codex/amabie-2-0-release` at `0980555`.
- Integration branch: `codex/p2e-amabie-integration`.
- The source P2E worktree has uncommitted and untracked changes. They remain there and are deliberately not included in this merge. This integration therefore covers the committed snapshot only.
- The authorization-first research work is in a separate Git repository at `Documents/ChatGPT/Canary/research/authorization-first`, commit `8d0ecd4`; its history is unrelated and was not copied into the product repository. Its recorded V4 pilot had 0/24 valid plans, so it is not a product integration.
- Stable branch `codex/amabie-2-0-release` and all source worktrees remain unchanged.

The only committed merge conflicts were `AGENTS.md` and `docs/NORTH_STAR.md`. Resolution retains the P2E versions, whose Phase 3 acceptance gate explicitly requires real workflows in two different task domains with independent evidence and bounded correction. Release follow-up documentation and the lifecycle fix/tests from the 2.0 candidate are included.

## Validation

- `npm ci`: passed; 20 packages installed, 36 audited, zero reported vulnerabilities. npm warned that the `esbuild` install script was not approved by the current npm policy.
- `npm run build:force`: passed.
- Prompt-to-Evidence core tests: 20 passed, 0 failed, 0 skipped.
- Combined targeted CLI/P2E/lifecycle tests: 39 total, 26 passed, 13 failed, 0 skipped. The 13 failures were in CLI/lifecycle cases that invoke Windows PowerShell 5.1 process enumeration. A direct `Get-CimInstance Win32_OperatingSystem` query under that host exited `-1073741819` (`0xC0000005`); the same query under installed PowerShell Core succeeded. No assertion was changed or suppressed. This is an observed host/runtime limitation; the affected Windows integration checks remain unverified here.
- The full `npm test` suite and `npm run verify:productization` were not run on this integration branch.

## Release boundary

Do not treat this experimental merge as a release candidate or merge it into Stable 2.0 without resolving or independently validating the Windows process-sweep test environment and running the required release gates. Nothing was pushed, published, or deployed.
