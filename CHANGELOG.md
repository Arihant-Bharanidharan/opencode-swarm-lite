# Changelog

All notable changes to `opencode-swarm-lite` are documented in this file.

## [2.0.0] — Adaptive Swarm Runtime (this release)

First proper public release. The runtime predicts whether parallelism is economically
worthwhile before spawning workers, chooses among serial / batched / small swarm /
full swarm / speculative swarm / pipeline topologies, routes work across models and
providers according to health and trust, recovers checkpointed runs after coordinator
failure, and adapts verification effort.

### Adaptive planning
- Cost-aware scheduler (`AdaptiveScheduler`) estimates serial vs every swarm shape;
  serial is the default, fan-out must clear a speedup bar
- Nine-field snake_case predictor contract published on every plan:
  `estimated_serial_time`, `estimated_swarm_time`, `estimated_parallel_efficiency`,
  `estimated_startup_cost`, `estimated_verification_gain`, `recommended_topology`,
  `recommended_agent_count`, `recommended_models`, `confidence`
- Topologies: `SERIAL`, `SMALL_SWARM`, `FULL_SWARM`, `SPECULATIVE_SWARM`, `PIPELINE`,
  `BATCHED_WORKER`
- Speculative fan-out, task batching, critical-path scheduling, ROI cancellation,
  information-gain scheduling

### Runtime execution
- Specialist subagent lanes (architect, builder, verifier, coder, researcher,
  reviewer, multimodal analyst) plus an extensible role registry (add / modify /
  broaden at runtime)
- Work stealing, warm-lane reuse, lane-to-lane relay communication
- Deadline pressure, anytime stages (`PRELIMINARY` → `VERIFIED` → `FINAL`),
  straggler detection, hedging
- Token-bucket dispatch rate limiting (default 4/s, burst 8)

### Multi-model / provider routing
- Provider reliability tracking with circuit breaker (closed / open / half_open)
- Portfolio routing with trust-aware specialization
- Degrade / reallocate feedback loop, `recordDegradation` / `feedback()`
- Rate-limit-aware behavior; quota limits are respected — no quota bypassing
- Multi-model means routing across LLM models/providers, not image/audio multimodality

### Verification
- Adaptive verification (V0 self-check → V4 adversarial verifier)
- Confidence calibration, trust scoring, diversity-aware consensus
- Deterministic verification preference, provenance tracking

### Resilience
- Durable event log, checkpoints, snapshots, selective rollback
- Durable run manifests with idempotent opId dedupe
- Coordinator crash recovery with resume / restart decisions and forced provider
  restoration
- Idempotent replay

### Learning / policy
- Historical runtime signals, self-tuning policy with promotion / rollback gates
- Shadow policy, manual override
- SLA modes: `FASTEST`, `CHEAPEST`, `HIGHEST_QUALITY`, `BALANCED`, `LOWEST_PROVIDER_RISK`

### Observability
- Scheduler dashboard, provider health dashboard, calibration dashboard
- Waste breakdown, multi-dimensional grading, telemetry and replay

### Benchmarks
- 5-task clean parallel subset: serial 68.07 min vs adaptive swarm 13.67 min →
  **4.98× speedup**, 86.1% parallel efficiency, identical correctness
- 8-task whole workload: serial Σ 155.02 min vs corrected swarm wall 57.78 min →
  **2.68× corrected speedup** (predicted 1.66×), 8/8 correctness both arms
  - Raw swarm wall was 658.3 min; an overnight server outage is disclosed and
    excluded from the corrected figure
- Negative result: ~30 s tasks run worse under swarm (~439 s answers / ~589 s
  completion vs ~293 s serial) — startup/orchestration overhead dominated; this
  motivated the cost predictor

## [1.4.0] — Extensible specialist role registry

- Add, modify, and broaden specialist roles at runtime (append-only markdown registry,
  hot-reloaded skill, compaction cooldown prune)
- 69 registry tests
- `/swarm-roles` command

## [1.3.0] — Lane doctrine

- Seven working rules for parallel lanes (evidence over assertion, scope fence,
  read-before-write, one truth per fact, fail loudly early, deterministic finish,
  no self-promotion)
- Adaptive lane rubric + anti-default guarantee + per-task lane hint

## [1.2.1] — Lane-to-lane relay communication

- Append-only relay file for lane coordination and handoffs

## [1.2.0] — Adaptive lane rubric

- Per-task word-count lane hint scaling with prompt size

## [1.1.0] — Base subagent execution

- Initial adaptive-or-manual swarm modes, specialist role briefs, refine loop,
  auto-compaction, shared memory
