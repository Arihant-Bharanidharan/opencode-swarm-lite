# opencode-swarm-lite

<!-- opencode-swarm-lite v1.1.0 | (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com> -->

Lightweight multi-agent orchestration for [OpenCode](https://opencode.ai). Parallel subagent lanes with **adaptive or manual swarm shapes**, **multimodal analyst workers**, **dispatch rate limiting**, **auto-compaction**, and a shared markdown memory. No gates, no receipts, no enforced reviews.

Built as a deliberately thin alternative to heavyweight swarm plugins: everything is a plain prompt contract or a small, inspectable mechanism.

## Install

The package is **not published to npm** yet (`opencode plugin add opencode-swarm-lite`
returns a 404), so install it from a local checkout.

```jsonc
// ~/.config/opencode/opencode.json  (or a project opencode.json)
{
  "plugins": [
    {
      "package": "file:///C:/path/to/opencode-swarm-lite",
      "options": {
        "mode": "adaptive",
        "ratePerSecond": 2,
        "burst": 4,
        "compactThreshold": 60,
        "compactCooldownMs": 120000
      }
    }
  ]
}
```

Point the entry at the **directory**, not a file. OpenCode resolves a plugin
directory to `<dir>/server` or `<dir>/index` and does *not* consult the package
`exports` map for local paths — the root `index.ts` in this repo is that
entrypoint, and it is what makes the `options` block above actually reach the
plugin. A directory without an `index.ts` is dropped **silently**, and every
option is ignored with no error to show for it.

Restart the service after editing the config:

```sh
opencode service restart
```

Then verify it loaded:

```sh
opencode api get /api/plugin
```

`swarm-lite` should be listed with `"path": ".../opencode-swarm-lite/index.ts"`.

## What you get

| Command | What it does |
| --- | --- |
| `/swarm <task>` | Load the swarm skill and orchestrate the task across parallel lanes |
| `/review [scope]` | Optional reviewer lane over your current changes |
| `/swarm-mode` | Show the current mode |
| `/swarm-mode adaptive\|manual` | Switch modes at runtime (persisted) |

Plus the `swarm` skill, which teaches any orchestrating agent the full protocol: plan → dispatch → integrate → optional review → memory.

## Swarm modes

- **Adaptive (default)** — the orchestrator analyzes the task and decides lane count and hierarchy (flat vs lead/worker), justifies the shape in a line, and adapts based on what past runs recorded in memory.
- **Manual** — *you* decide. The orchestrator takes the subagent count and hierarchy from your request, and asks before dispatching if you didn't state them.

Switch with `/swarm-mode manual` / `/swarm-mode adaptive`, or set the default in config:

```jsonc
{
  "plugins": [
    {
      "package": "file:///C:/path/to/opencode-swarm-lite",
      "options": {
        "mode": "manual",
        "ratePerSecond": 2,
        "burst": 4,
        "compactThreshold": 60,
        "compactCooldownMs": 120000
      }
    }
  ]
}
```

## Lane roles

The skill ships role briefs for four lane types — dispatch attaches the right brief to each subagent:

- **Coder** — implement, verify, report; no scope creep
- **Researcher** — read-only investigation, evidence-based findings
- **Reviewer** — optional, severity-ranked findings, no veto power
- **Multimodal analyst** — reads images, PDFs, screenshots, diagrams; cross-checks media against code/docs

## Rate limiting

Subagent dispatches go through a token bucket (default **2 dispatches/sec, burst 4**). When exhausted, the dispatch fails with a retry hint, so the orchestrator waves dispatches instead of flooding providers. Tune or disable via `ratePerSecond`, `burst`, `rateLimitEnabled: false`.

## Auto-compaction

When a session's message count crosses `compactThreshold` (default 60), the plugin triggers OpenCode's session compaction, with a `compactCooldownMs` (default 2 min) guard against loops. Lane briefs stay valid across compaction because the skill instructs self-contained briefs.

## Memory

A single markdown file (default `~/.config/opencode/swarm-memory.md`, override with `memoryPath`) where orchestrators append short lessons after each run and read them before planning. Keep it under ~150 lines; prune stale entries.

## Watermark

Generated payloads (skill content, memory header) carry an invisible Unicode-tag-character watermark decoding to `SWARMLITE/ARIHANT/2026`, plus visible attribution comments. Verify with:

```ts
import { decodeWatermark } from "opencode-swarm-lite"
```

The package ships TypeScript source only (no build step), so it is consumed by
OpenCode's own TS-capable plugin runtime. Plain-Node consumers cannot `require`
or `import` it as-is.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit over src/ and test/
bun run test        # runs every test/**/*.test.ts
```

Tests are plain Bun scripts — each file is executed directly and exits non-zero
on failure, so there is no test-runner dependency. `tsconfig.json` includes
both `src` and `test`.

## Layout

| Path | Purpose |
| --- | --- |
| `index.ts` | Root plugin entrypoint — the file OpenCode resolves for a local directory install |
| `src/index.ts` | Plugin implementation, `DispatchRateLimiter`, `decodeWatermark` |
| `test/rate-limit.test.ts` | Token-bucket behaviour (burst, refill, rejection messages) |
| `test/watermark.test.ts` | Watermark encode/decode behaviour |

## License

MIT — Copyright (c) 2026 Arihant Bharanidhran \<arihantbharani@outlook.com\>.
