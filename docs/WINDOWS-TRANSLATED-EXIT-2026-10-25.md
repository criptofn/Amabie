# Windows process adapters that translate exit into error

Exact Hosted run40177622090 on `e4fa98d` finished with Windows1,650PASS/1FAIL/
8SKIP (1,659total) and Linux1,631PASS/0FAIL/26SKIP (1,657total). Axios passed
37 proof assertions; native standalone build/execute jobs passed on all three OS.
These are executed results, not release approval.

The sole failure was the existing Prompt-to-Evidence CLI test for an unavailable
correction agent. On Windows, cross-spawn actually launches its command host,
then translates that host's native exit1 into an ENOENT error before ordinary
exit listeners see it. Amabie's listener-only cleanup therefore missed the
original process lifetime and refused cleanup. The deterministic blocked result
remained safe, but the reported setup failure was wrong.

The shared early observer now intercepts the public exit emission before that
adapter translation, measures cleanup while the original native handle is still
held, restores the adapter's emission function and delegates unchanged. It uses
no private Node fields, late numeric-root lookup, process-name exemption or retry.
Unknown cleanup still takes precedence and blocks verification. Original error,
exit, output, authorization and no-reverification assertions remain intact.

A new real cross-spawn missing-command regression first failed because cleanup
was absent at the error callback. After correction it and the original failed
CLI test pass2/2. Eight complete affected files subsequently pass Windows94/94
and Linux72PASS/0FAIL/22explicit Windows-onlySKIP; frozen source hashes match.
The new native Windows adapter test is skipped explicitly on Linux, not passed.
Evidence: `translated-exit-targets-2026-10-25` and
`native-lifetime-e4fa98d-hosted-2026-10-25` under the private release-log root.

The new corrected source still requires a full exact-head Hosted gate and a
current reproduced/clean-installed package. Prior CLR/V8 native failures remain
recorded; their absence in the e4fa98d retained trace does not establish a cause
or guarantee a cure. Process cleanup remains LOCAL. **NOT READY**.
