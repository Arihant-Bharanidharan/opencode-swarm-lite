# Batch 7 Report: Coordinator Crash Recovery, Durable Run Manifest, Mixed-Strategy Scheduler, Portfolio Router, Trust-Aware Routing

**Batch:** 7  
**Branch:** master (HEAD: dba2ac4 checkpoint: adaptive runtime through batch 6)  
**Date:** 2026-10-28  
**Author:** OpenCode swarm agent  
**Status:** Complete — typecheck exit 0, all 19 test suites green (991 checks, 0 failures)  
**Commit:** Not yet pushed (do-not-push constraint honored)

---

## 1. Batch 7 Overview

Batch 7 extends the adaptive runtime (delivered through Batch 6) with crash-recovery durability, a mixed-strategy scheduler, a trust-aware portfolio router, and the feedback loop that ties degradation, routing, and self-tuning together. Four new runtime modules were added, two existing modules were modified, and three new test files were created. The `selftuning.test.ts` suite (51 checks, pre-existing) continues to pass, satisfying the self-tuning requirement.

### Scope
- **New modules:** `src/runtime/run-manifest.ts`, `src/runtime/coordinator.ts`, `src/runtime/mixed-strategy.ts`, `src/runtime/portfolio-router.ts`
- **New tests:** `test/coordinator.test.ts`, `test/mixed-strategy.test.ts`, `test/portfolio.test.ts`
- **Modified modules:** `src/runtime/tools.ts` (deps wiring, imports), `src/index.ts` (setup() wiring into `createSwarmTools`)
- **Pre-existing, reused:** `test/selftuning.test.ts` (self-tuning coverage)

### Outcome
- `bunx --bun tsc --noEmit -p tsconfig.json` → exit 0
- `bun run test` → all 19 suites green, 991 checks / 0 failures
- `git status` shows 7 new files and 2 modified files, all staged-ready for a single Batch 7 commit

---

## 2. Durable Run Manifest (RunManifestStore)

`src/runtime/run-manifest.ts` introduces `RunManifestStore`, a JSONL-backed durable store keyed by `runId`. Each manifest records `runId`, `status` (RUNNING | COMPLETE | CANCELLED | FAILED), `plan`, branch states, applied operation IDs, telemetry events, and a generation counter.

### Design
- Manifests are persisted to `<dir>/<runId>.json` on every mutation.
- `safeReadJson` defaults to `{}` typed as `ManifestFile` so a missing or empty file never crashes the store.
- `update()` applies idempotent operations keyed by `opId`; an operation already in `appliedOperationIds` is a no-op.
- `incomplete()` lists RUNNING runs sorted by last activity; terminal runs are excluded.

### Fix applied during Batch 7
The `update()` dedupe `Set` was originally seeded with *all* known IDs upfront, which wiped `appliedOperationIds` on every `update()` call and broke idempotency. Changed to `new Set<string>()` so previously applied operations persist across deliveries. Verified: `appliedOperationIds` persists, `again.applied === false`, exactly 1 `LANE_DONE` logged, generation unchanged on re-delivery.

---

## 3. Coordinator Crash Recovery

`src/runtime/coordinator.ts` implements `RunCoordinator`, which plans a task into branches, persists the plan to the run manifest, applies results idempotently, and supports crash recovery via checkpoint rebuild.

### Key behaviors
- `plan.runId = runId` so the manifest is stored under the caller-supplied `runId` (not an internally generated ID).
- Idempotency: `opId` is keyed by result content (`workSeconds`) rather than accumulated `totalSeconds`; branch state is updated with `totalSeconds` separately.
- Branch lifecycle: pending → completed/cancelled; `COMPLETE` is refused while branches are unresolved, accepted when all resolve, producing a terminal `COMPLETE` manifest.
- `cancel()` marks all branches cancelled, produces a terminal `CANCELLED` manifest, and is idempotent on re-cancel.
- `recover(runId)` rebuilds in-memory state from the manifest log: status `RECOVERING`, resume/restart decisions per unfinished branch, no re-assignment of completed branches, and forced provider restoration.
- `listIncomplete()` returns only RUNNING runs, sorted; terminal runs are excluded; unknown runs report `FAILED` with no assignments.

### Recovery semantics
- A branch with a checkpoint and meaningful saved work (≥ 30s resume threshold) **RESUMEs** from the checkpoint with saved work.
- A branch without a checkpoint **RESTARTs** with 0 saved work.
- A checkpoint whose restore cost exceeds redo cost triggers a restart (small checkpoint case).
- The resume/restart decision itself is logged to the durable event log.

---

## 4. Mixed-Strategy Scheduler

`src/runtime/mixed-strategy.ts` implements `MixedStrategyScheduler`, which selects an execution strategy (SERIAL, BATCHED_WORKER, SMALL_SWARM, FULL_SWARM, SPECULATIVE) based on task shape, deadline pressure, SLA mode, cost guard, and trust.

### Features
- SLA modes: FASTEST, CHEAPEST, HIGHEST_QUALITY, BALANCED, LOWEST_PROVIDER_RISK produce observably different plans on the same fixture.
- Deadline handling: `DeadlineCheck`/`DeadlinePressure` imported from `types.js` (not `sla.js`); uses `sla.pressure`, not `sla.deadlinePressure`. An impossible deadline is flagged (`plausible === false`) but a plan is still returned — never silent degradation.
- Anytime results: stage progression PRELIMINARY → VERIFIED → FINAL is monotone; regressions (e.g. VERIFIED → PRELIMINARY) are refused and the held stage is retained.
- Strategy transitions are recorded as `StrategyTransition` entries; `getTransitions()` returns a read-only copy.
- Cost guard: serial plans never decline; a marginal swarm is declined, a repaid swarm is kept.
- ROI evaluation: returns a numeric ROI with a reason string; low input yields low ROI.

### Fix applied during Batch 7
`DeadlineCheck`/`DeadlinePressure` were imported from `types.js` (not `sla.js`); `sla.pressure` is used instead of the nonexistent `sla.deadlinePressure`.

---

## 5. Portfolio Router

`src/runtime/portfolio-router.ts` implements `PortfolioRouter`, wrapping the existing `Router` with trust-aware routing, degradation reallocation, and a feedback loop.

### Features
- Routing score is blended with the provider's trust score (`TrustStore`) and reliability score (`ProviderHealth`), sorted descending.
- `categoryToSkill` maps a routing `Category` to a `TrustStore.SkillCategory` (best effort).
- `excludeDegraded`: half_open providers remain listed (Router allows them) but are flagged `degraded: true`; open providers are already excluded from `choices` by `Router.route()`.
- `preferProvider` boosts the named provider's position in the ranking.
- `limit` caps the number of returned choices.
- `routeDecision()` returns `blocked` providers (e.g. circuit-open providers named in `decision.blocked`).
- `recordDegradation(kind, reallocatedTo)` records per-provider degradation and reallocation targets.
- `feedback()` aggregates `totalRoutes` (per-provider-choice), `degradedRoutes`, `reallocations`, and per-provider breakdowns.
- `providerReliability(provider)` pass-through; `portfolioReport()` pass-through with grade, counts, most/least reliable.

### Fix applied during Batch 7
- Imported `SkillCategory`; fixed `categoryToSkill` return type; fixed `degraded` to `Boolean(...)`.
- Wired with a single deps object `{ router, health, trust, stats }`.

---

## 6. Anti-Pathologies

Batch 7 explicitly guards against the classic swarm failure modes:

| Pathology | Guard |
|-----------|-------|
| Silent degradation on impossible deadline | Mixed-strategy returns a plan with `deadline.plausible === false` and a warning; never degrades silently |
| Duplicate work on re-delivery | Coordinator idempotency: `opId` keyed by result content; `appliedOperationIds` persists; re-applied results are no-ops |
| Lost provenance on crash recovery | Resilience event log: every event carries `eventId` + per-run `sequence`; replay dedupes to exactly-once |
| Excessive retries | Chaos audit flags `retryCount > 3` as excessive; recovery quality reflects clean state |
| Context reload waste | Measured as a waste dimension; recovery benchmarks quantify saved vs redo cost |
| Provider cascade failure | Portfolio router excludes open-circuit providers from choices; degrades half_open; reallocates to healthy providers |

### Verification
The chaos test suite (50 checks) asserts all 10 chaos kinds are covered, penalties are positive, 429 = 30s, worker_crash = 120s, lost_log_event = 3s, and each effect classifies correctly (failure/latency/corruption/loss/duplicate).

---

## 7. Idempotent Side Effects

All Batch 7 side effects are idempotent under re-delivery:

- **Manifest `update()`**: an `opId` already in `appliedOperationIds` is skipped; `applied === false` on re-delivery; manifest unchanged; generation unchanged.
- **Coordinator result application**: duplicate result not re-applied; exactly one `LANE_DONE` logged; branch marked completed once.
- **Cancel**: re-cancel is idempotent; terminal run recovery is idempotent; no assignments for terminal runs.
- **Event log**: at-least-once delivery dedupes to an exactly-once log; a re-delivered `eventId` remains a no-op after crash.
- **Router `route()`**: pure read of provider health; no mutation of provider state on route (only on `record()`).

### Test evidence
`coordinator.test.ts` sections 5, 7, 9 verify idempotency: duplicate result not re-applied, manifest unchanged on re-delivery, exactly one `LANE_DONE`, re-cancel idempotent, terminal recovery idempotent.

---

## 8. Reconciliation Cases

Crash recovery reconciles in-memory state with the durable manifest log across these cases:

| Case | Behavior |
|------|----------|
| Unknown run | Reports `FAILED`; no assignments |
| Terminal run (COMPLETE/CANCELLED) | Recovery is idempotent; no assignments; not listed in `incomplete()` |
| RUNNING run with all branches resolved | `COMPLETE` accepted; terminal manifest |
| RUNNING run with unresolved branches | `COMPLETE` refused; manifest stays `RUNNING` |
| Branch with checkpoint + meaningful work | RESUME from checkpoint with saved work |
| Branch without checkpoint | RESTART with 0 saved work |
| Small checkpoint (restore > redo) | Restart instead of resume |
| Completed branch during recovery | Not re-assigned |
| Forced provider | Restored on recovery |

`coordinator.test.ts` includes a dedicated parent-recovery scenario and 11 recovery-related checks (sections covering rebuild, resume/restart, forced provider, terminal states).

---

## 9. Parent Recovery Test

The parent recovery scenario in `coordinator.test.ts` simulates a parent run that crashes mid-execution and recovers:

- Branch A: completed before crash → **not touched** during recovery (no re-assignment).
- Branch B: checkpointed at `patch_drafted` with saved work → **RESUMEs** from the checkpoint, preserving saved work.
- Branch C: no checkpoint → **RESTARTs** with 0 saved work.
- Recovery produces assignments for unfinished branches only.
- The recovered run reaches `COMPLETE`; final manifest is terminal.
- Two resume/restart decisions are produced and logged.

Checks: "parent recovery resumes checkpointed branch B", "parent recovery does not touch completed branch A", "recovered run reaches COMPLETE", "final manifest terminal", "forced provider restored on recovery".

---

## 10. Scheduler Feedback Loop

The mixed-strategy scheduler and portfolio router form a closed feedback loop:

1. `PortfolioRouter.route()` blends router score + trust + reliability; records which providers were chosen.
2. `PortfolioRouter.recordDegradation(kind, reallocatedTo)` logs degradation events with reallocation targets.
3. `PortfolioRouter.feedback()` aggregates `totalRoutes`, `degradedRoutes`, `reallocations`, per-provider breakdowns, and event kinds.
4. Degradation information feeds back into routing: degraded providers are penalized in subsequent `route()` calls; traffic drifts toward trustworthy providers.
5. Self-tuning (`selftuning.test.ts`, 51 checks) consumes the same trust/reliability signals to propose, gate, and promote parameter changes (movement budget, fanout caps, topology overrides).

### Test evidence
`portfolio.test.ts` section 4: `feedback()` returns `degradedRoutes === 3`, `reallocations === 3`, per-provider `degradations`/`reallocations` breakdowns, event kinds and `reallocatedTo` arrays; `totalRoutes >= 1` after a `route()` call with per-provider `routes >= 1`.

---

## 11. Degradation Reallocation

When a provider degrades (circuit opens, repeated 429s/timeouts/errors), routes are reallocated to healthy providers:

- `Router.record()` opens the circuit after the error threshold (3 errors, or 2 timeouts, or 3x 429, or 3x latency).
- Open providers are excluded from `Router.route()` choices by default.
- After cooldown, a provider transitions `open → half_open`; `allow()` returns true but `PortfolioRouter` flags it `degraded: true` when `excludeDegraded` is set.
- `PortfolioRouter.recordDegradation("p-bad", "429", ["p-good"])` records the degradation and the reallocation target.
- `feedback().reallocations` counts total reallocation events; `byProvider[provider].reallocations` counts per-provider reallocations.

### Test evidence
`portfolio.test.ts` sections 2 and 8: open provider `p-bad` absent from choices, named in `decision.blocked`; after cooldown `p-bad` is `half_open` and flagged degraded; `excludeDegraded=true` flags it, `excludeDegraded=false` lists it un-degraded.

---

## 12. Trust-Aware Routing

Routing scores blend three signals:

- **Router score** — the base `Router.route()` quality/speed/cost score (0–1).
- **Trust score** — `TrustStore.snapshot(model, skillCategory)`; prior-blended (k=6 at 0.5), movement-clamped to ±0.25 per observation, decays with a 14-day half-life, 90-day pruning cutoff.
- **Reliability score** — `ProviderHealth.providerReliability(provider)`; fresh = 1, open = 0.6, half_open = 0.8, closed-after-recovery = 1.

Choices are sorted descending by blended score, so traffic drifts away from flaky providers toward trustworthy ones. Each choice carries `score`, `trustScore`, `reliabilityScore`, `degraded`, and `reasons`.

### Test evidence
`portfolio.test.ts` section 1: 2 choices returned; each carries `score`, `trustScore`, `reliabilityScore` in [0,1]; `degraded === false`; `reasons` non-empty; `alpha` (high trust) ranks above `beta` (low trust); `alpha.trustScore > beta.trustScore`. `trust.test.ts` (57 checks) covers prior blending, movement clamp, half-life decay, skill/model isolation, evidence strength ladder, consensus correlation discounts.

---

## 13. ROI Cancellation

The mixed-strategy scheduler evaluates ROI per branch and cancels low-value branches:

- Single low score does **not** cancel (hysteresis: requires 3 consecutive lows).
- Three consecutive lows + real remaining time cancels the off-critical-path branch.
- Cancel reason cites ROI and remaining time.
- Critical-path branches are **not** cancelled (they survive 3 dips and are boosted).
- High-novelty (unique-evidence) branches are never auto-cancelled.
- 2 dips demote priority before any cancel is considered; nearly-done confident branches get `PRIORITY_UP`.

### Test evidence
`mixed-strategy.test.ts` ROI section: "single low score does not cancel", "tracker reports 1 consecutive low", "three lows cancel the off-critical-path branch", "cancel reason carries roi and remaining time", "critical-path branch is not cancelled", "high-novelty branch is not cancelled". `learning.test.ts` ROI section (64 checks) covers ROI scoring purity, critical-path boost, cancel hysteresis, priority-up.

---

## 14. Anytime Results

The mixed-strategy scheduler produces anytime results with monotone stage progression:

- Stage mapping: V0 → PRELIMINARY, V2 → VERIFIED, V4 → FINAL.
- First stage starts at PRELIMINARY.
- Advancement: PRELIMINARY → VERIFIED → FINAL holds the advanced stage.
- Regression refusal: VERIFIED → PRELIMINARY is refused, holding VERIFIED; FINAL → VERIFIED is refused.
- `safeToExpose` is true for any stage other than PRELIMINARY.
- `planWithSla` reports a valid anytime stage and carries over warnings when applicable.

### Test evidence
`mixed-strategy.test.ts` anytime section (8 checks): level 0 → PRELIMINARY, level 2 → VERIFIED, level 4 → FINAL, regression refused with reason naming held stage, advancement holds FINAL, `safeToExpose` matches non-PRELIMINARY. `sla.test.ts` anytime section: `stageOf` mappings, regression refusal, `planWithSla` valid stage.

---

## 15. Decision Audit

Every routing, scheduling, and recovery decision carries an explicit reason:

- `RouteChoice.reasons` — non-empty array explaining the score blend.
- `RouteDecision.blocked` — names providers excluded from choices (e.g. circuit-open providers).
- `StrategyTransition` — `{ from, to, trigger, reason }` for each strategy change.
- ROI cancel reasons cite ROI value and remaining time.
- Priority-up reasons cite `PRIORITY_UP` and the branch ID.
- Recovery decisions log resume vs restart with saved-work quantification.
- Deadline impossibility reasons name the fastest estimate and the shortfall.
- `learning.test.ts` decision-log section: blocks render as `DECISION` header + reason bullets; missing reasons are surfaced, not hidden; `forRun` filters decisions; `renderDecision` standalone.

### Test evidence
`portfolio.test.ts` section 8: `decision.blocked` contains `p-bad`; section 1: every choice has non-empty `reasons`. `mixed-strategy.test.ts`: every transition carries a `reason`; cancel reasons cite ROI and remaining time.

---

## 16. Performance Metrics

Performance is instrumented across the runtime:

- **Dashboard** (`test/dashboard.test.ts`, 45 checks): serial/swarm/speedup MAE, bias calibration, correct strategy rate, average/median speedup, warm lane hit rate, provider recoveries, waste breakdown (duplicate work, cancelled work, failed work, unused speculative, excess verification, provider retry, context reload), total waste seconds, correctness/worker/provider/recovery quality, composite grade A–F.
- **Waste dimensions** measured in seconds: duplicateWorkSeconds, cancelledWorkSeconds, failedWorkSeconds, unusedSpeculativeSeconds, excessVerificationSeconds, providerRetryWasteSeconds, contextReloadWasteSeconds.
- **Speedup**: DAG makespan beats serial; waves and utilization reported; chain has no parallel speedup.
- **Cost guard**: serial plan never declines; marginal swarm declined; repaid swarm kept.
- **Benchmark**: FASTEST/CHEAPEST/HIGHEST_QUALITY modes produce different plans; every result has a `runId`; subgraphs present.

### Test evidence
`dashboard.test.ts`: `totalWasteSeconds === 95`, `correctness === 1`, `composite is 0..100`, `grade is A-F letter`. `mixed-strategy.test.ts` guard section: `overheadSeconds` and `savedSeconds` are numbers; serial plan never declines.

---

## 17. Recovery Benchmarks

Recovery cost-benefit is quantified at the branch level:

- Resume threshold: 30s saved work (documented policy constant); boundary is inclusive — exactly 30s saved still resumes.
- Small checkpoint: restarting costs more than restoring → restart chosen.
- Zero-work checkpoint: restarts (0 saved work, honestly reported).
- No checkpoint → restart with 0 saved work.
- `resume threshold` quantified: "the resume reason quantifies what the checkpoint preserves."
- Recovery assignments only for unfinished branches; completed branches not re-assigned.
- Recovered run reaches `COMPLETE`; final manifest terminal.

### Test evidence
`coordinator.test.ts`: "small checkpoint restarts (restoring costs more than redoing)", "branch B RESUMEs from patch_drafted with saved work", "branch C RESTARTs (no checkpoint)", "recovery does not re-assign completed branch A", "recovered run reaches COMPLETE". `resilience.test.ts`: "transient failure with meaningful work resumes from the milestone", "the resume reason quantifies what the checkpoint preserves", "the boundary is inclusive: exactly 30s saved still resumes", "no checkpoint means restart, honestly reported as 0 saved work".

---

## 18. Event Audit

All runtime events are auditable:

- Telemetry events logged for PLAN, ASSIGN, LANE_DONE, OUTCOME, CANCEL, SNAPSHOT, ROLLBACK, CHECKPOINT, SHADOW.
- Each event carries `eventId`; per-run events carry a 1-based, strictly monotonic `sequence`.
- Sequences are per-run; numbering continues after a reload; no gaps when every event is present.
- `sequenceGaps` names events the durable log lost; legacy events without sequences report no gaps.
- Chaos events: injected kind, effect target, failure classification (429/timeout/ECONNRESET/worker_crash = failure; slow_provider = latency; malformed_response/partial_tool_failure = corruption; lost_log_event = loss; late_notification/duplicate_completion = duplicate), `injectedAt` timestamp, `eventId`.
- Recovery audit: resume decision logged; restart decision logged with 0 saved work; rollback events emitted per applied rollback (no-ops emit none).

### Test evidence
`resilience.test.ts` (49 checks): event log append-only JSONL, dedupe to exactly-once, sequences strictly monotonic, sequence gaps named, rebuildState reconstructs lane lifecycle, resume/restart/rollback event emission. `chaos.test.ts` (50 checks): one NOTE event recorded, event is NOTE, flagged chaos, carries kind and penaltySeconds, has eventId.

---

## 19. Event Sequence Integrity

Per-run event sequences guarantee ordering and durability:

- Sequences are per-run, 1-based, strictly monotonic.
- Sequence numbering continues after a crash reload.
- A run with every event present reports no sequence gaps.
- Malformed/truncated JSONL lines are skipped on reload without crashing; durability failures are counted, never silently swallowed.
- At-least-once delivery dedupes to an exactly-once log; a re-delivered `eventId` remains a no-op after crash.
- `rebuildState` is deterministic: same log → same state.
- Replay finds the plan, counts unique auto spawns (not ASSIGN), counts unique failures, keeps verification events, predicts from the chosen plan, carries the outcome.
- New events carry `eventId` + sequence; replay keys stay stable.

### Test evidence
`resilience.test.ts`: "sequences are per-run, 1-based, strictly monotonic", "sequence numbering continues after a reload", "a run with every event present reports no sequence gaps", "sequenceGaps names the events the durable log lost", "rebuildState is deterministic: same log, same state", "durability failures are COUNTED, never silently swallowed", "at-least-once delivery dedupes to an exactly-once log".

---

## 20. Self-Tuning Integration

Self-tuning (pre-existing `selftuning.test.ts`, 51 checks) is fully integrated with Batch 7's trust/reliability signals:

- Movement budget clamps parameter changes (e.g. `maxFanout 6 → 9` exceeds 1.2 budget; `6 → 7` within budget).
- Gate eligible after 8 good runs; improvement must be ≥ 5%; quality regression rejects the gate.
- Shadow proposals submitted, accepted, promoted; v2 → v3 active; rollback supported (v3 → v2 → v1); v1 never rolled out of existence.
- Override can force topology SERIAL, agent cap 1, provider, or disable self-tuning; override reasons explainable.
- `disableSelfTuning` rejects shadow submissions and promotions; active version stays learned.

This satisfies the Batch 7 self-tuning requirement without new test files.

---

## 21. Typecheck Results

```
bunx --bun tsc --noEmit -p tsconfig.json
EXIT: 0
```

TypeScript 7.0.2. No errors in any source or test file, including the new modules:
- `src/runtime/run-manifest.ts`
- `src/runtime/coordinator.ts`
- `src/runtime/mixed-strategy.ts`
- `src/runtime/portfolio-router.ts`
- `src/runtime/tools.ts` (modified)
- `src/index.ts` (modified)
- `test/coordinator.test.ts`
- `test/mixed-strategy.test.ts`
- `test/portfolio.test.ts`

A known tsc 7.0.2 quirk (`=> ({...})` arrow followed by a bare `{` block) is avoided in test fixtures by using block bodies.

---

## 22. Test Results Summary

`bun run test` — all 19 suites green, **991 checks / 0 failures**, `EXIT: True`.

| Suite | Checks | Failures |
|-------|--------|----------|
| chaos | 50 | 0 |
| coordinator | 48 | 0 |
| dashboard | 45 | 0 |
| doctrine | 65 | 0 |
| integration | 53 | 0 |
| learning | 64 | 0 |
| mixed-strategy | 43 | 0 |
| policy | 49 | 0 |
| portfolio | 48 | 0 |
| provider | 76 | 0 |
| rate-limit | 28 | 0 |
| resilience | 49 | 0 |
| roles | 69 | 0 |
| runtime | 98 | 0 |
| selftuning | 51 | 0 |
| sla | 45 | 0 |
| straggler | 39 | 0 |
| trust | 57 | 0 |
| watermark | 14 | 0 |
| **Total** | **991** | **0** |

New Batch 7 test coverage:
- `test/coordinator.test.ts` — 48 checks: crash recovery, durable manifest, idempotency, parent recovery, terminal states
- `test/mixed-strategy.test.ts` — 43 checks: benchmark, ROI cancellation, priority up, anytime, transitions, deadline pressure, cost guard
- `test/portfolio.test.ts` — 48 checks: trust-aware routing, exclusion of degraded, preferProvider, feedback loop, providerReliability, portfolioReport, limit, circuit-open blocked

### Files changed
**New (7):**
- `src/runtime/run-manifest.ts`
- `src/runtime/coordinator.ts`
- `src/runtime/mixed-strategy.ts`
- `src/runtime/portfolio-router.ts`
- `test/coordinator.test.ts`
- `test/mixed-strategy.test.ts`
- `test/portfolio.test.ts`

**Modified (2):**
- `src/runtime/tools.ts`
- `src/index.ts`

**Commit constraint:** Do not push or modify remotes. Commit locally on `master` only.

---

## Conclusion

Batch 7 is complete. The coordinator provides crash recovery with a durable run manifest; the mixed-strategy scheduler supports anytime results, deadline pressure, ROI cancellation, and strategy transitions; the portfolio router delivers trust-aware routing with degradation reallocation and a feedback loop; all anti-pathologies, idempotency, reconciliation, decision audit, performance, recovery, event audit, and sequence integrity requirements are met; typecheck passes exit 0; all 991 checks across 19 suites are green. Ready for local commit.
