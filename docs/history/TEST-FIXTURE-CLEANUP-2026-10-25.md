# Owned test fixture cleanup

The lifecycle tests previously retained numeric process identifiers and issued cleanup kills after the checks had already confirmed those processes stopped. Under PID reuse, a later process could be selected. This cleanup is separate from the instrumented production descendant sweep; missing overlapping sweep kills cannot rule it out.

A controlled regression demonstrates the unsafe primitive: numeric `killTree` cleanup terminated a disposable process carrying another test owner's token. The initial result was one pass/one failure. This safely models a stale numeric lookup resolving to another owner; it does **not** force actual OS PID reuse or prove the cause of historical Hosted failures.

Test cleanup now requires the expected Node executable and a random per-file fixture ownership token. Windows opens and retains a `Process` handle, compares its creation time with the CIM record and terminates through that retained handle only after the ownership checks. The [.NET implementation](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Windows.cs) reuses an already opened handle in `Kill`; it does not reopen the numeric identifier. Missing or failed inspection is not permission to kill. A completed everyday descendant is removed from deferred cleanup.

The new tests positively observe both outcomes: another owner remains alive, and an owned fixture is actually terminated. The original lifecycle assertions about descendants being absent, unrelated controls remaining alive, bounded cleanup and fail-closed results remain unchanged. No production process selection, timeout, classifier or fallback policy changes.

Executed full affected lifecycle/helper/timeout files at concurrency8:

| Environment | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Windows, Node22.23.4 / PowerShell7.6.7 | 35 | 0 | 0 |
| Linux, WSL Ubuntu24.04 / Node22 | 23 | 0 | 12 |

All twelve Linux skips are existing Windows-specific lifecycle measurements. They are not passes. Raw logs/source hashes are retained separately in `release-logs/owned-cleanup-targets-2026-10-25`; the initial red control is preserved in `probe-diagnostics-aa9fa92-2026-10-25/owned-cleanup-red.log`. Build passed. This is focused test-harness evidence, not a new passing full repository gate.

Limits: POSIX cleanup checks executable and exact ownership argument before its existing best-effort signal, without an atomic pidfd guarantee; macOS's `ps` fallback is unverified here. Fixture tokens are test ownership markers, not a product security boundary. The native PowerShell ConsoleHost0xE9 incident and project checks exiting4294967295 remain unexplained. No corrected final package, full current-source CI pass, HARDENED capability or public release is claimed.
