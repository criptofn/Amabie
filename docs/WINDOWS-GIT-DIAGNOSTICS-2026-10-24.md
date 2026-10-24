# Windows Git failure diagnostic checkpoint — 24 October 2026

Release status remains **NOT READY**. The diagnostic change described here does not establish the cause of the intermittent Hosted Windows failure.

## Preserved failure

Exact source `9cd1cac190e4ff1d4c7b7859a928322092db0140`, [Hosted run 40066354789](https://github.com/criptofn/Amabie/actions/runs/40066354789): Windows reported 1,627 tests, 1,618 passed, one failed and eight skipped. The other five jobs succeeded. F4-A in `apps/cli/test/m10-obligations.test.ts` failed when candidate isolation returned exit 2 after an unsuccessful `git worktree add`; its task-authority verdict assertion was never reached. The output retained only `Preparing worktree (detached HEAD dd22bb1)`.

The existing formatter selected stderr instead of also retaining the spawn error, and `GitResult` discarded the actual child PID, signal and duration. The failed test's approximately 14.6-second duration is below the unchanged 120-second Git budget. Neither timeout nor external termination is established by the available trace. Unchanged Git-path source in the preceding binding delta does not exclude every indirect interaction.

## Diagnostic correction

- Preserve actual Git PID, signal, spawn error code, monotonic elapsed duration and wall-clock start/end in the internal result.
- On failed candidate creation, always print the outcome separately from both stderr and stdout, including the spawn error message even when stderr is populated.
- Observe target presence, registered worktree count/target membership and index-lock presence using two read-only Git queries, bounded to five seconds each. Query failures and unobservable filesystem state remain unknown rather than false success.
- Compare existing filesystem identities through native canonical paths. Missing/unresolvable identities remain unknown; query metadata distinguishes an unavailable executable from an invoked command that failed. Additional diagnostic exceptions cannot replace the original refusal. Preserve the beginning and end of both output streams.
- Do not retry, repair, prune, register a partial candidate or change the original exit-2 refusal. The original worktree-add budget, sweep rules, success path and verdict authority remain unchanged.

Three regression tests were observed failing before the production change: real successful/failed Git metadata, an actual missing-cwd spawn error, and an intentionally obstructed real `git worktree add`. The corrected focused run passed all three, with no skips. The obstruction test also requires no candidate registration, unchanged HEAD and an unchanged obstruction file. Its empty repository is explicitly initialized rather than relying on the absence of a parent repository.

The initial broader affected run passed 43 Candidate/Authority/Git tests plus eight binding regressions on Windows, and 42 plus eight on Linux, with no failures/skips. Source hashes and raw results are retained under `_canary-data/release-logs/git-diagnostics-targets-2026-10-24/`. These precede the final diagnostic-only review follow-up.

Independent read-only review prompted explicit unknown identity handling, separate query-error fields, diagnostic exception containment and a beginning/end output excerpt. The missing-identity expectation was observed RED before that follow-up. A fourth real-process test now leaves a partially created worktree using a checked-in post-checkout hook that exits exactly 1. It requires target presence and canonical registered membership, no Amabie registration, unchanged HEAD and unchanged hook bytes. The hook has explicitly pinned LF line endings. The final four tests passed on both Windows and Linux, zero failures/skips, with source hashes and raw logs under `_canary-data/release-logs/git-diagnostics-final-targets-2026-10-24/`.

Exact-source Hosted validation remains pending. No historical green run or older tarball is relabelled as containing this change.

## Existing candidate evidence and limits

The parent `9cd1cac` has a complete local Windows result of 1,680 passed, zero failed and seven skipped (1,687 total). Its 294,666-byte CLI package has SHA256 `b5cc8dcc8c947b97112e15afe1f278793b96851090d32b84fd3ef0e1b625ef3e`; three builds were byte-identical and fresh Windows/Linux package rehearsals passed. Selected M12/M13 mutations were both caught and compiled bytes restored exactly. These are parent-source results, not completed results for the new diagnostic source.

The nested-sweep hypothesis remains unverified: captured traces do not show an exact host-identity kill match, but nested captured stderr is incomplete. Process names alone cannot establish an unauthorized kill, and an expected conhost cleanup request is not evidence of the reported incident. No process-name exceptions or new retries were introduced. Prompt-to-Evidence and authorization experiments remain opt-in and LOCAL. No publication or main merge is part of this checkpoint.

Separate read-only review raised two fail-closed bind edge cases for reproduction: scoped/native-argv checks written to a manifest that does not declare them, and a bind that conflicts with a declaration on the other surface before reseal. Those cases are not claimed fixed or validated by this diagnostic change. A duplicate-name ambiguity question is also unverified; it is not reported as a demonstrated bypass.
