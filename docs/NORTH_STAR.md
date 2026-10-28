# Amabie North Star

> Your agent says it’s done. Amabie checks if it truly is.

Amabie’s long-term goal is **ONE-SHOT AGENT ASSURANCE**: a user states a goal once, an agent performs it, and Amabie independently checks whether the requested outcome is supported by evidence. Amabie reports what is verified, what failed, what remains unproven, and what is blocked. If correction is safe and authorized, a bounded loop may let the agent address specific gaps and submit the result for fresh verification.

This is the product direction, not a claim that the complete workflow exists today. Product copy, APIs, and release notes must distinguish shipped behavior from experimental work and future capability.

## Current priority

**The verified coding gate (Phase 1) comes first.** Until it is dependable on real projects (not only on Amabie's own fixtures), work on it outranks everything else: no false proof on a real repository, no tamper path around the gate, clear and honest messages, and a first run that works. Phase 2 and Phase 3 below are the direction, deferred; they do not displace this work and nothing in the release path may depend on them. Whether an agent is organically helped by Amabie, and by how much, is **not established**; only the measured, executed results in the benchmark reports may be quoted.

## Strategic product phases

### Phase 1 — Coding-Agent Verification (current priority)

Independently verify coding-agent changes using project checks, baselines, reproducible evidence, and deterministic verdicts. Agent statements are context, never proof. Verification must not rely on the agent being its own root of trust. When a check cannot tell the change apart from the baseline, or cannot run, the answer is NOT PROVEN, INCONCLUSIVE or BLOCKED, never a pass.

### Phase 2 — Prompt-to-Evidence

Translate the original user request into explicit, reviewable requirements and success criteria. Link each requirement to appropriate, independently collected evidence. Report each requirement as verified, failed, unproven, or blocked; a successful build or test suite cannot stand in for requirements it does not cover. Unclear requirements remain unclear until resolved rather than being silently treated as satisfied.

**Status: deferred.** Phase 2 stays experimental and opt-in (`amabie prompt-evidence …`), coding-only, and out of the stable 2.0 interface until Phase 1 is shown to hold on real projects. Keep its core contracts task-neutral where that is cheap. Coding is the only adapter; a small mock verifier may test that another task domain can use the same contracts, but that is an extensibility test, not support for that domain.

**Phase numbering is strategic, not a work-plan outline.** Numbered sections in an implementation request do not redefine these product phases. In particular, an implementation-plan Section 3 that delivers Prompt-to-Evidence V1 is work toward strategic **Phase 2**, not Universal Agent Assurance.

### Phase 3 — Universal Agent Assurance

Apply the same independent-verification principles to different kinds of AI-agent work, across models and task types. Long-term areas may include coding, browser tasks, research, data analysis, documents, video, and other domains. These are future directions, not current integrations or promises.

The phase-neutral foundation should support:

- a universal user goal and structured, traceable requirements;
- extensible evidence records with provenance and integrity information;
- per-requirement verification status and deterministic verdict rules;
- task-specific verifier adapters behind shared contracts;
- structured correction reports that return only unresolved, failed, or blocked work to the executing agent;
- bounded, authorized correction cycles followed by fresh independent verification; and
- reports that expose evidence, uncertainty, and limits.

## Phase 3 acceptance gate

Phase 3 is **not** achieved by connecting multiple MCP servers, exposing multiple tool names, or writing adapters that have not been exercised. A mock for another domain proves contract extensibility only. Before claiming Universal Agent Assurance, the release must demonstrate all of the following:

1. At least two genuinely different task domains have real, working agent workflows that use the same task-neutral verification core through task-specific verifier adapters. Each domain must exercise an executing agent, independent evidence collection, and verification end to end; connected MCPs, disconnected integrations, and mock verifiers alone do not count. Two integrations, models, or adapters for the same kind of task do not count as two domains.
2. Each domain has reproducible end-to-end scenarios for complete work, omissions or incorrect claims, and relevant failure cases.
3. Each workflow uses independently collected evidence; the executing agent’s self-report or an LLM’s judgment cannot establish a verdict.
4. Each workflow exercises a functioning, authorized correction cycle: Amabie returns a structured gap report, the executor makes a bounded in-scope correction, and Amabie gathers fresh evidence and re-verifies. It stops transparently when gaps remain, scope changes, authorization is absent, or the limit is reached.
5. Tests document coverage, false-pass and false-failure observations, runtime/cost conditions where measured, unresolved requirements, and uncertainty limits.

Until every criterion is demonstrated, describe Phase 3 as a future direction and list only the task domains that are actually implemented and tested.

## Architectural and product decisions

For Phase 2, prefer small, task-neutral contracts for goals, requirements, evidence, verifier adapters, requirement statuses, and correction reports. Keep domain-specific interpretation and evidence collection in adapters. The shared evaluator—not a model—decides whether evidence satisfies explicit criteria. Missing, invalid, or non-independent evidence cannot produce a verified status.

Keep experimental requirement extraction and correction loops opt-in and separate from stable Amabie 2.0 behavior until their contracts and failure modes are validated. A correction loop must preserve the original scope, require authorization for changes, have a hard iteration limit, and re-run verification after each attempt. It must report unresolved work honestly; it must not silently expand the request or claim that a retry succeeded without evidence.

Assess every substantial feature and each planned development phase against this North Star: does it improve independent verification of user intent, strengthen evidence quality, or make a proven step toward a new task domain without weakening deterministic verdicts? Keep Phase 2's coding-only support boundary explicit. Do not claim Phase 3 until every Phase 3 acceptance criterion above is demonstrated. If a proposal does not advance the North Star, keep it out of the release path.
