# Windows observer reuses the subject PID

## Current correction — local validation, full gates pending

The later local correction retains the original root's native process object
through cleanup: asynchronous callers sweep inside the public exit callback;
synchronous project checks use a source-owned Worker held in that callback until
the parent finishes cleanup. A plain numeric Windows root without that lifetime
scope is refused before an OS query. The Worker preserves argv, sanitized target
environment, original output/status, timeout and buffer errors; project processes
receive no control channel. A real ESM-bundled execution is tested.

The sweep now reads the retained root's native creation time instead of guessing
with a two-second timestamp allowance. Each accepted descendant is opened, matched
to the CIM microsecond identity and checked against its pinned parent's exact
native birth. Accepted handles remain open until the entire sweep finishes;
termination uses that handle, never another numeric PID lookup. Missing identity
access fails closed. All original snapshot, pass, descendant and timeout caps
remain. Synthetic CIM tests replace exactly one immutable native-bootstrap block;
there is no production test switch. Real-process controls execute the native code.

Four complete affected Windows files currently pass **43 tests, zero failures,
zero skips** (`native-pinned-third.log`). They include real descendant cleanup,
an untouched unrelated process, actual native rejection of changed creation and
sub-microsecond older-parent ordering, original dead-root retention, both command
execution paths and the ESM Worker bundle. Earlier controlled cases each requested
one wrong mocked termination; the new old-orphan and changed-owner controls each
request zero. An inaccessible identity reports uncertainty rather than clean.
Initial fixture failures are retained separately, not counted as product passes.

This is still LOCAL process cleanup. CIM discovery has microsecond precision;
unobserved ancestry and catastrophic supervisor/host loss are not claimed to be
contained by a kernel boundary. Root lifetime relies on the measured Node/libuv
Windows exit-callback contract (Node 22 and 26 probes); incompatible runtime or
unavailable native compilation/identity access must fail closed. Wider affected
Windows/Linux suites, exact-source full Hosted CI and a new final package remain
required. **NOT READY**. No native-crash cure or final release gate is claimed.

The sections below preserve the earlier observer-only correction and its results.

Subsequent affected validation retained two real Windows failures out of299
(297PASS/2FAIL/0SKIP): PowerShell CLR failure during Add-Type and a separate fatal
V8 assertion in the npm tree observer. Full native PowerShell stderr was lost
after three summary lines; opt-in structured diagnostics now retain16,384
characters with original length/truncation metadata and JSON escaping. A real
target plus controlled failed-host regression first failed for missing retained
stack, then passed; original exit/output/refusal and one-sweep-only assertions
remain. Updated complete focused files pass Windows44/44 and Linux23PASS/21
platformSKIP. The initial broader Linux run276PASS/1FAIL/20SKIP failed only the
new ESM bundle test because the shared Windows install lacked a Linux esbuild
binary; using the existing matching native0.28.2 binary passes that whole file
and the other three affected files. The earlier failed run remains recorded.

Call-site review also found tooling probes still using plain numeric ownership.
They now supply their real live ChildProcess or attach the exit-held observer
before awaiting close. The existing recorded-probe test reproduced ECLEANUP
before that adaptation and passes after it, on both OS. Actual scale probes
pass on both OS; Windows stress12/12 (six idle/six CPU-loaded) and a single
diagnostic trace retain positive descendant termination. Cleanup of disposable
probe fixtures also checks their UUID ownership using the existing helper.
These passes do not supersede the two broader native failures or constitute a
new current full gate/package.

One subsequent diagnostic attempt of just the two failing provenance prerequisites
passes2/2, with unchanged source hashes and the new failed-host stderr retention.
This is a reduced workload, not the original nineteen-file execution. The prior
CLR/V8 failures remain evidence and are not reclassified as passes. No unchanged
full CI is retried; the next full gate must identify the meaningful corrected
source that includes lifetime ownership, native handles and probe integration.

The exact Hosted run `40168699922` on `0390b5f` failed two Windows tests: 1,633 passed, two failed, eight skipped. Linux passed 1,624 with 17 skipped; the Axios proof and three standalone jobs passed. The MCP fixture's setup reported a project process exit3221225794 while its containment preflight and sweep both returned0. A separate protocol test's doctor invocation returned2 without retaining the nested output. The preceding failed cases passed this time; that is not proof their native causes are solved.

## Independently confirmed identity defect

A retained trace from that same run records subject root PID9144 and sweep-host PID9144. The observer's creation time is later than the subject's spawn. The observer then requested termination of conhost PID1852, whose parent is that reused PID and whose creation is after the observer's creation. The root's numeric PID had been reused by the observer itself; those new children were not descendants of the original subject. This trace occurs in another test and does not establish causality for the two reported failures.

A controlled regression executes the actual generated PowerShell script with the root bound to the disposable observer's actual PID. Process enumeration and termination are mocked, so it cannot kill an unrelated process. Before correction, the script requested one unauthorized mocked termination and reported a clean sweep: zero passed/one failed. After correction, it refuses before traversal or any kill request, the test observes zero requested kills, and the observation cannot certify zero survivors: one passed/zero failed.

The narrow correction checks process identity (`root PID == current observer PID`), not a process name. It fails closed on this proven ambiguity. It does not exempt a subject process named PowerShell or conhost, retry a sweep, loosen timeouts or change the deterministic classifier. This may expose additional refused runs rather than silently certifying an ambiguous tree.

This guard is not a general proof against arbitrary root-PID recycling. A separate controlled synthetic-table probe, using a later unrelated root owner that is not the observer, still requests one wrong mocked kill and reports a clean sweep after this guard. That is an unresolved release blocker, not merely untested coverage. It does not force actual OS PID reuse and never terminates a real unrelated process. The existing root PID plus spawn-time lower bound does not pin a Windows process object for its entire lifetime. Holding an original process handle or using an independently owned supervisor requires separate implementation and evidence. No atomic identity guarantee, native-crash cure or HARDENED isolation is claimed.

## Diagnostic retention

The protocol test's existing CLI helper now uses the same opt-in failed-invocation recorder already used by other suites. It returns the unchanged original spawn result and preserves stdout/stderr, PID, status, signal, error and elapsed time on failure. Assertions and commands are unchanged. Before the observer-root correction, the complete MCP/protocol files passed29/29 on both Windows and Linux, zero skipped; that focused result does not validate a native failure's cause.

The complete five affected lifecycle/MCP/protocol files passed on the observer guard: Windows64 passed/zero failed/zero skipped; Linux51 passed/zero failed/13 skipped (64 total). Twelve skips are existing Windows-specific cases and one is the new native Windows script regression; unsupported-host skips are never passes. Source hashes matched before and after execution, original concurrency8. Evidence directories: `root-observer-identity-targets-2026-10-25`, and `plan-halt-0390b5f-hosted-2026-10-25` for both controlled identity probes. The separate general-root probe remains FAIL despite those passing suites. Release remains NOT READY; corrected full Hosted validation and a current final package are not claimed.
