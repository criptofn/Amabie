# Pipeline containment correction — 25 October 2026

Release status remains **NOT READY** until the corrected source completes its required checks. This correction strengthens an existing fail-closed invariant; it adds no isolation capability or automatic retry.

## Finding

Source `c8c6043` completed [Hosted run 40085052603](https://github.com/criptofn/Amabie/actions/runs/40085052603) successfully: Windows 1,623 passed, zero failed, eight skipped; Linux 1,612 passed, zero failed, 17 skipped; all six jobs passed. Its retained Windows log nevertheless contains a real PowerShell sweep-host startup failure at 10:33:20.967Z–10:33:21.694Z, status `2148734499`, with ConsoleHost reporting Win32 `0xE9` while obtaining its active output-buffer handle. No script-start trace or exact cross-host kill match was retained. Green CI does not prove this intermittent native failure absent or fixed.

Code inspection and a failing regression exposed a separate definite propagation gap: `Recorder.step` returned a successful child exit even when its independent `sweepFailed` measurement was true. Pipeline preparation, toolchain, build and swap callers inspected the exit code alone. Direct dependency-tree, dependency-attestation and npm-version commands likewise did not enforce that flag. Measurement rounds already carry it into the deterministic infrastructure-failure classification.

## Correction and compatibility

Non-round recorder steps retain their raw/normalized logs, then throw the existing `AmabieError` with a specific containment reason. The pipeline translates that failure into its existing `InfraAbort` contract. Direct command helpers pass through the same explicit containment guard. No later stage may execute and no strong result may be returned after that failure.

Measurement rounds retain their original `sweepFailed` evidence and classifier semantics. Original exit codes, sweep process selection, kill identity rules, budgets, observation contracts and classification rules are unchanged. No fallback after a kill-capable execution, process-name exemption or retry was added.

`PipelineDeps.run` is an optional in-process test dependency, mirroring the existing recorder seam. It is never taken from a spec, environment, CLI argument or agent claim; ordinary production callers continue to use the original sanitized `runCommand`.

## Verification

The new recorder regression was observed RED before the correction: a zero-exit outcome with `sweepFailed:true` did not reject. After correction it rejects and retains both output logs; the existing round-level infrastructure-failure control also passes.

Seven integration cases execute real commands in local throwaway projects, then inject only the independent failed cleanup measurement at prepare, toolchain, build, swap, dependency tree, attestation or npm-version. Each requires the existing `InfraAbort`, confirmed injection into the named stage, and zero subsequent commands. No fabricated successful execution or agent claim substitutes for evidence.

The first complete affected component run was Windows81 PASS/1 FAIL and Linux81 PASS/1 FAIL, zero skips: the new attestation fixture searched for `require.resolve`, whereas the actual program uses `r.resolve`. The unchanged abort/injection/no-later-command assertions exposed this test-selector defect. The selector was corrected to identify the real program, and the infrastructure exception assertion was strengthened. Original failed logs remain retained under `release-logs/preparation-containment-2026-10-25`; they are not relabelled as passes.

The corrected complete affected executor and pipeline suites then passed on BOTH Windows and Linux: **82 passed, zero failed, zero skipped** on each platform. All seven named real-command fault-injection cases passed, along with ordinary real regression, unconfined-drift and artifact-tampering controls. Source hashes, actual outcomes and raw logs are retained separately under `release-logs/preparation-containment-final-2026-10-25`. This is focused component evidence, not a new complete repository suite. Exact-source Hosted validation and a corrected package remain pending.

The previous `c8c6043` 295,350-byte package, SHA256 `8e6b4623dccde3380b7a362f845d9bd24cbb47343eec072bdc306ef39db63038`, passed three identical builds and fresh Windows/Linux installed-package checks, including a separate default-host Windows rehearsal. That artifact does not contain this correction and remains a comparison artifact, not the corrected release package.

The native PowerShell startup root cause, incomplete nested diagnostic retention, separate bind edge findings and opt-in experimental acceptance gaps remain explicit. This correction prevents the demonstrated containment failure from being ignored; it does not claim an independent security audit, HARDENED execution or completed Universal Agent Assurance.

## Subsequent exact-source Hosted result

Corrected source `69677f4` completed [run40143343944](https://github.com/criptofn/Amabie/actions/runs/40143343944) with five successful jobs and a failed Windows core job: Windows1,627 passed/four failed/eight skipped (1,639 total); Linux1,620 passed/zero failed/17 skipped (1,637 total). The four Windows failures occurred during existing CLI setup calls in fastpath JSON-envelope, authority-drift loop, dash-leading requirement and final bench-binding guidance cases. They returned2 where0 was required. The new containment cases were not the failures. Status-only assertions discarded the relevant nested output, so neither another native crash nor a regression from the guard is established by those messages.

The three affected test wrappers now retain the original failed child result, PID/signal/error/start/end/duration and complete stdout/stderr under the existing diagnostic flag. The wrapper returns the original result unchanged; arguments, timeouts, assertions and runtime code are unchanged. All four original cases pass in focused Windows and Linux runs, zero skips; three expected negative-control invocations on each platform also confirm the diagnostic records are actually emitted. This is not a reproduced fix for the Hosted setup failures. The next exact-source Hosted measurement must supply their missing failure context if they recur. No unchanged rerun or corrected-source package is claimed passed.
