# Configuration

`opencode-swarm-lite` is configured through OpenCode plugin options in
`~/.config/opencode/opencode.json` (or a project `opencode.json`). All options are
optional; defaults are shown below.

## Plugin options

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
| `memoryPath` | `string` | `~/.config/opencode/swarm-memory.md` | Shared memory file |
| `relayPath` | `string` | `<memory-dir>/swarm-relay.md` | Lane-to-lane relay file |
| `rolesPath` | `string` | `<memory-dir>/swarm-roles.md` | Role registry file |

## Example config

```jsonc
{
  "plugins": [
    {
      "package": "file:///C:/path/to/opencode-swarm-lite",
      "options": {
        "mode": "adaptive",
        "ratePerSecond": 4,
        "burst": 8,
        "refinePasses": 1,
        "compactThreshold": 40,
        "compactCooldownMs": 30000,
        "swarmMaxAgents": 8,
        "maxTasksPerBatch": 6,
        "qualityWeight": 0.25,
        "judgeAvailable": true,
        "judgeCostSeconds": 45,
        "minSpeedupSwarm": 1.08,
        "minSpeedupBatch": 1.03,
        "minSavingsSeconds": 5,
        "providerFailureThreshold": 3,
        "providerCooldownMs": 60000,
        "laneTtlMs": 600000,
        "laneMaxUses": 4
      }
    }
  ]
}
```

## Runtime state directory

All runtime state files live under `stateDir` (default `<memory-dir>/swarm-state`):

- `stats.json` — historical runtime signals and shape baselines
- `provider-health.json` — provider circuit-breaker state
- `lanes.json` — warm-lane pool
- `capsules/` — versioned context capsules
- `events.jsonl` — durable telemetry event log
- `history.json` — completed-run records
- `trust.json` — trust snapshots per model / skill category
- `policy.json` — self-tuning policy (active / shadow / rolled_back)
- `runs/` — durable run manifests
- `checkpoint.json` — checkpoints and snapshots

Memory, relay, and roles files live alongside (configurable via `memoryPath`,
`relayPath`, `rolesPath`) and are **not** rewritten by the scheduler.

## SLA modes

| Mode | Bias |
|---|---|
| `FASTEST` | Minimize wall-clock time |
| `CHEAPEST` | Minimize cost / requests |
| `HIGHEST_QUALITY` | Maximize verification and quality |
| `BALANCED` | Balance cost, speed, quality (default) |
| `LOWEST_PROVIDER_RISK` | Prefer most reliable providers |
