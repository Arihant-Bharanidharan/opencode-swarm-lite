/**
 * opencode-swarm-lite — lightweight multi-agent orchestration for OpenCode
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 *
 * Features:
 *  - Adaptive or manual swarm modes (orchestrator decides vs user decides)
 *  - Lane doctrine (working rules that cut errors + keep lanes coherent)
 *  - Specialist roles: architect, builder, verifier, researcher, reviewer, multimodal
 *  - Extensible role registry: the agent can add, modify, and broaden specialist
 *    roles at runtime (persisted markdown registry, skill hot-refreshes)
 *  - Lane-to-lane communication via an append-only relay file
 *  - Refine/reiterate loop: draft -> verifier critique -> fix -> re-verify
 *  - Parallel subagent lanes incl. multimodal analysts, dispatched in waves
 *    (all lanes of a wave in one message; background by default)
 *  - Token-bucket rate limiting on subagent spawns (burst = wave size)
 *  - Auto-compaction of long sessions (tuned for fast context turnover)
 *  - Shared markdown memory file
 *  - /swarm-status: live dispatch budget + settings at a glance
 *
 * No gates, no receipts, no enforced reviews.
 */
import { Plugin } from "@opencode/plugin"
import type { Skill } from "@opencode/schema"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StatsStore } from "./runtime/stats.js"
import { ProviderHealth, Router } from "./runtime/provider.js"
import { LanePool } from "./runtime/lanes.js"
import { CapsuleStore } from "./runtime/capsules.js"
import { Telemetry } from "./runtime/telemetry.js"
import { AdaptiveScheduler } from "./runtime/scheduler.js"
import { createSwarmTools } from "./runtime/tools.js"
import type { ModelProfile } from "./runtime/types.js"
import { RunHistory } from "./runtime/history.js"
import { RunManifestStore } from "./runtime/run-manifest.js"
import { RunCoordinator } from "./runtime/coordinator.js"
import { MixedStrategyScheduler } from "./runtime/mixed-strategy.js"
import { PortfolioRouter } from "./runtime/portfolio-router.js"
import { TrustStore } from "./runtime/trust.js"
import { CheckpointManager } from "./runtime/checkpoint.js"
import { PolicyStore } from "./runtime/policy.js"

export interface RateLimitOptions {
  enabled: boolean
  ratePerSecond: number
  burst: number
}

export const DEFAULT_RATE_PER_SECOND = 4
export const DEFAULT_BURST = 8

/** Clamp a user-supplied number to a finite value >= min, else fallback (rejects NaN/Infinity/negatives). */
export function num(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
}

/** Token bucket for subagent dispatches. */
export class DispatchRateLimiter {
  private tokens: number
  private lastRefill: number
  private cfg: RateLimitOptions
  constructor(cfg: RateLimitOptions) {
    // sanitize at the boundary: rate must be finite and > 0, burst must be >= 1
    this.cfg = {
      enabled: cfg.enabled !== false,
      ratePerSecond: num(cfg.ratePerSecond, DEFAULT_RATE_PER_SECOND, 0.01),
      burst: num(cfg.burst, DEFAULT_BURST, 1),
    }
    this.tokens = this.cfg.burst
    this.lastRefill = Date.now()
  }
  /** Consume one dispatch token, or throw with a retry hint. No-op when disabled. */
  consume(): void {
    if (!this.cfg.enabled) return
    const now = Date.now()
    // clock-skew safe: never let a backwards wall clock subtract tokens
    const elapsed = Math.max(0, (now - this.lastRefill) / 1000)
    this.tokens = Math.max(0, Math.min(this.cfg.burst, this.tokens + elapsed * this.cfg.ratePerSecond))
    this.lastRefill = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const retryMs = Math.ceil(((1 - this.tokens) / this.cfg.ratePerSecond) * 1000)
    throw new Error(
      `swarm-lite rate limit: subagent dispatch budget exhausted (burst ${this.cfg.burst}, ${this.cfg.ratePerSecond}/s). Retry in ~${retryMs}ms or batch lanes into fewer dispatches.`,
    )
  }
  /** Live budget snapshot (read-only, does not consume or refill state). */
  status(): { enabled: boolean; burst: number; ratePerSecond: number; tokens: number } {
    const elapsed = Math.max(0, (Date.now() - this.lastRefill) / 1000)
    return {
      enabled: this.cfg.enabled,
      burst: this.cfg.burst,
      ratePerSecond: this.cfg.ratePerSecond,
      tokens: Math.max(0, Math.min(this.cfg.burst, this.tokens + elapsed * this.cfg.ratePerSecond)),
    }
  }
}

/** Brand a plain string as the schema requires (runtime value is unchanged). */
const brand = <T>(value: string): T => value as unknown as T

/** Small local helpers for tool-hook telemetry (never throw into the harness). */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback)
const roundSeconds = (value: number): number => Math.round(value * 10) / 10
const sanitizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "tool error"
  return message.length > 500 ? `${message.slice(0, 500)}...` : message
}

const AUTHOR = "Arihant Bharanidharan"
const EMAIL = "arihantbharani@outlook.com"
const VERSION = "2.0.0"

/**
 * Secret watermark: encodes "SWARMLITE/ARIHANT BHARANIDHARAN/2026" as Unicode
 * tag characters (U+E0020–U+E007F). Invisible in rendered text; recoverable by
 * decoding the tag-codepoint run back to ASCII.
 */
export const WATERMARK: string = (() => {
  const secret = "SWARMLITE/ARIHANT BHARANIDHARAN/2026"
  return Array.from(secret)
    .map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0)))
    .join("")
})()

/** Decode a watermark string back to its ASCII form. Exported for verification. */
export function decodeWatermark(mark: string): string {
  return Array.from(mark)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      return cp >= 0xe0000 && cp <= 0xe007f ? String.fromCharCode(cp - 0xe0000) : ""
    })
    .join("")
}

/** Hidden attribution comment for markdown payloads. */
function attribution(): string {
  return `<!-- opencode-swarm-lite v${VERSION} | (c) 2026 ${AUTHOR} <${EMAIL}> -->`
}

const DEFAULT_MEMORY = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "opencode",
  "swarm-memory.md",
)

const MEMORY_HEADER = `# Swarm memory

Shared lessons across swarm runs. Append short bullets, prune stale entries, keep this file under ~150 lines.
`

/** Built-in specialist role briefs. Exported: the role registry resolves against them. */
export const ROLE_BRIEFS: Record<string, string> = {
  architect: `You are an architect lane in a lightweight swarm.
- Design the approach for your brief: decompose the problem, name the invariants that must hold, and specify the acceptance checks a builder/verifier can run.
- Ground the design in the actual code you read (cite file:line). A design that ignores the existing code's conventions is wrong.
- Call out risks and unknowns explicitly. Do not implement — you produce the plan and the check-list, not the diff.`,
  builder: `You are a build-worker in a lightweight swarm.
- Implement exactly what your brief specifies, following the architect lane's plan if one is in the relay.
- Make the smallest coherent change. Match the file's existing style; do not reformat or refactor beyond the brief.
- Verify before you finish: run the relevant test/lint/repro command and paste the real result. "Should work" is not a status.
- Report: what changed, files touched, exact verification output, anything unfinished.`,
  verifier: `You are a verifier lane in a lightweight swarm.
- Attack the work: hunt for wrong claims, missed edge cases, broken invariants, and unverified assertions in your brief's scope.
- Every issue you raise needs a repro: a command that fails, a counterexample input, or file:line reasoning. No speculative findings.
- If you find zero substantive issues, say exactly that — do not invent nits to seem thorough.
- Do not fix anything. You critique; the orchestrator decides what to accept.`,
  coder: `You are a coding worker in a lightweight swarm.
- Do exactly the task in your brief; do not expand scope.
- Implement it, run the relevant checks, and verify your work before finishing.
- Report back concisely: what changed, files touched, how you verified, anything unfinished.
- If something is ambiguous, make the reasonable call and note it in your report rather than stalling.`,
  researcher: `You are a research worker in a lightweight swarm.
- Investigate the question in your brief using search, reads, and read-only commands.
- Report findings with file paths and concrete evidence. Prefer ten concrete facts over ten hedged guesses.
- Do not edit files.`,
  reviewer: `You are an optional code reviewer.
- Review only what you are asked to review (a diff, a file set, or a change description).
- Run cheap relevant checks when possible; otherwise reason from the diff.
- Report findings ranked by severity with file:line references. If there are no real issues, say so plainly - do not invent nits to seem thorough.
- Do not edit files. You inform the orchestrator; you do not block it.`,
  multimodal: `You are a multimodal analyst in a lightweight swarm.
- Your brief may include image, PDF, screenshot, diagram, or audio/video-metadata paths. Read them with the read tool and analyze what they actually show.
- Cross-check media against the code or docs in your brief (e.g. does the screenshot match the implemented UI, does the diagram match the architecture).
- Report findings with concrete references: file paths, timestamps, coordinates/regions of interest in images.
- Do not edit files. Combine visual/document evidence with textual evidence in one structured report.`,
}

/** Ordered built-in specialist roster (slug -> display title). */
export const BUILTIN_ROLES: ReadonlyArray<{ slug: string; title: string }> = [
  { slug: "architect", title: "Architect" },
  { slug: "builder", title: "Builder" },
  { slug: "verifier", title: "Verifier" },
  { slug: "coder", title: "Coder" },
  { slug: "researcher", title: "Researcher" },
  { slug: "reviewer", title: "Reviewer" },
  { slug: "multimodal", title: "Multimodal analyst" },
]

/** Registry slugs: lowercase letters, digits, hyphens (max 40 chars). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

const EXTEND_PREAMBLE = "**Broadened for this installation (added by the orchestrator):**"

/** One block of the agent-writable role registry: `### role:` (add/modify) or `### extend:` (broaden). */
export interface RoleBlock {
  kind: "role" | "extend"
  /** normalized lowercase slug */
  name: string
  /** optional base role (built-in or another registry role) for `role:` blocks */
  extends?: string
  /** the block's rules/purpose lines, newline-joined */
  body: string
}

/**
 * Parse the role registry markdown the orchestrator appends to.
 *
 * Format (per block):
 *   ### role: security-auditor     <- ADD a role; on a built-in slug it REPLACES that brief (modify)
 *   - extends: verifier            <- optional base (built-in or another registry role)
 *   - One-line purpose.
 *   - 2-5 terse, imperative rules.
 *   ### extend: builder            <- BROADEN a role by appending guidance
 *   - Extra judgment every builder lane should apply.
 *
 * Rules: any other heading ends the current block; blocks with an empty body are
 * dropped (a bare header changes nothing); duplicate `role:` slugs are kept in
 * file order (resolution is last-wins, so re-appending rewrites a role).
 */
export function parseRoles(text: string): RoleBlock[] {
  const blocks: RoleBlock[] = []
  let cur: RoleBlock | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("###")) {
      const m = /^###\s+(role|extend):\s*(\S+)\s*$/i.exec(line)
      const slug = m ? m[2].toLowerCase() : ""
      if (m && SLUG_RE.test(slug)) {
        cur = { kind: m[1].toLowerCase() as RoleBlock["kind"], name: slug, body: "" }
        blocks.push(cur)
      } else {
        cur = null // any other heading (or malformed role heading) ends the block
      }
      continue
    }
    if (!cur) continue
    const ext = /^-\s*extends:\s*`?([A-Za-z0-9][A-Za-z0-9-]*)`?\s*$/i.exec(line)
    if (ext && cur.kind === "role" && !cur.extends) {
      cur.extends = ext[1].toLowerCase()
      continue
    }
    if (line) cur.body = cur.body ? `${cur.body}\n${line}` : line
  }
  return blocks.filter((b) => b.body.length > 0)
}

/** Last `role:` definition for a slug in file order (re-appending the same slug rewrites it). */
function lastRoleDef(slug: string, blocks: RoleBlock[]): RoleBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === "role" && b.name === slug) return b
  }
  return undefined
}

/**
 * Resolve a slug's full brief: registry `role:` def (modify/replace) or built-in base,
 * climbed through its `extends:` chain, then every `extend:` block folded on top
 * (broadening a base applies wherever that base is used). `seen` breaks extends cycles.
 */
function resolveRaw(slug: string, blocks: RoleBlock[], seen: Set<string>): string | null {
  if (seen.has(slug)) return null // extends-cycle guard: stop climbing, never hang
  seen.add(slug)
  const def = lastRoleDef(slug, blocks)
  let base: string | null
  if (def) {
    base = def.body
    if (def.extends) {
      const parent = resolveRaw(def.extends, blocks, seen)
      base = parent ? `${parent}\n${def.body}` : def.body // unknown base: stand on the role's own body
    }
  } else {
    base = ROLE_BRIEFS[slug] ?? null
  }
  if (base === null) return null
  const exts = blocks.filter((b) => b.kind === "extend" && b.name === slug)
  if (exts.length > 0) base = `${base}\n${EXTEND_PREAMBLE}\n${exts.map((e) => e.body).join("\n")}`
  return base
}

/** Fully resolved brief for a slug (built-in or registry role), or null when unknown. */
export function resolveRoleBrief(slug: string, blocks: RoleBlock[]): string | null {
  return resolveRaw(slug.trim().toLowerCase(), blocks, new Set())
}

/** Registry-defined custom slugs (not built-in), in file order, de-duplicated (last def wins). */
function customSlugs(blocks: RoleBlock[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (b.kind !== "role" || b.name in ROLE_BRIEFS) continue
    if (!out.includes(b.name)) out.push(b.name)
  }
  return out
}

/** Slug -> heading title, sentence case to match the built-in headings (`security-auditor` -> `Security auditor`). */
function titleize(slug: string): string {
  // slugs are lowercase-only by SLUG_RE, so only the first letter needs raising
  return slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())
}

/** One-line-per-role listing for /swarm-roles (built-ins + registry, with modify/broaden markers). */
export function registrySummary(blocks: RoleBlock[]): string {
  const slugs = [...BUILTIN_ROLES.map((r) => r.slug), ...customSlugs(blocks)]
  return slugs
    .map((slug) => {
      if (resolveRoleBrief(slug, blocks) === null) return null
      const marks = [slug in ROLE_BRIEFS ? "built-in" : "custom"]
      const def = lastRoleDef(slug, blocks)
      if (def && slug in ROLE_BRIEFS) marks.push("modified")
      else if (def?.extends) marks.push(`extends ${def.extends}`)
      const extCount = blocks.filter((b) => b.kind === "extend" && b.name === slug).length
      if (extCount > 0) marks.push(`broadened x${extCount}`)
      return `- ${slug} (${marks.join(", ")})`
    })
    .filter((line): line is string => line !== null)
    .join("\n")
}

/**
 * The Specialist roles section of the skill: the built-in roster (with any registry
 * modifications/broadenings folded in), custom registry roles, and the registry
 * contract that lets the orchestrator add/modify/broaden roles itself.
 */
export function rolesSection(blocks: RoleBlock[], rolesPath: string): string {
  const builtin = BUILTIN_ROLES.map(({ slug, title }) => {
    const modified = lastRoleDef(slug, blocks) !== undefined
    const brief = resolveRoleBrief(slug, blocks) ?? ROLE_BRIEFS[slug]
    return `### ${title} lane${modified ? " (modified)" : ""}\n${brief}`
  }).join("\n\n")
  const customs = customSlugs(blocks)
    .flatMap((slug) => {
      const brief = resolveRoleBrief(slug, blocks)
      return brief ? [`### ${titleize(slug)} lane (custom)\n${brief}`] : []
    })
    .join("\n\n")
  const customSection = customs ? `\n\n${customs}` : ""
  return `## Specialist roles

Assign ONE specialist role per lane (mix and match as the workstreams demand):

${builtin}${customSection}

### Role registry - add, modify, or broaden roles yourself

The registry is yours to shape: when no built-in fits a workstream, define a project-specific role; when a built-in needs this project's judgment, broaden (or modify) it. Registry file: \`${rolesPath}\` - append-only markdown, same discipline as the relay.

Block format:

\`\`\`
### role: security-auditor
- extends: verifier
- One-line purpose for this specialist.
- 2-5 terse, imperative rules.

### extend: builder
- Extra judgment every builder lane in this project should apply.
\`\`\`

Rules:
- Slugs: lowercase letters, digits, hyphens. ONE role per lane still applies.
- \`role:\` on a new slug ADDS a role; \`role:\` on an existing slug (built-in or custom) REPLACES that brief - that is how you modify a role. Re-appending the same custom slug rewrites it (last block wins).
- \`extend:\` APPENDS guidance to an existing role - that is how you broaden one. Multiple \`extend:\` blocks accumulate in file order, and broadening a base applies everywhere that base is used (including roles that \`extends:\` it).
- \`- extends: <slug>\` makes a custom role inherit a base (built-in or another custom; a cycle resolves to the role's own body instead of hanging).
- Custom roles are specialization only: every lane still gets the Lane doctrine verbatim (evidence over assertion, scope fence, STATUS/FINDINGS/HANDOFFS finish). A registry block never replaces the doctrine, the relay protocol, or the refine loop.
- Effects are immediate if you read the file mid-run; the skill re-renders automatically when the file changes, so later runs see it too.
- Add a role only when a real workstream needs it (recurring project-specific specialists), keep each block paste-able (<=8 lines), and prune stale blocks - keep the file under ~150 lines.`
}

/**
 * Lane doctrine — working rules every lane follows (NOT permission rails).
 * Injected into every lane brief so parallel lanes stay coherent and error-free.
 */
export const DOCTRINE = `## Lane doctrine (follow always; these are working rules, not permissions)

1. **Evidence over assertion.** Every claim carries evidence: file:line, command output, or an explicit "I could not verify X". Never present a guess as a finding.
2. **Scope fence.** Do exactly your brief. If you discover work outside your lane, do NOT do it — append it to the relay (see below) as a handoff note and stay in scope.
3. **Read before write.** Open every file you intend to cite. Never cite from memory or from the brief's description of the code.
4. **One truth per fact.** If the relay already contains a verified fact you were about to re-derive, cite it instead of re-deriving — but re-check anything your conclusion depends on.
5. **Fail loudly, early.** If your lane is blocked (missing file, unclear requirement, failing check), say so in your report with the exact blocker. Do not pad a report to look complete.
6. **Deterministic finish.** End every report with: STATUS (done | partial | blocked), FINDINGS (numbered, each with evidence), HANDOFFS (anything the orchestrator or another lane needs).
7. **No self-promotion.** Do not grade your own work as excellent. Report what you did and how you verified it; the orchestrator judges.`

/** Lane-to-lane communication protocol (relay file). */
export function relaySection(relayPath: string): string {
  return `## Lane-to-lane communication (relay file)

Lanes coordinate through \`${relayPath}\` — an append-only markdown relay. It is the ONLY channel between lanes; subagents cannot message each other directly.

- **Format:** each entry is \`### [wave-N/lane-ID role] one-line summary\` followed by ≤5 bullet lines. One entry per meaningful event (start-assumption, finding, blocker, handoff).
- **Read first, write second:** on start, read the relay top-to-bottom. Build on others' verified facts; do not repeat work already done.
- **Append, never edit:** never rewrite or delete another lane's entry. If you disagree, append a contradicting entry with your evidence.
- **Handoffs:** to request another lane's attention, append \`### HANDOFF -> lane-ID\` with what you need. The orchestrator also watches the relay and can re-route.
- **Size discipline:** keep entries terse; the relay is context every other lane pays for. Target ≤15 lines per entry.
- Keep the file under ~300 lines; the orchestrator prunes stale entries after each wave.`
}

/** Refine/reiterate loop — where frontier-level quality comes from. */
export function refineSection(passes: number): string {
  if (passes <= 0) {
    return `## Refine loop

Refine passes: 0 (disabled). Integrate once, verify, report — no critique iteration.`
  }
  const s = passes === 1 ? "" : "es"
  return `## Refine loop (frontier-quality step — do not skip)

Quality comes from iterate-on-critique, not from a lucky first draft. After integrating lane results:

1. **Draft** — produce the integrated candidate answer/diff/report.
2. **Critique** — dispatch a verifier lane (or reuse a fresh-context subagent) whose ONLY job is to attack the draft: wrong claims, missed edge cases, broken invariants, unverified assertions. It reads the relay so it knows what was actually checked.
3. **Fix** — apply accepted critique points yourself (main session owns the diff).
4. **Re-verify** — run the real checks (tests/linters/repro) on the fixed version. If the critique raised a factual claim, confirm the fix addresses it.
5. **Repeat** up to ${passes} pass${s} — stop EARLY the moment a critique finds zero substantive issues. Never iterate past the point of diminishing returns; log "refine converged after N passes" in memory.`
}

type SwarmMode = "adaptive" | "manual"

/** Adaptive lane-count rubric — derives lane count from the work; explicitly not a fixed default. */
export const LANE_RUBRIC = `  - Derive the lane count from the WORKSTREAMS in the task, never from a fixed default. Rubric:
    - 1 lane: a single small deliverable; parallelism would add overhead, not speed.
    - 2-3 lanes: one problem with 2-3 separable aspects (e.g. analyze + fix, or two independent files).
    - 4-6 lanes: multiple independent subsystems/modules, or a broad audit where coverage = parallelism.
    - 7+ lanes: only when the user explicitly asked for many lanes, or the task genuinely has 7+ independent workstreams. More lanes than workstreams means duplicated work - split by workstream, never by number.`

/** Per-task lane hint from the prompt text (used in the /swarm expansion where the task is known). */
export function laneHint(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const hint = Math.min(6, Math.max(1, Math.round(words / 12)))
  return `complexity hint from the prompt (~${words} words): about ${hint} independent lane(s) - treat as an input, not a mandate; count actual independent workstreams before dispatching`
}

export function skillContent(
  mode: SwarmMode,
  memoryPath: string,
  waveSize: number,
  rateLimitOn: boolean,
  refinePasses: number,
  relayPath: string,
  roleBlocks: RoleBlock[] = [],
  rolesPath: string = path.join(path.dirname(memoryPath), "swarm-roles.md"),
): string {
  const modeSection =
    mode === "manual"
      ? `## Mode: MANUAL

You do NOT decide the swarm shape - the user does. Before dispatching:
- Take the requested subagent count and hierarchy (flat lanes vs lead/worker) from the user's request.
- If the user did not state them, ask: how many lanes, and flat or hierarchical?
- Only dispatch what the user approved. If the user says 2 flat lanes, run 2 flat lanes.`
      : `## Mode: ADAPTIVE

You decide the swarm shape based on task analysis:
${LANE_RUBRIC}
- Choose the hierarchy: flat lanes for independent work; add a lead lane only when one lane's output must be coordinated/merged by another worker before your final integration.
- Justify the shape in one or two lines before dispatching (e.g. "5 workstreams -> 5 lanes: parser, CLI, tests, docs, benchmark - no shared files").
- After each run, note in memory whether the chosen shape was right; next time adapt.
- Never say "I'll use the default N lanes". There is no default count - there is only the work.`
  return `${attribution()}
# Swarm (lightweight)

Orchestration protocol. No gates, no receipts, no enforced reviews - you decide (within the mode below).

${modeSection}

## Adaptive scheduler (v2) - serial is the default

Before spawning anything, call **swarm_plan** with the real shape of the task: \`branches\`, \`branchSeconds\`, \`independence\`, \`sharedContext\`, \`ambiguity\`, \`risk\`, \`verificationValue\`, and \`tasks\`/\`nodes\` when the work is known. It returns \`runId\`, the chosen topology, the exact lane count, waves, batches, model routes, verification level, estimates, reasons and shadow alternatives.

Obey the plan. The scheduler exists to stop you from fanning out when serial wins:

- **SERIAL** - do the work yourself. Spawn nothing. (One lane of work is not a swarm.)
- **BATCHED_WORKER** - spawn exactly \`agents\` workers; put one \`batches[i]\` per worker in its brief. Never spawn one agent per microtask.
- **SMALL_SWARM / FULL_SWARM** - spawn at most \`agents\` lanes, in \`waves\`. Do not invent extra lanes; do not exceed \`agents\`.
- **SPECULATIVE_SWARM** - spawn the planned scouts only. Merge their findings with **swarm_converge**; expand only when the uncertainty is real, and stop the redundant branches early.
- **PIPELINE** - dispatch DAG stages in the returned waves. Never start a node before its edges finish.

Before dispatch: use **swarm_capsule** \`attach\` (or create/merge) and paste the capsule text into every lane brief; attach only verified facts as facts, mark hypotheses. Use **swarm_route** for provider/model choice; route within a lane, never create a new top-level agent. Use **swarm_lane** \`acquire\` to reuse a compatible idle lane (same role/model/category/capsule scope) and \`register\`/\`release\` for fresh ones; never transplant context across scopes.

After dispatch: record every lane with **swarm_record** (startup, work, tokens, status, warm). After integration call **swarm_verify** (or use the level in the plan) - V0 self-check, V1 repro, V2 independent verifier, V3 spec-derived tests + targeted judge, V4 adversarial verifier. Start cheap; escalate only on disagreement, low confidence, weak tests or high impact. A judge is one optional step, never the default. Close the run with **swarm_record** actuals and inspect **swarm_status** / **swarm_replay**. If a lane fails or a provider is cooling down, reroute or cancel - never hammer it.

If no scheduler tool is available, fall back to: total expected work under ~60s or fewer than 2 genuinely independent branches -> serial; otherwise at most 3 lanes and batch small tasks.

## Workflow

1. **Memory + registry** - read \`${memoryPath}\` if it exists (apply relevant lessons) and \`${rolesPath}\` if it exists (project-specific or extended specialist roles - see the Role registry under Specialist roles).
2. **Plan (scheduler first)** - call \`swarm_plan\`. If it chooses SERIAL, do the work yourself and skip steps 3-4; only a non-serial plan earns lanes. For a swarm plan, split the work into exactly the planned number of independent bursts, one lane per workstream. Each lane brief is self-contained: goal, relevant files/context (plus the capsule text), verification method, expected report, and the lane doctrine (below).
3. **Dispatch exactly the plan** - launch at most \`agents\` lanes with the \`subagent\` tool in ONE message per wave, background by default. Attach the matching specialist brief (a built-in roster entry or a registry role from \`${rolesPath}\`) + doctrine to each lane's prompt. Prefer dedicated agents if available (\`swarm-coder\`, \`swarm-researcher\`, \`swarm-reviewer\`); otherwise the builtin \`general\` subagent with the specialist brief. Don't give two lanes the same files. For BATCHED_WORKER, give each worker its returned batch; never one agent per microtask.
4. **Relay** - lanes coordinate via \`${relayPath}\`; you (orchestrator) also read it between waves to re-route handoffs.
5. **Integrate** - combine results, resolve conflicts yourself, run tests/linters.
6. **Verify adaptively** - use the plan's verification level (or \`swarm_verify\`) and the refine loop below until critique converges. Escalate only on real disagreement, low confidence, weak tests or high impact; do not add a judge by reflex.
7. **Review (optional)** - spawn a reviewer lane only when the user asked, or when the change is high-risk. Findings inform you; they don't block you.
8. **Record + memory** - call \`swarm_record\` for each lane and close the run with actuals/quality; inspect \`swarm_replay\` to compare prediction with reality. Append short bullets to \`${memoryPath}\`: what worked, what didn't, project facts worth keeping. Keep the file under ~150 lines; prune stale entries.

## Lane doctrine

Every lane brief MUST include this doctrine verbatim (it is the error-reduction contract between lanes):

${DOCTRINE}

## Lane-to-lane communication

${relaySection(relayPath)}

${rolesSection(roleBlocks, rolesPath)}

${refineSection(refinePasses)}

## Dispatching

- **One message per wave**: put every lane's \`subagent\` call in the SAME assistant message so they start together - one turn for the whole wave, not one turn per lane.
- Wave size = ~${waveSize} lanes (the dispatch burst). More lanes than that? Dispatch the next wave while earlier lanes are still running.
- **Background subagents by default** on multi-lane runs - lanes overlap, the user never waits on your turn, and you integrate as results land.
- Subagents start with fresh context - give each lane everything it needs in its brief, including the doctrine and its role brief.
- Subagents inherit your model unless the brief says otherwise.
- **Rate limit**: ${rateLimitOn ? `dispatches are token-bucket limited (burst ${waveSize}). A rejected dispatch carries a retry hint in ms - wait that long, retry that lane once, then consolidate lanes if it still fails.` : `rate limiting is OFF - there is no dispatch budget to watch, wave size is purely advisory.`}
- When a lane involves images, PDFs, screenshots, or diagrams, make it a multimodal analyst lane and list the media paths in the brief.

## Principles

- Parallelism is a tool, not a goal. Don't spawn subagents for a small task.
- The orchestrator owns the truth: verify subagent claims before reporting done.
- Lane count follows workstreams, never a fixed default.
- Context is auto-compacted on long runs; keep lane briefs self-contained so compaction cannot orphan a lane.
`
}

export default Plugin.define({
  id: "swarm-lite",
  async setup(ctx) {
    // ---- configuration (options from opencode.json, runtime mode via storage) ----
    const memoryPath =
      typeof ctx.options.memoryPath === "string" && ctx.options.memoryPath.length > 0
        ? (ctx.options.memoryPath as string)
        : DEFAULT_MEMORY

    const defaultMode: SwarmMode = ctx.options.mode === "manual" ? "manual" : "adaptive"
    const rateCfg: RateLimitOptions = {
      enabled: ctx.options.rateLimitEnabled !== false,
      ratePerSecond: num(ctx.options.ratePerSecond, DEFAULT_RATE_PER_SECOND, 0.01),
      burst: num(ctx.options.burst, DEFAULT_BURST, 1),
    }
    const limiter = new DispatchRateLimiter(rateCfg)
    /** Lanes that can start in one message (the dispatch burst). */
    const waveSize = rateCfg.burst
    const rateLimitOn = rateCfg.enabled

    const compactThreshold = num(ctx.options.compactThreshold, 40, 1)
    const compactCooldownMs = num(ctx.options.compactCooldownMs, 30_000, 0)
    const lastCompaction = new Map<string, number>()
    const compacting = new Set<string>()

    /** Refine/reiterate passes (0 disables the loop; capped at 3). */
    const refinePasses = Math.min(3, num(ctx.options.refinePasses, 1, 0))
    /** Lane-to-lane relay file (append-only coordination log). */
    const relayPath =
      typeof ctx.options.relayPath === "string" && ctx.options.relayPath.length > 0
        ? (ctx.options.relayPath as string)
        : path.join(path.dirname(memoryPath), "swarm-relay.md")
    /** Role registry file (agent-writable: add / modify / broaden specialist roles). */
    const rolesPath =
      typeof ctx.options.rolesPath === "string" && ctx.options.rolesPath.length > 0
        ? (ctx.options.rolesPath as string)
        : path.join(path.dirname(memoryPath), "swarm-roles.md")

    // ---- adaptive runtime state (v2): stats, circuits, lanes, capsules, telemetry ----
    // Keep all runtime files in their own directory so v1 memory/relay/roles files
    // are never rewritten by the scheduler.
    const stateDir =
      typeof ctx.options.stateDir === "string" && ctx.options.stateDir.length > 0
        ? (ctx.options.stateDir as string)
        : path.join(path.dirname(memoryPath), "swarm-state")
    const runtimeStats = new StatsStore(path.join(stateDir, "stats.json"))
    const providerHealth = new ProviderHealth(path.join(stateDir, "provider-health.json"), {
      failureThreshold: num(ctx.options.providerFailureThreshold, 3, 1),
      cooldownMs: num(ctx.options.providerCooldownMs, 60_000, 1_000),
      timeoutThreshold: num(ctx.options.providerTimeoutThreshold, 2, 1),
      timeoutCooldownMs: num(ctx.options.providerTimeoutCooldownMs, 45_000, 1_000),
    })
    const runtimeRouter = new Router(runtimeStats, providerHealth, {
      profiles: Array.isArray(ctx.options.profiles) ? (ctx.options.profiles as ModelProfile[]) : undefined,
      qualityWeight: num(ctx.options.qualityWeight, 0.25, 0),
      quotaGroups: ctx.options.quotaGroups as Record<string, { maxConcurrent: number }> | undefined,
    })
    const lanePool = new LanePool(path.join(stateDir, "lanes.json"), {
      ttlMs: num(ctx.options.laneTtlMs, 10 * 60_000, 5_000),
      maxUses: num(ctx.options.laneMaxUses, 4, 1),
    })
    const capsuleStore = new CapsuleStore(path.join(stateDir, "capsules"))
    const runtimeTelemetry = new Telemetry(path.join(stateDir, "events.jsonl"))
    const history = new RunHistory(path.join(stateDir, "history.json"))
    const trustStore = new TrustStore(path.join(stateDir, "trust.json"))
    const checkpointManager = new CheckpointManager(path.join(stateDir, "checkpoint.json"), {
      telemetry: runtimeTelemetry,
    })
    const policyStore = new PolicyStore(path.join(stateDir, "policy.json"))
    const runManifestStore = new RunManifestStore({ dir: path.join(stateDir, "runs") })
    const scheduler = new AdaptiveScheduler({
      stats: runtimeStats,
      router: runtimeRouter,
      health: providerHealth,
      lanes: lanePool,
      config: {
        maxAgents: num(ctx.options.swarmMaxAgents ?? ctx.options.maxAgents, 8, 1),
        maxTasksPerBatch: num(ctx.options.maxTasksPerBatch, 6, 1),
        qualityWeight: num(ctx.options.qualityWeight, 0.25, 0),
        judgeAvailable: ctx.options.judgeAvailable !== false,
        judgeCostSeconds: num(ctx.options.judgeCostSeconds, 45, 0),
        minSpeedupSwarm: num(ctx.options.minSpeedupSwarm, 1.08, 1),
        minSpeedupBatch: num(ctx.options.minSpeedupBatch, 1.03, 1),
        minSavingsSeconds: num(ctx.options.minSavingsSeconds, 5, 0),
      },
    })
    const runCoordinator = new RunCoordinator({
      manifest: runManifestStore,
      telemetry: runtimeTelemetry,
      checkpoint: checkpointManager,
      policy: policyStore,
      scheduler,
      router: runtimeRouter,
      health: providerHealth,
      lanes: lanePool,
      capsules: capsuleStore,
      history,
      stats: runtimeStats,
    })
    const mixedStrategyScheduler = new MixedStrategyScheduler({
      stats: runtimeStats,
      scheduler,
      router: runtimeRouter,
      health: providerHealth,
    })
    const portfolioRouter = new PortfolioRouter({
      router: runtimeRouter,
      health: providerHealth,
      trust: trustStore,
      stats: runtimeStats,
    })

    /** Read + parse the role registry (missing/unreadable file = registry-only built-ins). */
    const loadRoles = (): RoleBlock[] => {
      try {
        return parseRoles(fs.readFileSync(rolesPath, "utf8"))
      } catch {
        return []
      }
    }

    // ---- seed memory file on first load; never touch an existing one ----
    try {
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
      fs.writeFileSync(memoryPath, MEMORY_HEADER + WATERMARK + "\n", { flag: "wx" })
    } catch {
      // exists or unwritable - leave alone
    }

    // ---- current mode: storage override, else configured default ----
    const currentMode = async (): Promise<SwarmMode> => {
      const stored = await ctx.storage.get("mode")
      if (stored === "manual" || stored === "adaptive") return stored
      return defaultMode
    }

    // ---- role registry state (hot: reloaded whenever swarm-roles.md changes on disk) ----
    let customRoles = loadRoles()
    const statRoles = (): string => {
      try {
        const s = fs.statSync(rolesPath)
        return `${s.mtimeMs}:${s.size}`
      } catch {
        return "absent"
      }
    }
    let rolesStamp = statRoles()

    // ---- swarm skill ----
    const initialMode = await currentMode()
    const skillPath = path.join(path.dirname(memoryPath), "swarm", "SKILL.md")
    const skillDescription =
      "Lightweight multi-agent orchestration - adaptive or manual swarm shape, lane doctrine, extensible specialist roles (add/modify/broaden via the role registry), lane-to-lane relay comms, refine/reiterate loops, one-message parallel dispatch in waves, multimodal lanes, dispatch rate limiting, auto-compaction, shared memory. Use when the user says 'swarm' or asks to parallelize work across agents."
    const renderSkill = (mode: SwarmMode): string =>
      skillContent(mode, memoryPath, waveSize, rateLimitOn, refinePasses, relayPath, customRoles, rolesPath)
    await ctx.skill.transform((editor) => {
      editor.add({
        id: brand<Skill.ID>("swarm"),
        name: brand<Skill.Name>("Swarm"),
        description: skillDescription,
        path: brand(skillPath),
        content: renderSkill(initialMode),
      })
    })

    // ---- custom runtime tools (plan/route/capsules/lanes/converge/verify/...) ----
    // These are the scheduler's control surface. They never spawn agents: the
    // parent model remains the only orchestration loop and calls `subagent`.
    const runtimeTools = createSwarmTools({
      stats: runtimeStats,
      router: runtimeRouter,
      health: providerHealth,
      lanes: lanePool,
      capsules: capsuleStore,
      telemetry: runtimeTelemetry,
      scheduler,
      history,
      manifest: runManifestStore,
      coordinator: runCoordinator,
      mixedStrategy: mixedStrategyScheduler,
      portfolioRouter,
    })
    await ctx.tool.transform((editor) => {
      for (const tool of runtimeTools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          execute: async (input, toolCtx) => {
            const result = await tool.execute(input, { sessionID: toolCtx.sessionID })
            return { content: result.content, metadata: result.metadata }
          },
        })
      }
    })

    // re-render the skill whenever the stored mode or the role registry changes;
    // add-if-missing so a missing skill is re-registered instead of silently skipped
    const refreshSkill = async () => {
      const content = renderSkill(await currentMode())
      await ctx.skill.transform((editor) => {
        const existing = editor.get("swarm")
        if (existing) editor.update("swarm", (s) => (s.content = content))
        else
          editor.add({
            id: brand<Skill.ID>("swarm"),
            name: brand<Skill.Name>("Swarm"),
            description: skillDescription,
            path: brand(skillPath),
            content,
          })
      })
    }

    // reload the registry + re-render the skill when the roles file changed on disk
    // (stamp only advances after a successful re-render, so a missed refresh retries)
    const maybeRefreshRoles = async (): Promise<boolean> => {
      const now = statRoles()
      if (now === rolesStamp) return false
      customRoles = loadRoles()
      await refreshSkill()
      rolesStamp = now
      return true
    }

    // ---- rate-limit subagent dispatches (token bucket) ----
    if (rateCfg.enabled) {
      await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "subagent") return
        limiter.consume() // throws on exhaustion -> model sees reason and adapts
      })
    }

    // ---- role registry hot-refresh: pick up registry edits made through write/edit/patch ----
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool === "write" || event.tool === "edit" || event.tool === "patch") void maybeRefreshRoles()
    })

    // ---- automatic subagent telemetry ----
    // The scheduler tools are advisory; the model can still call `subagent`
    // directly. These hooks make every actual spawn visible without changing
    // the ONE PARENT -> LANES architecture: no agent is created here.
    const spawnStarted = new Map<string, { at: number; agent: string; description: string; role: string }>()
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "subagent") return
      const input = asRecord(event.input)
      const agent = str(input.agent ?? input.subagent_type, "general")
      const description = str(input.description, "subagent lane")
      const role = str(input.role ?? input.agent_role, "")
      const resumedSessionID = str(input.sessionID ?? input.sessionId, "")
      const warm = resumedSessionID.length > 0
      const runId = runtimeTelemetry.latestPlan(event.sessionID)?.plan.runId
      spawnStarted.set(event.id, { at: Date.now(), agent, description, role })
      runtimeTelemetry.log(
        "SPAWN",
        {
          auto: true,
          agent,
          role: role || undefined,
          description,
          promptChars: str(input.prompt).length,
          toolCallID: event.id,
          warm,
          sessionID: resumedSessionID || undefined,
        },
        { runId, parentSessionID: event.sessionID },
      )
      runtimeTelemetry.log(
        "ASSIGN",
        { auto: true, agent, role: role || undefined, description, toolCallID: event.id, warm },
        { runId, parentSessionID: event.sessionID },
      )
    })
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "subagent") return
      const started = spawnStarted.get(event.id)
      spawnStarted.delete(event.id)
      const input = asRecord(event.input)
      const agent = started?.agent ?? str(input.agent ?? input.subagent_type, "general")
      const description = started?.description ?? str(input.description, "subagent lane")
      const elapsedSeconds = started ? Math.max(0, (Date.now() - started.at) / 1000) : undefined
      const runId = runtimeTelemetry.latestPlan(event.sessionID)?.plan.runId
      const okStatus = event.status === "completed"
      const base = {
        auto: true,
        agent,
        role: started?.role || undefined,
        description,
        elapsedSeconds: elapsedSeconds !== undefined ? roundSeconds(elapsedSeconds) : undefined,
        toolCallID: event.id,
      }
      if (okStatus) {
        runtimeTelemetry.log("LANE_DONE", base, { runId, parentSessionID: event.sessionID })
      } else {
        runtimeTelemetry.log(
          "LANE_FAIL",
          { ...base, error: event.status === "error" ? sanitizeError(event.error) : "unknown" },
          { runId, parentSessionID: event.sessionID },
        )
      }
    })

    // ---- auto-compaction: trigger when a session grows past the threshold ----
    await ctx.session.hook("context", (event) => {
      void maybeRefreshRoles() // also catches registry edits made outside write tools (e.g. shell append)
      // prune stale cooldown entries so the map cannot grow across sessions
      if (lastCompaction.size > 256) {
        const cutoff = Date.now() - Math.max(compactCooldownMs, 60_000)
        for (const [sid, at] of lastCompaction) if (at < cutoff) lastCompaction.delete(sid)
      }
      const id = event.sessionID
      if (compacting.has(id)) return
      if (event.messages.length < compactThreshold) return
      const last = lastCompaction.get(id) ?? 0
      if (Date.now() - last < compactCooldownMs) return
      compacting.add(id)
      void ctx.session
        .compact({ sessionID: id })
        // cooldown starts only on success: a failed compaction releases the guard
        // without burning the cooldown, so the next context build can retry
        .then(() => lastCompaction.set(id, Date.now()))
        .catch(() => {})
        .finally(() => compacting.delete(id))
    })

    // ---- commands ----
    await ctx.command.transform((editor) => {
      editor.add({
        name: "swarm",
        description: "Split a task across parallel subagent lanes",
        execute: async ({ sessionID, prompt, delivery }) => {
          const mode = await currentMode()
          const shapeGuidance =
            mode === "manual"
              ? "Mode is MANUAL: before dispatching, confirm the subagent count and hierarchy with the user if they did not state them."
              : `Mode is ADAPTIVE: you choose the lane count and hierarchy that fit the task, and justify the shape in a line or two. ${laneHint(prompt.text)}.`
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `Load the \`swarm\` skill and orchestrate this task: ${prompt.text}\n\n${shapeGuidance} Split into independent lanes and dispatch them in parallel - every lane in ONE message, in waves of ~${waveSize}. Attach the Lane doctrine and one specialist role brief to EVERY lane brief - a built-in roster entry, or a role from the registry at ${rolesPath} if a workstream fits it better (add/modify/broaden roles there per the Role registry section when no built-in fits). Lanes coordinate through the relay file (${relayPath}) - read it before starting, append findings/handoffs as you go. Integrate, then run the refine loop (${refinePasses} pass${refinePasses === 1 ? "" : "es"}: draft -> verifier critique -> fix -> re-verify; stop early on convergence) before reporting done. No review step unless I asked for one.`,
          })
        },
      })

      editor.add({
        name: "review",
        description: "Optional review of current changes by a reviewer lane",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `Load the \`swarm\` skill, then dispatch a single reviewer lane over my current changes. Use the Reviewer lane role brief. Scope: ${prompt.text || "all current changes"}. Report findings ranked by severity; do not edit files.`,
          })
        },
      })

      editor.add({
        name: "swarm-status",
        description: "Show swarm mode, dispatch budget, and compaction settings",
        execute: async ({ sessionID, prompt, delivery }) => {
          await maybeRefreshRoles() // listing reflects the file on disk, even shell-edited
          const mode = await currentMode()
          const s = limiter.status()
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `Swarm status - reply with exactly these lines:\n- Mode: ${mode.toUpperCase()} (default ${defaultMode.toUpperCase()})\n- Dispatch budget: burst ${s.burst} at ${s.ratePerSecond}/s, rate limiting ${s.enabled ? "ON" : "OFF"}, ~${s.tokens.toFixed(1)} of ${s.burst} tokens available now\n- Dispatch wave size: ~${waveSize} lanes per message\n- Refine loop: ${refinePasses} pass${refinePasses === 1 ? "" : "es"}${refinePasses === 0 ? " (disabled)" : " (draft -> critique -> fix -> re-verify)"}\n- Roles: ${BUILTIN_ROLES.length} built-in + ${customRoles.length} registry block(s)\n- Role registry: ${rolesPath}\n- Relay file: ${relayPath}\n- Auto-compaction: every ${compactThreshold} messages, ${compactCooldownMs / 1000}s cooldown\n- Memory file: ${memoryPath}`,
          })
        },
      })

      editor.add({
        name: "swarm-roles",
        description: "List specialist roles, or add/modify/broaden them in the role registry",
        execute: async ({ sessionID, prompt, delivery }) => {
          await maybeRefreshRoles() // listing reflects the file on disk, even shell-edited
          const request = prompt.text.trim()
          const listing = registrySummary(customRoles)
          if (request) {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: `Load the \`swarm\` skill (Role registry section) and update the specialist role registry at ${rolesPath} for this request: ${request}\n\nFollow the block format exactly: \`### role: <slug>\` to add a role or modify an existing one (on a built-in slug it replaces that brief), \`### extend: <slug>\` to broaden a role, optional \`- extends: <base>\` on role blocks. Keep every block to <=8 lines, do not dispatch any lane, and do not touch any file besides ${rolesPath}. After writing, reply with the updated listing below plus one line naming what you changed:\n${listing}`,
            })
          } else {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: `Current specialist-role registry (${BUILTIN_ROLES.length} built-in, ${customRoles.length} registry block(s)). Reply with exactly these lines and nothing else:\n${listing}\n- registry file: ${rolesPath} (use /swarm-roles <request> to add, modify, or broaden roles)`,
            })
          }
        },
      })

      editor.add({
        name: "swarm-mode",
        description: "Show or switch swarm mode (adaptive | manual)",
        execute: async ({ sessionID, prompt, delivery }) => {
          // first token decides: "/swarm-mode adaptive please" switches, extra words ignored
          const arg = prompt.text.trim().toLowerCase().split(/\s+/)[0] ?? ""
          if (arg === "adaptive" || arg === "manual") {
            await ctx.storage.set("mode", arg)
            await refreshSkill()
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: `Swarm mode switched to ${arg.toUpperCase()}. The swarm skill has been re-rendered for the new mode. Confirm briefly and continue.`,
            })
          } else {
            const mode = await currentMode()
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: `Current swarm mode: ${mode.toUpperCase()} (default: ${defaultMode.toUpperCase()}). Use /swarm-mode adaptive or /swarm-mode manual to switch. Reply with just this information.`,
            })
          }
        },
      })
    })
  },
})
