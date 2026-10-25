# Native activation negative controls and fixture time

The local full suite on `6fac83e` produced 1,693 PASS, 5 FAIL and 7 SKIP
(1,705 tests; 1,366,199 ms). Although its outer task was killed, its retained
raw log contains a complete failing reporter. It must not be counted as a pass
or described as providing no results. Memory pressure is not a proven cause
of these five assertion failures.

All five late broker-negative cases returned `stale or future measurement`
before reaching their expected live-broker rejection. The suite restores one
signed native fixture before each case. Its measurement expires 15 minutes
after its recorded start; restoring its bytes does not renew that validity.
The complete run lasted nearly 23 minutes. The product refused activation.

A new native regression moves the test clock beyond that expiry and still
requires the specific foreign-toolchain rejection. It first fails 0/1 with the
same unexpected freshness reason. The negative-control helper now evaluates at
the original fixture's recorded finish time through the **existing** explicit
verification-clock parameter. It does not rewrite or renew the record. Every
original rejection assertion remains. Real signatures, custody, native
observations and live broker exchanges are still checked.

The positive activation and installed CLI checks retain the real default clock.
Original stale/future mutations remain, and an additional control requires a
signed record to be rejected at start plus 15 minutes plus one millisecond,
even while the real broker is live. No production code, age threshold, verdict,
startup budget, concurrency pin or skip condition changed.

On the reference Windows host, Node 22.23.4 and PowerShell 7.6.7 execute the
entire corrected native file: **63 PASS, 0 FAIL, 0 SKIP**, 266,362 ms. This includes
the original 61 controls and both new regressions. Raw RED, full-file GREEN and
the original failed full-suite log are retained under the private
`native-activation-clock-2026-10-25` release-log directory. That failed log's
SHA-256 is `5cbc115df6dfdbe1190c55662c516d75accca4033f3a31201f78eda15c115071`.

These results precede the local import of the separately tested bind correction.
The combined source still requires its exact validation and final packaged
rehearsal. The hosted Windows image explicitly cannot execute the confinement
fixture; its skip is not equivalent to this native reference-host result.
No universal HARDENED capability or release approval is claimed.
