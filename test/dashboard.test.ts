/**
 * Dashboards and grades (Req 41-45).
 *
 * calibrationDashboard compares predicted vs actual serial/swarm time plus
 * confidence calibration. schedulerDashboard reports decision mix, strategy
 * correctness, speedup percentiles, warm-lane hit rate, provider recoveries.
 * wasteBreakdown sums wasted work across completed-run actuals.
 * multiDimensionGrade composites correctness, speed, prediction accuracy,
 * worker/provider/verification efficiency, recovery quality, and waste.
 *
 * All dashboard functions are pure over their inputs — they read, never
 * mutate — so dashboards are safe to render on any schedule.
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth } from "../src/runtime/provider.js"
import { Telemetry } from "../src/runtime/telemetry.js"
import { RunHistory } from "../src/runtime/history.js"
import {
  calibrationDashboard,
  schedulerDashboard,
  wasteBreakdown,
  multiDimensionGrade,
} from "../src/runtime/dashboards.js"
import type { CompletedRun, RunActuals } from "../src/runtime/types.js"

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++
    console.log(`[PASS] ${name}`)
  } else {
    fail++
    console.log(`[FAIL] ${name}${detail ? ` - ${detail}` : ""}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-dash-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// ---- Req 41: calibration dashboard ----
{
  const stats = new StatsStore(null)
  const history = new RunHistory(null)

  const empty = calibrationDashboard(stats, history)
  check("empty history: n is 0", empty.n === 0)
  check("empty history: serial MAE is 0", empty.serialTimeMae === 0)
  check("empty history: swarm MAE is 0", empty.swarmTimeMae === 0)
  check("empty history: speedup MAE is 0", empty.speedupMae === 0)
  check("empty history: biases are 0", empty.serialTimeBias === 0 && empty.swarmTimeBias === 0)
  check("empty history: confidence calibration has buckets", Array.isArray(empty.confidenceCalibration.buckets))

  history.add({
    ts: 1000,
    runId: "run_a",
    shape: "medium_branch",
    category: "coding",
    topology: "SERIAL",
    agents: 1,
    predictedSerialSeconds: 100,
    predictedChosenSeconds: 80,
    actualSeconds: 90,
    status: "ok",
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
  })
  history.add({
    ts: 2000,
    runId: "run_b",
    shape: "large_parallel",
    category: "research",
    topology: "SMALL_SWARM",
    agents: 3,
    predictedSerialSeconds: 200,
    predictedChosenSeconds: 150,
    actualSeconds: 180,
    status: "ok",
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
  })

  const cal = calibrationDashboard(stats, history)
  check("calibration n is 2", cal.n === 2)
  // serial errors: |90-100|=10, |180-200|=20 -> MAE 15
  check("serialTimeMae === 15", cal.serialTimeMae === 15, `got ${cal.serialTimeMae}`)
  // swarm errors: |90-80|=10, |180-150|=30 -> MAE 20
  check("swarmTimeMae === 20", cal.swarmTimeMae === 20, `got ${cal.swarmTimeMae}`)
  // speedup errors: |100/90-100/80|≈0.139, |200/180-200/150|≈0.222 -> MAE≈0.18
  check("speedupMae ≈ 0.18", cal.speedupMae === 0.18, `got ${cal.speedupMae}`)
  // serial bias: median(90/100-1, 180/200-1) = median(-0.1, -0.1) = -0.1
  check("serialTimeBias === -0.1", cal.serialTimeBias === -0.1, `got ${cal.serialTimeBias}`)
  // swarm bias: nearest-rank median of [0.125, 0.2] = 0.125
  check("swarmTimeBias === 0.125", cal.swarmTimeBias === 0.125, `got ${cal.swarmTimeBias}`)
}

// ---- Req 42: scheduler dashboard ----
{
  const stats = new StatsStore(null)
  const history = new RunHistory(null)
  const tel = new Telemetry(null, { now: () => 1000 })

  const empty = schedulerDashboard(tel, stats, history)
  check("empty: runs is 0", empty.runs === 0)
  check("empty: correctStrategyRate is 0", empty.correctStrategyRate === 0)
  check("empty: averageSpeedup is 0", empty.averageSpeedup === 0)
  check("empty: warmLaneHitRate is 0", empty.warmLaneHitRate === 0)
  check("empty: providerRecoveries is 0", empty.providerRecoveries === 0)

  history.add({
    ts: 1000,
    runId: "run_a",
    shape: "medium_branch",
    category: "coding",
    topology: "SERIAL",
    agents: 1,
    predictedSerialSeconds: 100,
    predictedChosenSeconds: 80,
    actualSeconds: 90,
    status: "ok",
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
  })
  history.add({
    ts: 2000,
    runId: "run_b",
    shape: "large_parallel",
    category: "research",
    topology: "SMALL_SWARM",
    agents: 3,
    predictedSerialSeconds: 200,
    predictedChosenSeconds: 150,
    actualSeconds: 180,
    status: "ok",
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
  })

  const sch = schedulerDashboard(tel, stats, history)
  check("scheduler runs is 2", sch.runs === 2)
  check("one serial decision", sch.serialDecisions === 1)
  check("one swarm decision", sch.swarmDecisions === 1)
  // run_a SERIAL: 90 <= 100*1.1=110 -> correct. run_b SWARM: 180 <= 150*1.1=165? no -> not correct.
  check("correctStrategyRate === 0.5", sch.correctStrategyRate === 0.5, `got ${sch.correctStrategyRate}`)
  // averageSpeedup = (100/90 + 200/180)/2 = (1.111 + 1.111)/2 = 1.11
  check("averageSpeedup ≈ 1.11", sch.averageSpeedup === 1.11, `got ${sch.averageSpeedup}`)
  check("medianSpeedup ≈ 1.11", sch.medianSpeedup === 1.11, `got ${sch.medianSpeedup}`)
}

// ---- Req 43: waste breakdown ----
{
  const empty = wasteBreakdown([])
  check("empty: totalWasteSeconds is 0", empty.totalWasteSeconds === 0)
  check("empty: all buckets 0", empty.duplicateWorkSeconds === 0 && empty.failedWorkSeconds === 0)

  const actuals: RunActuals[] = [
    { runId: "a", actualSeconds: 100, duplicateWorkSeconds: 10, failedWorkSeconds: 5 },
    { runId: "b", actualSeconds: 200, cancelledWorkSeconds: 20, unusedSpeculativeSeconds: 15 },
    { runId: "c", actualSeconds: 300, excessVerificationSeconds: 30, providerRetryWasteSeconds: 10, contextReloadWasteSeconds: 5 },
  ]
  const wb = wasteBreakdown(actuals)
  check("duplicateWorkSeconds === 10", wb.duplicateWorkSeconds === 10)
  check("cancelledWorkSeconds === 20", wb.cancelledWorkSeconds === 20)
  check("failedWorkSeconds === 5", wb.failedWorkSeconds === 5)
  check("unusedSpeculativeSeconds === 15", wb.unusedSpeculativeSeconds === 15)
  check("excessVerificationSeconds === 30", wb.excessVerificationSeconds === 30)
  check("providerRetryWasteSeconds === 10", wb.providerRetryWasteSeconds === 10)
  check("contextReloadWasteSeconds === 5", wb.contextReloadWasteSeconds === 5)
  // total = 10+20+5+15+30+10+5 = 95
  check("totalWasteSeconds === 95", wb.totalWasteSeconds === 95, `got ${wb.totalWasteSeconds}`)
}

// ---- Req 44-45: multi-dimension grade ----
{
  const okActuals: RunActuals[] = [
    { runId: "a", actualSeconds: 100, status: "ok", workers: 2, usefulWorkers: 2, wastedWorkers: 0, verificationSeconds: 10, quality: 0.9, targetQuality: 1.0 },
    { runId: "b", actualSeconds: 200, status: "ok", workers: 3, usefulWorkers: 3, wastedWorkers: 0, verificationSeconds: 20, quality: 1.0, targetQuality: 1.0 },
  ]
  const g = multiDimensionGrade(okActuals)
  check("correctness === 1 (all ok)", g.correctness === 1)
  check("workerEfficiency === 1 (no waste)", g.workerEfficiency === 1)
  check("providerEfficiency === 1 (no failures)", g.providerEfficiency === 1)
  check("grade is A-F letter", ["A", "B", "C", "D", "F"].includes(g.grade))
  check("composite is 0..100", g.composite >= 0 && g.composite <= 100)
  check("reasons non-empty", g.reasons.length > 0)
  check("raw has n=2", g.raw.n === 2)

  // error run drags correctness and provider efficiency down
  const mixedActuals: RunActuals[] = [
    { runId: "a", actualSeconds: 100, status: "ok", workers: 2, usefulWorkers: 2, wastedWorkers: 0, verificationSeconds: 0 },
    { runId: "b", actualSeconds: 100, status: "error", workers: 2, usefulWorkers: 0, wastedWorkers: 2, verificationSeconds: 0 },
  ]
  const g2 = multiDimensionGrade(mixedActuals)
  check("correctness === 0.5 (half ok)", g2.correctness === 0.5)
  // workerEfficiency: 1 wasted / 4 total workers = 0.5
  check("workerEfficiency === 0.5 (half wasted)", g2.workerEfficiency === 0.5)
  check("providerEfficiency === 0.5 (one failure)", g2.providerEfficiency === 0.5)

  // recovery opt-in: clean:false halves recovery quality
  const g3 = multiDimensionGrade(okActuals, { recovery: { clean: false } })
  check("recoveryQuality === 0.5 when not clean", g3.recoveryQuality === 0.5)

  // waste opt-in overrides computed waste
  const g4 = multiDimensionGrade(okActuals, { waste: { totalWasteSeconds: 999 } as any })
  check("waste score lowered by injected waste", g4.waste < g.waste)
}

console.log(`\n[dashboard] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
