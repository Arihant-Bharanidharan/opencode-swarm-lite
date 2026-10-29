/**
 * Straggler prediction and hedged execution.
 *
 * Req 27: straggler assessment -- a lane within the 1.5x noise envelope that
 *   is still making progress is active-but-overdue: its expected hedge benefit
 *   is 0, so it is never hedged (false-positive avoidance). Silent lanes
 *   (no progress events, no tool activity) that stall get checkpointed,
 *   hedged, or replaced based on how far beyond the envelope they are.
 * Req 28: hedge decision -- hedge only when expected saved latency strictly
 *   exceeds the hedge cost. The HedgeCoordinator implements first-valid-
 *   completion-wins: the loser is cancelled cleanly and exactly once, and a
 *   late loser's completion is deduplicated so no side effect is applied
 *   twice.
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import { clamp, round } from "./util.js"
import type { HedgeDecision, StragglerAction, StragglerAssessment, StragglerInput } from "./types.js"

const ENVELOPE_RATIO = 1.5
const STALL_SILENCE_SECONDS = 60

export interface StragglerOptions {
  now?: () => number
}

/**
 * Req 27: assess one lane for straggler risk and the action to take.
 *
 * Active-but-overdue lanes (still producing progress events or tool
 * activity) get expected hedge benefit 0 and are never hedged, no matter how
 * far overdue they are -- that is the false-positive avoidance gate. Only
 * silent lanes beyond the 1.5x envelope are candidates for hedge/replace.
 */
export function assessStraggler(input: StragglerInput, opts: StragglerOptions = {}): StragglerAssessment {
  const {
    branchId,
    elapsedSeconds,
    expectedSeconds,
    lastProgressSeconds,
    progressEvents = 0,
    toolActivity = 0,
  } = input

  const active = progressEvents > 0 || toolActivity > 0
  const silentFor = lastProgressSeconds === undefined ? Infinity : elapsedSeconds - lastProgressSeconds
  const stalled = !active && silentFor >= STALL_SILENCE_SECONDS

  const ratio = expectedSeconds > 0 ? clamp(elapsedSeconds / expectedSeconds, 0, 10) : 0
  const overEnvelope = ratio > ENVELOPE_RATIO

  let risk = 0
  let action: StragglerAction = "continue"
  let reason: string

  if (stalled && overEnvelope) {
    // Silent stall beyond the envelope: hedge a backup, or replace if deep.
    risk = 0.9
    action = ratio > 2 ? "replace" : "hedge"
    reason =
      `stalled: silent for ${round(silentFor, 1)}s with no progress events or tool activity; ` +
      (action === "replace"
        ? `beyond ${round(ratio, 1)}x expected, replace the lane`
        : `beyond ${round(ratio, 1)}x expected, hedge a backup lane against the stalled one`)
  } else if (stalled) {
    // Silent but within the envelope: checkpoint, never hedge (false-positive avoidance).
    risk = 0.4
    action = "checkpoint"
    reason = `silent within the ${ENVELOPE_RATIO}x envelope at ${round(ratio, 1)}x expected: checkpoint now, hedge only if the stall persists beyond the envelope`
  } else if (overEnvelope) {
    if (active) {
      risk = clamp(0.35 + (ratio - ENVELOPE_RATIO) * 0.1, 0, 1)
      action = "continue"
      reason =
        `active-but-overdue at ${round(ratio, 1)}x expected: still producing progress, so expected hedge ` +
        `benefit is 0 -- no hedge (false-positive avoidance)`
    } else {
      risk = 0.6
      action = "checkpoint"
      reason = `beyond the ${ENVELOPE_RATIO}x envelope and silent: checkpoint now, hedge only if the stall persists`
    }
  } else if (ratio > 1.0) {
    if (active) {
      risk = clamp(0.15 + (ratio - 1) * 0.15, 0, 1)
      action = "continue"
      reason =
        `within the ${ENVELOPE_RATIO}x envelope and active: overdue but productive, expected hedge benefit is ` +
        `0 -- no hedge`
    } else {
      risk = 0.4
      action = "checkpoint"
      reason = `overdue and silent within the envelope: checkpoint now, hedge only if it stalls`
    }
  } else {
    risk = round(ratio * 0.25, 3)
    action = "continue"
    reason = `on track at ${round(ratio, 1)}x expected`
  }

  return {
    branchId,
    stragglerRisk: round(clamp(risk, 0, 1), 3),
    action,
    reason,
  }
}

export interface HedgeOptions {
  /** Expected wall-clock latency of the incumbent lane if left alone (seconds). */
  expectedLatencySeconds: number
  /** Expected wall-clock latency of the hedge lane (seconds). */
  hedgeLatencySeconds: number
  /** Fully loaded cost of spawning and running the hedge lane (seconds). */
  hedgeCostSeconds: number
  /** Confidence the hedge lane produces a valid result (0..1); defaults to 1. */
  hedgeConfidence?: number
}

/**
 * Req 28: hedge only when expected saved latency strictly exceeds the hedge
 * cost. Expected saved latency = max(0, incumbent latency - hedge latency)
 * x hedge confidence, floored at zero. Returns the gross expected benefit
 * (saved latency) and the cost so callers can see the comparison.
 */
export function decideHedge(options: HedgeOptions): HedgeDecision {
  const { expectedLatencySeconds, hedgeLatencySeconds, hedgeCostSeconds, hedgeConfidence = 1 } = options
  const confidence = clamp(hedgeConfidence, 0, 1)
  const cost = round(Math.max(0, hedgeCostSeconds), 3)
  const expectedSaved = round(Math.max(0, expectedLatencySeconds - hedgeLatencySeconds) * confidence, 3)
  const benefit = round(expectedSaved - cost, 3)
  const hedge = expectedSaved > cost && expectedSaved > 0

  let reason: string
  if (!hedge) {
    if (expectedSaved <= 0) {
      reason = `no hedge: the hedge lane is not expected to finish before the incumbent (saved ${expectedSaved}s <= 0)`
    } else {
      reason = `no hedge: expected saved latency ${expectedSaved}s does not exceed the hedge cost ${cost}s`
    }
  } else {
    reason = `hedge: expected saved latency ${expectedSaved}s exceeds hedge cost ${cost}s by ${benefit}s`
  }

  return { hedge, reason, expectedCostSeconds: cost, expectedBenefitSeconds: expectedSaved }
}

export interface HedgeEvent {
  type: "completion" | "cancel" | "dedupe"
  branchId: string
  winner?: string
  ts: number
  reason?: string
}

export interface HedgeCoordinatorOptions {
  now?: () => number
  /** Fired once per lane when it is cancelled (idempotent: once per lane). */
  onCancel?: (branchId: string) => void
  /** Fired once, when the first valid completion wins the race. */
  onComplete?: (branchId: string, result: unknown) => void
}

interface LaneState {
  cancelled: boolean
  completed: boolean
  valid: boolean
  result: unknown
}

/**
 * Req 28: first-valid-completion-wins hedge coordinator.
 *
 * - The first valid completion wins; its result is returned by result().
 * - Every other lane is cancelled cleanly and exactly once.
 * - A completion after a decision (valid or not) is deduplicated: its result
 *   is not applied and no side effects fire for it.
 * - cancel() is idempotent: re-cancelling a lane is a no-op.
 */
export class HedgeCoordinator {
  private readonly lanes = new Map<string, LaneState>()
  private decided = false
  private winnerId: string | undefined = undefined
  private winnerResult: unknown
  private readonly eventLog: HedgeEvent[] = []
  private readonly now: () => number
  private readonly onCancel?: (branchId: string) => void
  private readonly onComplete?: (branchId: string, result: unknown) => void

  constructor(opts: HedgeCoordinatorOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.onCancel = opts.onCancel
    this.onComplete = opts.onComplete
  }

  /** Register a hedge lane before it starts. */
  register(branchId: string): void {
    this.lanes.set(branchId, { cancelled: false, completed: false, valid: false, result: undefined })
  }

  /** Cancel a lane. Idempotent: returns `alreadyCancelled: true` on repeat. */
  cancel(branchId: string): { cancelled: boolean; alreadyCancelled: boolean } {
    const lane = this.lanes.get(branchId)
    if (!lane) return { cancelled: false, alreadyCancelled: false }
    if (lane.cancelled) return { cancelled: false, alreadyCancelled: true }
    lane.cancelled = true
    this.eventLog.push({ type: "cancel", branchId, ts: this.now() })
    this.onCancel?.(branchId)
    return { cancelled: true, alreadyCancelled: false }
  }

  /**
   * Record a completion. The first valid completion wins; late completions
   * are deduplicated and produce no side effects. Returns `{ won: true }`
   * only for the first valid completion.
   */
  complete(branchId: string, result: unknown, valid = true): { won: boolean; duplicate: boolean; reason?: string } {
    const lane = this.lanes.get(branchId)
    if (!lane) return { won: false, duplicate: false }

    if (lane.completed) {
      this.eventLog.push({
        type: "dedupe",
        branchId,
        winner: this.winnerId ?? undefined,
        ts: this.now(),
        reason: "duplicate completion",
      })
      return { won: false, duplicate: true }
    }
    lane.completed = true
    lane.valid = valid
    lane.result = result

    if (!valid) {
      this.eventLog.push({
        type: "dedupe",
        branchId,
        winner: this.winnerId ?? undefined,
        ts: this.now(),
        reason: "invalid result",
      })
      return { won: false, duplicate: false }
    }

    if (this.decided) {
      // A late valid completion after the winner: dedupe, no side effects.
      this.eventLog.push({
        type: "dedupe",
        branchId,
        winner: this.winnerId,
        ts: this.now(),
        reason: "late completion after winner",
      })
      return { won: false, duplicate: true }
    }

    this.decided = true
    this.winnerId = branchId
    this.winnerResult = result
    this.cancelOthers(branchId)
    this.eventLog.push({ type: "completion", branchId, ts: this.now() })
    this.onComplete?.(branchId, result)
    return { won: true, duplicate: false }
  }

  private cancelOthers(except: string): void {
    for (const [branchId, lane] of this.lanes) {
      if (branchId === except) continue
      if (!lane.cancelled && !lane.completed) this.cancel(branchId)
    }
  }

  /** The winning result, once a valid completion has decided the race. */
  result(): { winnerId: string | undefined; result: unknown; decided: boolean } {
    return { winnerId: this.winnerId, result: this.winnerResult, decided: this.decided }
  }

  /** All hedge events, in order: completions, cancels, and dedupes. */
  events(): ReadonlyArray<HedgeEvent> {
    return [...this.eventLog]
  }

  isCancelled(branchId: string): boolean {
    return this.lanes.get(branchId)?.cancelled ?? false
  }

  isCompleted(branchId: string): boolean {
    return this.lanes.get(branchId)?.completed ?? false
  }

  size(): number {
    return this.lanes.size
  }
}
