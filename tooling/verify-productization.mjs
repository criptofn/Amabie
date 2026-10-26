#!/usr/bin/env node
/** Full unit suite once, followed by integration probes and mutation checks.
 * --list-json lists gates; --gate selects one; --from resumes from a gate.
 * Exit 0 requires no failures or incomplete steps; explicit host skips remain visible.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// v1.4 release-gate budgets + cascade isolation (pure rules, pinned by
// tooling/probes/v14-battery-budget.mjs).
import { budgetFor, verdictFor, shouldStopAfter, KNOWN_RUNTIME_MS } from './step-budgets.mjs';
import { runProbe } from './test-support/run-probe.mjs';
import { fileURLToPath } from 'node:url';
// In-place dist mutation must be self-healing. The mutation batteries edit the
// built dist and restore it in `finally`; a battery KILLED mid-mutation (timeout,
// CI cancel) leaves dist mutated, and `tsc -b` will NOT repair it because
// .tsbuildinfo already records the source as compiled — so every later step here
// would judge mutated product code. The guard's journal makes that recoverable,
// and this is where the recovery happens: BEFORE any step is judged.
import { recoverInterruptedMutation } from './test-support/dist-mutation-guard.mjs';

const AMABIE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = process.platform === 'win32';
const rawLogIndex = process.argv.indexOf('--raw-log-dir');
const rawLogDir = rawLogIndex < 0 ? null : process.argv[rawLogIndex + 1];
if (rawLogIndex >= 0 && (!rawLogDir || !path.isAbsolute(rawLogDir) || fs.existsSync(rawLogDir))) {
  throw new Error('--raw-log-dir requires a new absolute directory');
}
if (rawLogDir) fs.mkdirSync(rawLogDir, { recursive: true });
// 1.1 P0 isolation: every step spawns the CLI (directly or through a probe),
// and every such spawn inherits/spreads this process's env — pointing it at
// ONE fresh temp trust store keeps all verification sealing out of the real
// per-user store, which is exactly what it is NOT for.
// Repair a dist left mutated by an interrupted battery BEFORE judging anything.
if (!process.argv.includes('--list-json')) {
  const repaired = recoverInterruptedMutation();
  if (repaired !== null) console.log(`WARNING: ${repaired}`);
}
const STEPS = [
  // FORCED, not incremental. MEASURED (2026-09-14): `npm run build` (`tsc -b`) reports success
  // WITHOUT re-emitting a file whose bytes were changed after compilation — so a `dist` left mutated
  // by an interrupted mutation battery stays mutated, and the whole chain then measures a corrupted
  // artifact while every step reports on it as if it were a build. `--force` makes the first step
  // actually produce the artifact it claims to produce, which is the precondition for the tripwire
  // below to mean anything.
  // `npm exec`, not `npx`: the chain spawns steps without a shell, and `npx` is a shell shim that
  // `spawnSync` cannot resolve here (MEASURED: `spawnSync npx ENOENT`), while `npm` resolves.
  // v1.4 — force the WHOLE workspace, not just apps/cli. MEASURED: `tsc -b` exits 0 without
  // re-emitting a file whose output was changed after compilation, and forcing only the CLI left
  // every `packages/*/dist` free to be stale — so a probe could measure bytes that do not
  // correspond to the source in front of it. The freshness probe below then proves the property
  // rather than assuming it.
  ['build (tsc -b --force)', 'npm', ['exec', '--', 'tsc', '-b', '--force'], {}],
  ['build (npm run build, incremental)', 'npm', ['run', 'build'], {}],
  // BEFORE anything reads the artifact: is the compiled CLI a real build, or a mutation battery's
  // leftover? MEASURED (2026-09-14): an interrupted `master-pass-mutations` run left
  // `apps/cli/dist/src/candidate.js` containing `if (false) {` in place of the non-TTY acceptance
  // gate. The source was correct; the artifact was not. Against it, `pre10-acceptance` case C failed
  // while passing standalone on the byte-identical tree, and the master-pass battery aborted at its
  // own acceptance baseline — hours spent explaining behaviour the source never had. This step turns
  // that state into a loud first failure instead of a phantom product defect.
  ['dist tripwire (is the compiled artifact mutated?)', process.execPath, ['tooling/probes/v12-dist-tripwire.mjs'], {}],
  // v1.4 — the tripwire only looks for mutation-battery MARKERS. This proves the stronger
  // property the release depends on: after this build path, no emitted file can hold bytes that
  // do not match the source (it injects a sentinel, re-runs the build, and requires it to be gone).
  ['dist freshness (does dist correspond to source, or can stale bytes be tested?)', process.execPath, ['tooling/probes/v14-dist-freshness.mjs'], {}],
  // v1.4 — the gate checks its own budgets and its cascade isolation before anything slow runs:
  // a step whose MEASURED runtime class exceeds its budget is an infrastructure defect that shows
  // up as a false red (and did, twice).
  ['release-gate budgets + cascade isolation (is a timeout distinguishable from a failure?)', process.execPath, ['tooling/probes/v14-battery-budget.mjs'], {}],
  // v1.4 — MEASURED: suites passed alone and failed in the battery because a trust store derived
  // from a RECYCLABLE pid picked up a stale, keyless store from an unrelated earlier run. This
  // pins the isolation, that an unrelated stale store is inert, that a damaged store still refuses,
  // and that repeated runs agree.
  ['trust-store isolation (can stale temp state decide a test?)', process.execPath, ['tooling/probes/v14-trust-store-isolation.mjs'], {}],
  // v1.4 — MEASURED (GitHub Windows run 35636516908): the post-exit containment sweep asked WMI one
  // identity checks and, against a real live tree, the property the fix must not break: survivors are
  // still found and killed.
  ['containment sweep cost + honesty (one tree snapshot, bounded identity checks, survivors killed)', process.execPath, ['tooling/probes/v14-sweep-scale.mjs'], {}],
  // v1.4 — the same Windows leg was red for a second, independent reason: a DELETED artifact was
  // reported as "resolves outside the artifacts directory" whenever the host's temp path has an 8.3
  // SHORT name (`C:\Users\RUNNER~1\...`), which no developer machine reproduces because `Johannes`
  // fits 8.3. This runs the files that were red with TEMP/BOTH temp variables pointed at the short
  // spelling of a long-named directory, so the runner's condition is exercised locally in minutes.
  ['8.3 short-name suite (does the suite still hold when TEMP is spelled the way a runner spells it?)', process.execPath, ['tooling/probes/v14-shorttemp-suite.mjs'], {}],
  // And before anything is BELIEVED FROM THE DOCS: do their checkable numbers still match the
  // repository? This session's most persistent defect was summaries drifting from what they summarise
  // - the standings were stale twice, the README quoted a superseded token figure, a step label named
  // a corpus size that had moved. Each was caught by hand, one at a time, by someone already
  // suspicious. This turns that into a command.
  ['doc consistency (do the release documents still match the repository?)', process.execPath, ['tooling/probes/v12-doc-consistency.mjs'], {}],
  // v1.3: the everyday journey, measured end to end — the completion gate's real decisions, the
  // agent-tool registration and its containment, and what the ordinary path refuses to hand a worker.
  ['v1.3 the everyday journey (setup -> completion gate -> agent tools)', process.execPath, ['tooling/probes/v13-journey-baseline.mjs'], {}],
  // v1.4 Gap C: the SECOND gating adapter, measured rather than documented — the Codex `Stop` hook
  // written by setup, the hook contract driven exactly as the vendor documents it (stdin event ->
  // stdout decision, pass -> silent allow, fail -> parsed block, loop guard), and one real bounded
  // `codex exec` session in which Codex executes the hook and continues the turn on its decision.
  // SKIP-aware: a host with no codex CLI, or with no Codex credentials, cannot run the last arm and
  // says so with explicit SKIP lines — a SKIP is never a PASS, and `gatingMeasured` in the capability
  // table is exactly what that arm is evidence for.
  ['v1.4 codex stop hook (a second measured completion gate)', process.execPath, ['tooling/probes/v14-codex-stop-hook.mjs'], {}],
  // v1.5 §4A/§4E: the FIRST RUN as a journey, against a real installed artifact in a scratch repo —
  // install -> setup -> verified completion -> FAILED completion (block decision + evidence path that
  // exists) -> repair -> uninstall, plus the five first-run error paths. It asserts semantics and
  // required actions, never prose, so the wording can improve without turning the chain red. It
  // reports a source-side improvement the built artifact predates as `PENDING-REBUILD … NOT a pass`
  // rather than asserting it, so the chain stays honest between a source edit and the next build.
  ['v1.5 first run (install -> setup -> gate -> fail -> repair -> uninstall, asserted)', process.execPath, ['tooling/probes/v15-first-run.mjs'], {}],
  ['Windows process cleanup stress (6 idle + 6 under load)', process.execPath, ['tooling/probes/win-sweep-stress.mjs'], {}],
  // v1.5 POST-AUDIT (independent GPT-5.6 audit of a004f55). Each of these is the focused proof for a
  // confirmed finding, registered here so the release battery re-checks the finding rather than
  // trusting the commit message that fixed it. All three are deterministic and cost no model tokens.
  //   BLOCKERS 1+7: a worker that REWRITES an existing check must not inherit independent authority,
  //   and a legitimate check outside a test path must not be a false red. LESS false red, no MORE
  //   false green — one predicate caused both, so one probe covers both.
  ['v1.5 check provenance (rewritten existing check is worker-authored; sealed-script check is not a false red)', process.execPath, ['tooling/probes/v15-check-provenance.mjs'], {}],
  //   BLOCKER 2: a token headline may only rest on completed runs using the declared provider-native
  //   ledger, and on cells that all share ONE instrument. Prints NO ratio for an incomplete run.
  ['v1.5 token aggregate contract (ineligible cells and unstable instruments cannot enter a headline)', process.execPath, ['tooling/probes/v15-everyday-aggregate.mjs'], {}],
  //   BLOCKER 6: the sealed step must resolve the toolchain the project's own checks need, and must
  //   attribute an environment failure to AMABIE rather than to the project.
  ['v1.5 sealed toolchain (the environment names the missing tool instead of blaming the project)', process.execPath, ['tooling/probes/v15-sealed-toolchain.mjs'], {}],
  //   BLOCKER 4: every attempt gets immutable identity. MEASURED cause: the run-task probe wrote fixed
  //   filenames into one directory per task, so a SECOND attempt truncated the FIRST's stream, ledger,
  //   record and diff while leaving behind files it never wrote. The result was a directory that looked
  //   like one run and was two. This probe refuses an occupied attempt and proves the earlier attempt's
  //   bytes are untouched.
  ['v1.5 attempt provenance (one attempt per directory; an occupied attempt is refused, never mixed)', process.execPath, ['tooling/probes/v15-attempt-provenance.mjs'], {}],
  //   THE LAST WINDOWS CI BLOCKER, made portable. The Windows core leg failed one test because it
  //   compared the child's PATH against the authorized directory AS THE TEST SPELLED IT, while the
  //   product seals `fs.realpathSync.native(dir)` — the same class as the v1.4 short-name failure:
  //   one assertion comparing two spellings of one directory. 8.3 short names are disabled on this
  //   host, so a JUNCTION stands in for the short name and produces the identical shape: two
  //   spellings, one directory. The probe proves the sealed child receives the directory, that a RAW
  //   comparison would call it absent (the CI symptom, reproduced without a short name), and that a
  //   directory which was never authorized is still refused.
  ['v1.5 path spelling (two spellings of one directory are not "absent")', process.execPath, ['tooling/probes/v15-path-spelling.mjs'], {}],
  //   THE SECOND-AUDITOR FINDING, as a tripwire. A reviewer found the public audit set telling two
  //   stories at once: the matrix still carried the withdrawn `83.21 % / -16.79 %` as SUPPORTED in one
  //   section and WITHDRAWN in another; the audit kit still asked for an attack on that number; the
  //   closure document's last paragraph declared gates NOT RUN that had gone green; the README still
  //   called v1.3.0 the newest published artifact. Every one was caught by a human reading carefully.
  //   This probe checks the CONTEXT of each withdrawn figure (a marker within ±4 lines), the absence of
  //   statements the closure made false, and the presence of the current truth in the documents'
  //   words. It cannot check whether prose is true; it checks that the documents do not contradict
  //   each other about what this project claims.
  ['v1.5 evidence consistency (the public audit set tells one truth)', process.execPath, ['tooling/probes/v15-evidence-consistency.mjs'], {}],
  // v1.3: the AGENT side of the integration — `claude mcp list` proves the agent reads Amabie's entry
  // and reports honestly whether it honours it. Host-bound: an explicit SKIP where no CLI exists, and a
  // SKIP is never a pass.
  ['v1.3 agent integration (the agent reads what setup wrote)', process.execPath, ['tooling/probes/v13-agent-integration.mjs'], {}],
  // v1.3: how much internal vocabulary the ORDINARY path speaks, as a ratchet — with the other
  // direction checked too, so the default cannot be made quieter by deleting what --verbose explains.
  ['v1.3 everyday vocabulary (a ratchet on the words a user must decode)', process.execPath, ['tooling/probes/v13-everyday-vocabulary.mjs'], {}],
  // v1.3: what Amabie costs on EVERY turn, whether or not it is used — the MCP instructions and tool
  // definitions a client re-sends each request — and which shape the benchmark's arms actually measure.
  ['v1.3 standing context (what Amabie advertises per turn)', process.execPath, ['tooling/probes/v13-standing-context.mjs'], {}],
  // v1.3: can the harness's own consent gate be satisfied without a human? Measured with four settings
  // forms and two independent views of the answer. Host-bound: an explicit SKIP where no CLI exists.
  ['v1.3 mcp consent (is the harness gate closable without a human?)', process.execPath, ['tooling/probes/v13-mcp-consent.mjs'], {}],
  // v1.3: the block rate of the completion gate, read from the stored corpus — the decisive number for
  // whether the <=75% token target is reachable by removing turns. Costs no model tokens.
  ['v1.3 gate cost (how often does the gate refuse, and what would removing it save?)', process.execPath, ['tooling/probes/v13-gate-cost.mjs'], {}],
  // v1.3: the docs describe the SIMPLER product — the everyday path leads, and the candidate path is
  // never presented without its measured cost (177.8% vs the everyday figure, which v1.5 re-measured
  // at 83.21% WITH the standing MCP payload included; the historical 92.7% excluded it).
  ['v1.3 doc first path (do the docs still lead with the everyday path?)', process.execPath, ['tooling/probes/v13-doc-first-path.mjs'], {}],
  // v1.3: the property the invisible candidate/promotion lifecycle exists to provide, attacked directly —
  // a forged green checkpoint record on a repository whose checks fail must not allow a completion.
  ['v1.3 verified bytes (no stored record can produce a pass)', process.execPath, ['tooling/probes/v13-verified-bytes.mjs'], {}],
  // v1.3: which MCP scope avoids the harness's approval gate — the last measured obstacle to a genuinely
  // seamless integration. Host-bound: an explicit SKIP where no CLI exists.
  ['v1.3 mcp scope (which scope avoids the harness approval gate?)', process.execPath, ['tooling/probes/v13-mcp-scope.mjs'], {}],
  // v1.3: the confined worker is launched ONCE and never told a verdict — which is why the "you will be
  // told what to fix" instruction may not be added there, and why its long-task cost explodes. Pins the
  // fact AND the cost shape, so the diagnosis cannot drift.
  ['v1.3 transport feedback (can the confined worker learn a verdict?)', process.execPath, ['tooling/probes/v13-transport-feedback.mjs'], {}],
  // v1.3: what the project's own check actually costs to run — the input that decides whether returning
  // its result after each batch is affordable, measured rather than assumed.
  ['v1.3 transport suite cost (what does the check cost to run?)', process.execPath, ['tooling/probes/v13-transport-suite-cost.mjs'], {}],
  // v1.3: the opt-in per-batch check feedback — runs after a mutating batch, bounded, and never presented
  // as a verdict; and stays out of the way on read-only batches and when nothing is declared.
  ['v1.3 confined check feedback (does the per-batch check behave?)', process.execPath, ['tooling/probes/v13-confin-check.mjs'], {}],
  // v1.3: can the EVERYDAY path hand the agent its project's check result mid-task? A documented hook field
  // is not evidence it is delivered, so this measures it with the real CLI. Host-bound: explicit SKIP.
  // v1.4 §11 — ROLE MADE EXPLICIT. This probe asserts two different kinds of thing: deterministic
  // properties of the hook wiring (which gate this step) and what a LIVE MODEL SESSION did with
  // the delivered text (which does not, because it is nondeterministic — MEASURED PASS -> FAIL ->
  // PASS on identical bytes). A live-only non-observation exits 3 and is reported here as an
  // explicit host-bound SKIP; a deterministic failure still exits 1 and still fails the battery.
  ['v1.3 posttool feedback (DIAGNOSTIC live-integration; deterministic properties gate)', process.execPath, ['tooling/probes/v13-posttool-feedback.mjs'], {}],
  ['full unit suite', 'npm', ['test'], {}],
  // A REAL Go project verified end to end (setup -> doctor), which proves the Go
  // adapter's toolchain declaration works through the PRODUCT rather than in a
  // hand-run shell. SKIPs (exit 3) where no Go toolchain exists.
  ['probe: real Go project end-to-end (setup -> doctor)', process.execPath, ['tooling/probes/go-project-e2e.mjs'], {}],
  // The same proof for Rust, which needed a resolution fix: setup used to seal the
  // rustup PATH PROXY, which cannot run under the sanitized env. SKIPs (exit 3)
  // where no rustup toolchain exists.
  ['probe: real Rust project end-to-end (setup -> doctor)', process.execPath, ['tooling/probes/rust-project-e2e.mjs'], {}],
  ['probe: empty-plan checkpoint', process.execPath, ['tooling/probes/checkpoint-empty-plan.mjs'], {}],
  ['probe: M2 claims-not-evidence (real git)', process.execPath, ['tooling/probes/m2-claims-not-evidence.mjs'], {}],
  ['probe: M3 trust-classes (real git)', process.execPath, ['tooling/probes/m3-trust-classes.mjs'], {}],
  ['probe: M4 provenance (real git)', process.execPath, ['tooling/probes/m4-provenance.mjs'], {}],
  ['probe: M5 trusted plan (real git)', process.execPath, ['tooling/probes/m5-proof-plan.mjs'], {}],
  ['probe: M6 proof orchestration (real git)', process.execPath, ['tooling/probes/m6-proof-orchestration.mjs'], {}],
  ['probe: M7 candidate isolation (real git)', process.execPath, ['tooling/probes/m7-candidate-isolation.mjs'], {}],
  ['probe: M8 promotion (real git)', process.execPath, ['tooling/probes/m8-promotion.mjs'], {}],
  ['probe: M9 authority guard (real git)', process.execPath, ['tooling/probes/m9-authority.mjs'], {}],
  ['probe: M10 obligations + intent (real git)', process.execPath, ['tooling/probes/m10-obligations.mjs'], {}],
  ['probe: M10.1 F4 taskless-bypass repro (real git)', process.execPath, ['tooling/probes/m10-f4-bypass-repro.mjs'], {}],
  ['probe: M10.2 adversarial authority battery (real git)', process.execPath, ['tooling/probes/m10-2-adversarial.mjs'], {}],
  ['probe: M10 lying-index letters (git premise)', process.execPath, ['tooling/probes/m10-lsfiles-letters.mjs'], {}],
  ['probe: Lazy-Connect status contract (real git)', process.execPath, ['tooling/probes/lazy-connect-status.mjs'], {}],
  ['probe: master-pass split-verdict subjectivity battery (real git)', process.execPath, ['tooling/probes/master-pass-subjectivity.mjs'], {}],
  ['probe: pre-1.0 execution-environment authority battery (real git, poisoned env)', process.execPath, ['tooling/probes/pre10-env-authority.mjs'], {}],
  ['probe: pre-1.0 human-acceptance battery (real git + pty)', process.execPath, ['tooling/probes/pre10-acceptance.mjs'], {}],
  // Stable-scope consistency: the 2.0 release note must label the Prompt-to-Evidence commands the same way the CLI does.
  ['probe: stable-scope consistency (release note vs CLI experimental labels)', process.execPath, ['tooling/probes/stable-scope-consistency.mjs'], {}],
  // Each fault has its own unchanged finite budget; accumulated valid owner work cannot hide M12/M13.
  ...Array.from({ length: 13 }, (_, i) => [`probe: master-pass mutation battery (built dist) / M${i + 1}`, process.execPath,
    ['tooling/probes/master-pass-mutations.mjs', '--only', `M${i + 1}`], {}]),
  ['probe: 1.1 P0 trust-boundary mutations (scratch builds)', process.execPath, ['tooling/probes/p0-trust-boundary-mutations.mjs'], {}],
  // E: HARDENED is unreachable until a provider with a real second OS identity
  // exists. This step makes that a MEASUREMENT with a tripwire — it fails if the
  // product would ever report HARDENED without one — and prints the exact
  // privileged command a human must run to change the answer.
  ['probe: HARDENED provider boundary (measured, not claimed)', process.execPath, ['tooling/probes/provider-boundary.mjs'], {}],
  // Verification-integrity: prove that an interrupted in-place dist mutation is
  // detected and repaired, because a stale dist silently produced three phantom
  // mutation-battery failures in this repo before the guard existed.
  ['probe: dist-mutation guard (interrupted-battery recovery)', process.execPath, ['tooling/probes/dist-mutation-guard.mjs'], {}],
  ['probe: acceptance growth (real git + pty)', process.execPath, ['tooling/probes/f3-acceptance-growth.mjs'], {}],
  ['probe: architecture closure matrix', process.execPath, ['tooling/probes/architecture-closure.mjs'], {}],
  ['probe: architecture closure mutations (scratch builds)', process.execPath, ['tooling/probes/architecture-closure-mutations.mjs'], {}],
  ['probe: architecture metrics and zero-write status', process.execPath, ['tooling/probes/architecture-metrics.mjs'], {}],
  ['probe: clean-room lazy vibecoder', process.execPath, ['tooling/probes/cleanroom-lazy-vibecoder.mjs'], {}],
  ['probe: HTG inline-interpreter corpus', process.execPath, ['tooling/probes/htg-inline-interpreter-corpus.mjs'], {}],
  ['probe: packed-artifact clean room (spaces path)', process.execPath, ['tooling/probes/cleanroom-packed-artifact.mjs'], {}],
  ...(process.platform === 'win32' ? [['probe: installed HARDENED production authority and custody', process.execPath, ['tooling/probes/v12-packed-provider-audit.mjs'], {}]] : []),
  ['probe: documented examples (Node + Python, real CLI)', process.execPath, ['tooling/probes/examples-smoke.mjs'], {}],
  ['probe: packed architecture matrix', process.execPath, ['tooling/probes/packed-architecture.mjs'], {}],
  ['probe: node:test observation channel (shipped reporter bytes, real run)', process.execPath, ['tooling/probes/runner-observation-node-test.mjs'], {}],
  ['probe: pytest observation channel (shipped plugin bytes, real run)', process.execPath, ['tooling/probes/runner-observation-pytest.mjs'], {}],
  ['probe: broker cross-process serving (the provider transport premise)', process.execPath, ['tooling/probes/broker-cross-process.mjs'], {}],
  // The completion gate's failure payload is a TOKEN-COST control: the model must get the
  // smallest actionable message, with the full runner output on disk instead of in its context.
  ['1.1 failure payload is compact and points at the full log (real hook run)', process.execPath, ['tooling/probes/checkpoint-payload.mjs'], {}],
  // The product invariant behind this step: Amabie must never issue READY merely because the
  // configured tests are green while authorized requirements lack adequate proof, and existing
  // behaviour that must be preserved requires regression evidence. The probe drives six real
  // repositories: a silent change behind a green suite must be NOT PROVEN and must BLOCK, a
  // discriminating check must earn READY, and an unestablished comparison must not be read as
  // either answer.
  ['1.1 regression-evidence gate (a green plan that cannot discriminate a change is NOT PROVEN)', process.execPath, ['tooling/probes/regression-evidence-gate.mjs'], {}],
  // The other half of the same invariant: an AUTHORIZED requirement that no check covers must stay
  // NOT PROVEN (never READY), the worker must be told, the printed exit must be one that can be
  // taken, and binding each requirement to a sealed script must make coverage attainable.
  ['1.1 requirement coverage gate (authorized requirements are proven or NOT PROVEN)', process.execPath, ['tooling/probes/requirement-coverage-gate.mjs'], {}],
  // P0:22 — the user's original prompt reaches the verdict through the harness intake, not through the
  // worker's own goal text: omission, negation and replay of an older prompt are NOT PROVEN, never PASS.
  ['P0:22 original prompt bound through intake to the prompt-evidence verdict', process.execPath, ['tooling/probes/original-prompt-binding.mjs'], {}],
  // P0:23 — the task record is append-only and hash-chained: only a NEW user request may weaken the
  // duties; a drop inside one request, an edited chain and a rolled-back task are NOT PROVEN.
  ['P0:23 task revisions are chained and only a new request may weaken the duties', process.execPath, ['tooling/probes/task-revision-integrity.mjs'], {}],
  // P0:24 — a fixture/golden the sealed check reads is oracle bytes: a worker rewriting it is not `met`.
  ['P0:24 a rewritten fixture the sealed check reads cannot self-approve', process.execPath, ['tooling/probes/oracle-fixture-authority.mjs'], {}],
  // P0:25 — an approved routine profile is a proposal until every prerequisite is met (T13).
  ['P0:25 an approved routine profile binds a matching task; anything short of every prerequisite stays a proposal', process.execPath, ['tooling/probes/routine-profile.mjs'], {}],
  // P0:26 — a mission survives a restart, a torn write and a concurrent writer without a silent default or budget reset (T15).
  ['P0:26 the mission journal keeps order, attempts and limit across restart; a torn tail heals, corruption blocks', process.execPath, ['tooling/probes/mission-journal.mjs'], {}],
  // P0:27 — finishing the last sub-goal never completes the root goal, and no duty or attempt is lost on a revision or an agent switch (T16).
  ['P0:27 sub-goals keep dependency order; the root goal is checked separately; duties and attempts survive revision and agent handover', process.execPath, ['tooling/probes/mission-subgoals.mjs'], {}],
  // P0:28 — parallel workers get separate change areas; collisions, moved baselines and lost leases are caught before release (T17).
  ['P0:28 parallel workers hold separate areas; overlap, overshoot, moved baseline and expired lease are refused before release', process.execPath, ['tooling/probes/mission-assignments.mjs'], {}],
  // P0:29 — evidence is bound to the exact snapshot (incl. dirty bytes), goes stale per dimension, and an open mission keeps it through retention (T18).
  ['P0:29 evidence binds exact dirty bytes, goes stale when task/oracle/policy/env/subject change, and survives retention while a mission needs it', process.execPath, ['tooling/probes/evidence-binding.mjs'], {}],
  // P0:30 — Checkpoint C: one small real workflow; statuses stay separate, evidence goes stale, budget/scope survive restart and agent switch, sessions cannot overwrite each other.
  ['P0:30 checkpoint C: separate statuses, bound evidence, no budget reset on restart/agent switch, no silent overwrite between sessions', process.execPath, ['tooling/probes/checkpoint-c-workflow.mjs'], {}],
  // v1.2 Mission 2: the SAME invariant asked BEFORE the worker is handed anything. v1.1 could only
  // discover an unbound requirement at the end of a session (Stop hook / finish), after the model
  // had spent its budget on a duty no check could measure — measured at 1.5-1.85M tokens over 41-53
  // turns. This gate refuses the handoff, opens no candidate, names the digest and the plan scripts
  // it could be bound to, proceeds once bound, and does NOT block a genuinely subjective
  // registration (whose honest closure is a human acceptance).
  ['1.2 REQUIREMENT UNBOUND gate (no worker is handed a duty it cannot close)', process.execPath, ['tooling/probes/v12-requirement-unbound.mjs'], {}],
  // ...and the step BEFORE that gate: intake. A requirement whose text begins with a dash-like token
  // (`--strict …`) used to be neither registered nor reported — eight were stated, seven were
  // recorded. Found by the fixture-configuration probe below, not by review. `--requirement` now
  // takes its value verbatim, a missing value is refused, and an unknown option is refused rather
  // than ignored (a typo silently registering ZERO duties is the one outcome intake may never have).
  ['1.2 requirement intake (verbatim, or refused — never a silent coverage hole)', process.execPath, ['tooling/probes/v12-requirement-intake.mjs'], {}],
  // The five-outcome instrument, and the boundary measurement it depends on, check themselves before
  // any v1.2 number is believed: what the agent SAID is kept separate from what is TRUE, an oracle
  // that did not run is UNUSABLE rather than a failure, and a false-green rate with no denominator is
  // null rather than a fabricated zero.
  // No count in the label: the corpus grows, the probe prints the real denominator, and a number baked
  // into a step name goes stale silently — this one said "395 stored trials" when it had reached 410.
  ['1.2 benchmark outcome instrument (five outcomes; re-checks itself against the stored corpus)', process.execPath, ['tooling/probes/v12-outcome-selfcheck.mjs'], {}],
  // A security measurement is a measurement: it can be wrong, and the first version of this one WAS
  // (a control write and a confined write shared a filename, so the probe measured itself and called
  // it a boundary). It is in the chain so the retraction stays visible and re-runs.
  ['1.2 integrity boundary measurement (reports honestly whether confinement exists here)', process.execPath, ['tooling/probes/v12-integrity-boundary.mjs'], {}],
  // And the same invariant in a NON-Node project, where the bindings live in the universal manifest:
  // declared checks + bound digests are sealed, an unbound requirement stays NOT PROVEN, `amabie bind`
  // writes to the right declaration surface, and an unknown proof check is refused.
  ['1.1 universal requirement binding (manifest-declared proofs, non-Node project)', process.execPath, ['tooling/probes/universal-requirement-binding.mjs'], {}],
  // ...and every fixture's DECLARED configuration is checked against the fixture, not trusted: each
  // project is sealed, its own stated requirements are registered, and `registerRequirements: true`
  // must hold exactly where the product's own digests and sealed bindings show every requirement is
  // bound. This is the probe that found the silent-drop defect in requirement intake (above).
  ['benchmark: every fixture\'s declared configuration matches its own sealed bindings', process.execPath, ['tooling/probes/v12-fixture-configurations.mjs'], {}],
  ['benchmark: agent-driven token ledger (stream-json parsed for phase cost + visible bytes)', process.execPath, ['tooling/probes/agent-token-ledger.mjs'], {}],
];

// R4 honest evidence: three per-step states, never collapsed. A probe may
// signal exit 3 = "passed what THIS host could run, with explicit host-bound
// SKIP lines" (see htg-inline-interpreter-corpus.mjs) — that is NOT a PASS
// and is never counted as one; the SKIP lines are echoed into the summary.
// Exit code contract: 0 = zero failures (all PASS, or PASS + listed
// host-bound SKIPs — the headline distinguishes); 1 = any FAIL or a step
// aborted mid-chain so later steps judged stale bytes.
const SKIP_AWARE = new Set([
  // v1.4 §11 — the live-integration diagnostic. Its deterministic properties exit 1 (a real
  // failure, still reported as FAIL); a live-model-only non-observation exits 3 and is named as a
  // host-bound SKIP, because a gate whose verdict depends on a live session must not silently
  // decide a release. The probe prints the raw evidence either way.
  'v1.3 posttool feedback (DIAGNOSTIC live-integration; deterministic properties gate)',
  'probe: HTG inline-interpreter corpus',
  'probe: documented examples (Node + Python, real CLI)',
  // The two acceptance batteries need a REAL pty. Where the host has no
  // drivable pty (measured: win32 here — see tooling/probes/tty-capability.mjs)
  // they drive the same product gate through the repo's in-process terminal
  // driver, run EVERY product assertion, print an explicit SKIP naming what the
  // platform could not prove, and exit 3. SKIP is never counted as PASS.
  'probe: pre-1.0 human-acceptance battery (real git + pty)',
  'probe: acceptance growth (real git + pty)',
  // The fixture requires NTFS 8.3 short-name creation. If the volume does not
  // produce a distinct alias, the probe exits 3 and explicitly says the runner
  // condition could not be exercised; that is unverified, never a pass.
  '8.3 short-name suite (does the suite still hold when TEMP is spelled the way a runner spells it?)',
  // This is an environment measurement, not a requirement that LOCAL installs
  // provide OS confinement. A host that cannot start any confined child is a
  // named, non-passing SKIP; a child that runs without an observed boundary is
  // still a genuine FAIL.
  '1.2 integrity boundary measurement (reports honestly whether confinement exists here)',
  // The two ecosystem end-to-end probes SKIP (exit 3) on a host with no
  // toolchain — which is an honest host bound, not a failure. Without this they
  // would be reported as FAIL on a machine that simply has no Go or no rustup,
  // which is exactly the "host limit read as a defect" error this oracle exists
  // to avoid.
  'probe: real Go project end-to-end (setup -> doctor)',
  'probe: real Rust project end-to-end (setup -> doctor)',
  // The pytest channel needs a pytest INSTALLATION. It lives in a workspace-local
  // venv (`_toolchains/py`, gitignored) precisely so no global Python state is
  // touched; on a host without it the probe says so and exits 3, and the channel's
  // text-grammar half is still covered by the comparator unit tests.
  'probe: pytest observation channel (shipped plugin bytes, real run)',
  // v1.4: the Codex end-to-end arm needs a runnable, AUTHENTICATED codex CLI (and
  // the wired/protocol arms run regardless). Where either is absent the probe prints
  // explicit SKIP lines and exits 3 — the host bound is named, never counted as PASS.
  'v1.4 codex stop hook (a second measured completion gate)',
  'Windows process cleanup stress (6 idle + 6 under load)',
]);
// These diagnostics start real Claude Code sessions. Their CLI-level
// --max-budget-usd value was observed to overshoot, so this runner cannot
// currently enforce the user's total provider spend. Keep them listed and
// visible, but never start a paid session from the default productization gate.
const COST_GATED = new Map([
  ['v1.3 posttool feedback (DIAGNOSTIC live-integration; deterministic properties gate)',
    'cost-gated: live Claude sessions were not run; provider-level spend cannot be reliably capped'],
  ['benchmark: agent-driven token ledger (stream-json parsed for phase cost + visible bytes)',
    'cost-gated: live Claude session was not run; provider-level spend cannot be reliably capped'],
]);
const results = []; // [label, 'PASS'|'SKIP'|'FAIL'|'INCOMPLETE'|'NOT RUN', note]
const valueOf = flag => { const i = process.argv.indexOf(flag); if (i < 0) return null; if (!process.argv[i + 1]) throw new Error(`${flag} requires a gate label`); return process.argv[i + 1]; };
const from = valueOf('--from');
const gate = valueOf('--gate');
if (from && gate) throw new Error('Choose --from or --gate, not both');
const requested = from ?? gate;
const offset = requested ? STEPS.findIndex(([label]) => label === requested) : 0;
if (offset < 0) throw new Error(`Unknown gate: ${requested}`);
const selectedSteps = gate ? [STEPS[offset]] : STEPS.slice(offset);
if (process.argv.includes('--list-json')) {
  console.log(JSON.stringify(selectedSteps.map(([label, command, args], index) => ({ index: offset + index + 1, label, command, args,
    budgetMs: budgetFor(label), skipAware: SKIP_AWARE.has(label), costGate: COST_GATED.get(label) ?? null,
    mutatesDist: shouldStopAfter(label, 'FAIL'), preconditions: ['fresh compiled source', 'no concurrent dist mutations'],
    previousSelectedGate: index > 0 ? selectedSteps[index - 1][0] : null,
  })), null, 2));
  process.exit(0);
}
if (requested) console.log(`SELECTED GATES: ${selectedSteps.length}/${STEPS.length}; other gates are not being claimed as executed`);
process.env.AMABIE_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'amabie-trust-oracle-'));
const runStep = (cmd, args, timeout, prefix) => runProbe(cmd, args, { cwd: AMABIE, shell: SH && cmd === 'npm', timeout, prefix });
for (const [label, cmd, args] of selectedSteps) {
  console.log(`\n=== ${label} ===`);
  const costGate = COST_GATED.get(label);
  if (costGate) {
    console.log(`SKIP  ${costGate}`);
    results.push([label, 'SKIP', costGate]);
    continue;
  }
  // v1.4 — a per-step budget, because one flat timeout killed a step whose MEASURED legitimate
  // runtime class exceeds it (master-pass: ~993 s against a 900 s cap). Finite everywhere still:
  // a real deadlock must be caught, it just must not be confused with a slow valid workload.
  const budget = budgetFor(label);
  const startedAt = new Date().toISOString();
  const stepPrefix = rawLogDir ? path.join(rawLogDir, String(results.length + 1).padStart(3, '0')) : undefined;
  console.log(`START ${label}; limit=${budget / 1000}s${stepPrefix ? `; live logs=${stepPrefix}` : ''}`);
  const r = await runStep(cmd, args, budget, stepPrefix);
  if (rawLogDir) {
    const prefix = path.join(rawLogDir, String(results.length + 1).padStart(3, '0'));
    fs.writeFileSync(`${prefix}.json`, JSON.stringify({ label, command: [cmd, ...args], cwd: AMABIE,
      budgetMs: budget, startedAt, finishedAt: new Date().toISOString(), status: r.status, signal: r.signal,
      error: r.error ? { code: r.error.code, message: r.error.message } : null, durationMs: r.durationMs }, null, 2), { flag: 'wx' });
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
  console.log(tail);
  const skipLines = SKIP_AWARE.has(label)
    ? out.split(/\r?\n/).filter((l) => l.startsWith('SKIP')).map((l) => l.slice(0, 140))
    : [];
  // Node's test runner exits 0 when a whole describe block is skipped. That
  // used to make pytest wiring look PASS on a host with no pytest interpreter,
  // even though the report said "tests 0". An explicit missing-interpreter
  // reason is a host-bound SKIP; any other zero-execution test result is a FAIL.
  const nodeTestStat = (name) => {
    const match = out.match(new RegExp(`^(?:\\s*ℹ\\s+|\\s*#\\s*)${name}\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const nodeTests = args.includes('--test') ? {
    total: nodeTestStat('tests'),
    passed: nodeTestStat('pass') ?? 0,
    failed: nodeTestStat('fail') ?? 0,
    skipped: nodeTestStat('skipped') ?? 0,
  } : null;
  const noNodeTestsExecuted = nodeTests !== null
    && nodeTests.total !== null
    && nodeTests.passed + nodeTests.failed === 0
    && (nodeTests.total === 0 || nodeTests.skipped === nodeTests.total);
  const missingPytestInterpreter = label === '1.1 Phase 2 pytest channel WIRING (real recorder round path)'
    && /no workspace-local pytest interpreter/.test(out);
  if (noNodeTestsExecuted && missingPytestInterpreter && SKIP_AWARE.has(label)) {
    skipLines.push('SKIP 0 pytest wiring tests executed: workspace-local pytest interpreter is unavailable');
  }
  // "the assertion did not hold" and "we ran out of time" are different facts; only the first is
  // evidence about the product. spawnSync reports the second as error.code ETIMEDOUT.
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const verdict = r.error && !timedOut ? 'FAIL'
    : noNodeTestsExecuted && r.status === 0
      ? (missingPytestInterpreter && SKIP_AWARE.has(label) ? 'SKIP' : 'FAIL')
      : verdictFor({ status: r.status, skipAware: SKIP_AWARE.has(label), timedOut });
  // M10.2 Fix 6: a SKIP that EXECUTED checks is a different fact from one that
  // ran zero because the environment is absent — the note must distinguish
  // them. Neither kind is ever counted as a PASS. The count is any `PASS <case>`
  // / `FAIL <case>` line, so it also measures the acceptance batteries, whose
  // cases are not prefixed `L` like the HTG corpus layers.
  const ran = SKIP_AWARE.has(label) ? out.split(/\r?\n/).filter((l) => /^(?:PASS|FAIL)\s+\S/.test(l)).length : 0;
  const skipNote = `host-bound: ${ran} check(s) EXECUTED, ${skipLines.length} explicit SKIP(s) — SKIP never counts as PASS` +
    (ran === 0 ? '; nothing here was accepted by execution' : '');
  const known = KNOWN_RUNTIME_MS[label];
  const note = verdict === 'SKIP' ? skipNote
    : verdict === 'INCOMPLETE'
      ? `DID NOT COMPLETE within its ${Math.round(budget / 1000)}s budget${known ? ` (the workload's measured legitimate class is ~${Math.round(known / 1000)}s)` : ''} — this is NOT a failed assertion, and NOT a pass`
      : verdict === 'FAIL' ? `(exit ${r.status}${r.error ? `: ${r.error.message}` : ''})` : '';
  results.push([label, verdict, note]);
  // v1.4 — CASCADE ISOLATION. A step that REWRITES dist and did not finish leaves bytes this run
  // cannot vouch for; MEASURED, one master-pass timeout manufactured FIVE later "failures". Restore
  // trusted bytes and stop, so the summary carries the ORIGINAL finding and nothing artificial.
  if (shouldStopAfter(label, verdict)) {
    const restored = (await runStep('npm', ['exec', '--', 'tsc', '-b', '--force'], 900_000)).status === 0;
    console.log(`\nBATTERY STOPPED after "${label}" (${verdict}).`);
    console.log('  This step REWRITES dist, so every later step would judge bytes this run cannot vouch for.');
    console.log('  The finding above is the ONLY one to act on; the steps below were NOT RUN.');
    console.log(`  trusted bytes restored: ${restored ? 'yes (tsc -b --force)' : 'NO — dist may be dirty, rebuild before trusting anything'}`);
    results.push([`(all ${selectedSteps.length - results.length} remaining selected step(s) NOT RUN — a dist-rewriting step did not finish)`, 'NOT RUN', 'cascade suppressed']);
    break;
  }
  if (verdict === 'FAIL' && label.startsWith('build')) break; // later steps judge stale bytes — stop honestly
}

console.log(`\n=== VERIFY-PRODUCTIZATION ${requested ? 'SELECTED GATES ' : ''}SUMMARY ===`);
for (const [label, verdict, note] of results) console.log(`${verdict}  ${label}${note ? `  — ${note}` : ''}`);
const failed = results.filter(([, v]) => v === 'FAIL').length;
const skipped = results.filter(([, v]) => v === 'SKIP').length;
const passed = results.filter(([, v]) => v === 'PASS').length;
const incomplete = results.filter(([, v]) => v === 'INCOMPLETE').length;
const notRun = results.some(([, v]) => v === 'NOT RUN');
// A chain that did not finish is not a pass, whatever the reason — but the reason is NAMED, because
// "a step timed out" and "an assertion failed" call for different responses.
if (failed || incomplete || notRun) {
  const bits = [
    failed ? `${failed} FAIL` : null,
    incomplete ? `${incomplete} DID NOT COMPLETE (timeout, not a failed assertion)` : null,
    notRun ? 'the chain stopped early' : null,
  ].filter(Boolean);
  console.log(`VERIFY-PRODUCTIZATION: NOT GREEN (${bits.join('; ')}${passed ? `; ${passed} PASS, ${skipped} SKIP` : ''})`);
} else if (skipped) {
  const zeroExec = results.filter(([, v, n]) => v === 'SKIP' && /^host-bound: 0 check\(s\) EXECUTED/.test(n)).length;
  const costGated = results.filter(([, v, n]) => v === 'SKIP' && n.startsWith('cost-gated:')).length;
  const hostSkipped = skipped - costGated;
  console.log(`VERIFY-PRODUCTIZATION: PASS WITH EXPLICIT SKIPS (${passed} PASS, ${skipped} SKIP — no skipped probe counts as a pass${hostSkipped ? `; ${hostSkipped} host-bound` : ''}${costGated ? `; ${costGated} live cost-gated and NOT RUN` : ''}${zeroExec ? `; ${zeroExec} host-bound SKIP step(s) executed zero checks` : ''})`);
} else {
  console.log(`VERIFY-PRODUCTIZATION: PASS (${passed}/${selectedSteps.length} selected steps green)`);
}
process.exit(failed || incomplete || notRun ? 1 : 0);
