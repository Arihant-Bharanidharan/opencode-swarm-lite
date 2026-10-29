/**
 * Completed-run history keyed by task shape.
 * Req 40: shape baselines (p50/p90/success) feed planning and counterfactuals.
 * Req 48: records are metrics only — no task text, no secrets, ever; the
 *   record builder whitelists keys so learning data physically cannot carry
 *   prompt or source content.
 * Req 49: versioned store; an unknown schema version resets to a fresh start
 *   instead of crashing or misreading old data.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  CompletedRun,
  ObservationStatus,
  Plan,
  RunActuals,
  ShapeBaseline,
  TaskInput,
  TaskShape,
} from "./types.js"
import { median, percentile, round, safeReadJson, safeWriteJson } from "./util.js"

export interface HistoryFile {
  version: number
  runs: CompletedRun[]
}

const HISTORY_VERSION = 3
const MAX_RUNS = 1000

/** Rough serial estimate when no plan is available (branchSeconds x branches, or task sum). */
export function estimatedSerialSeconds(input: TaskInput): number {
  if (input.tasks?.length) return input.tasks.reduce((n, t) => n + t.seconds, 0)
  const branches = Math.max(1, input.branches ?? 1)
  return Math.max(1, input.branchSeconds ?? 120) * branches
}

const TOOLISH = /\b(run|execute|build|install|deploy|benchmark|compile|migrate|script|command)\b/

/**
 * Deterministic task-shape classifier. Shape buckets make history comparable:
 * predictions are only compared against runs of the same shape, so a 30s
 * microtask never drags a 40-minute parallel refactor baseline.
 */
export function classifyShape(input: TaskInput, plan?: Plan): TaskShape {
  const serial = plan?.estimates?.serial ?? estimatedSerialSeconds(input)
  if (input.tasks?.length) return "batched_microtasks"
  if (input.nodes?.length) return serial >= 1200 ? "large_parallel" : "medium_branch"
  if ((input.branches ?? 1) >= 5 || serial >= 1800) return "large_parallel"
  if ((input.ambiguity ?? 0) >= 0.6) return "ambiguous_debug"
  if ((input.verificationValue ?? 0) >= 0.7) return "high_verification"
  if ((input.contextTokens ?? 0) >= 40000) return "research"
  if (TOOLISH.test((input.task ?? "").toLowerCase()) && serial >= 150) return "tool_heavy"
  if (serial >= 600) return "medium_branch"
  if (serial >= 150) return "code_write"
  if (serial <= 60) return "microtask"
  return "small_serial"
}

const isRun = (r: unknown): r is CompletedRun =>
  !!r &&
  typeof r === "object" &&
  typeof (r as CompletedRun).runId === "string" &&
  typeof (r as CompletedRun).actualSeconds === "number"

/**
 * Build a history record from a finished plan. Copies whitelisted metric keys
 * only — the record cannot carry task text or secrets even if callers pass
 * loose objects (Req 48).
 */
export function completedRunFromPlan(plan: Plan, actuals: RunActuals): CompletedRun {
  return {
    ts: plan.createdAt,
    runId: actuals.runId ?? plan.runId,
    shape: classifyShape(plan.task, plan),
    category: plan.task.category ?? "mixed",
    topology: plan.topology,
    agents: actuals.agents ?? plan.agents,
    predictedSerialSeconds: plan.estimates.serial,
    predictedChosenSeconds: plan.estimates.chosen,
    actualSeconds: actuals.actualSeconds,
    quality: actuals.quality,
    requests: actuals.requests ?? plan.estimates.requests,
    workers: actuals.workers,
    usefulWorkers: actuals.usefulWorkers,
    wastedWorkers: actuals.wastedWorkers,
    verificationSeconds: actuals.verificationSeconds,
    verificationLevel: actuals.verificationLevel ?? plan.verification.level,
    providerFailures: actuals.status === "error" || actuals.status === "429" || actuals.status === "timeout" ? 1 : 0,
    status: (actuals.status ?? "ok") as ObservationStatus,
    provider: actuals.provider ?? "",
    model: actuals.model ?? plan.models[0] ?? "",
    sla: plan.task.sla,
    hedgeUsed: actuals.hedgeUsed,
    checkpointResumed: actuals.checkpointResumed,
    chaos: actuals.chaos,
  }
}

export class RunHistory {
  private runs: CompletedRun[] = []
  private readonly file: string | null

  constructor(file: string | null) {
    this.file = file
    this.load()
  }

  private load(): void {
    if (!this.file) return
    const data = safeReadJson<HistoryFile | CompletedRun[]>(this.file, {
      version: HISTORY_VERSION,
      runs: [],
    })
    if (Array.isArray(data)) {
      // Legacy/bare-array format: accept well-formed rows.
      this.runs = data.filter(isRun).slice(-MAX_RUNS)
      return
    }
    if (!data || data.version !== HISTORY_VERSION) {
      // Unknown schema version: fresh start, never a crash (Req 49).
      return
    }
    this.runs = (Array.isArray(data.runs) ? data.runs : []).filter(isRun).slice(-MAX_RUNS)
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, {
      version: HISTORY_VERSION,
      runs: this.runs.slice(-MAX_RUNS),
    } satisfies HistoryFile)
  }

  add(run: CompletedRun): void {
    this.runs.push(run)
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS)
    this.save()
  }

  all(): readonly CompletedRun[] {
    return this.runs
  }

  forShape(shape: TaskShape): CompletedRun[] {
    return this.runs.filter((r) => r.shape === shape)
  }

  recent(n = 20, shape?: TaskShape): CompletedRun[] {
    const rows = shape ? this.forShape(shape) : this.runs
    return rows.slice(-n).reverse()
  }

  /** p50/p90/success baseline for a shape; null when there is no evidence yet. */
  baseline(shape: TaskShape): ShapeBaseline | null {
    const rows = this.forShape(shape)
    if (rows.length === 0) return null
    const secs = rows.map((r) => r.actualSeconds)
    return {
      shape,
      n: rows.length,
      p50Seconds: round(median(secs)),
      p90Seconds: round(percentile(secs, 0.9)),
      successRate: round(rows.filter((r) => r.status === "ok").length / rows.length, 2),
    }
  }

  /** Median signed prediction bias (actual/predicted - 1) for a shape; 0 when unknown. */
  predictionBias(shape?: TaskShape): number {
    const rows = (shape ? this.forShape(shape) : this.runs).filter(
      (r) => r.predictedChosenSeconds > 0 && r.actualSeconds > 0,
    )
    if (rows.length === 0) return 0
    return round(median(rows.map((r) => r.actualSeconds / r.predictedChosenSeconds - 1)), 2)
  }

  /** Mean absolute percentage error of chosen-plan predictions for a shape. */
  predictionMape(shape?: TaskShape): number {
    const rows = (shape ? this.forShape(shape) : this.runs).filter(
      (r) => r.predictedChosenSeconds > 0 && r.actualSeconds > 0,
    )
    if (rows.length === 0) return 0.35
    const errs = rows.map((r) => Math.abs(r.actualSeconds / r.predictedChosenSeconds - 1))
    return round(errs.reduce((a, b) => a + b, 0) / errs.length, 2)
  }

  clear(): void {
    this.runs = []
    this.save()
  }
}
