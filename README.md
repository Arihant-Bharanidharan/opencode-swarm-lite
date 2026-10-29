# opencode-swarm-lite

> **An adaptive execution runtime that knows when to swarm — and when not to.**

[![npm version](https://img.shields.io/npm/v/opencode-swarm-lite.svg)](https://www.npmjs.com/package/opencode-swarm-lite)
[![CI](https://github.com/Arihant-Bharanidharan/opencode-swarm-lite/actions/workflows/ci.yml/badge.svg)](https://github.com/Arihant-Bharanidharan/opencode-swarm-lite/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-991%20passed-brightgreen)](#testing)
[![license](https://img.shields.io/npm/l/opencode-swarm-lite.svg)](LICENSE)

`opencode-swarm-lite` is an adaptive multi-model agent orchestration runtime for
[OpenCode](https://opencode.ai). It predicts whether parallel agents are worth
spawning, chooses different execution strategies across task subgraphs, routes work
according to model/provider health and trust, adapts verification effort, and can
recover checkpointed swarm runs after coordinator failure.

**The goal is not for the swarm to always win. The goal is for the scheduler to know
when the swarm will win.** Serial execution is the default; fan-out must clear a
measured speedup bar before any worker is spawned.

**Highlights at a glance:**

- 🎯 **Cost model first** — serial is the default; every spawn must clear a measured speedup bar
- 🏗️ **Six topologies** — `SERIAL`, `SMALL_SWARM`, `FULL_SWARM`, `SPECULATIVE_SWARM`, `PIPELINE`, `BATCHED_WORKER`
- 📈 **4.98× measured speedup** on a clean parallel subset (86.1% parallel efficiency)
- 🔀 **Multi-model routing** — provider health, circuit breakers, trust-aware portfolio routing
- 🛡️ **Crash recovery** — durable run manifests, checkpoints, selective rollback
- ✅ **Adaptive verification** — V0 self-check → V4 adversarial verifier
- 🧪 **Benchmark-driven** — 991 tests, published numbers including a case where the swarm *lost*

## Contents

- [Quick start](#quick-start)
- [Why it exists](#why-it-exists)
- [Benchmarks](#benchmarks)
- [Adaptive decision example](#adaptive-decision-example)
- [Architecture](#architecture)
- [Features](#features)
- [Usage](#usage)
- [Predictor contract](#predictor-contract)
- [Supported topologies](#supported-topologies)
- [Configuration](#configuration)
- [Testing](#testing)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license) · [Contributing](#contributing) · [Security](#security)

---

## Quick start

**1. Install from npm:**

```bash
npm install opencode-swarm-lite
# or
bun add opencode-swarm-lite
```

**2. Register the plugin** in `~/.config/opencode/opencode.json` (or a project
`opencode.json`):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-swarm-lite",
      "options": {
        "mode": "adaptive",
        "ratePerSecond": 4,
        "burst": 8,
        "refinePasses": 1,
        "compactThreshold": 40,
        "compactCooldownMs": 30000
      }
    }
  ]
}
```

All options are optional — see [Configuration](#configuration) for the full table
with defaults.

**3. Run:**

```text
/swarm "Refactor the authentication module across three files and add unit tests"
```

<details>
<summary>Installing from a source checkout instead</summary>

```bash
git clone https://github.com/Arihant-Bharanidharan/opencode-swarm-lite.git
cd opencode-swarm-lite
bun install
bun run typecheck
bun run test
```

Then point the plugin at the local path:

```jsonc
{
  "plugins": [
    {
      "package": "file:///C:/path/to/opencode-swarm-lite",
      "options": { "mode": "adaptive" }
    }
  ]
}
```

</details>

---

## Why it exists

Naive agent swarms often waste time: startup, coordination, and verification overhead
can exceed the useful work being parallelized. `opencode-swarm-lite` runs a cost model
before dispatching, so small or tightly coupled tasks stay serial while large,
independent workloads get batched, speculative, or full-swarm execution.

The runtime is benchmark-driven, not a "spawn lots of bots" demo. It publishes measured
speedups — including a case where swarm *lost* on small work — and uses those results to
drive its cost-aware decisions.

---

## Benchmarks

All benchmark figures come from the published fixture under `benchmark/`
(`SPEC.md`, `workspace/`, `tests/`). See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)
for full methodology.

### Positive swarm benchmark

**5-task clean parallel subset** — no outage correction needed:

| Metric | Serial | Adaptive swarm |
|---|---|---|
| Wall time | 68.07 min | 13.67 min |
| Speedup | — | **4.98×** |
| Parallel efficiency | — | 86.1% |
| Correctness | identical | identical |

This clean subset is the strongest headline benchmark because it required no outage
correction.

**8-task whole workload** — disclosed outage correction:

| Metric | Serial Σ | Corrected swarm wall |
|---|---|---|
| Wall time | 155.02 min | 57.78 min |
| Speedup | — | **2.68×** (predicted 1.66×) |
| Correctness | 8/8 | 8/8 |

The whole-arm run contained an overnight server outage. The raw swarm wall time was
**658.3 min**; the corrected figure excludes that disclosed shared outage. Do not treat
2.68× as raw wall-clock performance.

### Negative benchmark

**Small-task benchmark** — short ~30 s tasks performed worse under swarm execution:

| Metric | Serial | Swarm answers | Swarm completion |
|---|---|---|---|
| Time | ~293 s | ~439 s | ~589 s |

Startup and orchestration overhead dominated the useful work. This failure motivated
the cost predictor and adaptive scheduler — serial is the default for a reason.

---

## Adaptive decision example

**Task: small symbolic integral**

```
Predictor:
estimated_serial_time: low
branch_independence: near zero
recommended_topology: SERIAL
recommended_agent_count: 1

Result: parent solved directly; no subagents spawned
```

**Task: 8 independent defects**

```
Predictor:
recommended_topology: FULL_SWARM
recommended_agent_count: 6
recommended_waves: 2

Observed: 2.68× whole-arm corrected speedup; 4.98× clean parallel subset
```

---

## Architecture

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

There is **one parent**. The parent model remains the only orchestration loop and is
the only entity that calls `subagent`. Scheduler tools (`swarm_plan`, `swarm_route`,
`swarm_capsule`, `swarm_lane`, `swarm_record`, `swarm_verify`, etc.) are advisory —
they never spawn agents.

**Data flow:**

1. **Task input** arrives with shape hints (branches, branchSeconds, independence,
   sharedContext, ambiguity, risk, verificationValue, deadline, SLA mode).
2. **Cost / policy engine** (`AdaptiveScheduler`) estimates serial vs every swarm shape,
   applies SLA and deadline pressure, and runs the cost guard.
3. **Task DAG planner** builds waves/batches and a critical-path schedule when edges are
   present (PIPELINE).
4. **Provider portfolio router** picks model/provider per lane using health, trust, and
   reliability scores; blocked providers are excluded.
5. **Execution** dispatches lanes in waves (token-bucket rate limited), with warm-lane
   reuse, straggler detection, and hedging.
6. **Verification** runs adaptively (V0–V4) and the refine loop converges on quality.
7. **Recovery**: run manifests, checkpoints, and the coordinator resume/restart on
   crashes; selective rollback to prior snapshots.

---

## Features

### Adaptive planning

- Serial vs swarm prediction — cost model decides topology before any spawn
- Nine-field snake_case predictor contract (see [Predictor contract](#predictor-contract))
- Mixed-strategy subgraph planning (BATCH / PIPELINE / SPECULATIVE_SWARM / FULL_SWARM
  in one workload)
- Speculative fan-out with early branch termination
- Task batching (BATCHED_WORKER: one worker per batch, never one agent per microtask)
- Critical-path scheduling (PIPELINE DAG)
- ROI cancellation with hysteresis
- Information-gain scheduling

### Runtime execution

- Specialist subagent lanes: architect, builder, verifier, coder, researcher, reviewer,
  multimodal analyst
- Extensible role registry (add / modify / broaden roles at runtime)
- Work stealing and warm-lane reuse
- Deadline pressure and anytime stages (PRELIMINARY → VERIFIED → FINAL)
- Straggler detection and hedging
- Token-bucket dispatch rate limiting (default 4/s, burst 8)

### Multi-model / provider routing

> **Multi-model means routing subagent work across different LLM models/providers.
> It does not mean image/audio multimodality.**

- Provider reliability tracking with circuit breaker (closed / open / half_open)
- Portfolio routing with trust-aware specialization
- Degrade / reallocate feedback loop (`recordDegradation`, `feedback()`)
- Rate-limit-aware behavior; provider limits are respected — no quota bypassing
- Recommended models published per plan (`recommended_models`)

### Verification

- Adaptive verification (V0 self-check → V4 adversarial verifier)
- Confidence calibration and trust scoring
- Diversity-aware consensus with minority verdict preservation
- Deterministic verification preference; provenance tracking

### Resilience

- Durable event log and run manifests with idempotent opId dedupe
- Checkpoints, snapshots, and selective rollback
- Coordinator crash recovery (resume / restart decisions, forced provider restoration)
- Idempotent replay of completed runs

### Learning / policy

- Historical runtime signals and shape baselines
- Self-tuning policy with promotion / rollback gates
- Shadow policy and manual override
- SLA modes: FASTEST, CHEAPEST, HIGHEST_QUALITY, BALANCED, LOWEST_PROVIDER_RISK

### Observability

- Scheduler dashboard, provider health dashboard, calibration dashboard
- Waste breakdown and multi-dimensional grading
- Telemetry and replay

---

## Usage

### Example 1 — Adaptive (default)

The coordinator chooses the topology from the work itself:

```text
/swarm "Refactor the authentication module across three files and add unit tests"
```

The scheduler estimates serial vs swarm, picks a topology (e.g. SMALL_SWARM with 3
lanes), dispatches in one message, and runs the refine loop before reporting done.

### Example 2 — Manual

The user explicitly chooses agent count and hierarchy:

```text
/swarm-mode manual
/swarm "Fix the off-by-one in t6-business-days.ts"  → confirm 1 lane, serial
```

No lanes are dispatched without user approval in manual mode.

### Example 3 — Mixed strategy

One workload containing multiple subgraphs:

```text
BATCH        → batched microtasks, one worker per batch
PIPELINE     → DAG stages in waves, no node starts before its edges finish
SPECULATIVE_SWARM → scouts only, expand on real uncertainty, stop redundant branches
FULL_SWARM   → up to `agents` lanes in `waves`
```

The mixed-strategy scheduler applies SLA modes, deadline pressure, anytime stages
(PRELIMINARY → VERIFIED → FINAL), and ROI cancellation across the subgraphs.

---

## Predictor contract

Every `swarm_plan` returns nine published fields in snake_case. These are the external
contract — do not rename them in integrations or documentation.

| Field | Meaning |
|---|---|
| `estimated_serial_time` | Predicted wall clock if one agent does everything sequentially (seconds) |
| `estimated_swarm_time` | Predicted wall clock of the best non-serial candidate (seconds) |
| `estimated_parallel_efficiency` | serial / chosen, divided by agents; 1 when SERIAL |
| `estimated_startup_cost` | Startup (cold or warm) for the chosen plan (seconds) |
| `estimated_verification_gain` | Expected correctness gain from the chosen verification ladder |
| `recommended_topology` | `SERIAL` \| `SMALL_SWARM` \| `FULL_SWARM` \| `SPECULATIVE_SWARM` \| `PIPELINE` \| `BATCHED_WORKER` |
| `recommended_agent_count` | Recommended lane count for the chosen topology |
| `recommended_models` | Recommended provider/model per lane (`string[]`) |
| `confidence` | Scheduler confidence in the chosen plan (0.2–0.95) |

---

## Supported topologies

| Topology | Behavior |
|---|---|
| `SERIAL` | Do the work yourself; spawn nothing |
| `SMALL_SWARM` | At most `agents` lanes in `waves` |
| `FULL_SWARM` | Up to `agents` lanes in `waves` for large parallel efforts |
| `SPECULATIVE_SWARM` | Spawn planned scouts only; merge via `swarm_converge`; expand on real uncertainty |
| `PIPELINE` | Dispatch DAG stages in waves; never start a node before its edges finish |
| `BATCHED_WORKER` | Spawn exactly `agents` workers; one `batches[i]` per worker |

Do not use `"SWARM"` — it is not a real topology.

---

## Configuration

Documented options (all read from `opencode.json` plugin options; full reference in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)):

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `"adaptive" \| "manual"` | `"adaptive"` | Swarm shape policy |
| `ratePerSecond` | `number` | `4` | Sustained subagent dispatches/sec |
| `burst` | `number` | `8` | Immediate dispatches before throttling |
| `rateLimitEnabled` | `boolean` | `true` | Master switch for rate limiting |
| `refinePasses` | `number` (0–3) | `1` | Refine-loop passes after integration |
| `compactThreshold` | `number` | `40` | Messages before compaction prompt |
| `compactCooldownMs` | `number` | `30000` | Minimum ms between compactions |
| `swarmMaxAgents` / `maxAgents` | `number` | `8` | Max concurrent lanes |
| `maxTasksPerBatch` | `number` | `6` | Max tasks per batched worker |
| `qualityWeight` | `number` (0–1) | `0.25` | Quality vs speed weight |
| `judgeAvailable` | `boolean` | `true` | Whether an LLM judge may be used |
| `judgeCostSeconds` | `number` | `45` | Estimated judge cost in seconds |
| `minSpeedupSwarm` | `number` | `1.08` | Min speedup for swarm over serial |
| `minSpeedupBatch` | `number` | `1.03` | Min speedup for batch over serial |
| `minSavingsSeconds` | `number` | `5` | Min seconds saved to justify fan-out |
| `providerFailureThreshold` | `number` | `3` | Failures before circuit opens |
| `providerCooldownMs` | `number` | `60000` | Circuit cooldown ms |
| `providerTimeoutThreshold` | `number` | `2` | Timeouts before circuit opens |
| `providerTimeoutCooldownMs` | `number` | `45000` | Timeout cooldown ms |
| `laneTtlMs` | `number` | `600000` | Warm-lane TTL (10 min) |
| `laneMaxUses` | `number` | `4` | Max uses per warm lane |
| `stateDir` | `string` | `<memory-dir>/swarm-state` | Runtime state directory |

Runtime state files live under `stateDir` (stats, provider health, lanes, capsules,
telemetry, history, trust, policy, run manifests, checkpoints). Memory, relay, and
roles files live alongside (configurable via `memoryPath`, `relayPath`, `rolesPath`).

---

## Testing

Canonical test command:

```bash
bun run test
```

> **Warning:** plain `bun test` does NOT execute the complete custom suite. Always use
> `bun run test`.

Typecheck (must exit 0):

```bash
bun run typecheck
```

### Verified status

```text
19 suites
991 checks
991 passed
0 failures
typecheck: exit 0
```

---

## Development

```bash
bun install
bun run typecheck
bun run test
```

Project layout:

```
src/
  index.ts            # OpenCode plugin entry (swarm skill, commands, runtime tools)
  runtime/
    scheduler.ts      # Adaptive topology scheduler (cost-aware)
    predictor.ts      # Nine-field snake_case predictor contract
    provider.ts       # Router, ProviderHealth, circuit breaker
    trust.ts          # TrustStore, trust scoring
    portfolio-router.ts  # Trust-aware portfolio routing
    mixed-strategy.ts    # Mixed-strategy scheduler
    coordinator.ts    # RunCoordinator, crash recovery
    run-manifest.ts   # RunManifestStore, idempotent opId dedupe
    checkpoint.ts     # Checkpoints, snapshots, selective rollback
    capsules.ts       # Versioned context capsules
    chaos.ts          # Opt-in chaos injection
    dashboards.ts     # Scheduler / provider / calibration dashboards
    telemetry.ts      # Durable event log
    history.ts        # Run history and task-shape baselines
test/
  *.test.ts           # 19 suites, 991 checks
benchmark/
  SPEC.md             # 8-independent-task benchmark fixture
  workspace/          # Self-contained TypeScript modules, one defect each
  tests/              # bun test objectives per task
docs/
  ARCHITECTURE.md     # Runtime components, data flow, failure / recovery
  BENCHMARKS.md       # Methodology, raw vs corrected numbers, outage disclosure
  CONFIGURATION.md    # Configuration reference
```

New scheduler behavior must include tests. Benchmark claims must carry evidence
(methodology, timing definitions, raw vs corrected figures).

### Benchmark reproducibility

Benchmark assets under `benchmark/`:

- `SPEC.md` — 8 independent engineering tasks, one defect each
- `workspace/` — self-contained TypeScript modules (`t1-comparator.ts` … `t8-lcs.ts`)
- `tests/` — objective `bun test` per task (fails on pristine module, passes on fix)
- `run-tests.ts` / `run-tests-core.ts` — test harness
- `BATCH-7-REPORT.md` — full Batch 7 report with all 22 sections

Do not upload secret-bearing logs, giant temporary workspaces, or environment-specific
junk. `benchmark/logs/wave1-partial/` contains temporary debug output and is excluded
by `.gitignore`.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — runtime components, data flow, failure/recovery
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — methodology, raw vs corrected numbers, outage disclosure
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) — configuration reference
- [`CHANGELOG.md`](CHANGELOG.md) — full version history
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development workflow and standards
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting and key handling

---

## License

MIT License. Copyright (c) 2026 Arihant Bharanidharan
<arihantbharani@outlook.com>. See [`LICENSE`](LICENSE).

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Summary:

- `bun install`, `bun run typecheck` (exit 0), `bun run test` (all green)
- New scheduler behavior must include tests
- Benchmark claims must carry evidence
- No provider quota evasion; no secrets committed

---

## Security

See [`SECURITY.md`](SECURITY.md). Summary:

- Users are responsible for their own provider API keys; keep keys local and
  environment-based; never commit keys
- Provider rate limits and quotas must be respected; the runtime does not bypass them
- Report vulnerabilities responsibly via GitHub private vulnerability reporting
