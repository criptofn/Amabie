# Prompt-to-Evidence V1 (experimental)

Status: **opt-in prototype for coding tasks**. This feature is not part of the stable Amabie 2.0 interface and must not be described as Universal Agent Assurance. The implementation request's Section 3 is strategic Phase 2; numbered work-plan sections do not change the product phase definitions. See [NORTH_STAR.md](NORTH_STAR.md) for the strategic phases and the Phase 3 acceptance gate.

## What the prototype verifies

The request envelope contains the original task text, a task-domain identifier, and each declared requirement with a source reference, clarity state, and one or more deterministic criteria. Amabie checks that the task-domain identifier, task digest, and multiset of requirement digests exactly match the task registered locally. The task domain is part of the correction-scope fingerprint, so a correction cannot silently switch verifier domains. It also recomputes lexical source coverage: every non-whitespace character in the original goal must map exactly once to a goal-linked requirement, and each quoted span must match that requirement text (an explicit list marker may be removed). A missing span, overlap, or paraphrase that does not match its quote keeps the overall result `NOT PROVEN`; it cannot be repaired by changing code, so the correction loop stops for operator review. Stable requirement and criterion IDs are derived from the content and source reference; the agent cannot choose an easier ID or silently omit a registered requirement.

A verifier adapter collects facts and artifact references. It does not return a verdict. The shared core applies a small deterministic JSON-Pointer equality rule, checks evidence type, adapter identity, run identity, scope and a content digest, then assigns `met`, `unmet`, `unproven`, or `blocked` per requirement. Missing bindings and missing facts remain `unproven`; execution failures are `blocked`; contradictory measured facts are `unmet`. An `unclear` requirement cannot become `met` even when a check is green. An empty requirement set, incomplete lexical prompt coverage, a source quotation that does not match its requirement text, or a requirement without machine-verifiable criteria is `NOT PROVEN`, never a vacuous pass. Source coverage proves only that the prompt text was mapped; it does not prove the semantic split or that the selected checks express the user's intent. Agent success claims are not an input to the evaluator.

Evidence digests are tamper-evidence for accidental changes, **not signatures or proof against a user with control of the same machine**. The coding adapter only accepts results from the current in-memory `doctor` run and maps them to the operator-sealed requirement-to-script bindings. It does not read a saved bundle back to decide. The saved bundle contains evidence IDs, facts, hashes and statuses, but omits free-form requirement text.

## Current coding workflow

1. Start with a review-only, source-linked draft of the original prompt:

   ```sh
   amabie prompt-evidence draft "Validate email input.
Hash passwords.
Add tests." --json
   ```

   The command emits a JSON request skeleton without changing project files. It preserves the exact goal and creates one candidate per non-empty source line, with exact source offsets. The coverage count is lexical only; it does not certify a complete semantic interpretation. This is structural segmentation, not semantic extraction: a one-line compound task remains one candidate. Every candidate is `unclear` and has no criteria, so the draft verdict is always `NOT PROVEN`. Review and split the candidates, resolve unclear wording, and add explicit criteria before using the request for verification. Save the reviewed JSON as UTF-8 at `.amabie/prompt-evidence.json`.

2. Register that same exact task and each reviewed candidate before work begins:

   ```sh
   amabie task "Validate email input.
   Hash passwords.
   Add tests." \
     --requirement "Validate email input." \
     --requirement "Hash passwords." \
     --requirement "Add tests."
   ```

3. Bind each exact requirement to a check that already belongs to the sealed plan, then seal that declaration through the normal operator workflow. For example:

   ```sh
   amabie bind test --requirement "Validate email input." --reseal
   amabie bind test --requirement "Hash passwords." --reseal
   amabie bind test --requirement "Add tests." --reseal
   ```

   `amabie bind` is the operator’s explicit mapping act. A successful suite does not prove that its assertions actually cover the wording; the relevance of each bound script still needs review.

4. Each requirement entry in the reviewed request has this shape:

   ```json
   {
     "text": "Validate email input.",
     "sourceRef": {
       "kind": "goal",
       "start": 0,
       "end": 21,
       "excerpt": "Validate email input."
     },
     "clarity": "clear",
     "criteria": [
       {
         "statement": "A sealed project check covers the email validation behavior",
         "adapterId": "amabie.coding.sealed-plan",
         "evidenceType": "sealed-check-run",
         "predicate": { "path": "/ok", "equals": true }
       }
     ]
   }
   ```

   The request envelope is `{"schema":"amabie-prompt-evidence/1","goal":{"taskType":"coding","text":"<the exact registered task>"},"requirements":[...]}`. The `end` offset is the exact character length of the source excerpt. A `goal` source reference must quote the corresponding exact substring of the original goal.

5. Run the full check plan and request the experimental report:

   ```sh
   amabie doctor --prompt-evidence .amabie/prompt-evidence.json --json
   ```

   The request file must be a regular file inside the project and no larger than 256 KiB. This mode refuses `--check` and `--fast`, because neither can establish complete coverage. A source-map gap prevents `PASS` and prevents the correction callback from being invoked. A passing result still means only that every *registered, source-mapped and explicitly bound* criterion matched the check evidence; it does not establish that the structural draft decomposed every compound sentence semantically or that a broad test suite is relevant to every criterion.

## Verifier and correction contracts

The shared package `@amabie/prompt-evidence` is task-neutral. It defines goals, source-linked requirements, criteria, verifier adapters, evidence records, deterministic evaluation, per-requirement statuses, and structured correction reports. The production adapter implemented here is `amabie.coding.sealed-plan`, which consumes fresh sealed-plan results. A document-outline mock uses the same contracts in tests to check extensibility; it is **not** a document-agent integration and does not count toward Phase 3.

The core also exposes an opt-in correction-loop controller. It sends only unresolved requirement IDs, gaps, and the immutable request-scope fingerprint to a caller-supplied correction callback. It performs fresh verification after each applied attempt and stops after at most three corrections, on no change, on a blocked callback, or when the callback reports a changed scope. It does not grant filesystem permissions or sandbox the callback. No external agent-generation callback is connected in this prototype; correction behavior is exercised with a deterministic mock. The local Kai decision MCP only classifies requests and is not treated as a correction model or evidence source.

## Validation record

Latest focused recheck after task-domain binding (Windows/Node 26.7.0, 2026-10-13): `npx tsc -b packages/core/prompt-evidence apps/cli --force` succeeded, followed by `node --test packages/core/prompt-evidence/dist/test/prompt-evidence.test.js apps/cli/dist/test/prompt-evidence-cli.test.js`. All 27 tests passed with no skips (20 core tests, 7 CLI integration tests; 20.5 seconds test-run duration). Regression cases confirm incomplete original-goal source mapping stays `NOT PROVEN` despite green checks, forged cached coverage is recomputed, source paraphrases remain unclear, task-domain changes are rejected in both core and CLI and included in the correction-scope digest, and code correction is not invoked until scope mapping is complete. Malformed adapter collections stop as `BLOCKED`, malformed correction callbacks stop as `correction-blocked`, and prompt candidates preserve exact source spans while remaining unproven pending review. CLI scenarios use isolated temporary Git projects and fixed check fixtures; the document adapter remains a mock. The verification and correction report contracts are versioned as `/2` for the added source-coverage and scope-gap fields.

The full product suite after the task-domain binding and CLI regression test on 2026-10-13 reported 1,432 passed, 4 skipped, 0 failed (1,436 total; 471,407 ms). The four host-bound skips remain unverified cases, not passes.

The complete Windows `npm run verify:productization` run on this experimental worktree also completed on 2026-10-13: **115 PASS, 7 explicit SKIP, 0 FAIL or INCOMPLETE**. Its embedded full test suite reported 1,432 passed, 4 POSIX-only skipped, 0 failed. The unchanged owner assertions caught both M12 and M13 mutations. The seven skipped gates were the native Windows PTY portions of two acceptance probes, Go and Rust E2E probes without toolchains discoverable in this worktree, the pytest observation probe without its optional interpreter, and two live-Claude diagnostics withheld because provider spend cannot be reliably capped. After the full run, the Go E2E gate was rerun through the productization gate runner and passed 1/1 using the existing shared Go 1.27.1 installation with a process-scoped `PATH`; the real unknown-tool contract was also rerun through that runner and passed 21/21 tests. Those targeted follow-ups do not alter the earlier full-run aggregate, and Rust, pytest, native PTY, and live-Claude checks remain unverified here.

Across the labeled core scenarios, 3 positive outcomes (complete coding evidence, corrected coding evidence, and the mock document result) were all accepted, while 7 negative outcomes (partial coverage, a false-done claim without evidence, a regression, a failed security check, missing security evidence, an empty requirement set, and a requirement without criteria) were not accepted as complete. Observed false-pass rate: 0/7 negative scenarios. Observed false-failure rate: 0/3 positive scenarios. These are deterministic fixture counts, not population estimates. The correction mock repaired its case in 1 cycle; a persistent failure stopped at 3 cycles. The focused build and test run took about 13.5 seconds on this machine; it made 0 external model calls and incurred $0 external inference cost. Those measurements describe this test harness only.

## Known limits and release boundary

- Only structural line/list candidates are generated; no semantic requirement-extraction model is connected. Complete lexical source coverage prevents omission of unmapped text but cannot detect that one source-mapped candidate still contains several obligations. The draft cannot establish semantic completeness, and the local Kai classifier is not used to decide it. The request is checked against a locally registered task, whose completeness, interpretation, and origin still require operator review.
- The `clarity` and criteria fields live in the local request file. This prototype has no separate authenticated human-approval record; the operator must inspect the exact requirement split and criteria before running the gate. A same-user process can modify local request files, consistent with the documented `LOCAL` boundary.
- The current CLI adapter uses a sealed script's exit result as evidence. It does not inspect individual test assertions or prove that a script semantically covers its mapped wording.
- Only the coding adapter executes against real Amabie checks. The document adapter is a mock; Universal Agent Assurance remains future work.
- The correction callback is an API contract with a hard three-cycle bound, not a deployed coding-agent integration or a filesystem security boundary.
- The prototype does not change LOCAL capability semantics, enable HARDENED, or provide a cryptographic signature over locally stored evidence.
- No experimental behavior is enabled by default. The new command mode is explicitly invoked, and the report is attached to that fresh doctor run.
