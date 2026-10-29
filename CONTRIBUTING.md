# Contributing to opencode-swarm-lite

Thank you for contributing! `opencode-swarm-lite` is an adaptive multi-model agent
orchestration runtime for OpenCode. This guide covers how to get started, how changes
are reviewed, and what we expect of contributions.

## Getting started

```bash
git clone https://github.com/Arihant-Bharanidharan/opencode-swarm-lite.git
cd opencode-swarm-lite
bun install
```

## Canonical commands

```bash
bun run typecheck   # bunx --bun tsc --noEmit -p tsconfig.json  (must exit 0)
bun run test        # runs every test/**/*.test.ts file          (must all pass)
```

**Important:** use `bun run test`, not plain `bun test`. The custom runner executes
every `test/**/*.test.ts` file; plain `bun test` does not execute the complete suite.

## Project layout

```
src/
  index.ts            # OpenCode plugin entry (swarm skill, commands, runtime tools)
  runtime/
    scheduler.ts      # Adaptive topology scheduler (cost-aware)
    predictor.ts      # Nine-field snake_case predictor contract
    provider.ts       # Router, ProviderHealth, circuit breaker
    trust.ts          # TrustStore, trust scoring
    portfolio-router.ts  # Trust-aware portfolio routing
    mixed-strategy.ts    # Mixed-strategy scheduler (SLA, deadline, anytime stages)
    coordinator.ts    # RunCoordinator, crash recovery
    run-manifest.ts   # RunManifestStore, idempotent opId dedupe
    checkpoint.ts     # Checkpoints, snapshots, selective rollback
    capsules.ts       # Versioned context capsules
    chaos.ts          # Opt-in chaos injection
    dashboards.ts     # Scheduler / provider / calibration dashboards
    telemetry.ts      # Durable event log
    history.ts        # Run history and task-shape baselines
    ...               # verify, sla, roi, straggler, consensus, integration, etc.
test/
  *.test.ts           # 19 suites, 991 checks (verified green)
benchmark/
  SPEC.md             # 8-independent-task benchmark fixture
  workspace/          # Self-contained TypeScript modules, one defect each
  tests/              # bun test objectives per task
```

## Pull request expectations

1. **Tests required.** New scheduler behavior must include tests. Every PR that changes
   `src/runtime/` or `src/index.ts` should add or update tests under `test/`.
2. **Typecheck and tests must pass.** `bun run typecheck` must exit 0 and
   `bun run test` must show all suites green before review.
3. **Benchmark claims need evidence.** If a PR claims a speedup or efficiency number,
   include the methodology, timing definitions, and raw vs corrected figures. No
   hard-coded benchmark wins, no silent threshold weakening, no fake PASS states.
4. **No provider quota evasion.** Do not submit changes that claim to bypass provider
   rate limits or quotas. The runtime respects provider limits.
5. **No secrets.** Never commit API keys, tokens, passwords, or personal filesystem
   paths. `.gitignore` excludes `.env*` and `*.log`; keep it that way.
6. **Preserve history.** Do not rewrite existing commit history unnecessarily.

## Code style

- TypeScript strict mode, ESM (`"type": "module"`), NodeNext module resolution
- MIT license; preserve existing attribution (`Arihant Bharanidharan`,
  `<arihantbharani@outlook.com>`)
- Keep runtime changes minimal and auditable — this is a benchmark-driven runtime, not
  a "spawn lots of bots" demo

## Release process

Releases are created from `master` with an annotated tag matching the version in
`package.json` (currently `2.0.0`). The release notes highlight benchmark claims and
disclosures (clean subset speedup, corrected whole-arm speedup, outage disclosure,
negative small-task result).
