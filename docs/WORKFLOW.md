# Prove the requested change

## Recommended: reviewed red test, then implementation

The human defines the behaviour before the agent changes production code.
Add the test to a suite your declared test command actually executes. Run that
command and observe the expected failing assertion. Commit the reviewed test.
Run `amabie setup --yes` from a human terminal before opening the agent request.
A failing baseline test is useful here: it is the obligation the implementation
must satisfy, not permission to alter the oracle.

Setup can report `NEEDS ATTENTION` for this deliberately failing test. That is
expected: the plan and starting state are installed, while completion remains
blocked until the implementation makes the check pass.

Give the agent the request and its exact acceptance criteria. Its task
registration preserves those criteria; it cannot bind or approve them. On
completion Amabie executes the sealed checks and compares with the baseline.
Any separately declared requirement still needs its sealed proof binding;
one green test does not establish every sentence of a specification.

## When the agent writes the regression test

Keep existing checks intact and add a **new test file**, picked up by the sealed
test command. Amabie overlays it on the starting implementation and requires a
failure there and a pass on the candidate. A successful result carries the
worker-authored-evidence caveat: discrimination is measured, independent
requirement coverage is not established by authorship alone.

Editing an existing test file, including appending an honest assertion, is
treated more strictly and can remain `NOT PROVEN`. Do not reseal to hide that
origin. Have the operator review and bind the intended check, or use the
reviewed-red-test path for the next task. Native and shell changes to Amabie
state or hooks are operator actions during a Claude session.

## Refactors and other changes with unchanged behaviour

An equivalent refactor may pass on both sides. It can remain `NOT PROVEN`:
regression discrimination is not a general proof of maintainability. Ask for
the specific property the change should improve, or leave it for human review.
Do not invent a failing behaviour test or label missing evidence as a pass.

## MCP approval pending

Approve the server in Claude's `/mcp` menu, or use the CLI command supplied by
the request hook: `amabie task "<intent>" --requirement "<criterion>" --session <id>`.
Repeat `--requirement` once per stated criterion; omit it if none were stated.
The command must stand alone. A new request resets registration. The CLI path
does not grant evidence authority or authorize other shell commands.

## Operator review

Run setup, bind, accept or uninstall from a human terminal. If a Claude request
is still open, close it first or confirm the administrative operation at the
terminal prompt. `--yes` cannot replace that confirmation. Acceptance does not
turn an unmeasured objective requirement into independently proven evidence.

LOCAL guards cover recognized tool calls and direct targets. Arbitrary scripts,
aliases and same-user access remain outside an OS security boundary. See the
[security contract](../SECURITY.md).
