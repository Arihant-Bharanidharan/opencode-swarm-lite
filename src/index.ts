/**
 * opencode-swarm-lite — lightweight multi-agent orchestration for OpenCode
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 *
 * Features:
 *  - Adaptive or manual swarm modes (orchestrator decides vs user decides)
 *  - Lane doctrine (working rules that cut errors + keep lanes coherent)
 *  - Specialist roles: architect, builder, verifier, researcher, reviewer, multimodal
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

const AUTHOR = "Arihant Bharanidhran"
const EMAIL = "arihantbharani@outlook.com"
const VERSION = "1.3.0"

/**
 * Secret watermark: encodes "SWARMLITE/ARIHANT/2026" as Unicode tag characters
 * (U+E0020–U+E007F). Invisible in rendered text; recoverable by decoding the
 * tag-codepoint run back to ASCII.
 */
export const WATERMARK: string = (() => {
  const secret = "SWARMLITE/ARIHANT/2026"
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

const ROLE_BRIEFS = {
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

## Workflow

1. **Memory** - read \`${memoryPath}\` if it exists. Apply relevant lessons.
2. **Plan** - split the task into independent lanes, one lane per independent workstream. Each lane becomes one subagent with a self-contained brief: goal, relevant files/context, verification method, expected report, and the lane doctrine (below).
3. **Dispatch** - launch lanes in parallel with the \`subagent\` tool in ONE message per wave, background by default. Attach the matching specialist brief + doctrine to each lane's prompt. Prefer dedicated agents if available (\`swarm-coder\`, \`swarm-researcher\`, \`swarm-reviewer\`); otherwise the builtin \`general\` subagent with the specialist brief. Don't give two lanes the same files.
4. **Relay** - lanes coordinate via \`${relayPath}\`; you (orchestrator) also read it between waves to re-route handoffs.
5. **Integrate** - combine results, resolve conflicts yourself, run tests/linters.
6. **Refine** - run the refine loop below until critique converges. This is where quality comes from.
7. **Review (optional)** - spawn a reviewer lane only when the user asked, or when the change is high-risk. Findings inform you; they don't block you.
8. **Memory** - append short bullets to \`${memoryPath}\`: what worked, what didn't, project facts worth keeping. Keep the file under ~150 lines; prune stale entries.

## Lane doctrine

Every lane brief MUST include this doctrine verbatim (it is the error-reduction contract between lanes):

${DOCTRINE}

## Lane-to-lane communication

${relaySection(relayPath)}

## Specialist roles

Assign ONE specialist role per lane (mix and match as the workstreams demand):

### Architect lane
${ROLE_BRIEFS.architect}

### Builder lane
${ROLE_BRIEFS.builder}

### Verifier lane
${ROLE_BRIEFS.verifier}

### Coder lane
${ROLE_BRIEFS.coder}

### Researcher lane
${ROLE_BRIEFS.researcher}

### Reviewer lane
${ROLE_BRIEFS.reviewer}

### Multimodal analyst lane
${ROLE_BRIEFS.multimodal}

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

    // ---- rate-limit subagent dispatches (token bucket) ----
    if (rateCfg.enabled) {
      await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "subagent") return
        limiter.consume() // throws on exhaustion -> model sees reason and adapts
      })
    }

    // ---- auto-compaction: trigger when a session grows past the threshold ----
    await ctx.session.hook("context", (event) => {
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

    // ---- swarm skill ----
    const initialMode = await currentMode()
    const skillPath = path.join(path.dirname(memoryPath), "swarm", "SKILL.md")
    await ctx.skill.transform((editor) => {
      editor.add({
        id: brand<Skill.ID>("swarm"),
        name: brand<Skill.Name>("Swarm"),
        description:
          "Lightweight multi-agent orchestration - adaptive or manual swarm shape, lane doctrine, specialist roles, lane-to-lane relay comms, refine/reiterate loops, one-message parallel dispatch in waves, multimodal lanes, dispatch rate limiting, auto-compaction, shared memory. Use when the user says 'swarm' or asks to parallelize work across agents.",
        path: brand(skillPath),
        content: skillContent(initialMode, memoryPath, waveSize, rateLimitOn, refinePasses, relayPath),
      })
    })

    // re-render skill content whenever the stored mode changes
    const refreshSkill = async () => {
      const mode = await currentMode()
      await ctx.skill.transform((editor) => {
        const existing = editor.get("swarm")
        if (existing)
          editor.update(
            "swarm",
            (s) => (s.content = skillContent(mode, memoryPath, waveSize, rateLimitOn, refinePasses, relayPath)),
          )
      })
    }

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
            text: `Load the \`swarm\` skill and orchestrate this task: ${prompt.text}\n\n${shapeGuidance} Split into independent lanes and dispatch them in parallel - every lane in ONE message, in waves of ~${waveSize}. Attach the Lane doctrine and one specialist role brief to EVERY lane brief. Lanes coordinate through the relay file (${relayPath}) - read it before starting, append findings/handoffs as you go. Integrate, then run the refine loop (${refinePasses} pass${refinePasses === 1 ? "" : "es"}: draft -> verifier critique -> fix -> re-verify; stop early on convergence) before reporting done. No review step unless I asked for one.`,
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
          const mode = await currentMode()
          const s = limiter.status()
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `Swarm status - reply with exactly these lines:\n- Mode: ${mode.toUpperCase()} (default ${defaultMode.toUpperCase()})\n- Dispatch budget: burst ${s.burst} at ${s.ratePerSecond}/s, rate limiting ${s.enabled ? "ON" : "OFF"}, ~${s.tokens.toFixed(1)} of ${s.burst} tokens available now\n- Dispatch wave size: ~${waveSize} lanes per message\n- Refine loop: ${refinePasses} pass${refinePasses === 1 ? "" : "es"}${refinePasses === 0 ? " (disabled)" : " (draft -> critique -> fix -> re-verify)"}\n- Relay file: ${relayPath}\n- Auto-compaction: every ${compactThreshold} messages, ${compactCooldownMs / 1000}s cooldown\n- Memory file: ${memoryPath}`,
          })
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
