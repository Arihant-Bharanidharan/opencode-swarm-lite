/**
 * opencode-swarm-lite — lightweight multi-agent orchestration for OpenCode
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 *
 * Features:
 *  - Adaptive or manual swarm modes (orchestrator decides vs user decides)
 *  - Parallel subagent lanes incl. multimodal analysts
 *  - Token-bucket rate limiting on subagent spawns
 *  - Auto-compaction of long sessions
 *  - Shared markdown memory file
 *
 * No gates, no receipts, no enforced reviews.
 */
import { Plugin } from "@opencode/plugin"
import type { Skill } from "@opencode/schema"
import { DispatchRateLimiter, type RateLimitOptions } from "./rate-limit.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export { DispatchRateLimiter, type RateLimitOptions } from "./rate-limit.js"

/** Brand a plain string as the schema requires (runtime value is unchanged). */
const brand = <T>(value: string): T => value as unknown as T

const AUTHOR = "Arihant Bharanidhran"
const EMAIL = "arihantbharani@outlook.com"
const VERSION = "1.1.0"

/**
 * Secret watermark: encodes "SWARMLITE/ARIHANT/2026" as Unicode tag characters
 * (U+E0020–U+E007F). Invisible in rendered text; recoverable by decoding the
 * tag-codepoint run back to ASCII.
 */
const WATERMARK: string = (() => {
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

type SwarmMode = "adaptive" | "manual"

function skillContent(mode: SwarmMode, memoryPath: string): string {
  const modeSection =
    mode === "manual"
      ? `## Mode: MANUAL

You do NOT decide the swarm shape - the user does. Before dispatching:
- Take the requested subagent count and hierarchy (flat lanes vs lead/worker) from the user's request.
- If the user did not state them, ask: how many lanes, and flat or hierarchical?
- Only dispatch what the user approved. If the user says 2 flat lanes, run 2 flat lanes.`
      : `## Mode: ADAPTIVE

You decide the swarm shape based on task analysis:
- Choose the lane count: estimate independent workstreams, cap at what parallelism actually helps (2-6 lanes typical; more is rarely faster).
- Choose the hierarchy: flat lanes for independent work; add a lead lane only when one lane's output must be coordinated/merged by another worker before your final integration.
- Justify the shape in one or two lines before dispatching (e.g. "3 flat lanes: parser, tests, docs - no shared files").
- After each run, note in memory whether the chosen shape was right; next time adapt.`
  return `${attribution()}
# Swarm (lightweight)

Orchestration protocol. No gates, no receipts, no enforced reviews - you decide (within the mode below).

${modeSection}

## Workflow

1. **Memory** - read \`${memoryPath}\` if it exists. Apply relevant lessons.
2. **Plan** - split the task into independent lanes. Each lane becomes one subagent with a self-contained brief: goal, relevant files/context, how to verify, expected report.
3. **Dispatch** - launch lanes in parallel with the \`subagent\` tool. Attach the matching role brief from this skill to each lane's prompt. Prefer dedicated agents if available (\`swarm-coder\`, \`swarm-researcher\`, \`swarm-reviewer\`); otherwise use the builtin \`general\` subagent with the role brief. Don't give two lanes the same files.
4. **Integrate** - combine results, resolve conflicts yourself, run tests/linters.
5. **Review (optional)** - spawn a reviewer lane only when the user asked, or when the change is high-risk. Findings inform you; they don't block you.
6. **Memory** - append short bullets to \`${memoryPath}\`: what worked, what didn't, project facts worth keeping. Keep the file under ~150 lines; prune stale entries.

## Role briefs

### Coder lane
${ROLE_BRIEFS.coder}

### Researcher lane
${ROLE_BRIEFS.researcher}

### Reviewer lane
${ROLE_BRIEFS.reviewer}

### Multimodal analyst lane
${ROLE_BRIEFS.multimodal}

## Dispatching

- Independent lanes run in parallel; use background subagents if the user shouldn't wait.
- Subagents start with fresh context - give each lane everything it needs in its brief.
- Subagents inherit your model unless the brief says otherwise.
- **Rate limit**: subagent dispatches are token-bucket limited (default 2/s, burst 4). If a dispatch is rejected with a rate-limit error, wait and retry, or consolidate lanes. Dispatch in waves rather than bursts.
- When a lane involves images, PDFs, screenshots, or diagrams, make it a multimodal analyst lane and list the media paths in the brief.

## Principles

- Parallelism is a tool, not a goal. Don't spawn subagents for a small task.
- The orchestrator owns the truth: verify subagent claims before reporting done.
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
      ratePerSecond: typeof ctx.options.ratePerSecond === "number" ? ctx.options.ratePerSecond : 2,
      burst: typeof ctx.options.burst === "number" ? ctx.options.burst : 4,
    }
    const limiter = new DispatchRateLimiter(rateCfg)

    const compactThreshold =
      typeof ctx.options.compactThreshold === "number" ? ctx.options.compactThreshold : 60
    const compactCooldownMs =
      typeof ctx.options.compactCooldownMs === "number" ? ctx.options.compactCooldownMs : 120_000
    const lastCompaction = new Map<string, number>()
    const compacting = new Set<string>()

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
      lastCompaction.set(id, Date.now())
      void ctx.session
        .compact({ sessionID: id })
        .catch(() => compacting.delete(id))
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
          "Lightweight multi-agent orchestration - adaptive or manual swarm shape, parallel lanes incl. multimodal analysts, dispatch rate limiting, auto-compaction, shared memory. Use when the user says 'swarm' or asks to parallelize work across agents.",
        path: brand(skillPath),
        content: skillContent(initialMode, memoryPath),
      })
    })

    // re-render skill content whenever the stored mode changes
    const refreshSkill = async () => {
      const mode = await currentMode()
      await ctx.skill.transform((editor) => {
        const existing = editor.get("swarm")
        if (existing) editor.update("swarm", (s) => (s.content = skillContent(mode, memoryPath)))
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
              : "Mode is ADAPTIVE: you choose the lane count and hierarchy that fit the task, and justify the shape in a line or two."
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: `Load the \`swarm\` skill and orchestrate this task: ${prompt.text}\n\n${shapeGuidance} Split into independent lanes, dispatch them in parallel, integrate, and verify. No review step unless I asked for one.`,
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
        name: "swarm-mode",
        description: "Show or switch swarm mode (adaptive | manual)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.trim().toLowerCase()
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
