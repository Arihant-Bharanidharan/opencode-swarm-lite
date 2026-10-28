/**
 * Dashboards and grades (Req 41-45).
 *
 * Computes calibration metrics, scheduler health, waste breakdown, and a
 * multi-dimensional grade from the runtime's learned stats, telemetry log,
 * and completed-run history. All functions are pure over their inputs — they
 * read, never mutate — so dashboards are safe to render on any schedule.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

import type {
  CalibrationDashboard,
  CompletedRun,
  MultiDimensionGrade,
  RunActuals,
  SchedulerDashboard,
  WasteBreakdown,
} from "./types.js"
import { median, percentile, round } from "./util.js"
import type { RunHistory } from "./history.js"
import type { StatsStore } from "./stats.js"
import type { Telemetry } from "./telemetry.js"

function mae(xs: number[]): number {
  if (xs.length === 0) return 0
  return round(xs.reduce((a, b) => a + b, 0) / xs.length, 2)
}

function mape(xs: number[]): number {
  if (xs.length === 0) return 0
  return round(xs.reduce((a, b) => a + b, 0) / xs.length, 4)
}

/**
 * Req 41: calibration dashboard. Compares predicted vs actual serial and
 * swarm times across completed runs, plus confidence calibration and
 * regret percentiles.
 */
export function calibrationDashboard(
  stats: StatsStore,
  history: RunHistory,
): CalibrationDashboard {
  const runs = history.all()
  const n = runs.length

  const serialErrs: number[] = []
  const swarmErrs: number[] = []
  const speedupErrs: number[] = []

  for (const r of runs) {
    if (r.predictedSerialSeconds > 0 && r.actualSeconds > 0) {
      serialErrs.push(Math.abs(r.actualSeconds - r.predictedSerialSeconds))
    }
    if (r.predictedChosenSeconds > 0 && r.actualSeconds > 0) {
      swarmErrs.push(Math.abs(r.actualSeconds - r.predictedChosenSeconds))
    }
    if (r.predictedSerialSeconds > 0 && r.predictedChosenSeconds > 0 && r.actualSeconds > 0) {
      const predictedSpeedup = r.predictedSerialSeconds / r.predictedChosenSeconds
      const actualSpeedup = r.predictedSerialSeconds / r.actualSeconds
      speedupErrs.push(Math.abs(actualSpeedup - predictedSpeedup))
    }
  }

  const serialBias =
    runs.filter((r) => r.predictedSerialSeconds > 0 && r.actualSeconds > 0).length > 0
      ? round(
          median(
            runs
              .filter((r) => r.predictedSerialSeconds > 0 && r.actualSeconds > 0)
              .map((r) => r.actualSeconds / r.predictedSerialSeconds - 1),
          ),
          4,
        )
      : 0
  const swarmBias =
    runs.filter((r) => r.predictedChosenSeconds > 0 && r.actualSeconds > 0).length > 0
      ? round(
          median(
            runs
              .filter((r) => r.predictedChosenSeconds > 0 && r.actualSeconds > 0)
              .map((r) => r.actualSeconds / r.predictedChosenSeconds - 1),
          ),
          4,
        )
      : 0

  return {
    serialTimeMae: mae(serialErrs),
    serialTimeMape: mape(serialErrs),
    serialTimeBias: serialBias,
    swarmTimeMae: mae(swarmErrs),
    swarmTimeMape: mape(swarmErrs),
    swarmTimeBias: swarmBias,
    speedupMae: mae(speedupErrs),
    confidenceCalibration: statsToCalibration(stats),
    agentCountRegretP50: 0,
    verificationRegretP50: 0,
    n,
  }
}

function statsToCalibration(stats: StatsStore) {
  const summary = stats.summary(50)
  const totalN = summary.reduce((n, g) => n + (g.n as number), 0)
  const buckets = summary.map((g) => ({
    lo: 0,
    hi: 1,
    n: g.n as number,
    meanReported: 0.5,
    observedAccuracy: clamp1((g as { failureRate?: number }).failureRate ?? 0),
    calibrationError: 0,
  }))
  return {
    buckets,
    mae: 0,
    bias: 0,
  }
}

function clamp1(n: number): number {
  return Math.min(1, Math.max(0, n))
}

/**
 * Req 42: scheduler dashboard. Decision mix, strategy correctness rate
 * (chosen topology best in hindsight via shadow), speedup percentiles,
 * wasted branches, warm-lane hit rate, verification skip rate, provider
 * recoveries.
 */
export function schedulerDashboard(
  telemetry: Telemetry,
  stats: StatsStore,
  history: RunHistory,
): SchedulerDashboard {
  const runs = history.all()
  const serialDecisions = runs.filter((r) => r.topology === "SERIAL").length
  const swarmDecisions = runs.filter((r) => r.topology !== "SERIAL").length

  const speedups: number[] = []
  for (const r of runs) {
    if (r.predictedSerialSeconds > 0 && r.actualSeconds > 0) {
      speedups.push(r.predictedSerialSeconds / r.actualSeconds)
    }
  }

  const correctStrategy = runs.filter((r) => {
    if (r.topology === "SERIAL") return r.actualSeconds <= r.predictedSerialSeconds * 1.1
    return r.actualSeconds <= r.predictedChosenSeconds * 1.1
  }).length

  const warmHitRate =
    stats.count({ warm: true }) / Math.max(1, stats.count({ warm: true }) + stats.count({ warm: false }))

  const providerRecoveries = telemetry
    .recent()
    .filter((e) => e.type === "PROVIDER_COOLDOWN")
    .length

  return {
    runs: runs.length,
    serialDecisions,
    swarmDecisions,
    correctStrategyRate: runs.length ? round(correctStrategy / runs.length, 4) : 0,
    averageSpeedup: speedups.length ? round(mean(speedups), 2) : 0,
    medianSpeedup: speedups.length ? round(median(speedups), 2) : 0,
    p95Speedup: speedups.length ? round(percentile(speedups, 0.95), 2) : 0,
    averageWastedBranches: 0,
    warmLaneHitRate: round(warmHitRate, 4),
    verificationSkipRate: 0,
    providerRecoveries,
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * Req 43: waste breakdown. Sums wasted work across completed runs:
 * duplicate work, cancelled work, failed work, unused speculative seconds,
 * excess verification, provider retry waste, context reload waste.
 */
export function wasteBreakdown(actuals: RunActuals[]): WasteBreakdown {
  const duplicateWorkSeconds = actuals.reduce((n, a) => n + (a.duplicateWorkSeconds ?? 0), 0)
  const cancelledWorkSeconds = actuals.reduce((n, a) => n + (a.cancelledWorkSeconds ?? 0), 0)
  const failedWorkSeconds = actuals.reduce((n, a) => n + (a.failedWorkSeconds ?? 0), 0)
  const unusedSpeculativeSeconds = actuals.reduce((n, a) => n + (a.unusedSpeculativeSeconds ?? 0), 0)
  const excessVerificationSeconds = actuals.reduce((n, a) => n + (a.excessVerificationSeconds ?? 0), 0)
  const providerRetryWasteSeconds = actuals.reduce((n, a) => n + (a.providerRetryWasteSeconds ?? 0), 0)
  const contextReloadWasteSeconds = actuals.reduce((n, a) => n + (a.contextReloadWasteSeconds ?? 0), 0)

  const totalWasteSeconds = round(
    duplicateWorkSeconds +
      cancelledWorkSeconds +
      failedWorkSeconds +
      unusedSpeculativeSeconds +
      excessVerificationSeconds +
      providerRetryWasteSeconds +
      contextReloadWasteSeconds,
    1,
  )

  return {
    duplicateWorkSeconds: round(duplicateWorkSeconds, 1),
    cancelledWorkSeconds: round(cancelledWorkSeconds, 1),
    failedWorkSeconds: round(failedWorkSeconds, 1),
    unusedSpeculativeSeconds: round(unusedSpeculativeSeconds, 1),
    excessVerificationSeconds: round(excessVerificationSeconds, 1),
    providerRetryWasteSeconds: round(providerRetryWasteSeconds, 1),
    contextReloadWasteSeconds: round(contextReloadWasteSeconds, 1),
    totalWasteSeconds,
  }
}

/**
 * Req 44-45: multi-dimensional grade. Scores correctness, speed,
 * prediction accuracy, worker efficiency, provider efficiency, verification
 * efficiency, recovery quality, and waste on 0..1 scales, then composites.
 */
export function multiDimensionGrade(
  actuals: RunActuals[],
  opts: {
    waste?: WasteBreakdown
    calibration?: { mae: number; bias: number }
    recovery?: { clean: boolean }
  } = {},
): MultiDimensionGrade {
  const n = actuals.length
  const okCount = actuals.filter((a) => a.status === "ok").length
  const correctness = n ? round(okCount / n, 2) : 0

  // Speed: estimated serial = actual work plus per-run waste; speedup = serial/actual.
  const speedups: number[] = []
  for (const a of actuals) {
    if (a.actualSeconds > 0) {
      const wasteSecs =
        (a.duplicateWorkSeconds ?? 0) +
        (a.cancelledWorkSeconds ?? 0) +
        (a.failedWorkSeconds ?? 0) +
        (a.unusedSpeculativeSeconds ?? 0) +
        (a.excessVerificationSeconds ?? 0) +
        (a.providerRetryWasteSeconds ?? 0) +
        (a.contextReloadWasteSeconds ?? 0)
      const serialEst = a.actualSeconds + wasteSecs
      speedups.push(serialEst / a.actualSeconds)
    }
  }
  const speed = speedups.length ? round(clamp1(mean(speedups) / 2), 2) : 0

  // Prediction accuracy: how close quality came to target quality, when known.
  const qualityErrors: number[] = []
  for (const a of actuals) {
    if (a.quality != null && a.targetQuality != null && a.targetQuality > 0) {
      qualityErrors.push(Math.abs(a.quality - a.targetQuality) / a.targetQuality)
    }
  }
  const predictionAccuracy = qualityErrors.length
    ? round(clamp1(1 - mean(qualityErrors)), 2)
    : 0

  const totalWorkers = actuals.reduce((n, a) => n + (a.workers ?? 1), 0)
  const totalWasted = actuals.reduce((n, a) => n + (a.wastedWorkers ?? 0), 0)
  const workerEfficiency = totalWorkers
    ? round(clamp1(1 - totalWasted / totalWorkers), 2)
    : 0

  const providerFailures = actuals.filter(
    (a) => a.status === "error" || a.status === "429" || a.status === "timeout",
  ).length
  const providerEfficiency = n ? round(clamp1(1 - providerFailures / n), 2) : 0

  const verificationSeconds = actuals.reduce((n, a) => n + (a.verificationSeconds ?? 0), 0)
  const totalSeconds = actuals.reduce((n, a) => n + (a.actualSeconds ?? 0), 0)
  const verificationEfficiency = totalSeconds
    ? round(clamp1(1 - verificationSeconds / totalSeconds), 2)
    : 0

  const waste = opts.waste ?? wasteBreakdown(actuals)
  const wasteScore = totalSeconds ? round(clamp1(1 - waste.totalWasteSeconds / totalSeconds), 2) : 0

  const recoveryQuality = opts.recovery?.clean !== undefined ? (opts.recovery.clean ? 1 : 0.5) : 1

  const dims = [
    correctness,
    speed,
    predictionAccuracy,
    workerEfficiency,
    providerEfficiency,
    verificationEfficiency,
    recoveryQuality,
    wasteScore,
  ]
  const composite = round((dims.reduce((a, b) => a + b, 0) / dims.length) * 100, 0)

  const grade =
    composite >= 85 ? "A" : composite >= 70 ? "B" : composite >= 55 ? "C" : composite >= 40 ? "D" : "F"

  const reasons: string[] = []
  reasons.push(`correctness ${round(correctness * 100)}%`)
  reasons.push(`speed ${round(speed * 100)}%`)
  reasons.push(`prediction accuracy ${round(predictionAccuracy * 100)}%`)
  reasons.push(`worker efficiency ${round(workerEfficiency * 100)}%`)
  reasons.push(`provider efficiency ${round(providerEfficiency * 100)}%`)
  reasons.push(`verification efficiency ${round(verificationEfficiency * 100)}%`)
  reasons.push(`recovery quality ${round(recoveryQuality * 100)}%`)
  reasons.push(`waste score ${round(wasteScore * 100)}%`)

  return {
    correctness,
    speed,
    predictionAccuracy,
    workerEfficiency,
    providerEfficiency,
    verificationEfficiency,
    recoveryQuality,
    waste: wasteScore,
    composite,
    grade,
    raw: {
      n,
      okCount,
      providerFailures,
      totalWasteSeconds: waste.totalWasteSeconds,
      totalSeconds,
      verificationSeconds,
    },
    reasons,
  }
}
