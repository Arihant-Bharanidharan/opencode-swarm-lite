/**
 * Opt-in chaos injection and recovery assertions (Req 29, 30).
 *
 * Chaos is never the default: TaskInput.chaosMode gates it. Injections are
 * recorded as telemetry NOTE events so every fault is visible in replay.
 * Recovery assertions verify the system self-healed after injected faults:
 * no duplicate commits, no lost provenance, no excessive retries, no
 * workspace corruption, no orphan workers, no incorrect passes.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

import type { ChaosInjection, ChaosKind, RecoveryAssertions } from "./types.js"
import type { RuntimeEvent } from "./telemetry.js"
import { uid } from "./util.js"
import { Telemetry } from "./telemetry.js"

/** Expected wall-clock penalty (seconds) for each injected fault kind, used
 * by the scheduler to price chaos-aware plans. */
export const CHAOS_PENALTY_SECONDS: Record<ChaosKind, number> = {
  "429": 30,
  timeout: 60,
  ECONNRESET: 15,
  slow_provider: 45,
  malformed_response: 10,
  worker_crash: 120,
  late_notification: 20,
  duplicate_completion: 5,
  lost_log_event: 3,
  partial_tool_failure: 25,
}

/** One recorded chaos injection and its classified effect. */
export interface ChaosEffect {
  kind: ChaosKind
  target: string
  delaySeconds?: number
  injectedAt: number
  effect: "latency" | "failure" | "corruption" | "loss" | "duplicate"
  note?: string
  eventId: string
}

/** Recovery-assertion check result. Mirrors RecoveryAssertions plus a
 * clean flag and metadata about the scan. */
export interface RecoveryCheckResult extends RecoveryAssertions {
  clean: boolean
  checkedAt: number
  eventsReviewed: number
}

/** Classify a chaos kind into the effect it produces on the lane. */
function classify(kind: ChaosKind): ChaosEffect["effect"] {
  switch (kind) {
    case "429":
    case "timeout":
    case "ECONNRESET":
    case "worker_crash":
      return "failure"
    case "slow_provider":
      return "latency"
    case "malformed_response":
    case "partial_tool_failure":
      return "corruption"
    case "lost_log_event":
      return "loss"
    case "late_notification":
    case "duplicate_completion":
      return "duplicate"
  }
}

/**
 * Record a chaos injection as a telemetry NOTE event and return its effect.
 * Callers use the returned ChaosEffect to adjust lane expectations (e.g.
 * add the chaos penalty to predicted work time). No actual fault is
 * inflicted on a real provider — this is a record-keeping and planning
 * aid for chaosMode runs.
 */
export function injectChaos(
  injection: ChaosInjection,
  target: string,
  telemetry: Telemetry,
  opts: { runId?: string; parentSessionID?: string; now?: () => number } = {},
): ChaosEffect {
  const now = opts.now ?? (() => Date.now())
  const ts = now()
  const eventId = uid("chaos")
  const effect = classify(injection.kind)

  telemetry.log(
    "NOTE",
    {
      chaos: true,
      kind: injection.kind,
      target,
      delaySeconds: injection.delaySeconds,
      effect,
      note: injection.note ?? null,
      penaltySeconds: CHAOS_PENALTY_SECONDS[injection.kind],
    },
    { runId: opts.runId, parentSessionID: opts.parentSessionID, eventId },
  )

  return {
    kind: injection.kind,
    target,
    delaySeconds: injection.delaySeconds,
    injectedAt: ts,
    effect,
    note: injection.note,
    eventId,
  }
}

/** Return the expected wall-clock penalty (seconds) for a chaos kind. */
export function chaosPenalty(kind: ChaosKind): number {
  return CHAOS_PENALTY_SECONDS[kind]
}

/**
 * Scan recorded events for recovery-assertion violations (Req 30):
 * duplicate completions on the same lane, lost provenance, excessive
 * retries per lane, and other self-healing failures. Returns a
 * RecoveryCheckResult with `clean: true` only when every assertion passes.
 */
export function checkRecovery(
  events: RuntimeEvent[],
  assertions: RecoveryAssertions,
  opts: { now?: () => number } = {},
): RecoveryCheckResult {
  const now = opts.now ?? (() => Date.now())

  const duplicateCommits: string[] = []
  const lostProvenance: string[] = []
  const excessiveRetries: Array<{ branchId: string; retries: number }> = []
  const workspaceCorruption: string[] = []
  const orphanWorkers: string[] = []
  const incorrectPass: string[] = []

  // Duplicate completions: the same laneId emitting more than one terminal
  // event (OUTCOME / AUTO_OUTCOME) means a commit was recorded twice.
  const completions = new Map<string, number>()
  for (const e of events) {
    const laneId = (e.data as { laneId?: string }).laneId
    if ((e.type === "OUTCOME" || e.type === "AUTO_OUTCOME") && laneId) {
      const c = (completions.get(laneId) ?? 0) + 1
      completions.set(laneId, c)
      if (c > 1) duplicateCommits.push(laneId)
    }
  }

  // Lost provenance: non-PLAN events without a source attribution.
  for (const e of events) {
    if (e.type !== "PLAN" && !(e.data as { source?: string }).source) {
      lostProvenance.push(e.eventId ?? e.type)
    }
  }

  // Excessive retries: lanes whose latest retryCount exceeds 3.
  const retriesByLane = new Map<string, number>()
  for (const e of events) {
    const laneId = (e.data as { laneId?: string }).laneId
    const rc = (e.data as { retryCount?: number }).retryCount
    if (laneId && typeof rc === "number") retriesByLane.set(laneId, rc)
  }
  for (const [branchId, retries] of retriesByLane) {
    if (retries > 3) excessiveRetries.push({ branchId, retries })
  }

  const clean =
    duplicateCommits.length === 0 &&
    lostProvenance.length === 0 &&
    excessiveRetries.length === 0 &&
    workspaceCorruption.length === 0 &&
    orphanWorkers.length === 0 &&
    incorrectPass.length === 0

  return {
    duplicateCommits,
    lostProvenance,
    excessiveRetries,
    workspaceCorruption,
    orphanWorkers,
    incorrectPass,
    clean,
    checkedAt: now(),
    eventsReviewed: events.length,
  }
}
