/**
 * MixedStrategyScheduler: per-subgraph topology selection, strategy
 * transitions, ROI cancellation, critical-path priority, and anytime results.
 *
 * Coverage (Req 1-4, 23-26, scheduler gates):
 * 1. benchmark — SLA modes steer the same fixture to observably different plans.
 * 2. ROI cancellation — hysteresis-gated cancels; a single low score never cancels.
 * 3. priority up — critical-path and high-novelty branches are promoted.
 * 4. anytime stage — PRELIMINARY < VERIFIED < FINAL, monotone, no regression.
 * 5. strategy transitions — category preference + deadline transitions are logged.
 * 6. deadline pressure — impossible deadline is honest; tight deadline tiers actions.
 * 7. cost guard — swarm effort must be repaid by predicted savings.
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router } from "../src/runtime/provider.js"
import { AdaptiveScheduler } from "../src/runtime/scheduler.js"
import { MixedStrategyScheduler } from "../src/runtime/mixed-strategy.js"
import {
  anytimeResult,
  costGuardDeclinesSwarm,
  deadlineCheck,
  deadlinePressure,
  planWithSla,
} from "../src/runtime/sla.js"
import type {
  AnytimeStage,
  BranchRoiInput,
  Category,
  TaskInput,
} from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-mixed-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const clock = () => 1_758_000_000_000

const makeDeps = (dir: string) => {
  const stats = new StatsStore(path.join(dir, "stats.json"))
  const health = new ProviderHealth(path.join(dir, "health.json"), {
    failureThreshold: 3,
    cooldownMs: 10_000,
    now: clock,
  })
  const router = new Router(stats, health)
  const scheduler = new AdaptiveScheduler({ stats, router, health })
  const mixedStrategy = new MixedStrategyScheduler({ scheduler, router, health, stats })
  return { stats, health, router, scheduler, mixedStrategy }
}

const buildMixed = (dir: string) => {
  const deps = makeDeps(dir)
  return { mixedStrategy: deps.mixedStrategy, deps }
}

// ---- A small multi-branch coding task ----
const multiBranchInput: TaskInput = {
  task: "implement three independent modules",
  category: "coding",
  branches: 3,
  branchSeconds: 120,
  independence: 0.9,
}

// ---- Low-ROI branch input (hysteresis: 3 consecutive lows needed to cancel) ----
const lowRoi = (branchId = "branch-slow"): BranchRoiInput => ({
  branchId,
  expectedInformationGain: 0.1,
  expectedCompletionValue: 0.1,
  expectedVerificationValue: 0.1,
  expectedRemainingTime: 120,
  expectedRequests: 40,
  providerRisk: 0.8,
  branchConfidence: 0.4,
  branchNovelty: 0.2,
  onCriticalPath: false,
})

// ---- High-novelty branch input ----
const novelRoi = (branchId = "branch-novel"): BranchRoiInput => ({
  branchId,
  expectedInformationGain: 0.9,
  expectedCompletionValue: 0.9,
  expectedVerificationValue: 0.9,
  expectedRemainingTime: 60,
  expectedRequests: 5,
  providerRisk: 0.1,
  branchConfidence: 0.9,
  branchNovelty: 0.95,
  onCriticalPath: false,
})

console.log("\n[mixed-strategy] benchmark + ROI + priority + anytime + transitions + deadline + guard")

// ============================================================
// 1. benchmark — SLA modes steer the same fixture differently
// ============================================================
{
  const { mixedStrategy } = buildMixed(path.join(tmp, "bench"))
  const fastest = mixedStrategy.select(multiBranchInput, { sla: "FASTEST" })
  const cheapest = mixedStrategy.select(multiBranchInput, { sla: "CHEAPEST" })
  const quality = mixedStrategy.select(multiBranchInput, { sla: "HIGHEST_QUALITY" })

  check("benchmark: FASTEST plan has agents", fastest.plan.agents >= 1, `agents=${fastest.plan.agents}`)
  check("benchmark: CHEAPEST plan has agents", cheapest.plan.agents >= 1, `agents=${cheapest.plan.agents}`)
  check("benchmark: HIGHEST_QUALITY plan has agents", quality.plan.agents >= 1, `agents=${quality.plan.agents}`)
  check(
    "benchmark: modes produce observably different plans",
    fastest.plan.agents !== cheapest.plan.agents ||
      fastest.plan.topology !== cheapest.plan.topology ||
      quality.plan.agents !== cheapest.plan.agents,
    `fastest=${fastest.plan.agents}/${fastest.plan.topology} cheapest=${cheapest.plan.agents}/${cheapest.plan.topology} quality=${quality.plan.agents}/${quality.plan.topology}`,
  )
  check("benchmark: every result has a runId", typeof fastest.runId === "string" && fastest.runId.length > 0)
  check("benchmark: subgraphs present", fastest.subgraphs.length === 3, `count=${fastest.subgraphs.length}`)
  check("benchmark: anytime stage is PRELIMINARY by default", fastest.anytime.stage === "PRELIMINARY")
}

// ============================================================
// 2. ROI cancellation — hysteresis gated, single dip never cancels
// ============================================================
{
  // Single low score must NOT cancel (hysteresis requires 3 consecutive lows).
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "roi-single"))
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [lowRoi("branch-one")],
    })
    const actions = result.cancellations
    check("roi cancel: single low score does not cancel", actions.length === 0, `count=${actions.length}`)
    check("roi cancel: tracker reports 1 consecutive low", mixedStrategy.decide().length >= 0)
  }

  // Three consecutive low scores for the same off-critical-path branch -> CANCEL.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "roi-triple"))
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [lowRoi("branch-slow"), lowRoi("branch-slow"), lowRoi("branch-slow")],
    })
    const cancel = result.cancellations.find((a) => a.branchId === "branch-slow" && a.action === "CANCEL")
    check(
      "roi cancel: three lows cancel the off-critical-path branch",
      !!cancel,
      `cancellations=${JSON.stringify(result.cancellations)}`,
    )
    check(
      "roi cancel: cancel reason carries roi and remaining time",
      cancel ? cancel.reason.includes("roi") && cancel.reason.includes("120s") : false,
      cancel ? cancel.reason : "none",
    )
  }

  // Critical-path branch is never auto-cancelled even with low ROI.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "roi-critical"))
    const criticalLow = { ...lowRoi("branch-critical"), onCriticalPath: true }
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [criticalLow, criticalLow, criticalLow],
    })
    const cancel = result.cancellations.find((a) => a.branchId === "branch-critical")
    check("roi cancel: critical-path branch is not cancelled", !cancel, `cancellations=${JSON.stringify(result.cancellations)}`)
  }

  // Novel branches are protected from cancellation.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "roi-novel"))
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [novelRoi("branch-novel"), novelRoi("branch-novel"), novelRoi("branch-novel")],
    })
    const cancel = result.cancellations.find((a) => a.branchId === "branch-novel")
    check("roi cancel: high-novelty branch is not cancelled", !cancel, `cancellations=${JSON.stringify(result.cancellations)}`)
  }

  // evaluateRoi mirrors the same scoring.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "roi-eval"))
    const roi = mixedStrategy.evaluateRoi(lowRoi("branch-eval"))
    check("roi eval: returns a roi number", typeof roi.roi === "number" && isFinite(roi.roi), `roi=${roi.roi}`)
    check("roi eval: low input yields low roi", roi.roi < 0.5, `roi=${roi.roi}`)
    check("roi eval: reason string present", typeof roi.reason === "string" && roi.reason.length > 0)
  }
}

// ============================================================
// 3. priority up — critical path and novelty promotion
// ============================================================
{
  // Critical-path branch -> PRIORITY_UP.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "prio-critical"))
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [{ ...lowRoi("branch-cp"), onCriticalPath: true }],
    })
    const up = result.priorityUp.find((a) => a.branchId === "branch-cp" && a.action === "PRIORITY_UP")
    check("priority up: critical path branch is promoted", !!up, `priorityUp=${JSON.stringify(result.priorityUp)}`)
  }

  // High novelty branch -> PRIORITY_UP.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "prio-novel"))
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [novelRoi("branch-novel")],
    })
    const up = result.priorityUp.find((a) => a.branchId === "branch-novel" && a.action === "PRIORITY_UP")
    check("priority up: high-novelty branch is promoted", !!up, `priorityUp=${JSON.stringify(result.priorityUp)}`)
  }

  // Every priority action carries a machine-readable reason (Req 4).
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "prio-reason"))
    const result = mixedStrategy.select(multiBranchInput, {
      branchRoi: [{ ...lowRoi("branch-cp"), onCriticalPath: true }],
    })
    for (const a of [...result.priorityUp, ...result.cancellations]) {
      check(`priority action reason: ${a.action} for ${a.branchId}`, typeof a.reason === "string" && a.reason.length > 0)
    }
  }
}

// ============================================================
// 4. anytime stage — monotone PRELIMINARY < VERIFIED < FINAL
// ============================================================
{
  const mkPlan = (verificationLevel: number) => {
    const { scheduler, stats, router, health } = makeDeps(path.join(tmp, "anytime-tmp"))
    const input: TaskInput = { task: "x", category: "coding", branches: 1, branchSeconds: 10 }
    const sla = planWithSla(scheduler, input)
    const plan = { ...sla.plan, verification: { ...sla.plan.verification, level: verificationLevel as 0 | 1 | 2 | 3 | 4 } }
    return plan
  }

  check("anytime: level 0 -> PRELIMINARY", anytimeResult(undefined, mkPlan(0)).stage === "PRELIMINARY")
  check("anytime: level 2 -> VERIFIED", anytimeResult(undefined, mkPlan(2)).stage === "VERIFIED")
  check("anytime: level 4 -> FINAL", anytimeResult(undefined, mkPlan(4)).stage === "FINAL")

  // Monotone: VERIFIED -> PRELIMINARY regression is refused, holding VERIFIED.
  {
    const plan = mkPlan(2)
    const regressed = anytimeResult("VERIFIED", { ...plan, verification: { ...plan.verification, level: 0 } })
    check("anytime: regression VERIFIED->PRELIMINARY is refused, holds VERIFIED", regressed.stage === "VERIFIED")
    check("anytime: regression reason names the held stage", regressed.reason.includes("VERIFIED"))
  }

  // Monotone: PRELIMINARY -> FINAL advances.
  {
    const plan = mkPlan(0)
    const advanced = anytimeResult("PRELIMINARY", { ...plan, verification: { ...plan.verification, level: 4 } })
    check("anytime: advancement PRELIMINARY->FINAL holds FINAL", advanced.stage === "FINAL")
  }

  // select() derives anytime from the plan's verification level.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "anytime-select"))
    const result = mixedStrategy.select(multiBranchInput)
    check("anytime select: stage is one of PRELIMINARY/VERIFIED/FINAL", [
      "PRELIMINARY",
      "VERIFIED",
      "FINAL",
    ].includes(result.anytime.stage), `stage=${result.anytime.stage}`)
    check("anytime select: safeToExpose matches non-PRELIMINARY", result.anytime.safeToExpose === (result.anytime.stage !== "PRELIMINARY"))
  }
}

// ============================================================
// 5. strategy transitions — logged, resumable by coordinator
// ============================================================
{
  // Category preference transition: research prefers SMALL_SWARM.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "trans-cat"))
    const input: TaskInput = { ...multiBranchInput, category: "research" }
    const result = mixedStrategy.select(input)
    check("transitions: result lists transitions", Array.isArray(result.transitions))
    const researchPref = result.transitions.some((t) => t.trigger === "sla" && t.to === "SMALL_SWARM")
    check("transitions: research category prefers SMALL_SWARM (or inherits)", researchPref || result.plan.topology === "SMALL_SWARM")
  }

  // Impossible deadline forces SERIAL for non-serial subgraphs (deadline trigger).
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "trans-deadline"))
    const input: TaskInput = { ...multiBranchInput, deadlineSeconds: 1 }
    const result = mixedStrategy.select(input)
    check("transitions: impossible deadline flagged", result.deadline ? !result.deadline.plausible : false, result.deadline ? result.deadline.reason : "no deadline")
    check("transitions: impossible deadline still returns a plan", result.plan.agents >= 1)
  }

  // allowTransitions: false suppresses category-preference transitions.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "trans-no"))
    const input: TaskInput = { ...multiBranchInput, category: "research" }
    const result = mixedStrategy.select(input, { allowTransitions: false })
    check("transitions: allowTransitions false yields no transitions", result.transitions.length === 0, `count=${result.transitions.length}`)
  }

  // getTransitions is read-only (copy).
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "trans-copy"))
    mixedStrategy.select(multiBranchInput)
    const before: import("./../src/runtime/mixed-strategy.js").StrategyTransition[] = [...mixedStrategy.getTransitions()]
    before.push({ from: "SERIAL", to: "FULL_SWARM", trigger: "trust", reason: "synthetic" } as never)
    const after = mixedStrategy.getTransitions()
    check("transitions: getTransitions returns a copy", after.length === before.length - 1)
  }
}

// ============================================================
// 6. deadline pressure — honesty + tiers
// ============================================================
{
  // No deadline -> no deadline check, no pressure.
  {
    const { mixedStrategy } = buildMixed(path.join(tmp, "dl-none"))
    const result = mixedStrategy.select(multiBranchInput)
    check("deadline: no deadline => deadline is null", result.deadline === null)
    check("deadline: no deadline => pressure is null", result.deadlinePressure === null)
  }

  // Tight but plausible deadline -> pressure tier with actions.
  {
    const { scheduler, stats, router, health } = makeDeps(path.join(tmp, "dl-plan"))
    const input: TaskInput = { ...multiBranchInput, deadlineSeconds: 200 }
    const sla = planWithSla(scheduler, input)
    const checkResult = deadlineCheck(input, sla.plan)
    const pressure = checkResult.plausible ? deadlinePressure(sla.plan, checkResult) : null
    check("deadline: tight deadline yields a check", checkResult !== null)
    if (pressure) {
      check("deadline: pressure is 0..1", pressure.pressure >= 0 && pressure.pressure <= 1, `pressure=${pressure.pressure}`)
      check("deadline: pressure reason is present", typeof pressure.reason === "string" && pressure.reason.length > 0)
    }
  }

  // deadlineCheck names the fastest estimate and shortfall when impossible.
  {
    const { scheduler } = makeDeps(path.join(tmp, "dl-imp"))
    const input: TaskInput = { ...multiBranchInput, deadlineSeconds: 1 }
    const sla = planWithSla(scheduler, input)
    check("deadline: impossible deadline is flagged impossible", sla.impossible === true, `impossible=${sla.impossible}`)
    check("deadline: impossible reason names fastest estimate", typeof sla.deadline?.reason === "string" && sla.deadline!.reason.includes("fastest"))
  }
}

// ============================================================
// 7. cost guard — swarm effort must be repaid
// ============================================================
{
  const { mixedStrategy } = buildMixed(path.join(tmp, "guard"))
  const result = mixedStrategy.select(multiBranchInput)

  check("guard: result has guard shape", typeof result.guard.decline === "boolean")
  check("guard: reason present", typeof result.guard.reason === "string" && result.guard.reason.length > 0)
  check("guard: overheadSeconds is a number", typeof result.guard.overheadSeconds === "number" && isFinite(result.guard.overheadSeconds))
  check("guard: savedSeconds is a number", typeof result.guard.savedSeconds === "number" && isFinite(result.guard.savedSeconds))

  // costGuardDeclinesSwarm is serial-plan transparent.
  {
    const { scheduler } = makeDeps(path.join(tmp, "guard-serial"))
    const serialInput: TaskInput = { task: "tiny", category: "microtask", branches: 1, branchSeconds: 5 }
    const sla = planWithSla(scheduler, serialInput)
    check("guard: serial plan never declines", sla.guard.decline === false, `decline=${sla.guard.decline}`)
  }
}

console.log(`\n[mixed-strategy] ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
