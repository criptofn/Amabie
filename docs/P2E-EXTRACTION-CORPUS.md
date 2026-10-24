# Prompt-to-Evidence: requirement-extraction corpus

Status: **experimental**. Prompt-to-Evidence (`amabie prompt-evidence draft`, `amabie prompt-evidence loop`, `amabie doctor --prompt-evidence`) is coding-only, opt-in and separate from the stable Amabie 2.0 behaviour. This document records one measurement of its deterministic requirement splitter. It is not a release approval and not a reliability rate.

## What is measured

`draftPromptEvidence` splits a goal into candidate requirements without a model call. The corpus in `packages/core/prompt-evidence/test/extraction-corpus.ts` holds 18 hand-written goal sentences, each with the boundaries a careful human reader would draw. The expectations were written from the prompt alone, never from the splitter output.

Two kinds of assertion run for every case (`extraction-corpus.test.ts`):

- **Invariants, for every case:** the verdict is `NOT PROVEN`, source coverage is complete, every candidate is `unclear` with no criteria, and each source reference slices back to its text. A better or worse split therefore never produces a PASS.
- **Boundaries:** the split equals the expected one. A case marked `knownGap` is pinned the other way round: the test fails when the splitter starts to agree, so the marker has to be removed deliberately.

Re-measure with `node tooling/probes/extraction-corpus-measure.mjs` after `npm exec -- tsc -b packages/core/prompt-evidence --force`.

## Result

| State | Cases agreeing with the reader | Pinned gaps |
| --- | --- | --- |
| Before the fix (`b705f66`) | 9 / 18 | 9 |
| After the fix (`704a4a9`) | 16 / 18 | 2 |

The unmodified first measurement is kept verbatim in `docs/p2e-extraction-corpus-baseline-red.txt`.

Closed by the fix (each was red first, then fixed): `fix`/`make`/`refactor`/`bump`/`migrate`/`rename`/`drop`/`clear` as action verbs; `do not` / `don't` as a clause start; inline `(1) ... (2) ...` enumerations; sentence ends inside quotes or code spans; the title abbreviations `Dr.`, `Mr.`, `Mrs.`, `Ms.`, `Prof.`. A conditional clause ("If X, do A and do B") now keeps both duties together instead of stripping the condition from the second one.

Still open, deliberately pinned:

- **Elliptical second clause**, for example "Return 404 when the user is not found, and 403 when access is denied." The second duty has no verb of its own and stays attached to the first.
- **Non-English prompts.** The action-verb list is English only; a German prompt stays one candidate.

Other abbreviations, other languages, and phrasings outside the corpus are untested. A candidate that is split too coarsely or too finely stays `unclear` until a person adds independently checkable criteria.

## What this does not show

- 18 hand-picked cases are **not a reliability rate** and must not be quoted as one. They find regressions and document known limits.
- Source coverage is lexical: every character of the goal belongs to exactly one candidate. It does not say the requirements are semantically complete, and it must never be presented as requirement fulfilment.
- Correct splitting is not verification. The evidence for a requirement still has to come from independent checks.
- No second-domain claim follows from this. The CSV-report domain (see `P2E-INTEGRATION-STATUS.md`) runs through the same core under LOCAL evidence only. Universal Agent Assurance (Phase 3, `NORTH_STAR.md`) is not claimed.

## Feature status (Prompt-to-Evidence)

| Capability | Status |
| --- | --- |
| Deterministic draft with full source coverage, every candidate `unclear`, verdict `NOT PROVEN` | Implemented, experimental |
| Splitter on the 18-case corpus | Implemented, experimental; 16 of 18 agree, 2 pinned limits |
| Bounded correction loop (`--authorize-corrections`, at most 3 attempts, 5-minute agent cap, 30-minute verification cap) in a disposable candidate worktree | Implemented, experimental; not an OS-isolation guarantee |
| Correction evidence from live agent sessions (two providers) | Two historical controlled live runs exist (2026-10-21, recorded in `RELEASE-2.0.0.md`). No reliability rate, no new exact-head run and no current provider-SKIP coverage is claimed from them |
| Elliptical clauses and non-English prompts in the splitter | Planned |
| Reliability rate for extraction on a held-out prompt set | Planned; nothing is claimed until measured and published with its false-pass and false-failure observations |
