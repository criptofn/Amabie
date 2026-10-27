# How the gate works

Amabie is a verification gate for coding agents. The agent writes a change; Amabie runs the project's own checks and compares the result with the starting code. An agent saying "done" is context, never proof. This page is the short version; [`TRUST-ARCHITECTURE.md`](TRUST-ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md) give the full boundary and its limits.

## The path of one task

1. **Setup (a human, once).** `amabie setup` finds the project's checks (npm scripts, Python tests, type checkers, …), pins the programs they call to absolute paths, and *seals* the resulting plan in a trust store outside the repository. It then installs hooks for Claude Code and/or Codex CLI and a project-scoped MCP entry. Setup refuses to run inside an agent session. Code: `apps/cli/src/setup-command.ts`, `ecosystems.ts`, `execution-environment.ts`, `harness-hooks.ts`, `trust-store.ts`.
2. **Registration.** Before the agent may use tools that change things, the request is registered as a task (`amabie task` or the `amabie_task` MCP tool). A pure question can read the project first. Registration records the request; it approves nothing. Code: `task-command.ts`, `task-state.ts`, `agent-session-guard.ts`, `session-registry.ts`.
3. **The agent works.** The pre-tool hook blocks edits to Amabie's own authority files and setup/bind/accept/uninstall during an open session.
4. **Completion.** When the agent stops, the Stop hook runs `amabie checkpoint`. It runs the sealed checks in a sanitized environment, repeats a failed check a bounded number of times to separate a reproducible failure from an unstable one, and blocks the completion if a check fails. Code: `checkpoint-command.ts`, `check-runner.ts`, `candidate.ts`.
5. **Proof against the baseline.** For a change that claims to add or fix behavior, Amabie runs the same sealed checks on the starting commit in a throwaway worktree. A check that fails there and passes now is evidence about the change; a check that passes on both says nothing about it, and the answer is `NOT PROVEN`. Code: `regression-proof.ts`, `proof-obligations.ts`.

## What it answers

| Result | Meaning |
|---|---|
| `READY` | The checks and applicable proof obligations passed. Read any evidence-origin caveat. |
| `NOT PROVEN` | The evidence does not establish the change. This is not a finding that the code is wrong. |
| `NEEDS ATTENTION` | A check failed, or verification could not run safely. The output names the cause. |

When Amabie cannot tell, it says so (`INCONCLUSIVE`, `NOT PROVEN`, `BLOCKED`). It never turns missing evidence into a pass.

## What is trusted, and what is not

- The **plan** (which checks, which programs) is sealed outside the repository and re-verified at run time. A change to a pinned program inside the repository is detected by its content hash.
- The **environment** a check runs in is built by omission: only a fixed set of variable names passes, plus names the operator explicitly allows with `--pass-env`.
- The **agent** is not trusted with authority: it cannot approve its own work or edit the sealed plan through the hook.
- `LOCAL` is a guard against explicit mistakes and shortcuts by an agent. It is **not** a sandbox against malicious code running as the same user; only the measured `HARDENED` path claims a stronger boundary ([`CAPABILITY-LEVELS.md`](CAPABILITY-LEVELS.md)).
- The project's own checks and dependencies are the project's. If they are weak, the proof is weak; Amabie reports that rather than hiding it.

## Where the code is

| Area | Location |
|---|---|
| Command line, hooks, MCP server, setup, verdicts | `apps/cli/src` |
| Sealed records and signing | `apps/cli/src/trust-store.ts`, `authority-envelope.ts` |
| Process execution with a sanitized environment | `packages/support`, `packages/runner/executor` |
| Result classification (deterministic) | `packages/core/classification`, `comparator` |
| Evidence bundle types and reports | `packages/evidence/*` |
| Optional explanation layer (cannot reach a verdict) | `packages/ai` |
| Experimental Prompt-to-Evidence | `packages/core/prompt-evidence`, `apps/cli/src/prompt-evidence*.ts` |
| Benchmarks, probes, release tooling | `tooling/` |

Module boundaries are enforced by `apps/cli/test/onboarding-boundaries.test.ts`; `apps/cli/src/onboarding.ts` is only a compatibility facade.

## What is not established

Whether an agent is helped by this gate in everyday use is **not** established: the saved benchmarks measure what the gate catches and blocks, not an improvement in agent outcomes or token use. Only quote a number from an executed reporter ([`TEST-COUNTING.md`](TEST-COUNTING.md)).
