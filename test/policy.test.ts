/**
 * Deterministic policy benchmarks A-I for the adaptive scheduler.
 *
 * These are not wall-clock agent benchmarks. They pin the cost model's decisions
 * so a regression that starts swarming microtasks, ignores warm lanes, picks a
 * dependent fan-out instead of a pipeline, or judges every task fails CI.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router, type RouterOptions } from "../src/runtime/provider.js"
import { LanePool } from "../src/runtime/lanes.js"
import { AdaptiveScheduler } from "../src/runtime/scheduler.js"
import { chooseVerification } from "../src/runtime/verify.js"
import type { ModelProfile, Observation, TaskInput } from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-policy-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const scheduler = (opts: {
  stats?: StatsStore
  profiles?: ModelProfile[]
  router?: RouterOptions
  config?: ConstructorParameters<typeof AdaptiveScheduler>[0]["config"]
  lanes?: LanePool
} = {}) => {
  const stats = opts.stats ?? new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health, opts.router)
  return { scheduler: new AdaptiveScheduler({ stats, router, health, lanes: opts.lanes, config: opts.config }), stats, health, router }
}

const fullAlt = (p: ReturnType<AdaptiveScheduler["plan"]>) => p.alternatives.find((a) => a.topology === "FULL_SWARM")

// A. Eight 20s microtasks: serial wins on planning/startup, not on ideology.
{
  const { scheduler: s } = scheduler()
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, seconds: 20 }))
  const p = s.plan({ task: "rename variables in eight small files", tasks })
  check("A: microtasks stay serial", p.topology === "SERIAL" && p.agents === 1, `${p.topology}/${p.agents}`)
  check("A: serial is honestly cheaper", p.estimates.swarm > p.estimates.chosen, `${p.estimates.swarm} vs ${p.estimates.chosen}`)
  check("A: no fake speedup", p.estimates.speedup === 1)
  check("A: explanation names the alternative cost", p.reasons.some((r) => /Stayed serial/.test(r) && /predicted/.test(r)))
}

// B. The 60-120s crossover: 60s work stays serial, 90s+ pays for lanes.
{
  const { scheduler: s } = scheduler()
  const p60 = s.plan({ task: "inspect four small modules", branches: 4, branchSeconds: 60 })
  const p90 = s.plan({ task: "inspect four modules", branches: 4, branchSeconds: 90 })
  const p120 = s.plan({ task: "inspect four larger modules", branches: 4, branchSeconds: 120 })
  check("B: 4x60s stays serial", p60.topology === "SERIAL" && p60.estimates.speedup === 1, p60.topology)
  check("B: 4x90s crosses to a swarm", p90.topology !== "SERIAL" && p90.estimates.speedup > 1.2, `${p90.topology} x${p90.estimates.speedup}`)
  check("B: 4x120s swarm beats the crossover", p120.estimates.speedup > p90.estimates.speedup, `${p120.estimates.speedup} vs ${p90.estimates.speedup}`)
  check("B: crossover is not caused by more agents", p60.agents === 1 && p90.agents === p120.agents)
}

// C. 8-12 independent long tasks: fan-out is worth it, but still capped by quota.
{
  const { scheduler: s } = scheduler()
  const p = s.plan({
    task: "implement nine independent modules with tests",
    branches: 9,
    branchSeconds: 480,
    independence: 0.95,
    sharedContext: 0.15,
  })
  check("C: long independent work swarms", p.topology === "FULL_SWARM" || p.topology === "SMALL_SWARM", p.topology)
  check("C: speedup is material", p.estimates.speedup >= 1.5, `x${p.estimates.speedup}`)
  check("C: lanes are capped, not one per branch", p.agents < 9 && p.agents <= 6, `agents=${p.agents}`)
  check("C: extra branches are reported as waves", p.waves >= 2 && p.warnings.some((w) => /wave/.test(w)))
  check("C: parallel efficiency is below 1", p.estimates.parallelEfficiency < 1 && p.estimates.parallelEfficiency > 0)
}

// D. Ambiguous engineering at a low quality weight: ambiguity is priced, not
// feared. Covering every branch is cheaper than hedging, so speculation is
// rejected on cost rather than banned. H is the same shape where hedging pays.
{
  const { scheduler: s } = scheduler()
  const p = s.plan({
    task: "root cause an ambiguous intermittent production bug",
    branches: 3,
    branchSeconds: 600,
    ambiguity: 0.85,
    risk: 0.6,
    verificationValue: 0.6,
    qualityWeight: 0.25,
  })
  const two = s.plan({
    task: "root cause an ambiguous intermittent production bug",
    branches: 2,
    branchSeconds: 600,
    ambiguity: 0.85,
    risk: 0.6,
    verificationValue: 0.6,
    qualityWeight: 0.5,
  })
  const specAlt = p.alternatives.find((a) => a.topology === "SPECULATIVE_SWARM")
  check("D: ambiguity alone does not force speculation", p.topology === "FULL_SWARM", p.topology)
  check("D: every ambiguous branch still gets its own lane", p.agents === 3, `agents=${p.agents}`)
  check("D: speculation is still priced, not suppressed", specAlt !== undefined, "no speculative alternative reported")
  check(
    "D: the rejected speculation costs more than the chosen plan",
    (specAlt?.seconds ?? 0) > p.estimates.chosen,
    `${specAlt?.seconds} vs ${p.estimates.chosen}`,
  )
  check(
    "D: two branches only ever fan out fully",
    two.topology === "FULL_SWARM" && two.agents === 2,
    `${two.topology}/${two.agents}`,
  )
  check("D: the chosen fan-out still clears the speedup bar", p.estimates.speedup >= 1.08, `x${p.estimates.speedup}`)
}

// E. Provider failure: the open circuit is skipped and a healthy model is routed.
{
  const primary: ModelProfile = {
    id: "primary-model",
    provider: "primary",
    quotaGroup: "primary",
    quality: 0.8,
    speed: 0.9,
    contextLimit: 200_000,
    costTier: 0,
    strengths: ["coding", "tools", "bulk", "research", "analysis", "verification"],
  }
  const backup: ModelProfile = { ...primary, id: "backup-model", provider: "backup", quality: 0.6, speed: 0.7, costTier: 1 }
  const health = new ProviderHealth(null, { failureThreshold: 2, cooldownMs: 60_000 })
  const stats = new StatsStore(null)
  const router = new Router(stats, health, { profiles: [primary, backup], quotaGroups: { primary: { maxConcurrent: 6 }, backup: { maxConcurrent: 4 } } })
  health.record("primary", "429")
  health.record("primary", "429")
  const s = new AdaptiveScheduler({ stats, router, health })
  const p = s.plan({ task: "fix the parser and add tests", branches: 4, branchSeconds: 180 })
  check("E: failed provider circuit is open", health.state("primary") === "open")
  check("E: plan routes to the healthy backup", p.models[0] === "backup-model", p.models.join(","))
  check("E: blocked provider is named", p.warnings.some((w) => /primary.*circuit open|circuit open/.test(w)))
  check("E: backup quota caps the plan", p.agents <= 4, `agents=${p.agents}`)
  check("E: plan still produces a topology", p.topology.length > 0 && p.estimates.chosen > 0)
}

// F. Cold vs warm: a compatible idle lane lowers startup and planning costs.
{
  const stats = new StatsStore(null)
  const base: Omit<Observation, "warm" | "startupSeconds"> = {
    ts: Date.now(),
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
    role: "coder",
    category: "coding",
    workSeconds: 300,
    totalSeconds: 360,
    status: "ok",
    tokensIn: 12_000,
    tokensOut: 1_500,
  }
  for (let i = 0; i < 6; i++) {
    stats.add({ ...base, warm: true, startupSeconds: 15 })
    stats.add({ ...base, warm: false, startupSeconds: 60 })
  }
  const cold = scheduler({ stats }).scheduler.plan({ task: "implement four modules", branches: 4, branchSeconds: 300 })
  const lanes = new LanePool(path.join(tmp, "policy-lanes.json"))
  lanes.register({
    sessionID: "ses_policy_warm",
    role: "coder",
    model: "mimo-v2.6-flash-free",
    provider: "opencode",
    category: "coding",
  })
  const warm = scheduler({ stats, lanes }).scheduler.plan({ task: "implement four modules", branches: 4, branchSeconds: 300 })
  check("F: warm plan uses a compatible lane", warm.reasons.some((r) => /Warm lane estimated startup/.test(r)))
  check("F: warm startup is cheaper", warm.estimates.startupCost < cold.estimates.startupCost, `${warm.estimates.startupCost} vs ${cold.estimates.startupCost}`)
  check("F: warm planning is cheaper", warm.estimates.planningCost < cold.estimates.planningCost, `${warm.estimates.planningCost} vs ${cold.estimates.planningCost}`)
  check("F: warm plan is faster end to end", warm.estimates.chosen < cold.estimates.chosen, `${warm.estimates.chosen} vs ${cold.estimates.chosen}`)
  check("F: same topology, lower cost", warm.topology === cold.topology)
}

// G. Ten lanes vs two batched workers vs serial, with a 12-lane quota.
{
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, seconds: 30 }))
  const { scheduler: free } = scheduler({
    router: { quotaGroups: { "opencode-free": { maxConcurrent: 12 } } },
    config: { maxAgents: 10 },
  })
  const p = free.plan({ task: "process ten short independent checks", tasks })
  const batch2 = p.alternatives.find((a) => a.topology === "BATCHED_WORKER" && a.agents === 2)
  const full10 = p.alternatives.find((a) => a.topology === "FULL_SWARM" && a.agents === 10)
  check("G: batching is chosen over ten lanes", p.topology === "BATCHED_WORKER" && p.agents < 10, `${p.topology}/${p.agents}`)
  check("G: chosen batch beats serial", p.estimates.chosen < p.estimates.serial, `${p.estimates.chosen} vs ${p.estimates.serial}`)
  check("G: full ten-lane plan is present and legal", !!full10 && full10.agents === 10)
  check("G: two batches beat ten lanes", !!batch2 && !!full10 && batch2.seconds < full10.seconds, `${batch2?.seconds} vs ${full10?.seconds}`)
  check("G: two batches also beat serial", !!batch2 && batch2.seconds < p.estimates.serial)
  const two = scheduler({ config: { maxAgents: 2 } }).scheduler.plan({ task: "process ten short independent checks", tasks })
  check("G: a two-worker cap chooses two batches", two.topology === "BATCHED_WORKER" && two.agents === 2, `${two.topology}/${two.agents}`)
  check("G: two batches pack all ten tasks", two.batches.flatMap((b) => b.taskIds).length === 10)
}

// H. Full fan-out vs two-explorer speculative: fewer workers, explicit trade-off.
{
  const { scheduler: s } = scheduler()
  const input: TaskInput = {
    task: "investigate three plausible root causes for a rare failure",
    branches: 3,
    branchSeconds: 600,
    ambiguity: 0.85,
    risk: 0.6,
    verificationValue: 0.6,
    qualityWeight: 0.5,
  }
  const p = s.plan(input)
  const full = fullAlt(p)
  check("H: speculative beats full fan-out for ambiguous work", p.topology === "SPECULATIVE_SWARM", p.topology)
  check("H: speculative uses two workers instead of three", p.agents === 2 && full?.agents === 3)
  check("H: full fan-out is faster in raw wall clock", !!full && full.seconds < p.estimates.chosen)
  check("H: speculative is selected for measured downside", p.reasons.some((r) => /Downside protection/.test(r)))
  check("H: no bogus wave warning for conditional expansion", !p.warnings.some((w) => /branches exceed/.test(w)))
  const serial = s.plan({ ...input, ambiguity: 0.2, risk: 0.2, qualityWeight: 0 })
  check("H: without ambiguity/risk, speculative is not chosen", serial.topology !== "SPECULATIVE_SWARM", serial.topology)
}

// I. Always-judge vs adaptive verification: trivial skips, hard escalates.
{
  const { scheduler: s } = scheduler()
  const trivial = s.plan({ task: "rename a local variable", branches: 1, branchSeconds: 8 })
  const hard = s.plan({
    task: "rewrite the billing ledger with a disputed spec",
    branches: 2,
    branchSeconds: 300,
    confidence: 0.4,
    disagreement: 0.8,
    risk: 0.9,
    verificationValue: 0.9,
  })
  const alwaysJudge = chooseVerification({ level: 4, judgeAvailable: true, workSeconds: 300 })
  // A uniform always-judge policy: the same two tasks, escalated to V4 with a
  // judge regardless of need (the strong signals that would hold V4 open).
  const alwaysTrivial = chooseVerification({
    level: 4,
    judgeAvailable: true,
    workSeconds: 8,
    risk: 0.9,
    disagreement: 0.8,
    confidence: 0.4,
  })
  const alwaysHard = chooseVerification({
    level: 4,
    judgeAvailable: true,
    workSeconds: 600,
    risk: 0.9,
    disagreement: 0.8,
    confidence: 0.4,
  })
  const mid = s.plan({
    task: "refactor a module with one unresolved spec question",
    branches: 2,
    branchSeconds: 300,
    confidence: 0.72,
    disagreement: 0.3,
    risk: 0.45,
    verificationValue: 0.5,
  })
  check("I: trivial work does not judge", trivial.verification.level <= 1 && !trivial.verification.judgeAllowed, `V${trivial.verification.level}`)
  check("I: trivial verification is cheap", trivial.verification.estimatedCost < alwaysJudge.estimatedCost, `${trivial.verification.estimatedCost} vs ${alwaysJudge.estimatedCost}`)
  check("I: hard work escalates to V4", hard.verification.level === 4 && hard.verification.judgeAllowed, `V${hard.verification.level}`)
  check("I: hard work names the disputed judge step", hard.verification.steps.some((x) => /judge only/.test(x)))
  check(
    "I: a blanket V4 request is capped by the judge-addiction gate",
    alwaysJudge.level === 2 && !alwaysJudge.judgeAllowed && /judge cost outweighed/.test(alwaysJudge.skipReason ?? ""),
    `V${alwaysJudge.level}`,
  )
  check(
    "I: mid-confidence work is verified without a judge",
    mid.verification.level === 3 && !mid.verification.judgeAllowed && mid.verification.estimatedCost < hard.verification.estimatedCost,
    `V${mid.verification.level}/${mid.verification.estimatedCost}`,
  )
  check(
    "I: adaptive spend beats a uniform always-judge policy",
    trivial.verification.estimatedCost + hard.verification.estimatedCost < alwaysTrivial.estimatedCost + alwaysHard.estimatedCost,
    `${trivial.verification.estimatedCost + hard.verification.estimatedCost} vs ${alwaysTrivial.estimatedCost + alwaysHard.estimatedCost}`,
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
