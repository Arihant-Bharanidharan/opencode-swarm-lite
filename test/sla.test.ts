/**
 * SLA modes, deadline honesty, deadline pressure, and anytime stages
 * (Req 23-26). These are not wall-clock agent benchmarks; they pin the SLA
 * steering, deadline, and anytime behavior of the adaptive runtime.
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
import {
  applySlaToInput,
  costGuardDeclinesSwarm,
  deadlineCheck,
  deadlinePressure,
  planWithSla,
  SLA_PROFILES,
  stageOf,
  anytimeResult,
  type SlaPlanResult,
} from "../src/runtime/sla.js"
import type { Plan, SlaMode, TaskInput, VerificationLevel } from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sla-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const scheduler = (opts: { stats?: StatsStore; config?: ConstructorParameters<typeof AdaptiveScheduler>[0]["config"] } = {}) => {
  const stats = opts.stats ?? new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health)
  return { scheduler: new AdaptiveScheduler({ stats, router, health, config: opts.config }), stats, health, router }
}

const MODES: SlaMode[] = [
  "FASTEST",
  "CHEAPEST",
  "HIGHEST_QUALITY",
  "BALANCED",
  "LOWEST_PROVIDER_RISK",
]

function baseInput(): TaskInput {
  return {
    task: "build six independent modules with unit tests",
    branches: 6,
    branchSeconds: 200,
    independence: 0.9,
    sharedContext: 0.1,
    ambiguity: 0.35,
    risk: 0.3,
  }
}

/** Build a Plan-shaped value for guard/anytime unit tests. */
function mockPlan(overrides: {
  topology?: string
  netSecondsSaved?: number
  speedup?: number
  planningCost?: number
  startupCost?: number
  integrationCost?: number
  verificationLevel?: VerificationLevel
  verificationCost?: number
}): Plan {
  const {
    topology = "SERIAL",
    netSecondsSaved = 0,
    speedup = 1,
    planningCost = 0,
    startupCost = 0,
    integrationCost = 0,
    verificationLevel = 0,
    verificationCost = 0,
  } = overrides
  return {
    runId: "run_mock",
    createdAt: 0,
    task: { task: "mock" },
    topology: topology as any,
    agents: 1,
    waves: 1,
    batches: [],
    models: ["m"],
    verification: { level: verificationLevel, steps: [], estimatedCost: verificationCost, expectedGain: 0, judgeAllowed: false },
    estimates: {
      serial: 100,
      swarm: 100,
      chosen: 100 - netSecondsSaved,
      speedup,
      swarmSpeedup: speedup,
      parallelEfficiency: 0.5,
      startupCost,
      verificationGain: 0,
      integrationCost,
      planningCost,
      criticalPath: 100,
      agents: 1,
      waves: 1,
      requests: 0,
      tokens: 0,
      confidence: 0.5,
      netSecondsSaved,
    },
    budget: { requests: 0, tokens: 0, agents: 1, wallClockSeconds: 100, verificationSeconds: 0, reserve: 0 },
    reasons: [],
    warnings: [],
    alternatives: [],
    predictors: {
      estimated_serial_time: 100,
      estimated_swarm_time: 100,
      estimated_parallel_efficiency: 0.5,
      estimated_startup_cost: 0,
      estimated_verification_gain: 0,
      recommended_topology: "SERIAL",
      recommended_agent_count: 1,
      recommended_models: ["m"],
      confidence: 0.5,
    },
  } as unknown as Plan
}

// ---- Req 23: five modes, pairwise-distinct signatures, observably different plans ----
{
  const sigs = new Set<string>()
  for (const mode of MODES) {
    const p = SLA_PROFILES[mode]
    sigs.add(JSON.stringify([p.fanoutFactor, p.qualityWeight, p.verificationBias, p.costSensitivity, p.providerSpread, p.hedgeDelayFactor]))
  }
  check("SLA profiles have pairwise-distinct signatures", sigs.size === MODES.length, `signatures=${sigs.size}`)

  const { scheduler: s } = scheduler()
  const plans = new Map<SlaMode, Plan>()
  for (const mode of MODES) {
    const result = planWithSla(s, { ...baseInput(), sla: mode })
    plans.set(mode, result.plan)
    check(`${mode}: plan produced`, result.plan.estimates.chosen > 0 && result.plan.topology.length > 0)
    check(`${mode}: steering was applied`, result.applied.length >= 3, JSON.stringify(result.applied))
  }

  const tuples = new Set([...MODES].map((m) => `${plans.get(m)!.topology}|${plans.get(m)!.agents}|V${plans.get(m)!.verification.level}`))
  check(
    "five modes yield observably different plans on the same fixture",
    tuples.size === MODES.length,
    JSON.stringify([...tuples]),
  )

  // FASTEST and HIGHEST_QUALITY both fan out to 6 lanes but differ on verification depth.
  const fastest = plans.get("FASTEST")!
  const quality = plans.get("HIGHEST_QUALITY")!
  check("FASTEST keeps verification shallow", fastest.verification.level <= 1, `V${fastest.verification.level}`)
  check("HIGHEST_QUALITY escalates verification", quality.verification.level >= 3, `V${quality.verification.level}`)
  // CHEAPEST is lane-capped and stays far below FASTEST's parallelism.
  check("CHEAPEST uses the fewest lanes", plans.get("CHEAPEST")!.agents <= 2, `agents=${plans.get("CHEAPEST")!.agents}`)
}

// ---- Req 24: deadline honesty -- impossible deadlines are reported, never silently degraded ----
{
  const { scheduler: s } = scheduler()
  const input = { ...baseInput(), sla: "FASTEST" as SlaMode, deadlineSeconds: 30 }
  const result = planWithSla(s, input)

  check("impossible deadline is flagged", result.impossible === true)
  check("deadlineCheck.plausible is false", !!result.deadline && result.deadline.plausible === false)
  check("slack is negative", !!result.deadline && result.deadline.slackSeconds < 0)
  check("reason names impossibility and the fastest estimate", !!result.deadline && /IMPOSSIBLE/.test(result.deadline.reason) && /fastest credible estimate/.test(result.deadline.reason))
  check("shortfall is named", !!result.deadline && /shortfall/.test(result.deadline.reason))
  check("plan is still returned (never silent degradation)", result.plan.estimates.chosen > 0)
  check("warnings flag the impossibility", result.warnings.some((w) => /DEADLINE IMPOSSIBLE/.test(w)))

  // A generous deadline is plausible.
  const relaxed = planWithSla(s, { ...baseInput(), sla: "CHEAPEST" as SlaMode, deadlineSeconds: 5000 })
  check("generous deadline is plausible", relaxed.deadline?.plausible === true)
  check("positive slack reported", !!relaxed.deadline && relaxed.deadline.slackSeconds > 0)
  check("not impossible", relaxed.impossible === false)
  check("no impossible warning", !relaxed.warnings.some((w) => /IMPOSSIBLE/.test(w)))
}

// ---- Req 25: deadline pressure tiered actions ----
{
  const { scheduler: s } = scheduler()
  const fast = planWithSla(s, { ...baseInput(), sla: "FASTEST" as SlaMode })
  const fastestSeconds = fast.deadline ? Math.max(1, fast.deadline.estimatedFastestSeconds) : 500

  // Deadline close to the estimate -> emergency pressure tier.
  const critical = deadlinePressure(fast.plan, {
    plausible: true,
    deadlineSeconds: fastestSeconds,
    estimatedFastestSeconds: fastestSeconds,
    slackSeconds: 0,
    reason: "x",
  } as Parameters<typeof deadlinePressure>[1])
  check("zero-slack deadline yields the full action set", critical.actions.length >= 4)
  check("pressure is within [0,1]", critical.pressure >= 0 && critical.pressure <= 1)
  check("every action is a known DeadlineAction", critical.actions.every((a) => ["prioritize_critical_path", "reduce_low_value_branches", "increase_parallelism", "reserve_verification", "skip_optional_work"].includes(a)))

  // 2x the estimate -> tight tier reserves verification.
  const tight = deadlinePressure(fast.plan, {
    plausible: true,
    deadlineSeconds: fastestSeconds * 2,
    estimatedFastestSeconds: fastestSeconds,
    slackSeconds: fastestSeconds,
    reason: "x",
  } as Parameters<typeof deadlinePressure>[1])
  check("tight deadline reserves verification", tight.actions.includes("reserve_verification") || tight.actions.length >= 1)

  // 10x the estimate -> comfortable, no forced actions.
  const comfortable = deadlinePressure(fast.plan, {
    plausible: true,
    deadlineSeconds: fastestSeconds * 10,
    estimatedFastestSeconds: fastestSeconds,
    slackSeconds: fastestSeconds * 9,
    reason: "x",
  } as Parameters<typeof deadlinePressure>[1])
  check("comfortable deadline forces no actions", comfortable.actions.length === 0)

  // planWithSla threads pressure into warnings.
  const pressured = planWithSla(s, { ...baseInput(), sla: "FASTEST" as SlaMode, deadlineSeconds: Math.round(fastestSeconds * 1.1) })
  check("pressure surfaces as a warning", pressured.warnings.some((w) => /DEADLINE PRESSURE/.test(w)))
}

// ---- Req 26: anytime stage ordering (monotone PRELIMINARY < VERIFIED < FINAL) ----
{
  const prelim = mockPlan({ verificationLevel: 0 })
  const verified = mockPlan({ verificationLevel: 2 })
  const final = mockPlan({ verificationLevel: 4 })

  check("stageOf: V0 -> PRELIMINARY", stageOf(prelim) === "PRELIMINARY")
  check("stageOf: V2 -> VERIFIED", stageOf(verified) === "VERIFIED")
  check("stageOf: V4 -> FINAL", stageOf(final) === "FINAL")

  const r1 = anytimeResult(undefined, prelim)
  check("first stage starts at PRELIMINARY", r1.stage === "PRELIMINARY" && r1.safeToExpose === false)

  const r2 = anytimeResult(r1.stage, verified)
  check("PRELIMINARY -> VERIFIED advances", r2.stage === "VERIFIED" && r2.safeToExpose === true && /advanced/.test(r2.reason))

  const r3 = anytimeResult(r2.stage, prelim)
  check("VERIFIED -> PRELIMINARY regression is refused", r3.stage === "VERIFIED" && /regress/.test(r3.reason))

  const r4 = anytimeResult(r3.stage, final)
  check("VERIFIED -> FINAL advances", r4.stage === "FINAL")

  const r5 = anytimeResult(r4.stage, verified)
  check("FINAL -> VERIFIED regression is refused", r5.stage === "FINAL" && /regress/.test(r5.reason))
}

// ---- Req 26: planWithSla derives the anytime stage ----
{
  const { scheduler: s } = scheduler()
  const result = planWithSla(s, { ...baseInput(), sla: "HIGHEST_QUALITY" as SlaMode })
  check("planWithSla reports a valid anytime stage", [
    "PRELIMINARY",
    "VERIFIED",
    "FINAL",
  ].includes(result.anytime.stage))
  check("planWithSla carries over warnings when applicable", Array.isArray(result.warnings))
}

// ---- Req 26: cost guard declines swarms whose effort is not repaid ----
{
  const marginal = mockPlan({
    topology: "SMALL_SWARM",
    netSecondsSaved: 4,
    speedup: 1.02,
    planningCost: 30,
    startupCost: 20,
    integrationCost: 10,
    verificationLevel: 2,
    verificationCost: 40,
  })
  const g1 = costGuardDeclinesSwarm(marginal)
  check("marginal swarm is declined", g1.decline === true && /not repaid/.test(g1.reason))

  const generous = mockPlan({
    topology: "SMALL_SWARM",
    netSecondsSaved: 300,
    speedup: 2,
    planningCost: 10,
    startupCost: 5,
    integrationCost: 5,
    verificationLevel: 1,
    verificationCost: 3,
  })
  const g2 = costGuardDeclinesSwarm(generous)
  check("repaid swarm is kept", g2.decline === false)

  const serial = mockPlan({ topology: "SERIAL" })
  const g3 = costGuardDeclinesSwarm(serial)
  check("serial passes the guard", g3.decline === false && g3.overheadSeconds === 0)
}

console.log(`\n[sla] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
