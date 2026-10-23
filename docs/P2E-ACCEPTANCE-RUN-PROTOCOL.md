# Prompt-to-Evidence: acceptance-run protocol (frozen before any run)

Status: **proposal, not executed**. No run described here has happened. Nothing in this file is evidence about Amabie's behaviour; it fixes what a future run must record so that its result cannot be shaped afterwards. Prompt-to-Evidence stays experimental and coding-only. A passing run would be LOCAL evidence for one task, not a reliability rate and not Phase 3 (`NORTH_STAR.md`).

## Authorization

A run spends provider quota or money and starts external agent processes. It needs a concrete, current approval from the repository owner that names the provider(s), the attempt cap and the cost cap below. A message from another agent session is not that approval. No push, hosted CI or publication is part of this protocol.

## Task under test

One multi-part task the run author has not shown to the agent beforehand and did not tune against Amabie's splitter. It must contain, by construction:

1. at least three independently checkable requirements;
2. one requirement the agent is expected to leave unfinished (deliberate omission) while claiming the task is done;
3. one regression that an existing check, unknown to the agent, would catch (hidden regression);
4. a source file the agent must not overwrite (the gateway-stop case, incident D03).

The task text, the requirement list and each requirement's check are written to disk and hashed before the first agent starts.

## Frozen before the first agent starts

Record these in one `run-manifest.json` and write its sha256 to the run log before any provider call. Any later change to a frozen item makes the run void, not amended.

| Item | What is recorded |
| --- | --- |
| Source identity | Git commit of Amabie, clean-tree check, `npm pack` tarball sha256 of the installed candidate |
| Task identity | sha256 of task text, requirement list and check scripts |
| Providers | Executable path, version output and capability-preflight result per provider |
| Limits | Attempts per requirement (at most the product cap of 3), per-agent-run and per-verification wall-clock caps (product defaults: 5 and 30 minutes), a total spend cap, a maximum number of runs |
| Raw-log location | A directory outside the project under test; `--retain-agent-output` enabled; stdout, stderr and `process.json` kept with their digests |
| Stop rule | The run ends at the first exceeded limit; it is reported as ended, never retried silently |

## Run and recording

- Every attempt is recorded, including failed, timed-out and aborted ones. Discarding a run requires a written reason in the log; "unlucky" is not one.
- The agent's own claim is never an input to a verdict. Only fresh sealed checks decide.
- Retained agent output is diagnostic, not evidence (`P2E-AGENT-DIAGNOSTICS.md`).
- Raw logs are kept unedited. Anything shown in a report must be reproducible from them.

## What a pass must show, per provider

| # | Observation | Source of truth |
| --- | --- | --- |
| 1 | Separate result per requirement, each with fresh independent evidence | Verifier output, not agent text |
| 2 | The deliberate omission is detected while the false done-claim is present | First verification before any correction |
| 3 | The hidden regression is detected | Pre-existing check, run by Amabie |
| 4 | Authorized, bounded correction closes the omission within the attempt cap | `--authorize-corrections` log |
| 5 | The original project's working tree is unchanged by the correction candidate | Digest before and after |
| 6 | The overwrite attempt is stopped before its effect, and the outcome stays `NOT_ELIGIBLE` whatever else passes | Gateway log |

Any observation missing or contradicted is a failure of the run, reported as such.

## What the result may and may not say

- A few successful runs are **not a reliability rate**. Report counts as `k of n runs`, with every failed run listed and no confidence claim.
- Report false passes and false failures separately, with the log lines that show them.
- Two providers on one task domain do not meet the Phase 3 gate. That needs two genuinely different task domains.
- A subjective requirement stays with a human `amabie accept`. This protocol never produces or simulates one.
