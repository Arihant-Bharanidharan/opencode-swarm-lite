# Architecture

`opencode-swarm-lite` is an adaptive multi-model agent orchestration runtime for
OpenCode. This document explains the runtime's components, data flow, and failure /
recovery behavior.

## High-level diagram

```
                    Parent Coordinator
                           │
                    Cost / Policy Engine
                           │
                    Task DAG Planner
                           │
        ┌──────────────────┼───────────────────┐
        │                  │                   │
      SERIAL             BATCHED_WORKER      PIPELINE
        │                  │                   │
        └───────────┬──────┴────────────┬──────┘
                    │                   │
              SPECULATIVE          FULL_SWARM / SMALL_SWARM
                    │                   │
                    └─────────┬─────────┘
                              │
                    Provider Portfolio Router
                              │
              ┌───────────────┼───────────────┐
              │               │               │
           Model A         Model B         Model C
                              │
                    Trust / Reliability Layer
                              │
                    Checkpoints & Run Manifests
                              │
        Durable Events · Selective Rollback · Crash Recovery
```

## Components

### Parent coordinator

There is **one parent**. The parent model remains the only orchestration loop and is
the only entity that calls `subagent`. Scheduler tools (`swarm_plan`, `swarm_route`,
`swarm_capsule`, `swarm_lane`, `swarm_record`, `swarm_verify`, etc.) are advisory —
they never spawn agents.

### Adaptive scheduler (`src/runtime/scheduler.ts`)

Estimates serial vs every swarm shape (`SERIAL`, `SMALL_SWARM`, `FULL_SWARM`,
`SPECULATIVE_SWARM`, `PIPELINE`, `BATCHED_WORKER`). Serial is the default; fan-out must
clear a speedup bar (`minSpeedupSwarm`, `minSpeedupBatch`, `minSavingsSeconds`). Applies
SLA mode, deadline pressure, and the cost guard.

### Predictor (`src/runtime/predictor.ts`)

Derives the nine-field snake_case `PlanPredictors` contract from the live plan:
`estimated_serial_time`, `estimated_swarm_time`, `estimated_parallel_efficiency`,
`estimated_startup_cost`, `estimated_verification_gain`, `recommended_topology`,
`recommended_agent_count`, `recommended_models`, `confidence`.

### Task DAG planner (`src/runtime/schedule.ts`)

Builds waves/batches and a critical-path schedule when dependency edges are present
(PIPELINE topology). Reports makespan, serial time, concurrency, and utilization.

### Provider portfolio router (`src/runtime/provider.ts`, `portfolio-router.ts`)

- `Router`: picks model/provider per lane using health, trust, quality, and cost scores
- `ProviderHealth`: circuit breaker (closed / open / half_open) with failure and timeout
  thresholds
- `PortfolioRouter`: trust-aware routing blend with degrade / reallocate feedback loop;
  blocked providers are excluded from `routeDecision`

### Trust layer (`src/runtime/trust.ts`)

`TrustStore` maintains per-model / per-skill-category trust snapshots with
decay-weighted scoring, first-attempt pass rate, verification failure rate, and
hallucination rate. Feeds into portfolio routing.

### Persistence (`src/runtime/run-manifest.ts`, `checkpoint.ts`, `capsules.ts`,
`history.ts`, `telemetry.ts`)

- `RunManifestStore`: durable run manifests with idempotent opId dedupe;
  `incomplete()` lists RUNNING runs; terminal states excluded
- `CheckpointManager`: checkpoints, snapshots, selective rollback; milestone-based
  resume / restart decisions
- `CapsuleStore`: versioned context capsules (facts, files, invariants, blockers,
  commands, failed approaches, provenance)
- `RunHistory`: completed-run records and task-shape baselines
- `Telemetry`: append-only durable event log (SPAWN, ASSIGN, LANE_DONE, LANE_FAIL,
  chaos injections, etc.)

### Verification (`src/runtime/verify.ts`)

Adaptive verification ladder V0 (self-check) → V4 (adversarial verifier). Chooses level
from risk, disagreement, confidence, deterministic tests, and test strength. Confidence
calibration tracks reported vs observed accuracy.

### Mixed-strategy scheduler (`src/runtime/mixed-strategy.ts`)

SLA modes (`FASTEST`, `CHEAPEST`, `HIGHEST_QUALITY`, `BALANCED`, `LOWEST_PROVIDER_RISK`),
deadline pressure, anytime stages (`PRELIMINARY` → `VERIFIED` → `FINAL`), ROI
cancellation with hysteresis, cost guard, strategy transitions.

### Coordinator crash recovery (`src/runtime/coordinator.ts`)

`RunCoordinator` with idempotent result application, COMPLETE / CANCEL terminal states,
crash recovery with resume / restart decisions, and forced provider restoration.

### Learning / policy (`src/runtime/policy.ts`, `sla.ts`, `roi.ts`, `selftuning`)

Self-tuning policy with promotion / rollback gates, shadow policy, manual override,
branch ROI, information-gain scheduling, straggler detection, hedging.

### Observability (`src/runtime/dashboards.ts`)

Scheduler dashboard, provider health dashboard, calibration dashboard, waste breakdown,
multi-dimensional grading.

## Data flow

1. **Task input** arrives with shape hints (branches, branchSeconds, independence,
   sharedContext, ambiguity, risk, verificationValue, deadline, SLA mode).
2. **Cost / policy engine** estimates serial vs every swarm shape, applies SLA and
   deadline pressure, runs the cost guard.
3. **Task DAG planner** builds waves/batches and critical-path schedule (PIPELINE).
4. **Provider portfolio router** picks model/provider per lane using health, trust, and
   reliability; blocked providers excluded.
5. **Execution** dispatches lanes in waves (token-bucket rate limited), with warm-lane
   reuse, straggler detection, hedging.
6. **Verification** runs adaptively (V0–V4); refine loop converges on quality.
7. **Recovery**: run manifests, checkpoints, and the coordinator resume/restart on
   crashes; selective rollback to prior snapshots.

## Failure / recovery flow

```
Lane fails / provider 429 / timeout
        │
        ▼
ProviderHealth opens circuit (cooldown)
        │
        ▼
PortfolioRouter excludes blocked provider, reallocates
        │
        ▼
Coordinator crash?
        ├─ Yes → RunManifestStore.incomplete() lists RUNNING runs
        │         → RunCoordinator decides resume (from checkpoint) vs restart
        │         → Forced provider restoration if needed
        └─ No  → Continue execution
        │
        ▼
Integration + adaptive verification
        │
        ▼
Run closed; actuals recorded; telemetry + dashboards updated
```
