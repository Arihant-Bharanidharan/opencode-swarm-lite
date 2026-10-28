/**
 * MixedStrategyScheduler: per-subgraph topology selection, strategy
 * transitions, ROI cancellation, critical-path priority, and anytime results
 * for a single mixed workload.
 *
 * Layers on top of AdaptiveScheduler: decomposes a plan into subgraphs
 * (one per branch/task/node group), picks a topology per subgraph based on
 * category + SLA + deadline pressure, scores each branch's ROI to decide
 * cancellations, promotes critical-path branches, and derives a monotone
 * anytime stage. Strategy transitions are logged so a coordinator can
 * re-plan mid-run without losing progress.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  AnytimeResult,
  BranchRoi,
  BranchRoiInput,
  Category,
  DagNode,
  MicroTask,
  Plan,
  PriorityAction,
  SlaMode,
  TaskInput,
  Topology,
} from "./types.js"
import { AdaptiveScheduler } from "./scheduler.js"
import { Router } from "./provider.js"
import type { ProviderHealth } from "./provider.js"
import type { StatsStore } from "./stats.js"
import { scoreBranchRoi, BranchRoiTracker } from "./roi.js"
import {
  planWithSla,
  anytimeResult,
  type CostGuardResult,
} from "./sla.js"
import type { DeadlineCheck, DeadlinePressure } from "./types.js"
import { round } from "./util.js"

export interface SubgraphPlan {
  id: string
  branches: string[]
  category: Category
  estimatedSeconds: number
  topology: Topology
  agents: number
  criticalPath: boolean
  reason: string
}

export interface StrategyTransition {
  from: Topology
  to: Topology
  trigger: "deadline" | "roi" | "provider_degradation" | "trust" | "sla"
  reason: string
}

export interface MixedStrategyResult {
  runId: string
  plan: Plan
  subgraphs: SubgraphPlan[]
  transitions: StrategyTransition[]
  cancellations: PriorityAction[]
  priorityUp: PriorityAction[]
  anytime: AnytimeResult
  deadline: DeadlineCheck | null
  deadlinePressure: DeadlinePressure | null
  guard: { decline: boolean; reason: string; overheadSeconds: number; savedSeconds: number }
  rois: BranchRoi[]
  message: string
}

export interface MixedStrategyOptions {
  /** Per-branch ROI inputs for cancellation/priority decisions. */
  branchRoi?: BranchRoiInput[]
  /** Force a specific SLA mode. */
  sla?: SlaMode
  /** Hard wall-clock deadline in seconds. */
  deadlineSeconds?: number
  /** Whether strategy transitions are logged/allowed. */
  allowTransitions?: boolean
}

const DEFAULT_TOPOLOGY: Topology = "SERIAL"

/** Category -> preferred topology when no deadline/ROI pressure. */
const CATEGORY_TOPOLOGY: Record<Category, Topology> = {
  microtask: "BATCHED_WORKER",
  research: "SMALL_SWARM",
  coding: "SERIAL",
  analysis: "SMALL_SWARM",
  verification: "PIPELINE",
  mixed: "SMALL_SWARM",
  ops: "BATCHED_WORKER",
}

export class MixedStrategyScheduler {
  private readonly scheduler: AdaptiveScheduler
  private readonly router: Router
  private readonly health: ProviderHealth
  private readonly stats: StatsStore
  private readonly roiTracker = new BranchRoiTracker()
  private readonly transitions: StrategyTransition[] = []

  constructor(deps: {
    scheduler: AdaptiveScheduler
    router: Router
    health: ProviderHealth
    stats: StatsStore
  }) {
    this.scheduler = deps.scheduler
    this.router = deps.router
    this.health = deps.health
    this.stats = deps.stats
  }

  /**
   * Plan a mixed workload: decompose into subgraphs, select a topology per
   * subgraph, score ROI for cancellation/priority, apply deadline pressure,
   * and derive the anytime stage. Call again after observing branch outcomes
   * to transition strategies mid-run.
   */
  select(input: TaskInput, opts: MixedStrategyOptions = {}): MixedStrategyResult {
    const transitions: StrategyTransition[] = []
    const allowTransitions = opts.allowTransitions !== false

    // Apply SLA steering + deadline.
    const effectiveInput: TaskInput = { ...input }
    if (opts.sla) effectiveInput.sla = opts.sla
    if (opts.deadlineSeconds !== undefined) effectiveInput.deadlineSeconds = opts.deadlineSeconds

    const sla = planWithSla(this.scheduler, effectiveInput)
    const plan = sla.plan
    const runId = plan.runId

    // ---- Decompose into subgraphs ----
    const subgraphs = this.decompose(plan)

    // ---- Per-subgraph topology selection ----
    const baseTopology = plan.topology
    for (const sg of subgraphs) {
      let topology = baseTopology
      let reason = `inherits plan topology ${baseTopology}`

      // Category preference (steer per-subgraph topology).
      const catPref = CATEGORY_TOPOLOGY[sg.category]
      if (catPref !== baseTopology && allowTransitions) {
        transitions.push({
          from: baseTopology,
          to: catPref,
          trigger: "sla",
          reason: `subgraph ${sg.id} (${sg.category}) prefers ${catPref}`,
        })
        topology = catPref
        reason = `category ${sg.category} prefers ${catPref}`
      }

      // Deadline pressure: impossible deadline -> force SERIAL for that subgraph.
      if (sla.deadline && !sla.deadline.plausible && topology !== "SERIAL" && allowTransitions) {
        transitions.push({
          from: topology,
          to: "SERIAL",
          trigger: "deadline",
          reason: `deadline impossible for ${sg.id}`,
        })
        topology = "SERIAL"
        reason += "; deadline impossible, forced SERIAL"
      } else if (sla.pressure && sla.pressure.pressure >= 0.85) {
        // Emergency: protect the critical path, deprioritize everything else.
        if (sg.criticalPath && topology !== "SERIAL" && allowTransitions) {
          // keep a parallel-ish topology but flag it
          reason += "; emergency deadline: protecting critical path"
        } else if (!sg.criticalPath) {
          reason += "; emergency deadline: low-value subgraph may be cancelled"
        }
      }

      sg.topology = topology
      sg.estimatedSeconds = plan.estimates.chosen / Math.max(1, subgraphs.length)
      sg.reason = reason
    }

    // ---- ROI scoring + cancellation / priority decisions ----
    const rois: BranchRoi[] = []
    const cancellations: PriorityAction[] = []
    const priorityUp: PriorityAction[] = []

    const branchRoiInputs = opts.branchRoi ?? []
    for (const roiInput of branchRoiInputs) {
      const roi = scoreBranchRoi(roiInput)
      this.roiTracker.update(roi)
      rois.push(roi)
    }

    const actions = this.roiTracker.decide()
    for (const a of actions) {
      if (a.action === "CANCEL") cancellations.push(a)
      else if (a.action === "PRIORITY_UP") priorityUp.push(a)
    }

    // ---- Anytime stage (monotone, starts at PRELIMINARY for a fresh plan) ----
    const anytime = anytimeResult(undefined, plan)

    // ---- Message ----
    const parts = [
      `plan ${plan.topology} with ${plan.agents} agent(s) in ${plan.waves} wave(s)`,
      `${subgraphs.length} subgraph(s)`,
      `${cancellations.length} cancellation(s)`,
      `${priorityUp.length} priority-up(s)`,
      `anytime ${anytime.stage}`,
    ]
    if (sla.impossible) parts.push("DEADLINE IMPOSSIBLE")
    if (sla.guard.decline) parts.push("COST GUARD DECLINES SWARM")

    return {
      runId,
      plan,
      subgraphs,
      transitions,
      cancellations,
      priorityUp,
      anytime,
      deadline: sla.deadline,
      deadlinePressure: sla.pressure,
      guard: {
        decline: sla.guard.decline,
        reason: sla.guard.reason,
        overheadSeconds: sla.guard.overheadSeconds,
        savedSeconds: sla.guard.savedSeconds,
      },
      rois,
      message: parts.join("; "),
    }
  }

  /** Score one branch's ROI and record it in the tracker (pure + tracked). */
  evaluateRoi(input: BranchRoiInput): BranchRoi {
    const roi = scoreBranchRoi(input)
    this.roiTracker.update(roi)
    return roi
  }

  /** Current hysteresis decisions for all tracked branches. */
  decide(): PriorityAction[] {
    return this.roiTracker.decide()
  }

  /** Decompose a plan into subgraphs: one per branch/task/node group. */
  private decompose(plan: Plan): SubgraphPlan[] {
    const subgraphs: SubgraphPlan[] = []
    const task = plan.task as {
      branches?: number
      tasks?: MicroTask[]
      nodes?: DagNode[]
      category?: Category
    }
    const category = (task.category ?? "mixed") as Category

    if (task.branches && task.branches > 1) {
      for (let i = 0; i < task.branches; i++) {
        subgraphs.push({
          id: `branch-${i + 1}`,
          branches: [`branch-${i + 1}`],
          category,
          estimatedSeconds: plan.estimates.chosen / Math.max(1, task.branches),
          topology: plan.topology,
          agents: Math.max(1, Math.floor(plan.agents / Math.max(1, task.branches))),
          criticalPath: i === 0,
          reason: `branch ${i + 1} of ${task.branches}`,
        })
      }
    } else if (task.tasks?.length) {
      for (const t of task.tasks) {
        subgraphs.push({
          id: t.id,
          branches: [t.id],
          category: t.category ?? category,
          estimatedSeconds: t.seconds,
          topology: plan.topology,
          agents: 1,
          criticalPath: false,
          reason: `task ${t.id}`,
        })
      }
    } else if (task.nodes?.length) {
      const critical = new Set(plan.schedule?.criticalPath ?? [])
      for (const n of task.nodes) {
        subgraphs.push({
          id: n.id,
          branches: [n.id],
          category: n.category ?? category,
          estimatedSeconds: n.seconds,
          topology: plan.topology,
          agents: 1,
          criticalPath: critical.has(n.id),
          reason: `node ${n.id}`,
        })
      }
    } else {
      subgraphs.push({
        id: "root",
        branches: ["root"],
        category,
        estimatedSeconds: plan.estimates.chosen,
        topology: plan.topology,
        agents: plan.agents,
        criticalPath: true,
        reason: "single root branch",
      })
    }
    return subgraphs
  }

  /** Last logged strategy transitions (read-only). */
  getTransitions(): readonly StrategyTransition[] {
    return [...this.transitions]
  }
}
