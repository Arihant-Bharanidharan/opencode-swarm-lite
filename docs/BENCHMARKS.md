# Benchmarks

All benchmark figures below come from the published benchmark fixture under
`benchmark/` (`SPEC.md`, `workspace/`, `tests/`). This document describes methodology,
timing definitions, raw vs corrected numbers, outage disclosures, correctness evidence,
and known limitations.

## Benchmark fixture

**8 independent engineering tasks** (`benchmark/SPEC.md`). Each task is a self-contained
TypeScript module under `benchmark/workspace/` with exactly one defect. Each task has an
objective `bun test` under `benchmark/tests/` that fails on the pristine (broken) module
and passes when the module satisfies its documented contract. Tasks are independent: no
module imports another, no shared state, no shared file. Fixing one never affects another.

| id | file | domain | defect class |
|---|---|---|---|
| t1 | `t1-comparator.ts` | sorting / comparator | tie-break comparator direction inverted |
| t2 | `t2-token-bucket.ts` | rate limiting | refill not clamped for out-of-order timestamps |
| t3 | `t3-shingles.ts` | text n-grams | loop bound `<=` yields a short trailing shingle |
| t4 | `t4-jaccard.ts` | set similarity | Jaccard denominator uses multiset size not union |
| t5 | `t5-varint.ts` | binary codecs | LEB128 shift advances 8 bits instead of 7 |
| t6 | `t6-business-days.ts` | calendar arithmetic | counting loop off-by-one (`<=`) |
| t7 | `t7-router.ts` | provider routing | argmin selected instead of argmax |
| t8 | `t8-lcs.ts` | sequence DP | backtrack loop bound `i > 1 && j > 1` drops matches |

Run all: `bun test benchmark/tests`

## Timing definitions

- **Serial time** — wall clock for one agent to complete every task sequentially
- **Swarm wall time** — measured wall clock of the adaptive swarm run (all lanes
  dispatched in waves, token-bucket rate-limited)
- **Corrected swarm wall** — swarm wall time excluding disclosed shared outages
  (overnight server outage, etc.)
- **Speedup** — serial / swarm (or corrected serial / corrected swarm wall)
- **Parallel efficiency** — speedup / agent count

## Positive swarm benchmark

### 5-task clean parallel subset

This subset required no outage correction. It is the strongest headline benchmark.

| Metric | Serial | Adaptive swarm |
|---|---|---|
| Wall time | 68.07 min | 13.67 min |
| Speedup | — | **4.98×** |
| Parallel efficiency | — | 86.1% |
| Correctness | identical | identical |

### 8-task whole workload (disclosed outage correction)

The whole-arm run contained an overnight server outage. The raw swarm wall time was
**658.3 min**. The corrected figure excludes that disclosed shared outage.

| Metric | Serial Σ | Corrected swarm wall |
|---|---|---|
| Wall time | 155.02 min | 57.78 min |
| Speedup | — | **2.68×** (predicted 1.66×) |
| Correctness | 8/8 | 8/8 |

Do not treat 2.68× as raw wall-clock performance.

## Negative benchmark

### Small-task benchmark

Short ~30 s tasks performed worse under swarm execution because startup and
orchestration overhead dominated the useful work.

| Metric | Serial | Swarm answers | Swarm completion |
|---|---|---|---|
| Time | ~293 s | ~439 s | ~589 s |

This failure motivated the cost predictor and adaptive scheduler — serial is the
default for a reason.

## Methodology

- Each task has one seeded defect and one objective test
- Serial arm: one agent fixes all tasks sequentially
- Swarm arm: adaptive scheduler picks topology; lanes dispatched in waves,
  token-bucket rate-limited (4/s, burst 8)
- Correctness measured by objective test pass/fail per task
- Outages identified from server logs and disclosed separately; corrected figures
  exclude them

## Known limitations

- Wall-clock measurements are environment-dependent; your results may vary
- The corrected whole-arm speedup excludes a disclosed overnight server outage;
  it is not raw wall-clock performance
- Small tasks (~30 s) run worse under swarm; the cost predictor steers them to serial
- Provider rate limits and model variability affect absolute timings
