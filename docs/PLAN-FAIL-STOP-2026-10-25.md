# Stop ordered checks after an unmeasured process

The Hosted onboarding failure on source `a16a7e5` exposed a separate product defect: after a build's containment measurement failed, setup still executed the next check. A failure verdict alone did not prevent the extra execution. The native failure's cause remains unresolved; continuing after that failure was independently reproducible.

The new regression executes a real build, then makes only process-table access unavailable. Before the correction, the later check created its marker: zero passes/one failure, despite setup correctly returning exit2. After the correction that original assertion passes: the first command executed, the later command did not, and the run remained refused.

Existing setup, doctor and checkpoint loops now halt when a returned step has no measured exit code. Candidate verification and baseline input controls use the same small ordered-step helper; the primary baseline loop already halted on that condition. Completed results remain available for evidence and refusal reporting. No synthetic result is created for an unexecuted check. A real, measured nonzero project exit still permits collection of subsequent checks, as before; a positive control observes exit7 followed by an actual later execution.

This changes execution ordering after process failure, not the deterministic classifier, sealed authority, normal project assertions, time budgets, concurrency or security capability level. It adds no retries or detached sweep hosts. Missing evidence remains unproven and the failed run remains blocked. Full affected Windows/Linux validation and exact-current Hosted results must be recorded under their actual source identities before release approval. No corrected final package is claimed here.

## Validation

On the correction based on `a16a7e5`, all seven complete affected files (everyday lifecycle, onboarding, M5 proof plans, M6 orchestration, M7 candidate isolation, M8 promotion and M9 authority) passed: Windows 146 passed, Linux 144 passed, zero failures and zero skips in either run. The unchanged runner concurrency was eight. Source hashes were checked before and after execution; raw results and hashes are retained in the local release evidence directory `plan-halt-targets-2026-10-25`.

The new in-process setup regression now selects a fixture-owned temporary trust store and restores the prior environment in `finally`. After that test-isolation change and a successful build, the complete everyday-lifecycle file passed again on both systems: six passed, zero failed, zero skipped each. The product sources were unchanged from the seven-file run. Its separate source hashes and logs are retained in `plan-halt-isolation-2026-10-25`. These are real process executions with only process-table observation faulted; the positive control requires an actual later command after an ordinary exit7.

These focused results do not replace a full exact-source Hosted gate. The preceding Hosted run `40165362106` on `a16a7e5` failed three Windows tests; Linux and the other four jobs passed. The native startup failures remain unexplained. No retries, assertion relaxation, concurrency reduction or new skip were introduced. Release status remains NOT READY pending the complete corrected-source gate and remaining functional acceptance requirements.
