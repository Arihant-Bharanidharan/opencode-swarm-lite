/**
 * Append-only runtime event log with deterministic replay and efficiency
 * scoring. Events are JSONL under the swarm state directory.
 *
 * Hardened for v3 (Req 31-33): every event carries a stable eventId and a
 * per-run 1-based monotonic sequence; at-least-once worker delivery is
 * deduplicated to an exactly-once log; a failed durable append is COUNTED
 * (lostEvents) instead of silently swallowed; sequenceGaps() names the
 * sequence numbers the durable log lost; rebuildState() reconstructs lane
 * and checkpoint state from the log alone, deterministically.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { EffortReport, Plan } from "./types.js"
import { clamp, readJsonLines, round, safeAppendLine, uid } from "./util.js"

export type RuntimeEventType =
  | "PLAN"
  | "SPAWN"
  | "ASSIGN"
  | "PROMOTE"
  | "DEMOTE"
  | "BATCH"
  | "MERGE"
  | "DEDUP"
  | "CANCEL"
  | "ESCALATE"
  | "REROUTE"
  | "COMPACT"
  | "VERIFY"
  | "PROVIDER_COOLDOWN"
  | "CACHE_HIT"
  | "CAPSULE_LOAD"
  | "LANE_REGISTER"
  | "LANE_RELEASE"
  | "LANE_DONE"
  | "LANE_FAIL"
  | "WARM_HIT"
  | "WARM_MISS"
  | "SHADOW"
  | "CHECKPOINT"
  | "RESUME"
  | "SNAPSHOT"
  | "ROLLBACK"
  | "OUTCOME"
  | "AUTO_OUTCOME"
  | "NOTE"

export interface RuntimeEvent {
  ts: number
  runId?: string
  parentSessionID?: string
  type: RuntimeEventType
  data: Record<string, unknown>
  /** Stable identity: re-delivering the same eventId is a no-op (idempotent). */
  eventId?: string
  /** Per-run 1-based monotonic order; a gap means the durable log lost events. */
  sequence?: number
  /** Which lane/worker emitted this event, when known. */
  workerId?: string
}

export interface ReplayReport {
  runId: string
  plan?: Plan
  events: RuntimeEvent[]
  outcome?: EffortReport
  actualSeconds?: number
  predictedSeconds?: number
  predictionErrorPct?: number
  lanesSpawned: number
  lanesFailed: number
  verifications: number
}

export interface TelemetryOptions {
  now?: () => number
  maxMemory?: number
}

/** Sequence numbers the durable log is missing for a run (Req 31/32). */
export interface SequenceGapReport {
  runId: string
  /** Highest sequence observed for this run. */
  expected: number
  /** Sequenced events present for this run. */
  found: number
  /** Sequence numbers absent from 1..expected: events the durable log lost. */
  missing: number[]
}

export type RebuiltLaneStatus = "active" | "done" | "failed" | "released" | "unknown"

export interface RebuiltLaneState {
  laneId: string
  workerId?: string
  spawned: boolean
  done: boolean
  failed: boolean
  released: boolean
  status: RebuiltLaneStatus
  eventCount: number
  lastTs: number
  lastType?: RuntimeEventType
}

/** Checkpoint summary recovered from the log; the full checkpoint lives in
 * the CheckpointManager's versioned store (Req 11). */
export interface RebuiltCheckpointState {
  branchId: string
  milestone: string
  workSecondsCompleted: number
  ts: number
}

/** Lane + checkpoint state reconstructed from the event log alone (Req 33).
 * Deterministic: the same log always rebuilds the same state; every ts comes
 * from events, no wall-clock value is invented. */
export interface RebuiltState {
  runId: string
  plan?: Plan
  open: boolean
  lanes: RebuiltLaneState[]
  checkpoints: RebuiltCheckpointState[]
  snapshots: number
  resumes: number
  restarts: number
  rollbacks: number
  verifications: number
  /** Durable-append failures this instance counted (Req 31). */
  lostEvents: number
}

export class Telemetry {
  private events: RuntimeEvent[] = []
  private readonly now: () => number
  private readonly maxMemory: number
  /** Per-run sequence watermark; rebuilt from the durable log on load. */
  private readonly seqByRun = new Map<string, number>()
  /** eventId -> recorded event: at-least-once delivery becomes exactly-once logging. */
  private readonly seenEventIds = new Map<string, RuntimeEvent>()
  private _lostEvents = 0
  readonly file: string | null

  constructor(file: string | null, opts: TelemetryOptions = {}) {
    this.file = file
    this.now = opts.now ?? (() => Date.now())
    this.maxMemory = opts.maxMemory ?? 5000
    this.load()
  }

  /** Durable-append failures since construction (Req 31): events that live
   * only in memory because the JSONL write failed. Counted, never hidden. */
  get lostEvents(): number {
    return this._lostEvents
  }

  private load(): void {
    if (!this.file) return
    this.events = readJsonLines<RuntimeEvent>(this.file, this.maxMemory)
    // Sequence watermarks and the dedupe index are rebuilt from the durable
    // log so numbering and idempotence survive a crash + restart (Req 32).
    for (const e of this.events) {
      if (e.runId && typeof e.sequence === "number") {
        const cur = this.seqByRun.get(e.runId) ?? 0
        if (e.sequence > cur) this.seqByRun.set(e.runId, e.sequence)
      }
      if (e.eventId) this.seenEventIds.set(e.eventId, e)
    }
  }

  private append(e: RuntimeEvent): void {
    this.events.push(e)
    if (this.events.length > this.maxMemory) this.events = this.events.slice(-this.maxMemory)
    if (e.eventId) this.seenEventIds.set(e.eventId, e)
    // Req 31: a failed durable append is COUNTED, never silently swallowed.
    if (this.file && !safeAppendLine(this.file, JSON.stringify(e))) this._lostEvents++
  }

  log(
    type: RuntimeEventType,
    data: Record<string, unknown> = {},
    opts: { runId?: string; parentSessionID?: string; eventId?: string; workerId?: string } = {},
  ): RuntimeEvent {
    // Idempotent dedupe (Req 32): a worker retrying after a crash re-delivers
    // the same eventId; the log keeps exactly one copy and returns it.
    if (opts.eventId) {
      const seen = this.seenEventIds.get(opts.eventId)
      if (seen) return seen
    }
    const sequence = opts.runId ? (this.seqByRun.get(opts.runId) ?? 0) + 1 : undefined
    const e: RuntimeEvent = {
      ts: this.now(),
      type,
      data,
      runId: opts.runId,
      parentSessionID: opts.parentSessionID,
      eventId: opts.eventId ?? uid("evt"),
      workerId: opts.workerId,
      sequence,
    }
    if (opts.runId) this.seqByRun.set(opts.runId, sequence!)
    this.append(e)
    return e
  }

  startRun(plan: Plan, parentSessionID?: string): RuntimeEvent {
    return this.log("PLAN", { plan }, { runId: plan.runId, parentSessionID })
  }

  finish(runId: string, report: EffortReport, parentSessionID?: string): RuntimeEvent {
    return this.log("OUTCOME", { report }, { runId, parentSessionID })
  }

  autoFinish(runId: string, actualSeconds: number, parentSessionID?: string): RuntimeEvent {
    return this.log("AUTO_OUTCOME", { actualSeconds }, { runId, parentSessionID })
  }

  list(runId?: string): RuntimeEvent[] {
    return runId ? this.events.filter((e) => e.runId === runId) : [...this.events]
  }

  latestPlan(parentSessionID?: string): { plan: Plan; event: RuntimeEvent } | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!
      if (e.type !== "PLAN") continue
      if (parentSessionID && e.parentSessionID !== parentSessionID) continue
      const plan = (e.data as { plan?: Plan }).plan
      if (plan) return { plan, event: e }
    }
    return undefined
  }

  replay(runId?: string, parentSessionID?: string): ReplayReport | undefined {
    const planRec = runId
      ? this.events.find((e) => e.runId === runId && e.type === "PLAN")
      : this.latestPlan(parentSessionID)?.event
    if (!planRec) return undefined
    const id = planRec.runId!
    const events = this.list(id)
    const plan = (planRec.data as { plan?: Plan }).plan
    const outcomeEvent = events.find((e) => e.type === "OUTCOME" || e.type === "AUTO_OUTCOME")
    const outcome = outcomeEvent ? ((outcomeEvent.data as { report?: EffortReport }).report ?? undefined) : undefined
    const auto = outcomeEvent ? Number((outcomeEvent.data as { actualSeconds?: number }).actualSeconds ?? 0) : 0
    const actualSeconds = outcome?.actualSeconds ?? (auto || undefined)
    const predictedSeconds = plan?.estimates.chosen ?? plan?.estimates.swarm
    // SPAWN and ASSIGN are different lifecycle facts for the same lane. Count
    // unique executions, and prefer automatic hook events when present so an
    // explicit lane registration/record cannot double-count a real spawn.
    const autoSpawns = events.filter((e) => e.type === "SPAWN" && e.data.auto === true)
    const spawnEvents = autoSpawns.length ? autoSpawns : events.filter((e) => e.type === "SPAWN")
    const spawnKeys = new Set(
      spawnEvents.map((e, i) => String(e.data.toolCallID ?? e.data.sessionID ?? `spawn-${i}`)),
    )
    const autoFails = events.filter((e) => e.type === "LANE_FAIL" && e.data.auto === true)
    const failEvents = autoFails.length ? autoFails : events.filter((e) => e.type === "LANE_FAIL")
    const failKeys = new Set(
      failEvents.map((e, i) =>
        String(e.data.toolCallID ?? e.data.sessionID ?? e.data.laneId ?? `fail-${i}`),
      ),
    )
    return {
      runId: id,
      plan,
      events,
      outcome,
      actualSeconds,
      predictedSeconds,
      predictionErrorPct:
        actualSeconds && predictedSeconds
          ? round((Math.abs(actualSeconds - predictedSeconds) / actualSeconds) * 100)
          : undefined,
      lanesSpawned: spawnKeys.size,
      lanesFailed: failKeys.size,
      verifications: events.filter((e) => e.type === "VERIFY").length,
    }
  }

  activeRuns(parentSessionID?: string): Array<{ runId: string; plan: Plan; startedAt: number; events: number }> {
    const open = new Map<string, { plan: Plan; startedAt: number; events: number }>()
    for (const e of this.events) {
      if (parentSessionID && e.parentSessionID !== parentSessionID) continue
      if (e.type === "PLAN") {
        const plan = (e.data as { plan?: Plan }).plan
        if (plan && e.runId) open.set(e.runId, { plan, startedAt: e.ts, events: 1 })
      } else if (e.type === "OUTCOME" || e.type === "AUTO_OUTCOME") {
        if (e.runId) open.delete(e.runId)
      } else if (e.runId && open.has(e.runId)) {
        open.get(e.runId)!.events++
      }
    }
    return [...open.entries()].map(([runId, v]) => ({ runId, ...v }))
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.events) out[e.type] = (out[e.type] ?? 0) + 1
    return out
  }

  recent(n = 12): RuntimeEvent[] {
    return this.events.slice(-n).reverse()
  }

  /**
   * Sequence numbers missing from each run's observed stream (Req 31/32).
   * Only runs with actual gaps are reported; runs with no sequenced events
   * (legacy logs) report nothing.
   */
  sequenceGaps(runId?: string): SequenceGapReport[] {
    const byRun = new Map<string, number[]>()
    for (const e of this.events) {
      if (!e.runId || typeof e.sequence !== "number") continue
      if (runId && e.runId !== runId) continue
      const arr = byRun.get(e.runId) ?? []
      arr.push(e.sequence)
      byRun.set(e.runId, arr)
    }
    const out: SequenceGapReport[] = []
    for (const [id, seqs] of byRun) {
      const max = Math.max(...seqs)
      const present = new Set(seqs)
      const missing: number[] = []
      for (let s = 1; s <= max; s++) if (!present.has(s)) missing.push(s)
      if (missing.length > 0) out.push({ runId: id, expected: max, found: seqs.length, missing })
    }
    return out
  }

  /**
   * Reconstruct lane + checkpoint state for a run from the event log alone
   * (Req 33). The same log always rebuilds the same state: every timestamp
   * comes from events, and lanes/checkpoints are sorted by id, so no
   * wall-clock or iteration-order nondeterminism can leak in. Lanes are
   * keyed the way production logs identify them (sessionID first, then
   * toolCallID, then laneId), matching replay()'s spawn accounting.
   */
  rebuildState(runId: string): RebuiltState | undefined {
    const events = this.list(runId)
    const planRec = events.find((e) => e.type === "PLAN")
    if (!planRec) return undefined
    const plan = (planRec.data as { plan?: Plan }).plan
    const lanes = new Map<string, RebuiltLaneState>()
    const checkpoints = new Map<string, RebuiltCheckpointState>()
    let open = true
    let snapshots = 0
    let resumes = 0
    let restarts = 0
    let rollbacks = 0
    let verifications = 0
    for (const e of events) {
      const d = e.data as { laneId?: string; sessionID?: string; toolCallID?: string }
      const laneId = d.sessionID ?? d.toolCallID ?? d.laneId
      if (laneId) {
        let lane = lanes.get(laneId)
        if (!lane) {
          lane = {
            laneId,
            spawned: false,
            done: false,
            failed: false,
            released: false,
            status: "unknown",
            eventCount: 0,
            lastTs: e.ts,
          }
          lanes.set(laneId, lane)
        }
        lane.eventCount++
        lane.lastTs = e.ts
        lane.lastType = e.type
        if (e.workerId) lane.workerId = e.workerId
        if (e.type === "SPAWN" || e.type === "LANE_REGISTER") lane.spawned = true
        else if (e.type === "LANE_DONE") lane.done = true
        else if (e.type === "LANE_FAIL") lane.failed = true
        else if (e.type === "LANE_RELEASE") lane.released = true
      }
      if (e.type === "OUTCOME" || e.type === "AUTO_OUTCOME") open = false
      else if (e.type === "CHECKPOINT") {
        const cp = (e.data as { checkpoint?: { branchId?: string; milestone?: string; workSecondsCompleted?: number } })
          .checkpoint
        if (cp?.branchId && cp.milestone) {
          checkpoints.set(cp.branchId, {
            branchId: cp.branchId,
            milestone: cp.milestone,
            workSecondsCompleted: Number(cp.workSecondsCompleted ?? 0),
            ts: e.ts,
          })
        }
      } else if (e.type === "SNAPSHOT") snapshots++
      else if (e.type === "RESUME") {
        if ((e.data as { decision?: string }).decision === "restart") restarts++
        else resumes++
      } else if (e.type === "ROLLBACK") rollbacks++
      else if (e.type === "VERIFY") verifications++
    }
    return {
      runId,
      plan,
      open,
      lanes: [...lanes.values()]
        .map((l) => ({ ...l, status: laneStatus(l) }))
        .sort((a, b) => (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0)),
      checkpoints: [...checkpoints.values()].sort((a, b) =>
        a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0,
      ),
      snapshots,
      resumes,
      restarts,
      rollbacks,
      verifications,
      lostEvents: this._lostEvents,
    }
  }

  static efficiency(input: {
    runId: string
    predictedSeconds: number
    actualSeconds: number
    serialSeconds?: number
    workers: number
    usefulWorkers: number
    wastedWorkers: number
    requests?: number
    tokensIn?: number
    tokensOut?: number
    quality?: number
    qualityGain?: number
    verificationSeconds?: number
    startupSeconds?: number
  }): EffortReport {
    const actual = Math.max(0.001, input.actualSeconds)
    const workers = Math.max(0, input.workers)
    const wasted = clamp(input.wastedWorkers, 0, Math.max(workers, input.wastedWorkers))
    const speedup = input.serialSeconds && input.serialSeconds > 0 ? input.serialSeconds / actual : undefined
    const errorPct = Math.abs(input.predictedSeconds - actual) / actual
    const wastedRatio = workers > 0 ? wasted / workers : 0
    const startupFraction = clamp((input.startupSeconds ?? 0) / actual, 0, 1)
    const qualityGain = clamp(input.qualityGain ?? 0, 0, 1)
    const efficiency = speedup ? clamp(speedup / Math.max(1, workers), 0, 1) : 1 - wastedRatio
    const score = clamp(
      35 * (speedup ? clamp(speedup / 2, 0, 1) : 0.5) +
        25 * (1 - clamp(errorPct, 0, 1)) +
        20 * (1 - wastedRatio) +
        10 * (1 - startupFraction) +
        10 * qualityGain +
        (speedup && speedup < 1 ? -15 : 0),
      0,
      100,
    )
    const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F"
    const reasons: string[] = []
    if (speedup) reasons.push(`speedup ${round(speedup, 2)}x vs serial`)
    if (speedup && speedup < 1) reasons.push("slower than serial: fan-out overhead was not repaid")
    reasons.push(`prediction error ${round(errorPct * 100)}%`)
    if (wasted > 0) reasons.push(`${wasted}/${workers} workers produced no unique kept result`)
    if (startupFraction > 0.25) reasons.push(`startup was ${round(startupFraction * 100)}% of wall clock`)
    if (qualityGain > 0) reasons.push(`quality gain ${round(qualityGain * 100)}%`)
    reasons.push(`parallel efficiency ${round(efficiency * 100)}%`)
    return {
      runId: input.runId,
      predictedSeconds: round(input.predictedSeconds),
      actualSeconds: round(input.actualSeconds),
      serialSeconds: input.serialSeconds ? round(input.serialSeconds) : undefined,
      speedup: speedup ? round(speedup, 2) : undefined,
      predictedErrorPct: round(errorPct * 100),
      workers,
      usefulWorkers: input.usefulWorkers,
      wastedWorkers: wasted,
      requests: input.requests ?? 0,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      quality: input.quality,
      qualityGain: input.qualityGain,
      verificationSeconds: input.verificationSeconds,
      startupSeconds: input.startupSeconds,
      score: round(score),
      grade,
      reasons,
    }
  }
}

function laneStatus(l: { failed: boolean; done: boolean; released: boolean; spawned: boolean }): RebuiltLaneStatus {
  if (l.failed) return "failed"
  if (l.done) return "done"
  if (l.released) return "released"
  if (l.spawned) return "active"
  return "unknown"
}

export function newRunId(): string {
  return uid("run")
}
