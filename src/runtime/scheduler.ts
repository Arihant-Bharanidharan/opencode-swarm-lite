/**
 * Adaptive topology scheduler: estimate serial vs every swarm shape, pick the
 * cheapest plan that clears the speedup bar, and explain why. Serial is the
 * default; fan-out has to pay for planning, startup, congestion and integration.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  AnytimeResult,
  BatchPlan,
  Budget,
  Category,
  DagNode,
  DeadlineCheck,
  DeadlinePressure,
  MicroTask,
  ModelProfile,
  Plan,
  PlanEstimates,
  ScheduleResult,
  SlaMode,
  SlaProfile,
  TaskInput,
  Topology,
  VerificationPlan,
} from "./types.js"
import type { StatsStore } from "./stats.js"
import type { LanePool } from "./lanes.js"
import { ProviderHealth, Router, synthesizeProfile } from "./provider.js"
import { chooseVerification } from "./verify.js"
import { scheduleDag } from "./schedule.js"
import { newRunId } from "./telemetry.js"
import {
  SLA_PROFILES,
  applySlaToInput,
  costGuardDeclinesSwarm,
  deadlineCheck,
  deadlinePressure,
  planWithSla,
  anytimeResult,
  VERIFICATION_VALUE_BY_MODE,
  AGENT_CAP_BY_MODE,
} from "./sla.js"
import { planPredictors } from "./predictor.js"
import { clamp, median, round } from "./util.js"

export interface SchedulerConfig {
  maxAgents: number
  maxTasksPerBatch: number
  planningBaseSeconds: number
  planningSecondsPerLane: number
  planningCapSeconds: number
  warmPlanningFactor: number
  dispatchStaggerSeconds: number
  startupCongestionMax: number
  integrationBaseSeconds: number
  integrationSecondsPerLane: number
  integrationWorkFactor: number
  congestionPerLane: number
  maxCongestion: number
  sharedContextPenalty: number
  minSpeedupSwarm: number
  minSpeedupBatch: number
  minSavingsSeconds: number
  qualityWeight: number
  judgeAvailable: boolean
  judgeCostSeconds: number
  now: () => number
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxAgents: 8,
  maxTasksPerBatch: 6,
  planningBaseSeconds: 8,
  planningSecondsPerLane: 12,
  planningCapSeconds: 180,
  warmPlanningFactor: 0.85,
  dispatchStaggerSeconds: 1,
  startupCongestionMax: 1.5,
  integrationBaseSeconds: 6,
  integrationSecondsPerLane: 2,
  integrationWorkFactor: 0.02,
  congestionPerLane: 0.12,
  maxCongestion: 1.8,
  sharedContextPenalty: 0.8,
  minSpeedupSwarm: 1.08,
  minSpeedupBatch: 1.03,
  minSavingsSeconds: 5,
  qualityWeight: 0.25,
  judgeAvailable: true,
  judgeCostSeconds: 45,
  now: () => Date.now(),
}

export interface SchedulerDeps {
  stats: StatsStore
  router: Router
  health: ProviderHealth
  lanes?: LanePool
  config?: Partial<SchedulerConfig>
}

interface Candidate {
  topology: Topology
  agents: number
  waves: number
  seconds: number
  effective: number
  planningCost: number
  startupCost: number
  work: number
  integrationCost: number
  criticalPath: number
  qualityCredit: number
  reason: string
  batches?: BatchPlan[]
  schedule?: ScheduleResult
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

export function classifyTask(input: TaskInput): Category {
  if (input.category) return input.category
  if (input.tasks?.length && input.tasks.every((t) => t.seconds <= 45)) return "microtask"
  if (input.nodes?.length || input.dependencies) return "mixed"
  const text = input.task.toLowerCase()
  if (/\b(test|verify|audit|review|validate|check\b)/.test(text)) return "verification"
  if (/\b(fix|implement|write|refactor|patch|code|function|module|bug|compile|build)\b/.test(text)) {
    return "coding"
  }
  if (/\b(research|find|investigate|explain|compare|search|read|look up)\b/.test(text)) return "research"
  if (/\b(analy[sz]e|dataset|csv|metric|report|calculate|compute|aggregate|count|summar)\b/.test(text)) {
    return "analysis"
  }
  if (/\b(shell|deploy|install|config|ops|provision)\b/.test(text)) return "ops"
  if (text.length < 140 && text.split(/\s+/).length < 24) return "microtask"
  return "mixed"
}

export function roleFor(category: Category, explicit?: string): string {
  if (explicit) return explicit
  switch (category) {
    case "research":
    case "analysis":
      return "researcher"
    case "coding":
      return "coder"
    case "verification":
      return "verifier"
    case "ops":
      return "builder"
    case "microtask":
      return "builder"
    default:
      return "builder"
  }
}

/** LPT packing keeps batches balanced without mixing task order semantics. */
export function packBatches(tasks: MicroTask[], workers: number): MicroTask[][] {
  const bins: MicroTask[][] = Array.from({ length: Math.max(1, workers) }, () => [])
  const loads = Array<number>(bins.length).fill(0)
  const sorted = [...tasks].sort((a, b) => b.seconds - a.seconds)
  for (const t of sorted) {
    let idx = 0
    for (let i = 1; i < loads.length; i++) if (loads[i]! < loads[idx]!) idx = i
    bins[idx]!.push(t)
    loads[idx] += Math.max(0.1, t.seconds)
  }
  return bins.filter((b) => b.length > 0)
}

export class AdaptiveScheduler {
  readonly config: SchedulerConfig

  constructor(private readonly deps: SchedulerDeps) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...(deps.config ?? {}) }
  }

  plan(input: TaskInput): Plan {
    const cfg = this.config
    const stats = this.deps.stats
    const router = this.deps.router
    const health = this.deps.health
    const category = classifyTask(input)
    const tasks = input.tasks ?? []
    const nodes = input.nodes ?? []
    const edges = input.edges ?? []
    const branches = Math.max(1, Math.floor(input.branches ?? (nodes.length || tasks.length || 1)))
    // Nodes plus edges are a dependency graph, not independent branches. Fan-out
    // candidates would silently assume the edges do not exist and overstate speed.
    const hasDag = nodes.length >= 2 && edges.length > 0
    const role = roleFor(category, input.role)
    const ambiguity = clamp(
      input.ambiguity ?? (tasks.length ? 0.2 : category === "research" || category === "mixed" ? 0.5 : 0.3),
      0,
      1,
    )
    const independence = clamp(
      input.independence ?? (tasks.length ? 0.9 : branches > 1 ? 0.8 : 0.6),
      0,
      1,
    )
    const sharedContext = clamp(
      input.sharedContext ?? (tasks.length ? 0.35 : category === "analysis" ? 0.45 : 0.3),
      0,
      1,
    )
    const risk = clamp(input.risk ?? 0.3, 0, 1)
    let qualityWeight = clamp(input.qualityWeight ?? cfg.qualityWeight, 0, 1)
    const warnings: string[] = []

    // SLA steering (Req 23): force the profile's qualityWeight and agent cap so
    // the same fixture yields observably different plans per mode. This is a
    // hard contract applied inside plan() itself, not merely a hint.
    let slaProfile: SlaProfile | undefined
    if (input.sla) {
      slaProfile = SLA_PROFILES[input.sla]
      qualityWeight = clamp(slaProfile.qualityWeight, 0, 1)
      warnings.push(`SLA ${input.sla}: qualityWeight forced to ${qualityWeight}`)
      if (input.budget?.agents !== undefined) {
        const cap = Math.min(input.budget.agents, AGENT_CAP_BY_MODE[slaProfile.mode])
        if (cap < input.budget.agents) {
          input.budget = { ...input.budget, agents: cap }
          warnings.push(`SLA ${input.sla}: budget.agents capped at ${cap}`)
        }
      }
    }

    const now = cfg.now()
    let warmLane = undefined as ReturnType<LanePool["list"]>[number] | undefined
    if (this.deps.lanes) {
      this.deps.lanes.sweep()
      warmLane = this.deps.lanes
        .list()
        .find(
          (l) =>
            l.status === "idle" &&
            l.expiresAt > now &&
            l.role === role &&
            (!input.model || l.model === input.model) &&
            (l.category === category || l.category === "mixed") &&
            (!input.capsule || l.capsule === input.capsule),
        )
    }
    const warm = input.warm ?? !!warmLane

    const contextTokens = stats.contextTokens({
      ...input,
      model: input.model ?? warmLane?.model,
    })
    const outputTokens = stats.outputTokens(input)
    const route = router.route({
      role,
      category,
      contextTokens,
      qualityWeight,
      warm,
    })

    let modelProfile: ModelProfile | undefined
    if (warmLane) {
      const p = router.profileFor(warmLane.model, warmLane.provider)
      if (health.allow(p.provider)) modelProfile = p
    }
    if (!modelProfile && input.model) {
      const p = router.profileFor(input.model, input.provider)
      if (health.allow(p.provider)) modelProfile = p
    }
    if (!modelProfile) {
      modelProfile = route.choices[0]?.model
    }
    if (!modelProfile) {
      modelProfile = synthesizeProfile(input.model ?? "inherit", input.provider ?? "unknown")
      warnings.push("No healthy routed model found; planned with a synthesized generalist profile.")
    }
    const provider = modelProfile.provider
    const quota = provider === "unknown" ? cfg.maxAgents : router.quotaCap(provider)
    const budgetAgents = Math.max(1, Math.floor(input.budget?.agents ?? cfg.maxAgents))
    const cap = Math.max(1, Math.min(cfg.maxAgents, quota, budgetAgents))
    if (cap < Math.min(cfg.maxAgents, quota) && input.budget?.agents !== undefined) {
      warnings.push(`Agent budget caps the swarm at ${cap} lane(s).`)
    }
    if (input.model && modelProfile.id !== input.model) {
      warnings.push(`Requested model ${input.model} is unavailable; routed to ${modelProfile.id}.`)
    }
    const providerState = health.state(provider)
    if (providerState !== "closed") {
      warnings.push(`${provider} circuit is ${providerState}; plan may reroute at spawn time.`)
    }
    if (route.blocked.length) warnings.push(...route.blocked.slice(0, 3))

    // Expected lane work from history, not from wishful thinking.
    const perBranch = clamp(
      input.branchSeconds ??
        (tasks.length
          ? median(tasks.map((t) => Math.max(0.1, t.seconds)))
          : nodes.length
            ? median(nodes.map((n) => Math.max(0.1, n.seconds)))
            : stats.estimateWork({ provider, model: modelProfile.id, role, category }, category)),
      1,
      3600,
    )
    const fanBranch = clamp(
      input.branchSeconds ??
        (tasks.length
          ? Math.max(...tasks.map((t) => Math.max(0.1, t.seconds)))
          : nodes.length
            ? Math.max(...nodes.map((n) => Math.max(0.1, n.seconds)))
            : perBranch),
      1,
      3600,
    )
    const serialWork = Math.max(
      1,
      tasks.length
        ? sum(tasks.map((t) => Math.max(0.1, t.seconds)))
        : nodes.length
          ? sum(nodes.map((n) => Math.max(0.1, n.seconds)))
          : perBranch * branches,
    )

    const verification = chooseVerification({
      level: input.verificationLevel,
      risk,
      disagreement: input.disagreement ?? 0,
      confidence: input.confidence ?? 0.75,
      deterministicTests: input.deterministicTests ?? false,
      testStrength: input.testStrength ?? 0.35,
      impact: Math.max(risk, input.verificationValue ?? 0),
      judgeAvailable: cfg.judgeAvailable,
      judgeCostSeconds: cfg.judgeCostSeconds,
      workSeconds: Math.min(1200, serialWork),
      budgetSeconds: input.budget?.wallClockSeconds,
    })
    const serialVerifyCost = verification.estimatedCost * (verification.level >= 2 ? 0.35 : 0.5)
    const serialSeconds = round(serialWork * 1.03 + serialVerifyCost, 1)

    const planningCost = (briefs: number): number =>
      round(
        Math.min(cfg.planningCapSeconds, cfg.planningBaseSeconds + cfg.planningSecondsPerLane * Math.max(1, briefs)) *
          (warm ? cfg.warmPlanningFactor : 1),
        1,
      )
    const startupBase = stats.estimateStartup({ provider, model: modelProfile.id, role, category, warm })
    const startupWall = (n: number): number =>
      round(
        startupBase * clamp(1 + 0.05 * Math.max(0, n - 1), 1, cfg.startupCongestionMax) +
          cfg.dispatchStaggerSeconds * Math.max(0, n - 1),
        1,
      )
    const integrationCost = (n: number, work: number): number =>
      round(cfg.integrationBaseSeconds + cfg.integrationSecondsPerLane * n + cfg.integrationWorkFactor * Math.min(work, 600), 1)
    const congestion = (n: number): number =>
      clamp(1 + cfg.congestionPerLane * Math.max(0, n - 1), 1, cfg.maxCongestion)
    const sharedFactor = 1 + cfg.sharedContextPenalty * sharedContext
    const dependencyFactor =
      independence >= 0.5 ? 1 : 1 + ((0.5 - independence) * 2 * (branches - 1)) / Math.max(1, branches)
    const laneCritical = fanBranch * dependencyFactor * sharedFactor
    const verifyCost = verification.estimatedCost
    const models = [modelProfile.id]

    const makeSwarm = (topology: Topology, requestedAgents: number): Candidate | undefined => {
      const agents = Math.max(1, Math.min(requestedAgents, cap, branches))
      if (agents < 2) return undefined
      const waves = Math.ceil(branches / agents)
      const waveSizes = Array.from({ length: waves }, (_, i) => Math.min(agents, branches - i * agents)).filter((n) => n > 0)
      const work = laneCritical * sum(waveSizes.map((n) => congestion(n)))
      const planning = planningCost(agents + Math.max(0, branches - agents) * 0.25)
      const startup = startupWall(agents)
      const integration = integrationCost(agents, serialWork)
      const seconds = round(planning + startup + work + integration + verifyCost, 1)
      return {
        topology,
        agents,
        waves,
        seconds,
        effective: seconds,
        planningCost: planning,
        startupCost: startup,
        work: round(work, 1),
        integrationCost: integration,
        criticalPath: round(laneCritical, 1),
        qualityCredit: 0,
        reason: `${agents} lane(s), ${waves} wave(s), congestion ${round(congestion(agents), 2)}x`,
      }
    }

    const candidates: Candidate[] = [
      {
        topology: "SERIAL",
        agents: 1,
        waves: 1,
        seconds: serialSeconds,
        effective: serialSeconds,
        planningCost: 0,
        startupCost: 0,
        work: round(serialWork, 1),
        integrationCost: 0,
        criticalPath: round(serialWork, 1),
        qualityCredit: 0,
        reason: "one agent; no planning/startup/integration overhead",
      },
    ]

    const fullAgents = Math.min(cap, branches)
    const smallAgents = Math.min(3, cap, branches)
    if (!hasDag && fullAgents >= 2) {
      const full = makeSwarm("FULL_SWARM", fullAgents)
      if (full) candidates.push(full)
    }
    if (!hasDag && smallAgents >= 2 && smallAgents < fullAgents) {
      const small = makeSwarm("SMALL_SWARM", smallAgents)
      if (small) candidates.push(small)
    }

    // Batched workers: several microtasks per lane, fewer spawns and less fan-out congestion.
    if (tasks.length >= 2 && cap >= 2) {
      const n = tasks.length
      const minWorkers = Math.max(2, Math.ceil(n / cfg.maxTasksPerBatch))
      // A "batch" of one task per lane is just fan-out with extra bookkeeping.
      // Keep at least one lane with a second task.
      const maxWorkers = Math.min(cap, n - 1)
      for (let workers = minWorkers; workers <= maxWorkers; workers++) {
        const bins = packBatches(tasks, workers)
        const loads = bins.map((b) => sum(b.map((t) => Math.max(0.1, t.seconds))))
        const maxLoad = Math.max(...loads)
        const total = sum(loads)
        const work = maxLoad * (1 + 0.02 * sharedContext) * congestion(bins.length) + 2 * bins.length
        const planning = planningCost(bins.length)
        const startup = startupWall(bins.length)
        const integration = integrationCost(bins.length, total)
        const seconds = round(planning + startup + work + integration + verifyCost, 1)
        const batches: BatchPlan[] = bins.map((b, i) => ({
          index: i,
          taskIds: b.map((t) => t.id),
          seconds: round(sum(b.map((t) => t.seconds)), 1),
          role: b[0]?.role,
        }))
        candidates.push({
          topology: "BATCHED_WORKER",
          agents: bins.length,
          waves: 1,
          seconds,
          effective: seconds,
          planningCost: planning,
          startupCost: startup,
          work: round(work, 1),
          integrationCost: integration,
          criticalPath: round(maxLoad, 1),
          qualityCredit: 0,
          reason: `${bins.length} worker(s), max ${cfg.maxTasksPerBatch} tasks each, no ${n}-lane fan-out`,
          batches,
        })
      }
    }

    // Speculative fan-out: two explorers first, expand only if they disagree.
    // Only when there is real fan-out to defer: 2 branches mean every lane starts
    // now anyway, so 2 explorers + 1 conditional expansion is what 3 branches buy.
    if (!hasDag && branches >= 3 && ambiguity >= 0.55 && branches <= 3 && cap >= 2) {
      const initial = Math.min(2, cap)
      const expansion = cap > initial ? 1 : 0
      const expectedAgents = initial + expansion * clamp((ambiguity - 0.5) / 0.5, 0, 1)
      const specLane = perBranch * (1 + 0.5 * ambiguity) * sharedFactor
      // The two explorers run concurrently; the congestion penalty is set by
      // their lane count, not by the expected number after a conditional
      // expansion. A late expansion adds branch work only if disagreement wins.
      const work = specLane * congestion(initial) + (expectedAgents - initial) * perBranch * 0.15
      const planning = planningCost(initial + expansion * 0.5)
      const startup = startupWall(initial) + (expansion ? 0.3 * startupWall(1) : 0)
      const integration = integrationCost(initial, perBranch * branches)
      const qualityCredit = round(
        Math.min(
          serialSeconds * 0.3,
          serialSeconds * qualityWeight * ambiguity * risk * (0.5 + 0.7 * risk),
        ),
        1,
      )
      const seconds = round(planning + startup + work + integration + verifyCost, 1)
      candidates.push({
        topology: "SPECULATIVE_SWARM",
        agents: initial,
        waves: 1,
        seconds,
        effective: round(seconds - qualityCredit, 1),
        planningCost: planning,
        startupCost: startup,
        work: round(work, 1),
        integrationCost: integration,
        criticalPath: round(specLane, 1),
        qualityCredit,
        reason: `start ${initial} explorers, expand to ${initial + expansion} only on disagreement; expected ${round(expectedAgents, 1)} workers`,
      })
    }

    // Pipeline: explicit dependency graph or declared dependencies.
    let pipelineSchedule: ScheduleResult | undefined
    if (nodes.length >= 2) {
      pipelineSchedule = scheduleDag(nodes, edges, { concurrency: cap })
    } else if (input.dependencies && branches >= 2) {
      const chain: DagNode[] = Array.from({ length: branches }, (_, i) => ({
        id: `stage${i + 1}`,
        seconds: perBranch,
        role,
        category,
      }))
      pipelineSchedule = scheduleDag(
        chain,
        chain.slice(0, -1).map((n, i) => [n.id, chain[i + 1]!.id] as [string, string]),
        { concurrency: cap },
      )
    }
    if (pipelineSchedule && pipelineSchedule.nodes.length >= 2 && pipelineSchedule.makespan < pipelineSchedule.serialTime * 0.98) {
      const width = Math.max(1, ...pipelineSchedule.waves.map((w) => w.length))
      const agents = Math.max(1, Math.min(cap, width))
      const work = pipelineSchedule.makespan * congestion(agents)
      const planning = planningCost(agents + Math.max(0, pipelineSchedule.nodes.length - agents) * 0.2)
      const startup = startupWall(agents)
      const integration = integrationCost(agents, pipelineSchedule.serialTime)
      const seconds = round(planning + startup + work + integration + verifyCost, 1)
      if (agents >= 2) {
        candidates.push({
          topology: "PIPELINE",
          agents,
          waves: pipelineSchedule.waves.length,
          seconds,
          effective: seconds,
          planningCost: planning,
          startupCost: startup,
          work: round(work, 1),
          integrationCost: integration,
          criticalPath: pipelineSchedule.makespan,
          qualityCredit: 0,
          reason: `critical path ${pipelineSchedule.makespan}s vs ${pipelineSchedule.serialTime}s serial; ${pipelineSchedule.criticalPath.join(" -> ")}`,
          schedule: pipelineSchedule,
        })
      }
    }

    const serialCandidate = candidates[0]!
    const swarmCandidates = candidates.filter((c) => c.topology !== "SERIAL").sort((a, b) => a.effective - b.effective)
    const bestSwarm = swarmCandidates[0]
    let chosen = serialCandidate
    if (bestSwarm) {
      const required =
        bestSwarm.topology === "BATCHED_WORKER"
          ? cfg.minSpeedupBatch
          : bestSwarm.topology === "SPECULATIVE_SWARM"
            ? 1
            : cfg.minSpeedupSwarm
      const savings = serialSeconds - bestSwarm.effective
      if (bestSwarm.effective <= serialSeconds / required && savings >= cfg.minSavingsSeconds) chosen = bestSwarm
    }

    const chosenAgents = chosen.agents
    const speedup = round(serialSeconds / Math.max(0.1, chosen.seconds), 2)
    const swarmSpeedup = round(serialSeconds / Math.max(0.1, bestSwarm?.seconds ?? serialSeconds), 2)
    const parallelEfficiency =
      chosen.topology === "SERIAL"
        ? 1
        : round(clamp(serialSeconds / Math.max(0.1, chosen.seconds) / Math.max(1, chosenAgents), 0, 1), 2)

    const requests =
      chosen.topology === "SERIAL"
        ? Math.round(2 + branches * 2 + verification.steps.length)
        : Math.round(chosenAgents * 3 + chosen.waves * 2 + verification.steps.length * 2 + 6)
    const tokens = Math.round(
      (chosen.topology === "SERIAL"
        ? contextTokens + outputTokens * branches
        : contextTokens * chosenAgents + outputTokens * chosenAgents * 2) +
        verification.estimatedCost * 10,
    )
    const wallClock =
      input.budget?.wallClockSeconds ??
      Math.max(30, Math.round(chosen.seconds * 1.35))
    const budget: Budget = {
      requests: input.budget?.requests ?? Math.round(requests * 1.25),
      tokens: input.budget?.tokens ?? Math.round(tokens * 1.25),
      agents: input.budget?.agents ?? Math.max(1, chosen.topology === "SERIAL" ? 1 : Math.min(cap, chosenAgents + 1)),
      wallClockSeconds: wallClock,
      verificationSeconds: verification.estimatedCost,
      reserve: input.budget?.reserve ?? Math.round(tokens * 0.1),
    }
    if (input.budget?.wallClockSeconds !== undefined && input.budget.wallClockSeconds < chosen.seconds) {
      warnings.push(
        `Wall-clock budget ${input.budget.wallClockSeconds}s is below the ${chosen.seconds}s estimate; expect cancellation or partial results.`,
      )
    }
    if (input.budget?.tokens !== undefined && input.budget.tokens < tokens) {
      warnings.push(`Token budget ${input.budget.tokens} is below the ${tokens} estimate.`)
    }

    const nModel = stats.count({ model: modelProfile.id })
    const nCategory = stats.count({ category })
    const explicitSignals =
      (input.branchSeconds !== undefined ? 1 : 0) +
      (tasks.length ? 1 : 0) +
      (input.branches !== undefined ? 1 : 0) +
      (nodes.length ? 1 : 0)
    let confidence =
      0.32 +
      0.38 * Math.min(1, (nModel + nCategory) / 14) +
      0.08 * Math.min(2, explicitSignals) +
      (warm ? 0.03 : 0) -
      (ambiguity > 0.7 ? 0.08 : 0) -
      (providerState !== "closed" ? 0.12 : 0)
    if (input.confidence !== undefined) confidence = 0.6 * confidence + 0.4 * input.confidence
    confidence = round(clamp(confidence, 0.2, 0.95), 2)

    const reasons: string[] = []
    if (chosen.topology === "SERIAL") {
      if (branches <= 1 && tasks.length === 0) {
        reasons.push("Stayed serial: only one independent branch; fan-out has no parallel work to exploit.")
      } else if (tasks.length) {
        reasons.push(
          `Stayed serial: ${tasks.length} microtasks are faster in one context; best alternative ${bestSwarm?.topology ?? "none"} predicted ${bestSwarm?.seconds ?? serialSeconds}s vs ${serialSeconds}s serial.`,
        )
      } else {
        reasons.push(
          `Stayed serial: best alternative ${bestSwarm?.topology ?? "none"} predicted ${bestSwarm?.seconds ?? serialSeconds}s vs ${serialSeconds}s serial after planning/startup/congestion.`,
        )
      }
    } else if (chosen.topology === "BATCHED_WORKER") {
      reasons.push(
        `Batched ${tasks.length} microtasks into ${chosenAgents} workers instead of ${tasks.length} lanes; planning ${chosen.planningCost}s, startup ${chosen.startupCost}s, congestion ${round(congestion(chosenAgents), 2)}x.`,
      )
    } else if (chosen.topology === "SPECULATIVE_SWARM") {
      reasons.push(
        `Ambiguity ${round(ambiguity, 2)}: start ${chosenAgents} explorers and expand only on disagreement; expected ${round(chosenAgents + clamp((ambiguity - 0.5) / 0.5, 0, 1), 1)} workers instead of a full fan-out.`,
      )
      if (chosen.qualityCredit > 0) {
        reasons.push(`Downside protection is worth ${chosen.qualityCredit}s of expected rework at quality weight ${round(qualityWeight, 2)}.`)
      }
    } else if (chosen.topology === "PIPELINE") {
      reasons.push(
        `Dependency graph has a ${chosen.criticalPath}s critical path vs ${round(pipelineSchedule?.serialTime ?? serialWork, 1)}s serial; ${chosenAgents} lanes, ${chosen.waves} wave(s).`,
      )
    } else {
      reasons.push(
        `${branches} independent branch(es), ${chosenAgents} lanes in ${chosen.waves} wave(s): ${speedsummary(chosen, serialSeconds)} after ${chosen.planningCost}s planning and ${chosen.startupCost}s startup.`,
      )
    }
    reasons.push(
      `Verification V${verification.level}: ${verification.steps.length} step(s), ${verification.estimatedCost}s estimated, expected gain ${verification.expectedGain}.${verification.skipReason ? ` ${verification.skipReason}` : ""}`,
    )
    const routeReason = route.choices[0]?.reasons.slice(0, 2).join("; ")
    reasons.push(`Routing: ${modelProfile.id} (${provider})${routeReason ? ` — ${routeReason}` : ""}.`)
    if (warm) {
      const cold = stats.estimateStartup({ provider, model: modelProfile.id, role, category, warm: false })
      reasons.push(`Warm lane estimated startup ${startupBase}s vs ${round(cold)}s cold.`)
    }
    if (chosen.topology !== "SERIAL" && speedup < 1) {
      reasons.push(`Predicted wall clock is ${round((1 - speedup) * 100)}% slower than serial; this plan buys risk reduction, not speed.`)
    }

    if (confidence < 0.45) warnings.push("Low confidence: little history for this model/category; treat the estimate as a prior.")
    if (branches > chosenAgents && chosen.topology !== "SERIAL" && chosen.topology !== "PIPELINE" && chosen.topology !== "SPECULATIVE_SWARM") {
      warnings.push(`${branches} branches exceed ${chosenAgents} lanes; work runs in ${chosen.waves} wave(s).`)
    }
    if (chosen.topology === "BATCHED_WORKER" && sharedContext < 0.2) {
      warnings.push("Batch tasks share little context; split them if scope/context leakage is a risk.")
    }
    if (chosen.topology === "SPECULATIVE_SWARM" && chosen.seconds > serialSeconds) {
      warnings.push("Speculative plan is predicted slower than serial; selected for downside protection, not speed.")
    }
    if (chosen.topology !== "SERIAL" && speedup < 1.15) {
      warnings.push("Predicted speedup is under 15%; serial may be safer if the task is urgent.")
    }
    if (verification.level === 0 && risk >= 0.6) {
      warnings.push("High risk with V0 verification; add deterministic tests or raise verificationValue.")
    }

    const estimates: PlanEstimates = {
      serial: round(serialSeconds),
      swarm: round(bestSwarm?.seconds ?? serialSeconds),
      chosen: round(chosen.seconds),
      speedup,
      swarmSpeedup,
      parallelEfficiency,
      startupCost: chosen.startupCost,
      verificationGain: verification.expectedGain,
      integrationCost: chosen.integrationCost,
      planningCost: chosen.planningCost,
      criticalPath: round(chosen.criticalPath),
      agents: chosenAgents,
      waves: chosen.waves,
      requests,
      tokens,
      confidence,
      netSecondsSaved: round(serialSeconds - chosen.seconds),
    }

    // Assembly is split from `predictors` so the derived contract is computed
    // from the decided plan rather than from the individual locals.
    const plan = {
      runId: newRunId(),
      createdAt: now,
      task: input,
      topology: chosen.topology,
      agents: chosenAgents,
      waves: chosen.waves,
      batches: chosen.batches ?? [],
      models,
      verification,
      estimates,
      budget,
      reasons,
      warnings,
      schedule: chosen.schedule,
      alternatives: candidates
        .map((c) => ({
          topology: c.topology,
          agents: c.agents,
          seconds: c.seconds,
          reason:
            c.qualityCredit > 0
              ? `${c.reason}; effective ${c.effective}s after ${c.qualityCredit}s quality credit`
              : c.reason,
        }))
        .sort((a, b) => a.seconds - b.seconds),
    } satisfies Omit<Plan, "predictors">
    // The snake_case predictor contract is derived from the decided plan, so it
    // mirrors exactly the numbers the scheduler chose. See predictor.ts.
    return { ...plan, predictors: planPredictors(plan) }
  }
}

function speedsummary(c: Candidate, serialSeconds: number): string {
  const speedup = serialSeconds / Math.max(0.1, c.seconds)
  return `${round(speedup, 2)}x serial`
}
