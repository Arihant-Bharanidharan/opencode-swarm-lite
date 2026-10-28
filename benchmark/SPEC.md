# Benchmark fixture — 8 independent engineering tasks

Each task is a self-contained TypeScript module under `workspace/` with exactly
one defect. Each task has an objective bun test under `tests/` that fails on the
pristine (broken) module and passes when the module satisfies its documented
contract.

Tasks are independent: no module imports another, no shared state, no shared
file. Fixing one never affects another.

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
