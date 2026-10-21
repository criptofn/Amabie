# Experimental Shared Assurance Contract

**Status: experiment only.** This module is not wired into the CLI, stable 2.0, or the Prompt-to-Evidence correction loop.

## Purpose

`tooling/experimental/shared-assurance.mjs` combines two separately supplied evidence legs under one task and candidate binding:

- the requested outcome, using the current `amabie-prompt-evidence-report/2` schema;
- execution authorization/audit evidence, including proposal, attempt, and effect coverage.

It evaluates each leg independently, preserves unauthorized selections and attempts as violations, checks event-state transitions, records policy currency, and marks promotion eligible only when outcome evidence passes, execution is compliant, adapter attestations are verified, and policy evidence is current.

## Trust boundary

The evaluator checks adapter-attestation shape and shared identity; it does **not** verify P1 seals or signatures, Tenuo warrants, gateway hash chains, or execution artifacts itself. `adapterVerification` is a trusted input and must only be produced inside a separately protected verifier boundary. The compatibility test feeds a real report from the current Prompt-to-Evidence core into the aggregator, but execution evidence, adapter attestations, and policy currency are mocked. There is no live execution adapter or end-to-end agent workflow. This module therefore does not establish production authorization enforcement or Universal Agent Assurance.

The prototype is adapted from the isolated authorization-first research commit `68c5709`. That research used a separate Git history; selected files were copied into this experimental tooling folder rather than merging unrelated histories. The failed V4 planner and vendored Tenuo runtime were not imported.

## Validation and next gate

The focused contract suite has 12 deterministic cases covering dual evidence legs, binding/schema failures, incomplete audit coverage, invalid transitions, unauthorized selected/attempted/executed actions, and stale policy. Passing these tests validates only the aggregator's mock contract. Before product use, Amabie still needs real adapters that verify each evidence artifact and its provenance, plus reproducible end-to-end workflows and bounded authorized correction tests.

## Real double gate (T28)

`apps/cli/src/double-gate.ts` is the first real adapter pair on top of this contract, and it does not import the aggregator: the outcome adapter recomputes the Prompt-to-Evidence verdict from the raw evidence and requires the report the trust store sealed for the exact mission, criteria revision, snapshot, candidate and policy revision; the execution adapter reads the hash-chained audit journal and the signed grants (a stopped run is a violation, a reviewed successor is compliant for the new run only). A delivered `VERIFIED` string or well-formed digest is never authority: `tooling/probes/v28-double-gate.mjs` shows this aggregator saying ELIGIBLE for a bare claim that the real gate refuses. Level LOCAL: signatures establish issuer and integrity, not freshness or human identity.
