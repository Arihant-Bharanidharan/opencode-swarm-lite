/**
 * Custom swarm tools. These are the runtime's public control surface: plan,
 * route, schedule, capsule, lane, convergence, verification, outcome recording,
 * status and replay. They do not spawn lanes themselves; the parent model still
 * has exactly one orchestration loop and calls `subagent` for actual work.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  CalibrationDashboard,
  Category,
  ChaosInjection,
  ChaosKind,
  DagNode,
  Finding,
  MicroTask,
  MultiDimensionGrade,
  Observation,
  ObservationStatus,
  Plan,
  PortfolioReport,
  ProviderReliability,
  QualityLevel,
  RecoveryAssertions,
  RunActuals,
  SchedulerDashboard,
  SlaMode,
  TaskInput,
  VerificationInput,
  VerificationLevel,
  WasteBreakdown,
} from "./types.js"
import type { StatsStore } from "./stats.js"
import type { ProviderHealth, Router } from "./provider.js"
import type { LanePool } from "./lanes.js"
import type { CapsuleStore } from "./capsules.js"
import type { RunHistory } from "./history.js"
import { Telemetry } from "./telemetry.js"
import type { RuntimeEvent } from "./telemetry.js"
import type { AdaptiveScheduler } from "./scheduler.js"
import { chooseVerification } from "./verify.js"
import { clusterFindings } from "./cluster.js"
import { scheduleDag } from "./schedule.js"
import { round } from "./util.js"
import { injectChaos, chaosPenalty, checkRecovery, CHAOS_PENALTY_SECONDS } from "./chaos.js"
import {
  calibrationDashboard,
  schedulerDashboard,
  wasteBreakdown,
  multiDimensionGrade,
} from "./dashboards.js"
import { planWithSla, SLA_PROFILES } from "./sla.js"

export interface SwarmToolDeps {
  stats: StatsStore
  router: Router
  health: ProviderHealth
  lanes: LanePool
  capsules: CapsuleStore
  telemetry: Telemetry
  scheduler: AdaptiveScheduler
  history: RunHistory
}

export interface ToolResult {
  content: string
  metadata?: Record<string, unknown>
}

export interface SwarmTool {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: any, context: { sessionID?: string }) => Promise<ToolResult> | ToolResult
}

const CATEGORIES = new Set<Category>([
  "microtask",
  "research",
  "coding",
  "analysis",
  "verification",
  "mixed",
  "ops",
])
const STATUSES = new Set<ObservationStatus>(["ok", "error", "timeout", "interrupted", "429"])

const asCategory = (v: unknown, fallback: Category = "mixed"): Category =>
  typeof v === "string" && CATEGORIES.has(v as Category) ? (v as Category) : fallback
const asStatus = (v: unknown): ObservationStatus =>
  typeof v === "string" && STATUSES.has(v as ObservationStatus) ? (v as ObservationStatus) : "error"
const asLevel = (v: unknown): VerificationLevel | undefined => {
  const n = typeof v === "number" ? Math.round(v) : NaN
  return n >= 0 && n <= 4 ? (n as VerificationLevel) : undefined
}
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const num = (v: unknown, fallback?: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback
const bool = (v: unknown, fallback?: boolean): boolean | undefined =>
  typeof v === "boolean" ? v : fallback

const clip = (text: string, max = 14_000): string =>
  text.length <= max ? text : `${text.slice(0, max - 40)}\n... (truncated ${text.length - max + 40} chars)`
const json = (value: unknown, max = 14_000): string => clip(JSON.stringify(value, null, 2), max)
const ok = (value: unknown, metadata?: Record<string, unknown>, max = 14_000): ToolResult => ({
  content: json(value, max),
  metadata,
})
const fail = (message: string): ToolResult => ({ content: `ERROR: ${message}`, metadata: { error: true } })

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
})

const TASK_PROPS: Record<string, unknown> = {
  task: { type: "string", description: "The user-visible task or goal." },
  category: {
    type: "string",
    enum: [...CATEGORIES],
    description: "Work category; inferred from the task when omitted.",
  },
  branches: { type: "number", description: "Genuinely independent branches. Default 1: never fan out by default." },
  branchSeconds: { type: "number", description: "Expected wall-clock seconds per branch." },
  independence: { type: "number", description: "0..1 independence of branches." },
  sharedContext: { type: "number", description: "0..1 how much branches re-read/re-derive the same context." },
  ambiguity: { type: "number", description: "0..1 how unclear the solution path is." },
  risk: { type: "number", description: "0..1 blast radius if wrong." },
  verificationValue: { type: "number", description: "0..1 how much a separate verification pass is worth." },
  qualityWeight: { type: "number", description: "0..1 weight on quality vs speed." },
  contextTokens: { type: "number" },
  outputTokens: { type: "number" },
  role: { type: "string" },
  model: { type: "string" },
  provider: { type: "string" },
  warm: { type: "boolean", description: "Reuse a compatible idle lane if available." },
  capsule: { type: "string", description: "Versioned context capsule name to attach." },
  capsuleVersion: { type: "number" },
  tasks: {
    type: "array",
    description: "Independent microtasks for batching.",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        seconds: { type: "number" },
        category: { type: "string", enum: [...CATEGORIES] },
        files: { type: "array", items: { type: "string" } },
        role: { type: "string" },
      },
      required: ["id", "seconds"],
    },
  },
  nodes: {
    type: "array",
    description: "Explicit dependency graph nodes.",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        seconds: { type: "number" },
        role: { type: "string" },
        category: { type: "string", enum: [...CATEGORIES] },
      },
      required: ["id", "seconds"],
    },
  },
  edges: { type: "array", items: { type: "array", items: { type: "string" } } },
  dependencies: { type: "boolean", description: "Declared dependencies imply PIPELINE rather than plain fan-out." },
  verificationLevel: { type: "number", enum: [0, 1, 2, 3, 4] },
  deterministicTests: { type: "boolean" },
  testStrength: { type: "number" },
  disagreement: { type: "number" },
  confidence: { type: "number" },
  budget: {
    type: "object",
    properties: {
      requests: { type: "number" },
      tokens: { type: "number" },
      agents: { type: "number" },
      wallClockSeconds: { type: "number" },
      verificationSeconds: { type: "number" },
      reserve: { type: "number" },
    },
  },
  files: { type: "array", items: { type: "string" } },
}

function taskInput(raw: any): TaskInput {
  const input: TaskInput = { task: str(raw?.task, "unspecified task") }
  if (raw?.category !== undefined) input.category = asCategory(raw.category)
  for (const key of [
    "branches",
    "branchSeconds",
    "independence",
    "sharedContext",
    "ambiguity",
    "risk",
    "verificationValue",
    "qualityWeight",
    "contextTokens",
    "outputTokens",
  ] as const) {
    const v = num(raw?.[key])
    if (v !== undefined) input[key] = v
  }
  if (raw?.role !== undefined) input.role = str(raw.role)
  if (raw?.model !== undefined) input.model = str(raw.model)
  if (raw?.provider !== undefined) input.provider = str(raw.provider)
  if (raw?.warm !== undefined) input.warm = bool(raw.warm)
  if (raw?.capsule !== undefined) input.capsule = str(raw.capsule)
  if (raw?.capsuleVersion !== undefined) input.capsuleVersion = num(raw.capsuleVersion)
  if (Array.isArray(raw?.tasks)) {
    const tasks: MicroTask[] = []
    for (const t of raw.tasks) {
      if (!t || typeof t.id !== "string" || typeof t.seconds !== "number") continue
      const task: MicroTask = { id: t.id, seconds: t.seconds }
      if (t.category !== undefined) task.category = asCategory(t.category)
      if (Array.isArray(t.files)) task.files = t.files.filter((x: unknown): x is string => typeof x === "string")
      if (typeof t.role === "string") task.role = t.role
      tasks.push(task)
    }
    if (tasks.length) input.tasks = tasks
  }
  if (Array.isArray(raw?.nodes)) {
    const nodes: DagNode[] = []
    for (const n of raw.nodes) {
      if (!n || typeof n.id !== "string" || typeof n.seconds !== "number") continue
      const node: DagNode = { id: n.id, seconds: n.seconds }
      if (typeof n.role === "string") node.role = n.role
      if (n.category !== undefined) node.category = asCategory(n.category)
      nodes.push(node)
    }
    if (nodes.length) input.nodes = nodes
  }
  if (Array.isArray(raw?.edges)) {
    input.edges = raw.edges
      .filter(
        (e: unknown): e is [string, string] =>
          Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
      )
      .map((e: [string, string]) => [e[0], e[1]] as [string, string])
  }
  if (raw?.dependencies !== undefined) input.dependencies = bool(raw.dependencies)
  const level = asLevel(raw?.verificationLevel)
  if (level !== undefined) input.verificationLevel = level
  if (raw?.budget && typeof raw.budget === "object") input.budget = raw.budget
  if (raw?.deterministicTests !== undefined) input.deterministicTests = bool(raw.deterministicTests)
  const testStrength = num(raw?.testStrength)
  if (testStrength !== undefined) input.testStrength = testStrength
  const disagreement = num(raw?.disagreement)
  if (disagreement !== undefined) input.disagreement = disagreement
  const confidence = num(raw?.confidence)
  if (confidence !== undefined) input.confidence = confidence
  if (Array.isArray(raw?.files)) input.files = raw.files.filter((x: unknown): x is string => typeof x === "string")
  return input
}

export function createSwarmTools(deps: SwarmToolDeps): SwarmTool[] {
  const { stats, router, health, lanes, capsules, telemetry, scheduler, history } = deps

  const planTool: SwarmTool = {
    name: "swarm_plan",
    description:
      "Estimate serial vs small/full/speculative/pipeline/batched topologies, then choose the cheapest plan that clears the speedup bar. Call this BEFORE dispatching lanes. Serial is the default; fan-out must pay for planning, startup, congestion and integration. Logs a PLAN event and returns runId, topology, agents, waves, batches, models, verification, estimates, budget, reasons, warnings and shadow alternatives. `predictors` is the snake_case contract: estimated_serial_time, estimated_swarm_time, estimated_parallel_efficiency, estimated_startup_cost, estimated_verification_gain, recommended_topology, recommended_agent_count, recommended_models, confidence.",
    input: objectSchema(TASK_PROPS, ["task"]),
    execute: (raw, context) => {
      try {
        const input = taskInput(raw)
        const plan = scheduler.plan(input)
        telemetry.startRun(plan, context.sessionID)
        if (plan.topology === "BATCHED_WORKER" && plan.batches.length) {
          telemetry.log("BATCH", { batches: plan.batches, workers: plan.agents }, { runId: plan.runId, parentSessionID: context.sessionID })
        }
        telemetry.log(
          "SHADOW",
          {
            alternatives: plan.alternatives,
            chosen: plan.topology,
            note: "shadow ranking uses the same priors; it is not a second dispatch",
          },
          { runId: plan.runId, parentSessionID: context.sessionID },
        )
        const { task: _task, ...rest } = plan
        return ok(rest, { runId: plan.runId, topology: plan.topology, agents: plan.agents })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const routeTool: SwarmTool = {
    name: "swarm_route",
    description:
      "Score available provider/model profiles for a role + category, honoring context limits, circuit breakers and quality weight. Returns ranked choices and blocked reasons. Models never become new top-level agents.",
    input: objectSchema(
      {
        role: { type: "string" },
        category: { type: "string", enum: [...CATEGORIES] },
        contextTokens: { type: "number" },
        qualityWeight: { type: "number" },
        warm: { type: "boolean" },
        exclude: { type: "array", items: { type: "string" } },
      },
      ["role"],
    ),
    execute: (raw) => {
      try {
        const decision = router.route({
          role: str(raw?.role, "builder"),
          category: asCategory(raw?.category),
          contextTokens: num(raw?.contextTokens),
          qualityWeight: num(raw?.qualityWeight),
          warm: bool(raw?.warm),
          exclude: Array.isArray(raw?.exclude) ? raw.exclude.filter((x: unknown): x is string => typeof x === "string") : undefined,
        })
        return ok(
          {
            ...decision,
            choices: decision.choices.map((c) => ({
              model: c.model.id,
              provider: c.model.provider,
              quotaGroup: c.model.quotaGroup,
              score: round(c.score, 3),
              reasons: c.reasons,
            })),
          },
          { models: decision.choices.map((c) => c.model.id) },
        )
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const scheduleTool: SwarmTool = {
    name: "swarm_schedule",
    description:
      "Run deterministic DAG scheduling: topological order, critical path, slack, waves, lane assignment, utilization and cycle detection. Use for pipeline stages or straggler prioritization.",
    input: objectSchema(
      {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              seconds: { type: "number" },
              role: { type: "string" },
              category: { type: "string", enum: [...CATEGORIES] },
            },
            required: ["id", "seconds"],
          },
        },
        edges: { type: "array", items: { type: "array", items: { type: "string" } } },
        concurrency: { type: "number" },
      },
      ["nodes"],
    ),
    execute: (raw) => {
      try {
        const nodes: DagNode[] = Array.isArray(raw?.nodes)
          ? raw.nodes
              .filter((n: any) => n && typeof n.id === "string" && typeof n.seconds === "number")
              .map((n: any) => ({
                id: n.id,
                seconds: n.seconds,
                role: typeof n.role === "string" ? n.role : undefined,
                category: n.category !== undefined ? asCategory(n.category) : undefined,
              }))
          : []
        if (!nodes.length) return fail("nodes must contain at least one {id, seconds}")
        const edges: Array<[string, string]> = Array.isArray(raw?.edges)
          ? raw.edges
              .filter(
                (e: unknown): e is [string, string] =>
                  Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
              )
              .map((e: [string, string]) => [e[0], e[1]] as [string, string])
          : []
        const schedule = scheduleDag(nodes, edges, { concurrency: num(raw?.concurrency) })
        return ok(schedule, { makespan: schedule.makespan, concurrency: schedule.concurrency })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const capsuleTool: SwarmTool = {
    name: "swarm_capsule",
    description:
      "Create, merge, render, attach, refresh, invalidate, version, list or stat versioned context capsules. Capsules carry architecture, verified facts, hypotheses, stale notes, files, invariants, blockers, commands, failed approaches and provenance. Attach returns the exact text to put in a lane brief and logs CAPSULE_LOAD.",
    input: objectSchema(
      {
        action: {
          type: "string",
          enum: ["create", "merge", "render", "attach", "refresh", "invalidate", "bump", "list", "stats"],
        },
        name: { type: "string" },
        scope: { type: "string" },
        architecture: { type: "array", items: { type: "string" } },
        invariants: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
        failedApproaches: { type: "array", items: { type: "string" } },
        facts: { type: "array", items: { type: "object" } },
        files: { type: "array", items: { type: "object" } },
        commands: { type: "array", items: { type: "object" } },
        provenance: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        maxChars: { type: "number" },
        fileHashes: { type: "object" },
        reverifyKeys: { type: "array", items: { type: "string" } },
        keys: { type: "array", items: { type: "string" } },
        pattern: { type: "string" },
        reason: { type: "string" },
        runId: { type: "string" },
      },
      ["action"],
    ),
    execute: (raw, context) => {
      try {
        const action = str(raw?.action, "render")
        const name = str(raw?.name)
        const runId = str(raw?.runId) || undefined
        if (action === "list") return ok({ capsules: capsules.list(), stats: capsules.stats() })
        if (action === "stats") return ok(capsules.stats())
        if (!name) return fail("name is required for capsule actions other than list/stats")
        if (action === "create") {
          const c = capsules.create({
            name,
            scope: str(raw?.scope) || undefined,
            architecture: Array.isArray(raw?.architecture) ? raw.architecture.filter((x: unknown): x is string => typeof x === "string") : undefined,
            invariants: Array.isArray(raw?.invariants) ? raw.invariants.filter((x: unknown): x is string => typeof x === "string") : undefined,
            blockers: Array.isArray(raw?.blockers) ? raw.blockers.filter((x: unknown): x is string => typeof x === "string") : undefined,
            failedApproaches: Array.isArray(raw?.failedApproaches)
              ? raw.failedApproaches.filter((x: unknown): x is string => typeof x === "string")
              : undefined,
            facts: Array.isArray(raw?.facts) ? raw.facts : undefined,
            files: Array.isArray(raw?.files) ? raw.files : undefined,
            commands: Array.isArray(raw?.commands) ? raw.commands : undefined,
            provenance: Array.isArray(raw?.provenance)
              ? raw.provenance.filter((x: unknown): x is string => typeof x === "string")
              : ["tool:swarm_capsule"],
          })
          return ok(
            {
              name: c.name,
              version: c.version,
              revision: c.revision,
              digest: capsules.digest(c),
              summary: capsules.summaryLine(name),
              preview: capsules.render(name, num(raw?.maxChars, 3000)),
            },
            { capsule: name, version: c.version },
          )
        }
        if (action === "merge") {
          const c = capsules.merge(name, {
            scope: str(raw?.scope) || undefined,
            architecture: Array.isArray(raw?.architecture) ? raw.architecture : undefined,
            invariants: Array.isArray(raw?.invariants) ? raw.invariants : undefined,
            blockers: Array.isArray(raw?.blockers) ? raw.blockers : undefined,
            failedApproaches: Array.isArray(raw?.failedApproaches) ? raw.failedApproaches : undefined,
            facts: Array.isArray(raw?.facts) ? raw.facts : undefined,
            files: Array.isArray(raw?.files) ? raw.files : undefined,
            commands: Array.isArray(raw?.commands) ? raw.commands : undefined,
            provenance: Array.isArray(raw?.provenance) ? raw.provenance : ["tool:swarm_capsule"],
            note: str(raw?.note) || undefined,
          })
          return ok(
            {
              name: c.name,
              version: c.version,
              revision: c.revision,
              digest: capsules.digest(c),
              summary: capsules.summaryLine(name),
              preview: capsules.render(name, num(raw?.maxChars, 3000)),
            },
            { capsule: name, version: c.version },
          )
        }
        if (action === "attach") {
          const attached = capsules.attach(name, {
            maxChars: num(raw?.maxChars, 6000),
            role: str(raw?.role) || undefined,
          })
          if (!attached) return fail(`capsule not found: ${name}`)
          telemetry.log(
            "CAPSULE_LOAD",
            { name, version: attached.version, digest: attached.digest, verified: attached.verified, stale: attached.stale },
            { runId, parentSessionID: context.sessionID },
          )
          return ok(attached, { capsule: name, version: attached.version, digest: attached.digest })
        }
        if (action === "refresh") {
          const refreshed = capsules.refresh(name, {
            fileHashes: raw?.fileHashes && typeof raw.fileHashes === "object" ? raw.fileHashes : undefined,
            reverifyKeys: Array.isArray(raw?.reverifyKeys)
              ? raw.reverifyKeys.filter((x: unknown): x is string => typeof x === "string")
              : undefined,
            note: str(raw?.note) || undefined,
          })
          if (!refreshed) return fail(`capsule not found: ${name}`)
          return ok(
            {
              name,
              version: refreshed.capsule.version,
              revision: refreshed.capsule.revision,
              stale: refreshed.stale,
              refreshed: refreshed.refreshed,
              summary: capsules.summaryLine(name),
              preview: capsules.render(name, num(raw?.maxChars, 3000)),
            },
            { capsule: name, version: refreshed.capsule.version, stale: refreshed.stale.length },
          )
        }
        if (action === "invalidate") {
          const c = capsules.invalidate(name, {
            keys: Array.isArray(raw?.keys) ? raw.keys.filter((x: unknown): x is string => typeof x === "string") : undefined,
            pattern: str(raw?.pattern) || undefined,
            reason: str(raw?.reason) || undefined,
          })
          if (!c) return fail(`capsule not found: ${name}`)
          return ok(
            {
              name,
              version: c.version,
              revision: c.revision,
              summary: capsules.summaryLine(name),
              preview: capsules.render(name, num(raw?.maxChars, 3000)),
            },
            { capsule: name, version: c.version },
          )
        }
        if (action === "bump") {
          const c = capsules.bumpVersion(name, str(raw?.note) || undefined)
          if (!c) return fail(`capsule not found: ${name}`)
          return ok({ name, version: c.version, revision: c.revision, digest: capsules.digest(c) }, { capsule: name, version: c.version })
        }
        const text = capsules.render(name, num(raw?.maxChars, 6000))
        if (!text) return fail(`capsule not found: ${name}`)
        return ok({ name, text, summary: capsules.summaryLine(name) }, { capsule: name })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const laneTool: SwarmTool = {
    name: "swarm_lane",
    description:
      "Warm lane pool: acquire a compatible idle session, register a freshly spawned lane, release it after a run, invalidate on scope/version mismatch, or list/stat lanes. Reuse requires identical role/model/category/capsule scope; no context is transplanted across scopes.",
    input: objectSchema(
      {
        action: {
          type: "string",
          enum: ["acquire", "register", "release", "invalidate", "list", "stats", "sweep"],
        },
        sessionID: { type: "string" },
        role: { type: "string" },
        model: { type: "string" },
        category: { type: "string", enum: [...CATEGORIES] },
        provider: { type: "string" },
        capsule: { type: "string" },
        capsuleVersion: { type: "number" },
        runId: { type: "string" },
        ttlMs: { type: "number" },
        maxUses: { type: "number" },
        stale: { type: "boolean" },
        reason: { type: "string" },
      },
      ["action"],
    ),
    execute: (raw, context) => {
      try {
        const action = str(raw?.action, "list")
        const runId = str(raw?.runId) || undefined
        if (action === "list") return ok({ lanes: lanes.list(true), stats: lanes.statsSummary() })
        if (action === "stats") return ok(lanes.statsSummary())
        if (action === "sweep") return ok({ expired: lanes.sweep(), stats: lanes.statsSummary() })
        if (action === "acquire") {
          const role = str(raw?.role)
          if (!role) return fail("role is required for acquire")
          const result = lanes.acquire({
            role,
            model: str(raw?.model) || undefined,
            category: raw?.category !== undefined ? asCategory(raw.category) : undefined,
            provider: str(raw?.provider) || undefined,
            capsule: str(raw?.capsule) || undefined,
            capsuleVersion: num(raw?.capsuleVersion),
          })
          telemetry.log(
            result.warm ? "WARM_HIT" : "WARM_MISS",
            { role, model: str(raw?.model) || undefined, lane: result.lane, reason: result.reason, hitRate: result.hitRate },
            { runId, parentSessionID: context.sessionID },
          )
          return ok(result, { warm: result.warm, hitRate: result.hitRate })
        }
        if (action === "register") {
          const sessionID = str(raw?.sessionID)
          const role = str(raw?.role)
          const model = str(raw?.model)
          if (!sessionID || !role || !model) return fail("sessionID, role and model are required for register")
          const lane = lanes.register({
            sessionID,
            role,
            model,
            category: asCategory(raw?.category),
            provider: str(raw?.provider) || undefined,
            capsule: str(raw?.capsule) || undefined,
            capsuleVersion: num(raw?.capsuleVersion),
            runId,
            ttlMs: num(raw?.ttlMs),
            maxUses: num(raw?.maxUses),
          })
          telemetry.log(
            "LANE_REGISTER",
            { sessionID, role, model, category: lane.category, warm: false, lane },
            { runId, parentSessionID: context.sessionID },
          )
          return ok(lane, { lane: sessionID, role })
        }
        if (action === "release") {
          const sessionID = str(raw?.sessionID)
          if (!sessionID) return fail("sessionID is required for release")
          const lane = lanes.release(sessionID, {
            capsule: str(raw?.capsule) || undefined,
            capsuleVersion: num(raw?.capsuleVersion),
            runId,
            stale: bool(raw?.stale),
            reason: str(raw?.reason) || undefined,
          })
          if (!lane) return fail(`lane not found: ${sessionID}`)
          telemetry.log(
            "LANE_RELEASE",
            { sessionID, status: lane.status, reason: lane.reason, uses: lane.uses },
            { runId, parentSessionID: context.sessionID },
          )
          return ok(lane, { lane: sessionID, status: lane.status })
        }
        if (action === "invalidate") {
          const sessionID = str(raw?.sessionID)
          if (!sessionID) return fail("sessionID is required for invalidate")
          const done = lanes.invalidate(sessionID, str(raw?.reason, "invalidated"))
          return ok({ invalidated: done, sessionID }, { lane: sessionID })
        }
        return fail(`unknown lane action: ${action}`)
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const convergeTool: SwarmTool = {
    name: "swarm_converge",
    description:
      "Cluster findings by semantic overlap, measure uncertainty, deduplicate redundant workers, preserve genuine dissent and decide whether to stop exploring. Consensus needs independent evidence, not paraphrases. Logs DEDUP/MERGE.",
    input: objectSchema(
      {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              confidence: { type: "number" },
              evidence: { type: "array", items: { type: "string" } },
              source: { type: "string" },
              branch: { type: "string" },
            },
            required: ["text"],
          },
        },
        threshold: { type: "number" },
        minSharedConcepts: { type: "number" },
        stopThreshold: { type: "number" },
        runId: { type: "string" },
      },
      ["findings"],
    ),
    execute: (raw, context) => {
      try {
        if (!Array.isArray(raw?.findings) || raw.findings.length === 0) return fail("findings must be a non-empty array")
        const findings: Finding[] = raw.findings
          .filter((f: any) => f && typeof f.text === "string")
          .map((f: any, i: number) => ({
            id: typeof f.id === "string" ? f.id : `f${i + 1}`,
            text: f.text,
            confidence: num(f.confidence),
            evidence: Array.isArray(f.evidence) ? f.evidence.filter((x: unknown): x is string => typeof x === "string") : [],
            source: typeof f.source === "string" ? f.source : undefined,
            branch: typeof f.branch === "string" ? f.branch : undefined,
          }))
        if (!findings.length) return fail("no valid findings with text")
        const result = clusterFindings(findings, {
          threshold: num(raw?.threshold),
          minSharedConcepts: num(raw?.minSharedConcepts),
          stopThreshold: num(raw?.stopThreshold),
        })
        const runId = str(raw?.runId) || undefined
        if (result.redundant.length) {
          telemetry.log("DEDUP", { redundant: result.redundant, clusters: result.clusters.length }, { runId, parentSessionID: context.sessionID })
        }
        telemetry.log(
          "MERGE",
          {
            keep: result.keep,
            dissent: result.dissent,
            shouldStop: result.shouldStop,
            reason: result.reason,
            confidence: result.confidence,
            clusters: result.clusters.map((c) => ({
              id: c.id,
              representative: c.representative.id,
              members: c.members.map((m) => m.id),
              evidence: c.evidence,
              consensus: c.consensus,
              dissent: c.dissent,
            })),
          },
          { runId, parentSessionID: context.sessionID },
        )
        return ok(result, { shouldStop: result.shouldStop, redundant: result.redundant.length, confidence: result.confidence })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const verifyTool: SwarmTool = {
    name: "swarm_verify",
    description:
      "Choose adaptive verification V0-V4 from risk, disagreement, confidence, test strength, impact and budget. Start cheap; escalate only on real uncertainty. A judge is one optional step, never the default. Logs VERIFY.",
    input: objectSchema({
      level: { type: "number", enum: [0, 1, 2, 3, 4] },
      risk: { type: "number" },
      disagreement: { type: "number" },
      confidence: { type: "number" },
      deterministicTests: { type: "boolean" },
      testStrength: { type: "number" },
      impact: { type: "number" },
      trivial: { type: "boolean" },
      judgeAvailable: { type: "boolean" },
      judgeCostSeconds: { type: "number" },
      workSeconds: { type: "number" },
      budgetSeconds: { type: "number" },
      runId: { type: "string" },
    }),
    execute: (raw, context) => {
      try {
        const plan = chooseVerification({
          level: asLevel(raw?.level),
          risk: num(raw?.risk),
          disagreement: num(raw?.disagreement),
          confidence: num(raw?.confidence),
          deterministicTests: bool(raw?.deterministicTests),
          testStrength: num(raw?.testStrength),
          impact: num(raw?.impact),
          trivial: bool(raw?.trivial),
          judgeAvailable: bool(raw?.judgeAvailable),
          judgeCostSeconds: num(raw?.judgeCostSeconds),
          workSeconds: num(raw?.workSeconds),
          budgetSeconds: num(raw?.budgetSeconds),
        })
        telemetry.log("VERIFY", { plan }, { runId: str(raw?.runId) || undefined, parentSessionID: context.sessionID })
        return ok(plan, { level: plan.level, cost: plan.estimatedCost, judgeAllowed: plan.judgeAllowed })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const recordTool: SwarmTool = {
    name: "swarm_record",
    description:
      "Record a lane observation (startup/work/first-token/tool/completion latency, tokens, retries, branch, judge/integration time, status/warm) into the learned cost model, and/or close a run with an efficiency report (actual seconds, serial seconds, workers, useful/wasted, quality gain). Also records provider success/failure in the circuit breaker. Use after every lane and at integration.",
    input: objectSchema(
      {
        runId: { type: "string" },
        laneId: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        role: { type: "string" },
        category: { type: "string", enum: [...CATEGORIES] },
        warm: { type: "boolean" },
        startupSeconds: { type: "number" },
        workSeconds: { type: "number" },
        totalSeconds: { type: "number" },
        tokensIn: { type: "number" },
        tokensOut: { type: "number" },
        firstTokenSeconds: { type: "number" },
        toolSeconds: { type: "number" },
        completionSeconds: { type: "number" },
        toolCalls: { type: "number" },
        requests: { type: "number" },
        retryCount: { type: "number" },
        failureKind: { type: "string" },
        branch: { type: "string" },
        judgeSeconds: { type: "number" },
        integrationSeconds: { type: "number" },
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string" },
        actualSeconds: { type: "number" },
        serialSeconds: { type: "number" },
        predictedSeconds: { type: "number" },
        workers: { type: "number" },
        usefulWorkers: { type: "number" },
        wastedWorkers: { type: "number" },
        quality: { type: "number" },
        qualityGain: { type: "number" },
        verificationSeconds: { type: "number" },
      },
    ),
    execute: (raw, context) => {
      try {
        const runId = str(raw?.runId) || telemetry.latestPlan(context.sessionID)?.plan.runId
        const provider = str(raw?.provider, "unknown")
        const model = str(raw?.model, "unknown")
        const role = str(raw?.role, "builder")
        const category = asCategory(raw?.category)
        const status = raw?.status !== undefined ? asStatus(raw.status) : undefined
        const startupSeconds = num(raw?.startupSeconds, 0) ?? 0
        const workSeconds = num(raw?.workSeconds, 0) ?? 0
        const totalSeconds =
          num(raw?.totalSeconds) ?? Math.max(0, startupSeconds) + Math.max(0, workSeconds)
        let observed: Record<string, unknown> | undefined
        if (status !== undefined && (raw?.laneId !== undefined || raw?.startupSeconds !== undefined || raw?.workSeconds !== undefined)) {
          const obs: Observation = {
            ts: Date.now(),
            runId,
            laneId: str(raw?.laneId) || undefined,
            provider,
            model,
            role,
            category,
            warm: bool(raw?.warm, false) ?? false,
            startupSeconds,
            workSeconds,
            totalSeconds,
            tokensIn: num(raw?.tokensIn),
            tokensOut: num(raw?.tokensOut),
            firstTokenSeconds: num(raw?.firstTokenSeconds),
            toolSeconds: num(raw?.toolSeconds),
            completionSeconds: num(raw?.completionSeconds),
            toolCalls: num(raw?.toolCalls),
            requests: num(raw?.requests),
            retryCount: num(raw?.retryCount),
            failureKind: str(raw?.failureKind) || undefined,
            branch: str(raw?.branch) || undefined,
            judgeSeconds: num(raw?.judgeSeconds),
            integrationSeconds: num(raw?.integrationSeconds),
            status,
            source: str(raw?.source, "tool:swarm_record"),
          }
          stats.add(obs)
          health.record(provider, status === "ok" ? "ok" : status === "429" ? "429" : status === "timeout" ? "timeout" : "error")
          telemetry.log(
            status === "ok" ? "LANE_DONE" : "LANE_FAIL",
            {
              laneId: obs.laneId,
              provider,
              model,
              role,
              category,
              warm: obs.warm,
              startupSeconds,
              workSeconds,
              totalSeconds,
              tokensIn: obs.tokensIn,
              tokensOut: obs.tokensOut,
              firstTokenSeconds: obs.firstTokenSeconds,
              toolSeconds: obs.toolSeconds,
              completionSeconds: obs.completionSeconds,
              retryCount: obs.retryCount,
              failureKind: obs.failureKind,
              branch: obs.branch,
              judgeSeconds: obs.judgeSeconds,
              integrationSeconds: obs.integrationSeconds,
              status,
            },
            { runId, parentSessionID: context.sessionID },
          )
          if (health.state(provider) !== "closed") {
            telemetry.log(
              "PROVIDER_COOLDOWN",
              { provider, ...(health.snapshot()[provider] ?? { state: health.state(provider) }) },
              { runId, parentSessionID: context.sessionID },
            )
          }
          observed = { provider, model, role, category, status, totalSeconds }
        }

        let report: unknown
        if (num(raw?.actualSeconds) !== undefined) {
          const plan = runId ? telemetry.replay(runId, context.sessionID)?.plan : telemetry.latestPlan(context.sessionID)?.plan
          const predicted = num(raw?.predictedSeconds) ?? plan?.estimates.chosen ?? 0
          const serial = num(raw?.serialSeconds) ?? plan?.estimates.serial
          const workers = Math.max(0, num(raw?.workers) ?? plan?.agents ?? 1)
          const wasted = num(raw?.wastedWorkers, 0) ?? 0
          const useful = num(raw?.usefulWorkers) ?? Math.max(0, workers - wasted)
          const eff = Telemetry.efficiency({
            runId: runId ?? "run_unknown",
            predictedSeconds: predicted,
            actualSeconds: num(raw?.actualSeconds)!,
            serialSeconds: serial,
            workers,
            usefulWorkers: useful,
            wastedWorkers: wasted,
            requests: num(raw?.requests, 0) ?? 0,
            tokensIn: num(raw?.tokensIn, 0) ?? 0,
            tokensOut: num(raw?.tokensOut, 0) ?? 0,
            quality: num(raw?.quality),
            qualityGain: num(raw?.qualityGain),
            verificationSeconds: num(raw?.verificationSeconds),
            startupSeconds: num(raw?.startupSeconds),
          })
          report = eff
          if (runId) telemetry.finish(runId, eff, context.sessionID)
        }
        return ok({ observed, report, runId }, { runId, observed: !!observed, closed: !!report })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const statusTool: SwarmTool = {
    name: "swarm_status",
    description:
      "Live runtime state: active runs, latest plan, lane pool hit rate, capsules, provider circuits, learned cost summary, event counts and recent events. Read-only.",
    input: objectSchema({ runId: { type: "string" } }),
    execute: (raw, context) => {
      try {
        const runId = str(raw?.runId) || undefined
        const active = telemetry.activeRuns(context.sessionID)
        const latest = telemetry.latestPlan(context.sessionID)
        const replay = runId ? telemetry.replay(runId, context.sessionID) : undefined
        return ok(
          {
            activeRuns: active.map((r) => ({
              runId: r.runId,
              topology: r.plan.topology,
              agents: r.plan.agents,
              startedAt: r.startedAt,
              events: r.events,
              estimates: r.plan.estimates,
            })),
            latestPlan: latest
              ? {
                  runId: latest.plan.runId,
                  topology: latest.plan.topology,
                  agents: latest.plan.agents,
                  waves: latest.plan.waves,
                  estimates: latest.plan.estimates,
                  budget: latest.plan.budget,
                }
              : undefined,
            replay: replay
              ? {
                  runId: replay.runId,
                  actualSeconds: replay.actualSeconds,
                  predictedSeconds: replay.predictedSeconds,
                  predictionErrorPct: replay.predictionErrorPct,
                  outcome: replay.outcome,
                }
              : undefined,
            lanes: { stats: lanes.statsSummary(), lanes: lanes.list(true) },
            capsules: { stats: capsules.stats(), list: capsules.list() },
            providers: health.snapshot(),
            learned: stats.summary(8),
            events: telemetry.counts(),
            recent: telemetry.recent(8),
          },
          { activeRuns: active.length, lanes: lanes.statsSummary().total },
        )
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const replayTool: SwarmTool = {
    name: "swarm_replay",
    description:
      "Deterministic replay of a run: plan, ordered events, outcome, actual vs predicted time, lanes spawned/failed, verifications and shadow alternatives. Use it to explain why the scheduler won or lost.",
    input: objectSchema({ runId: { type: "string" }, includeEvents: { type: "boolean" } }),
    execute: (raw, context) => {
      try {
        const runId = str(raw?.runId) || undefined
        const report = telemetry.replay(runId, context.sessionID)
        if (!report) return fail(runId ? `no telemetry for run ${runId}` : "no run for this session")
        const shadow = report.plan
          ? report.plan.alternatives.map((a) => ({
              ...a,
              predictedErrorPct:
                report.actualSeconds && report.actualSeconds > 0
                  ? round((Math.abs(a.seconds - report.actualSeconds) / report.actualSeconds) * 100)
                  : undefined,
            }))
          : []
        return ok(
          {
            ...report,
            events: bool(raw?.includeEvents, false) ? report.events : undefined,
            shadow,
            chosen: report.plan?.topology,
            chosenEstimate: report.plan?.estimates.chosen,
          },
          { runId: report.runId, events: report.events.length },
          20_000,
        )
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const shadowTool: SwarmTool = {
    name: "swarm_shadow",
    description:
      "Shadow-evaluate a plan against an observed wall-clock result without dispatching anything: compares actual seconds with the chosen estimate and every alternative topology. Use after a run to learn which topology would have won in hindsight.",
    input: objectSchema({ ...TASK_PROPS, actualSeconds: { type: "number" } }, ["task", "actualSeconds"]),
    execute: (raw, context) => {
      try {
        const actual = num(raw?.actualSeconds)
        if (actual === undefined || actual <= 0) return fail("actualSeconds must be a positive number")
        const plan: Plan = scheduler.plan(taskInput(raw))
        const errors = plan.alternatives.map((a) => ({
          topology: a.topology,
          agents: a.agents,
          predicted: a.seconds,
          errorPct: round((Math.abs(a.seconds - actual) / actual) * 100),
          deltaSeconds: round(a.seconds - actual),
        }))
        errors.sort((x, y) => x.errorPct - y.errorPct)
        telemetry.log(
          "SHADOW",
          { actualSeconds: actual, chosen: plan.topology, estimates: plan.estimates, errors },
          { runId: plan.runId, parentSessionID: context.sessionID },
        )
        return ok({ runId: plan.runId, topology: plan.topology, estimates: plan.estimates, errors }, { runId: plan.runId })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const actualsFromHistory = (): RunActuals[] =>
    history.all().map((r) => ({
      runId: r.runId,
      actualSeconds: r.actualSeconds,
      requests: r.requests,
      verificationSeconds: r.verificationSeconds,
      verificationLevel: r.verificationLevel,
      quality: r.quality,
      agents: r.agents,
      workers: r.workers,
      usefulWorkers: r.usefulWorkers,
      wastedWorkers: r.wastedWorkers,
      provider: r.provider,
      model: r.model,
      status: r.status,
      hedgeUsed: r.hedgeUsed,
      checkpointResumed: r.checkpointResumed,
      chaos: r.chaos,
    }))

  const chaosInjectTool: SwarmTool = {
    name: "swarm_chaos_inject",
    description:
      "Record an opt-in chaos injection as a telemetry NOTE event (never the default: chaosMode gates it). Returns the classified ChaosEffect and penaltySeconds so the scheduler can price fault-aware plans. No real fault is inflicted on a provider; this is record-keeping for chaos-mode runs.",
    input: objectSchema(
      {
        kind: {
          type: "string",
          enum: [
            "429",
            "timeout",
            "ECONNRESET",
            "slow_provider",
            "malformed_response",
            "worker_crash",
            "late_notification",
            "duplicate_completion",
            "lost_log_event",
            "partial_tool_failure",
          ],
        },
        target: { type: "string" },
        delaySeconds: { type: "number" },
        note: { type: "string" },
        runId: { type: "string" },
      },
      ["kind"],
    ),
    execute: (raw, context) => {
      try {
        const target = str(raw?.target) || "lane"
        const kind = str(raw?.kind) as ChaosKind
        if (!kind) return fail("kind is required")
        const effect = injectChaos(
          { kind, target, delaySeconds: num(raw?.delaySeconds), note: str(raw?.note) || undefined },
          target,
          telemetry,
          { runId: str(raw?.runId) || undefined, parentSessionID: context.sessionID },
        )
        return ok(effect, { kind: effect.kind, effect: effect.effect, penaltySeconds: chaosPenalty(effect.kind) })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const chaosRecoveryTool: SwarmTool = {
    name: "swarm_check_recovery",
    description:
      "Scan recorded telemetry events for recovery-assertion violations: duplicate completions, lost provenance, excessive retries, workspace corruption, orphan workers, incorrect passes. Returns a RecoveryCheckResult with clean:true only when every assertion passes. Pass a runId to scope the scan to one run, or omit it to review recent events.",
    input: objectSchema(
      {
        runId: { type: "string" },
        assertions: { type: "object" },
      },
      [],
    ),
    execute: (raw, context) => {
      try {
        const runId = str(raw?.runId) || undefined
        const events = runId ? telemetry.list(runId) : telemetry.recent()
        const assertions: RecoveryAssertions =
          raw?.assertions && typeof raw.assertions === "object"
            ? (raw.assertions as RecoveryAssertions)
            : { duplicateCommits: [], lostProvenance: [], excessiveRetries: [], workspaceCorruption: [], orphanWorkers: [], incorrectPass: [], clean: true }
        const result = checkRecovery(events, assertions, { now: () => Date.now() })
        return ok(result, { runId, clean: result.clean, eventsReviewed: result.eventsReviewed })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const calibrationDashboardTool: SwarmTool = {
    name: "swarm_calibration_dashboard",
    description:
      "Calibration dashboard: predicted vs actual serial/swarm time across completed runs, confidence calibration, and regret percentiles. Pure read over stats + history.",
    input: objectSchema({}, []),
    execute: () => {
      try {
        return ok(calibrationDashboard(stats, history))
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const schedulerDashboardTool: SwarmTool = {
    name: "swarm_scheduler_dashboard",
    description:
      "Scheduler dashboard: decision mix, strategy-correctness rate, speedup percentiles, warm-lane hit rate, provider recoveries. Pure read over telemetry + stats + history.",
    input: objectSchema({}, []),
    execute: () => {
      try {
        return ok(schedulerDashboard(telemetry, stats, history))
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const wasteBreakdownTool: SwarmTool = {
    name: "swarm_waste_breakdown",
    description:
      "Waste breakdown: sums duplicate/cancelled/failed/unused-speculative/excess-verification/provider-retry/context-reload waste across completed-run history. Pure read.",
    input: objectSchema({ actuals: { type: "array", items: { type: "object" } } }, []),
    execute: (raw) => {
      try {
        const actuals: RunActuals[] = Array.isArray(raw?.actuals) ? (raw.actuals as RunActuals[]) : actualsFromHistory()
        return ok(wasteBreakdown(actuals))
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const multiDimensionGradeTool: SwarmTool = {
    name: "swarm_multi_dimension_grade",
    description:
      "Multi-dimensional grade: correctness, speed, prediction accuracy, worker/provider/verification efficiency, recovery quality, and waste, composited into a letter grade. Pure read over run actuals.",
    input: objectSchema({ actuals: { type: "array", items: { type: "object" } } }, []),
    execute: (raw) => {
      try {
        const actuals: RunActuals[] = Array.isArray(raw?.actuals) ? (raw.actuals as RunActuals[]) : actualsFromHistory()
        return ok(multiDimensionGrade(actuals))
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const providerReliabilityTool: SwarmTool = {
    name: "swarm_provider_reliability",
    description:
      "Reliability report for a single provider: circuit-breaker state, failures, opens, cooldown remaining, failure/429 rates, recovery count, and a composite reliability score.",
    input: objectSchema({ provider: { type: "string" } }, ["provider"]),
    execute: (raw) => {
      try {
        const provider = str(raw?.provider)
        if (!provider) return fail("provider is required")
        return ok(health.providerReliability(provider), { provider })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const portfolioReportTool: SwarmTool = {
    name: "swarm_portfolio_report",
    description:
      "Portfolio report across every tracked provider: per-provider reliability, aggregate failure/429 rates, open/half-open/closed counts, most/least reliable, and a letter grade.",
    input: objectSchema({}, []),
    execute: () => {
      try {
        return ok(health.portfolioReport())
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  const planWithSlaTool: SwarmTool = {
    name: "swarm_plan_with_sla",
    description:
      "Steer a real AdaptiveScheduler.plan() with an SLA mode: apply the profile (qualityWeight, verificationValue, agent cap), plan, then run deadline honesty, deadline pressure, cost guard, and anytime-stage derivation. Never silently degrades on an impossible deadline.",
    input: objectSchema(
      {
        ...TASK_PROPS,
        sla: { type: "string", enum: ["FASTEST", "CHEAPEST", "HIGHEST_QUALITY", "BALANCED", "LOWEST_PROVIDER_RISK"] },
        deadlineSeconds: { type: "number" },
      },
      ["task"],
    ),
    execute: (raw) => {
      try {
        const input = taskInput(raw)
        if (raw?.sla !== undefined) input.sla = raw.sla as SlaMode
        if (typeof raw?.deadlineSeconds === "number") input.deadlineSeconds = raw.deadlineSeconds
        const result = planWithSla(scheduler, input)
        return ok(result, { mode: result.mode, impossible: result.impossible, guard: result.guard.decline })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  return [
    planTool,
    routeTool,
    scheduleTool,
    capsuleTool,
    laneTool,
    convergeTool,
    verifyTool,
    recordTool,
    statusTool,
    replayTool,
    shadowTool,
    chaosInjectTool,
    chaosRecoveryTool,
    calibrationDashboardTool,
    schedulerDashboardTool,
    wasteBreakdownTool,
    multiDimensionGradeTool,
    providerReliabilityTool,
    portfolioReportTool,
    planWithSlaTool,
  ]
}
