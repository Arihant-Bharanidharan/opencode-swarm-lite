# opencode-swarm-lite

<!-- opencode-swarm-lite v1.4.0 | (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com> -->

Lightweight multi-agent orchestration for [OpenCode](https://opencode.ai). Parallel subagent lanes with **adaptive or manual swarm shapes**, a **lane doctrine** (working rules, not permission rails), **lane-to-lane relay communication**, **specialist role briefs** backed by an **extensible role registry** (add, modify, or broaden roles at runtime), **refine/reiterate quality loops**, **multimodal analyst workers**, **dispatch rate limiting**, **auto-compaction**, and a shared markdown memory. No gates, no receipts, no enforced reviews.

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

## How it works

### Modes

| Mode | Swarm shape |
| --- | --- |
| `adaptive` (default) | The orchestrator derives the lane count and hierarchy from the work itself. The skill carries a lane rubric (1 lane for a single focused task, 2-3 for two or three workstreams, 4-6 for four to six, 7+ only for genuinely parallel large efforts) plus an explicit anti-default guarantee: **there is no fixed lane count, and the orchestrator is told to never say "I'll use the default N lanes."** A per-task word-count hint (`laneHint`) is embedded in every `/swarm` expansion so the shape tracks the prompt size, not a constant. |
| `manual` | You decide. The orchestrator confirms the subagent count and hierarchy with you before dispatching (unless you already stated them). |

### Dispatch behavior

Lanes dispatch in **waves through one assistant message** containing multiple `task`
tool calls (rate-limit aware: token bucket, default 4/s with burst 8). Every lane brief is
built from a template that now includes, in order:

1. The **lane doctrine** — seven working rules that keep parallel lanes coherent:
   evidence over assertion, scope fence, read-before-write, one-truth-per-fact,
   fail-loudly-early, a deterministic finish (`STATUS | FINDINGS | HANDOFFS`), and
   no self-promotion.
2. A **specialist role brief** — architect, builder, verifier, coder, researcher,
   reviewer, or multimodal analyst — or any custom/broadened role from the registry
   (see below).
3. The task-specific instructions from the orchestrator.
4. The **relay protocol** — how to read and append to the shared relay file.

Multimodal lanes are tagged (analyst role brief + media path requirements), and
dispatch is throttled through a token bucket with a clear error message on rejection.

### Lane doctrine

Doctrine is a **prompt contract, not a permission system** — it does not gate, block,
or receipt anything. It exists because parallel lanes doing redundant or contradictory
work is the main source of swarm errors. The seven rules:

1. **Evidence over assertion.** Every claim carries file:line, command output, or an
   explicit "I could not verify X".
2. **Scope fence.** A lane does exactly its brief; out-of-scope discoveries become
   relay handoffs, not side quests.
3. **Read before write.** Read the relay and any file you will touch before touching it.
4. **One truth per fact.** Cite relay-verified facts instead of re-deriving them.
5. **Fail loudly, early.** Surface blockers in the relay immediately.
6. **Deterministic finish.** Every lane ends with `STATUS | FINDINGS | HANDOFFS`.
7. **No self-promotion.** Reports describe the work, not how well the work was done.

### Lane-to-lane communication (relay file)

Lanes coordinate through an append-only markdown relay file (default
`<memory-dir>/swarm-relay.md`, configurable via `relayPath`). Subagents cannot message
each other directly; the relay is the only channel between them. It carries findings,
FINDINGS blocks from finished lanes, and `HANDOFF -> lane-ID: description` notes for
work that crosses lane boundaries. The orchestrator reads it back at integration time,
so work a lane discovered outside its scope gets routed instead of dropped.

### Extensible role registry (add / modify / broaden)

The seven built-in roles are a starting point, not a ceiling. The agent reshapes the
roster at runtime through an **append-only role registry** file
(`<memory-dir>/swarm-roles.md` by default, configurable via `rolesPath`):

- `### role: <slug>` **adds** a role; on an existing slug (built-in or custom) it
  **replaces** that brief — that is how you *modify* a role. Last block wins.
- `### extend: <slug>` **broadens** an existing role by appending guidance. Multiple
  `extend:` blocks accumulate in file order, and broadening a base propagates to every
  role that `extends:` it.
- `- extends: <base>` on a role block makes a custom role inherit a base (built-in or
  another custom); cycles resolve to the role's own body instead of hanging.

Registry blocks are short (<=8 lines) and end at the next heading. The file is
re-read automatically whenever it changes — through `write`/`edit`/`patch`, a shell
append (checked on the next context build), or `/swarm-roles` — and the swarm skill
re-renders in place: no restart, no service reload. A registry block is additive: it
never replaces the lane doctrine, the relay protocol, or the refine loop, and ONE
role per lane still applies. Browse the roster with `/swarm-roles`; reshape it with
`/swarm-roles <request>` (the agent edits the file for you) or by editing the file
directly — custom roles render as `### <Title> lane (custom)`, modified built-ins get
`(modified)`.

### Refine / reiterate loop

After integrating, the orchestrator runs a bounded quality loop (default 1 pass,
`refinePasses` 0-3):

1. **Draft** — the integrated result.
2. **Critique** — a fresh verifier lane attacks it (claims vs evidence, gaps, contradictions).
3. **Fix** — a fix lane addresses valid critique points.
4. **Re-verify** — the fixed result is re-checked.

The loop **stops early the moment a critique finds zero issues** — convergence, not
fixed iteration count. `refinePasses: 0` disables it (single pass, no critique).

### Memory & auto-compaction

All lanes and the orchestrator share one markdown memory file
(`~/.config/opencode/swarm-memory.md` by default), seeded with a header, an attribution
comment, and a hidden watermark on first run. After every 40th message (configurable)
the orchestrator is instructed to distill the session into the memory file — recent
lessons first, stale ones pruned — then continue, with a cooldown to prevent
back-to-back compactions.

## Commands

| Command | What it does |
| --- | --- |
| `/swarm <task>` | Loads the `swarm` skill and dispatches the task to parallel subagent lanes in one message: adaptive shape guidance (with per-task lane rubric + word-count hint) or manual confirmation, lane doctrine, specialist role briefs (built-in roster or registry-defined), relay file coordination, and the refine loop before reporting done. |
| `/swarm-mode` | Toggle between `adaptive` and `manual`. Persists in `swarm-state.json`. |
| `/swarm-status` | One-shot status report: mode, dispatch budget (burst/rate/tokens), wave size, refine passes, role roster (built-in + registry), registry/relay paths, auto-compaction settings, memory file. |
| `/swarm-roles [request]` | No text: prints the exact role listing (built-ins + registry roles with modified/broadened markers). With text: has the agent add, modify, or broaden roles in the registry for your request — no lanes dispatched. |

Slash commands work in the TUI (and via the `POST /api/session/{id}/command` HTTP
endpoint). Note: `opencode run "/cmd"` does **not** resolve slash commands — that is an
OpenCode CLI behavior, not a plugin bug.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"adaptive" \| "manual"` | `"adaptive"` | Swarm shape policy. |
| `ratePerSecond` | `number` | `4` | Sustained dispatches/sec. |
| `burst` | `number` | `8` | Immediate dispatches before throttling. |
| `rateLimit` | `boolean` | `true` | Master switch for rate limiting. |
| `waveSize` | `number` | `8` | Lanes per dispatch message. |
| `refinePasses` | `number` | `1` | Refine-loop passes after integration (0 disables, max 3). |
| `relayPath` | `string` | `<memory-dir>/swarm-relay.md` | Append-only lane-to-lane relay file. |
| `rolesPath` | `string` | `<memory-dir>/swarm-roles.md` | Role registry file: `### role:` adds/modifies, `### extend:` broadens; hot-reloaded into the skill. |
| `memoryPath` | `string` | `~/.config/opencode/swarm-memory.md` | Shared memory file. |
| `compactThreshold` | `number` | `40` | Messages before a compaction prompt. |
| `compactCooldownMs` | `number` | `30000` | Minimum ms between compactions. |

## Skill output (what the orchestrator receives)

```markdown
# Swarm orchestration

<!-- opencode-swarm-lite v1.4.0 | (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com> -->

## Mode: ADAPTIVE (default: adaptive)

You choose the lane count and hierarchy that fit the task and justify the shape.
Never say "I'll use the default N lanes." — there is no default count; there is only
the work. Rubric: 1 lane for a single focused task; 2-3 for two or three workstreams;
4-6 for four to six; 7+ only for genuinely parallel large efforts. Split by workstream,
never by number. (This task hints ~N words -> about M independent lanes; a hint, not a
mandate.)

## Lane doctrine (follow always; these are working rules, not permissions)

1. **Evidence over assertion.** ...
...(seven rules; each lane brief repeats them)...

## Lane-to-lane communication (relay file)

Lanes coordinate through `<memory-dir>/swarm-relay.md` — an append-only relay, the only
channel between lanes. Read first, write second; append findings/handoffs, never edit.

## Workflow

1. **Memory + registry** — read the memory file and `swarm-roles.md` (registry roles).
2. Decompose the task into INDEPENDENT lanes...
3. Dispatch lanes in parallel — every lane brief gets the doctrine + a built-in or
   registry role.
4. **Relay** — read the relay file top-to-bottom at integration time; route HANDOFFs.
5. Integrate results...
6. **Refine** — draft -> verifier critique -> fix -> re-verify; stop early on convergence.
7. Review (only when asked or high-risk)...
8. Append short lessons to memory...

## Specialist roles (attach exactly one to every lane brief)

### Architect lane / Builder lane / Verifier lane
### Coder lane / Researcher lane / Reviewer lane / Multimodal analyst lane
### <Custom> lane (custom) / <Built-in> lane (modified)   <- registry outcomes

...(one-line role contract each; multimodal requires media paths)...

### Role registry - add, modify, or broaden roles yourself

Registry file: `<memory-dir>/swarm-roles.md` (append-only markdown, same discipline as
the relay). `### role: <slug>` adds or replaces (modify); `### extend: <slug>` appends
(broaden); optional `- extends: <base>` inherits a base. Last block wins; accumulation
is file order; ONE role per lane and the lane doctrine always apply. The skill
re-renders automatically when the registry changes.

## Dispatch mechanics

Dispatch every lane in ONE message... ~8 lanes per message, token-bucket limited
(burst 8)...

## Memory & auto-compaction

Shared memory file: `<memory-dir>/swarm-memory.md`. After every 40th message, distill...

## Refine passes

1 pass (draft -> critique -> fix -> re-verify; stop early on convergence).
```

## Memory file (seeded on first run)

```markdown
# Swarm memory

<!-- opencode-swarm-lite v1.4.0 | (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com> -->

<hidden zero-width watermark>

Shared lessons across swarm runs. Append short bullets, prune stale entries, keep this
under ~300 lines. Structure: `## Durable` (carry forward) and `## Recent` (prune).
```

## Verification

```bash
bun run typecheck   # tsc --noEmit
bun run test        # runs every test/**/*.test.ts file
```

176 checks across four suites, all hand-checked against the source:

- `test/doctrine.test.ts` (65) — doctrine rule coverage, relay protocol invariants,
  refine-loop rendering (0/1/2/3 passes), adaptive lane rubric + laneHint scaling
  (tiny vs mid vs huge prompts hint different lane counts — the anti-hardcode proof),
  specialist roster completeness, and skillContent rendering for both modes.
- `test/rate-limit.test.ts` (28) — burst, recovery, rejection message.
- `test/roles.test.ts` (69) — registry parse rules, resolution (add/modify/broaden,
  extends chains, cycle safety, last-block-wins), section rendering, the
  `/swarm-roles` listing, skill integration, and 6-arg backward compatibility.
- `test/watermark.test.ts` (14) — decode, placement, attribution comment.

Layout:

```
opencode-swarm-lite/
  src/
    index.ts            # plugin: doctrine, relay, refine loop, role registry, lanes, rate limit, compaction
  test/
    doctrine.test.ts    # 65 checks: doctrine/relay/refine/rubric/roles/skillContent
    rate-limit.test.ts  # 28 checks: burst/recovery/reject
    roles.test.ts       # 69 checks: registry parse/resolve/render/listing/back-compat
    watermark.test.ts   # 14 checks: secret watermark
  package.json
  README.md
```

## Design notes

- **Doctrine over permissions.** v1.3.0 adds working rules for lanes, not permission
  rails: nothing is gated, blocked, or receipted. Doctrine reduces errors (contradictory
  or redundant parallel work) while keeping the plugin thin.
- **Adaptive means adaptive.** The lane count is derived from the task's workstreams via
  an embedded rubric plus a per-prompt word-count hint, with an explicit instruction to
  never claim a "default" count. Tests assert the hint scales with prompt size.
- **Quality loops.** The refine loop is a bounded prompt contract (draft -> critique ->
  fix -> re-verify, early stop on convergence), not a fixed iteration tax.
- **Everything is prompt text or a small mechanism.** The doctrine, relay protocol,
  role briefs, and refine loop are plain markdown in the skill/`task` payloads.
  The only executable machinery remains the token-bucket rate limiter, state persistence,
  and the compaction timer. v1.4.0's role registry stays inside this rule: the registry
  is markdown and the refresh is a stat check + skill re-render.
- **Extensible roster, fixed doctrine.** The agent can add, modify, and broaden
  specialist roles at runtime (append-only registry file, hot-reloaded into the skill),
  while the lane doctrine, relay protocol, refine loop, and one-role-per-lane rule stay
  fixed contracts. Specialization is open; the safety properties are not editable.

## Limitations

- Rate limiting is **in-process** — it throttles what this plugin dispatches, not what
  the model emits elsewhere.
- Compaction asks the orchestrator to distill; it cannot force a small model to
  comply, and it does not truncate the conversation itself.
- Lane doctrine and the refine loop are prompt contracts: a weak model can still ignore
  them (same trust model as every prompt-based tool).
- `opencode run "/swarm ..."` does not resolve slash commands (OpenCode CLI limitation);
  use the TUI or the command API.
- The relay file is append-only markdown shared by concurrent lanes; on very fast parallel
  writers, last-append-wins is possible (same trust model as shared files generally).
- The role registry is agent-writable by design: a bad edit can degrade a custom role
  brief (the file is plain markdown, so it is easy to inspect and fix; built-in briefs
  are only affected by an explicit `role:` block on their slug).

## Roadmap (v1.4.x)

- [x] Adaptive lane rubric + anti-default guarantee + per-task lane hint
- [x] Lane doctrine (7 working rules in every lane brief)
- [x] Lane-to-lane relay communication (append-only shared file)
- [x] Specialist role briefs (architect/builder/verifier added to coder/researcher/reviewer/multimodal)
- [x] Refine/reiterate loop with early stop on convergence
- [x] Extensible role registry - add / modify / broaden roles at runtime
      (`/swarm-roles`, `extends:` chains, cycle-safe resolution, hot-reloaded skill)
- [ ] Optional relay rotation per run (archive + fresh relay)
- [ ] Worktree-aware lanes (parallel file isolation)
- [ ] Registry diff/undo (`/swarm-roles` snapshots before each update)

## License / Attribution

Copyright (c) 2026 **Arihant Bharanidhran** `<arihantbharani@outlook.com>`.
All rights reserved. Every markdown payload emitted by this plugin (skill content,
memory seed) carries an attribution comment; the memory seed additionally carries a
hidden zero-width watermark that decodes to `SWARMLITE/ARIHANT/2026`.
