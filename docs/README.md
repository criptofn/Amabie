# Amabie documentation

Current documents only. Dated logs, audits and per-release reports are in [`history/`](history/README.md): they record what was true when they were written and are not current status.

## Use it

| Document | Read it for |
|---|---|
| [`../QUICKSTART.md`](../QUICKSTART.md) | The first run, end to end. |
| [`WORKFLOW.md`](WORKFLOW.md) | Reviewed red test first, agent-written tests, refactoring. |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | Every message that stops you, what caused it, what to do. |
| [`COMPATIBILITY.md`](COMPATIBILITY.md) | What was run on which host, and what is only implemented. |
| [`SPEC-FORMAT.md`](SPEC-FORMAT.md) | The `spec.json` contract. |

## Understand it

| Document | Read it for |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the gate works, in one page. Start here. |
| [`SECURITY.md`](SECURITY.md) | The security contract, its tiers and its ceilings. |
| [`TRUST-ARCHITECTURE.md`](TRUST-ARCHITECTURE.md) | Where authority lives, what guards it, what is only a contract. |
| [`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md) | `LOCAL` and `HARDENED`, and how each is measured. |
| [`EXECUTION-AUTHORITY.md`](EXECUTION-AUTHORITY.md) | Which programs a sealed check may run. |
| [`AUTHORIZATION-1.0.md`](AUTHORIZATION-1.0.md) | What a completion authorizes. |
| [`TEST-COUNTING.md`](TEST-COUNTING.md) | How test numbers are counted; the only way to quote one. |

## Direction

| Document | Read it for |
|---|---|
| [`NORTH_STAR.md`](NORTH_STAR.md) | The long-term goal. Current priority is the verified coding gate; Phases 2 and 3 are deferred. |
| [`ADR-001-product-direction.md`](ADR-001-product-direction.md) | The decision that Amabie is an independent verification layer. |
| [`PLAN.md`](PLAN.md) | The original migration plan (historical; section 6 is the decision table the classifier implements). |

## Release

[`RELEASE-2.0.0.md`](RELEASE-2.0.0.md), [`RELEASE-2.0-PUBLIC-PACKAGE.md`](RELEASE-2.0-PUBLIC-PACKAGE.md), [`RELEASE-AUDIT.md`](RELEASE-AUDIT.md), [`RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md). The root [`CHANGELOG.md`](../CHANGELOG.md) is the version history.

## Experimental (not part of the stable interface)

[`PROMPT-TO-EVIDENCE.md`](PROMPT-TO-EVIDENCE.md), [`P2E-ACCEPTANCE-RUN-PROTOCOL.md`](P2E-ACCEPTANCE-RUN-PROTOCOL.md), [`P2E-AGENT-DIAGNOSTICS.md`](P2E-AGENT-DIAGNOSTICS.md), [`P2E-EXTRACTION-CORPUS.md`](P2E-EXTRACTION-CORPUS.md), [`P2E-INTEGRATION-STATUS.md`](P2E-INTEGRATION-STATUS.md), [`EXPERIMENTAL-SHARED-ASSURANCE.md`](EXPERIMENTAL-SHARED-ASSURANCE.md).

## Evidence records

[`night-evidence/`](night-evidence/README.md) holds saved raw records from the 2026-09 hardening runs. They are kept as written, and the paths inside them refer to the layout before the historical documents moved to `history/`.
