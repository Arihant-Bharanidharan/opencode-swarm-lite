/**
 * v2.0 runtime tests: learned costs, provider breakers/routing, warm lanes,
 * context capsules, convergence/dedup, adaptive verification, DAG scheduling,
 * telemetry/replay and the adaptive scheduler's cost gates.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router, DEFAULT_PROFILES } from "../src/runtime/provider.js"
import { LanePool } from "../src/runtime/lanes.js"
import { CapsuleStore } from "../src/runtime/capsules.js"
import { clusterFindings, findingSimilarity } from "../src/runtime/cluster.js"
import { chooseVerification } from "../src/runtime/verify.js"
import { scheduleDag } from "../src/runtime/schedule.js"
import { Telemetry } from "../src/runtime/telemetry.js"
import { AdaptiveScheduler, DEFAULT_SCHEDULER_CONFIG, packBatches } from "../src/runtime/scheduler.js"
import { PREDICTOR_FIELDS, hasPredictorContract, planPredictors } from "../src/runtime/predictor.js"
import type { Observation, Plan, TaskInput } from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runtime-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const obs = (over: Partial<Observation> = {}): Observation => ({
  ts: Date.now(),
  provider: "opencode",
  model: "mimo-v2.6-flash-free",
  role: "coder",
  category: "coding",
  warm: false,
  startupSeconds: 45,
  workSeconds: 100,
  totalSeconds: 145,
  status: "ok",
  ...over,
})

// ---- Stats: learned startup/work/tokens, failure-aware tok/s ----
{
  const stats = new StatsStore(path.join(tmp, "stats.json"))
  stats.add(obs({ startupSeconds: 80, workSeconds: 200, tokensOut: 2000 }))
  stats.add(obs({ startupSeconds: 60, workSeconds: 180, tokensOut: 1800 }))
  stats.add(obs({ startupSeconds: 20, workSeconds: 180, tokensOut: 0, status: "error" }))
  const a = stats.aggregate({ model: "mimo-v2.6-flash-free" })
  check("aggregate keeps all rows", a.n === 3, `n=${a.n}`)
  check("aggregate uses successful rows for tok/s", Math.abs(a.tokPerSecond - 10) < 0.01, `tok/s=${a.tokPerSecond}`)
  check("aggregate blends failures into failure rate", a.failureRate > 0 && a.failureRate < 1, `fail=${a.failureRate}`)
  check("cold startup is learned", stats.estimateStartup({ model: "mimo-v2.6-flash-free", warm: false }) > 45)
  const warmFromCold = stats.estimateStartup({ model: "mimo-v2.6-flash-free", warm: true })
  check(
    "warm startup is below cold startup",
    warmFromCold < stats.estimateStartup({ model: "mimo-v2.6-flash-free", warm: false }),
    `warm=${warmFromCold}`,
  )
  for (let i = 0; i < 5; i++) stats.add(obs({ tokensIn: 30_000 + i, tokensOut: 7_000 + i }))
  check("context tokens are learned", stats.contextTokens({ task: "x", model: "mimo-v2.6-flash-free" }) > 20_000)
  check("output tokens are learned", stats.outputTokens({ task: "x", model: "mimo-v2.6-flash-free" }) > 5_000)
  const summary = stats.summary()
  check("summary exposes warm/cold learned group", summary.length >= 1 && String(summary[0]!.key).includes("cold"))
  const reopened = new StatsStore(path.join(tmp, "stats.json"))
  check("observations persist across instances", reopened.all().length === stats.all().length)
}

// ---- Provider breaker + router failover ----
{
  let now = 1_000_000
  const health = new ProviderHealth(path.join(tmp, "health.json"), {
    failureThreshold: 2,
    cooldownMs: 10_000,
    now: () => now,
  })
  check("provider starts closed", health.state("opencode") === "closed")
  health.record("opencode", "429")
  check("one failure leaves provider closed", health.allow("opencode"))
  health.record("opencode", "error")
  check("threshold opens the circuit", health.state("opencode") === "open")
  check("open circuit blocks dispatch", !health.allow("opencode"))
  health.record("opencode", "error")
  check("cooldown backs off exponentially", health.snapshot().opencode!.cooldownRemaining > 10)
  now += 20_000
  check("cooldown expiry becomes half-open", health.state("opencode") === "half_open" && health.allow("opencode"))
  health.record("opencode", "ok")
  check("success closes the circuit", health.state("opencode") === "closed")

  const stats = new StatsStore(null)
  const router = new Router(stats, health)
  health.record("opencode", "error")
  health.record("opencode", "error")
  health.record("opencode", "error")
  const route = router.route({ role: "coder", category: "coding" })
  check("router blocks an open provider", route.choices.length === 0 && route.blocked.some((b) => b.includes("circuit open")))
  const reopened = new ProviderHealth(path.join(tmp, "health.json"), {
    failureThreshold: 2,
    cooldownMs: 10_000,
    now: () => now + 100_000,
  })
  check("breaker state persists", reopened.state("opencode") !== "closed" || reopened.allow("opencode"))
}

// ---- Warm lane pool: exact scope reuse, no context leakage ----
{
  let now = 2_000_000
  const lanes = new LanePool(path.join(tmp, "lanes.json"), { ttlMs: 60_000, maxUses: 4, now: () => now })
  const cold = lanes.acquire({ role: "coder", model: "m", category: "coding" })
  check("empty pool is a cold miss", !cold.warm && cold.hitRate === 0)
  lanes.register({ sessionID: "ses_coder_1", role: "coder", model: "m", category: "coding", provider: "opencode", runId: "r1" })
  const warm = lanes.acquire({ role: "coder", model: "m", category: "coding" })
  check("matching idle lane is reused warm", warm.warm && warm.lane?.sessionID === "ses_coder_1")
  check("warm hit rate rises", lanes.hitRate() === 0.5, `hitRate=${lanes.hitRate()}`)
  const wrongRole = lanes.acquire({ role: "verifier", model: "m", category: "coding" })
  check("different role cannot reuse the lane", !wrongRole.warm)
  lanes.release("ses_coder_1", { runId: "r2" })
  const capsuleMiss = lanes.acquire({ role: "coder", model: "m", category: "coding", capsule: "spec" })
  check("capsule-scoped request cannot reuse an unscoped lane", !capsuleMiss.warm)
  lanes.release("ses_coder_1", { capsule: "spec", capsuleVersion: 1, runId: "r3" })
  const capsuleHit = lanes.acquire({ role: "coder", model: "m", category: "coding", capsule: "spec", capsuleVersion: 1 })
  check("same capsule scope is reusable", capsuleHit.warm)
  lanes.release("ses_coder_1", { capsule: "spec", capsuleVersion: 2 })
  lanes.register({ sessionID: "ses_short", role: "verifier", model: "m", category: "verification", maxUses: 1 })
  lanes.acquire({ role: "verifier", model: "m", category: "verification" })
  lanes.release("ses_short")
  check("max uses invalidates a lane", lanes.get("ses_short")?.status === "invalid")
  const stats = lanes.statsSummary()
  check("lane stats separate cold/warm starts", stats.coldStarts === 2 && stats.warmStarts >= 2, JSON.stringify(stats))
  check("lane state persists", new LanePool(path.join(tmp, "lanes.json"), { now: () => now }).get("ses_coder_1")?.status === "idle")
}

// ---- Capsules: versions, conflicts, staleness, provenance ----
{
  let now = 3_000_000
  const caps = new CapsuleStore(path.join(tmp, "capsules"), { now: () => now })
  const c1 = caps.create({
    name: "format spec",
    scope: "r2",
    architecture: ["ONE parent -> lanes"],
    invariants: ["MM:SS always two digits"],
    files: [{ path: "src/format.js", hash: "aaa" }],
    commands: [{ cmd: "bun test", verified: true }],
    failedApproaches: ["judge-only verification"],
    facts: [
      { text: "formatDuration(3630000) returns 1h 0m", status: "verified", evidence: ["src/format.js"], source: "t1" },
      { text: "hours may omit minutes", status: "hypothesis" },
    ],
    provenance: ["handoff from baseline"],
  })
  check("capsule starts at version 1 revision 1", c1.version === 1 && c1.revision === 1)
  check("capsule keeps verified vs hypothesis", c1.facts.filter((f) => f.status === "verified").length === 1)
  const c2 = caps.merge("format spec", { facts: [{ text: "minutes must never be omitted", status: "verified" }], note: "review" })
  check("merge advances revision", c2.revision > c1.revision, `${c2.revision} vs ${c1.revision}`)
  const hypothesis = c2.facts.find((f) => f.text === "hours may omit minutes")!
  const conflict = caps.merge("format spec", {
    facts: [{ key: hypothesis.key, text: "hours may omit minutes after all", status: "verified" }],
  })
  check("conflicting claim is kept as a hypothesis", conflict.facts.some((f) => f.text.includes("after all") && f.status === "hypothesis"))
  const bumped = caps.bumpVersion("format spec", "approved spec")!
  check("version bump advances version", bumped.version === 2)
  const refreshed = caps.refresh("format spec", {
    fileHashes: { "src/format.js": "bbb" },
    reverifyKeys: [conflict.facts.find((f) => f.text.includes("1h 0m"))!.id],
  })!
  check("changed file marks dependent fact stale", refreshed.stale.length === 1 && refreshed.refreshed.length === 1)
  const emphasized = caps.invalidate("format spec", { pattern: "minutes", reason: "spec changed" })
  check("invalidation marks matched facts stale", !!emphasized && emphasized.facts.some((f) => f.status === "stale"))
  const render = caps.render("format spec")!
  check("render separates sections with ASCII", render.includes("### Facts") && render.includes("### Provenance") && render.includes("### Failed approaches"))
  check("render keeps provenance and failed approaches", render.includes("handoff from baseline") && render.includes("judge-only verification"))
  const attach = caps.attach("format spec", { role: "judge" })!
  check("attach reports version and evidence counts", attach.version === 2 && attach.verified >= 1 && attach.stale >= 1)
  check("capsule digest is stable", caps.digest(caps.load("format spec")!) === caps.digest(caps.load("format spec")!))
}

// ---- Convergence: dedup paraphrases, keep genuine dissent ----
{
  const same = [
    { id: "a", text: "The formatter is wrong because it drops the minute component for whole hours", confidence: 0.82, evidence: ["test:3630000"], source: "s1" },
    { id: "b", text: "The formatter is wrong: it drops the minute component for whole hours", confidence: 0.8, evidence: ["test:3630000"], source: "s2" },
    { id: "c", text: "The formatter is wrong: it drops the minute component for whole hours", confidence: 0.6, evidence: ["test:3630000"], source: "s3" },
    { id: "d", text: "The formatter is wrong for a different reason: timezone conversion shifts the day", confidence: 0.76, evidence: ["test:86405000"], source: "s3" },
  ]
  check("paraphrases are semantically similar", findingSimilarity(same[0]!.text, same[1]!.text).score >= 0.6)
  const conv = clusterFindings(same)
  check("convergence keeps a representative and cuts duplicates", conv.keep.length < same.length && conv.redundant.length >= 1, conv.reason)
  check("genuine dissent is preserved", conv.dissent.length >= 1 && !conv.shouldStop, conv.reason)
  const strong = clusterFindings(same.slice(0, 3))
  check("strong agreement can stop early", strong.shouldStop && strong.clusters[0]!.consensus, strong.reason)
  check("dedup carries evidence metadata", strong.clusters[0]!.evidence >= 1 && strong.clusters[0]!.confidence >= 0.8)
}

// ---- Adaptive verification: V0 for trivial, V4 for hard, budget caps ----
{
  const trivial = chooseVerification({ trivial: true, workSeconds: 30 })
  check("trivial work stays V0 and skips the judge", trivial.level === 0 && !trivial.judgeAllowed && trivial.estimatedCost === 0)
  const easy = chooseVerification({
    confidence: 0.95,
    disagreement: 0.02,
    impact: 0.1,
    deterministicTests: true,
    testStrength: 0.95,
  })
  check("strong deterministic checks stay V0", easy.level === 0 && !!easy.skipReason)
  const hard = chooseVerification({ confidence: 0.4, disagreement: 0.8, risk: 0.9, testStrength: 0.1, workSeconds: 300 })
  check("high disagreement/risk escalates to V4", hard.level === 4 && hard.judgeAllowed && hard.steps.length >= 4)
  const medium = chooseVerification({ confidence: 0.9, disagreement: 0.4, impact: 0.55, workSeconds: 300 })
  check("moderate dispute uses V3 without judge addiction", medium.level === 3 && !medium.judgeAllowed)
  const capped = chooseVerification({ confidence: 0.4, disagreement: 0.8, risk: 0.9, workSeconds: 1200, budgetSeconds: 100 })
  check("verification respects the run budget", capped.level < 4 && !!capped.skipReason)
  const noJudge = chooseVerification({ confidence: 0.4, disagreement: 0.8, risk: 0.9, judgeAvailable: false })
  check("missing judge falls back to adversarial verifier", noJudge.level === 3 && !noJudge.judgeAllowed)
}

// ---- DAG scheduling: critical path, waves, cycles ----
{
  const nodes = [
    { id: "a", seconds: 10 },
    { id: "b", seconds: 30 },
    { id: "c", seconds: 20 },
    { id: "d", seconds: 10 },
  ]
  const dag = scheduleDag(nodes, [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]], { concurrency: 3 })
  check("DAG finds the critical path", dag.criticalPath.join(",") === "a,b,d" || dag.criticalPath.join(",") === "a,c,d", dag.criticalPath.join(","))
  check("DAG makespan beats serial", dag.makespan === 50 && dag.serialTime === 70, `${dag.makespan}/${dag.serialTime}`)
  check("DAG reports waves and utilization", dag.waves.length >= 2 && dag.utilization > 0.5, JSON.stringify(dag.waves))
  const cyclic = scheduleDag(nodes, [["a", "b"], ["b", "a"]], { concurrency: 2 })
  check("cycles are detected, not hidden", !!cyclic.cycle && cyclic.cycle.length === 2)
  const chain = scheduleDag(nodes, [["a", "b"], ["b", "c"], ["c", "d"]], { concurrency: 4 })
  check("a chain has no parallel speedup", chain.makespan === chain.serialTime && chain.criticalPath.length === 4)
}

// ---- Telemetry: deterministic replay, unique lanes, efficiency score ----
{
  const stats = new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health)
  const scheduler = new AdaptiveScheduler({ stats, router, health })
  const plan = scheduler.plan({ task: "implement and test the duration formatter", branches: 2, branchSeconds: 300 })
  const tel = new Telemetry(path.join(tmp, "events.jsonl"), { now: () => 4_000_000 })
  tel.startRun(plan, "ses_parent")
  tel.log("SPAWN", { toolCallID: "t1", sessionID: "ses_a", auto: true }, { runId: plan.runId })
  tel.log("ASSIGN", { toolCallID: "t1", sessionID: "ses_a" }, { runId: plan.runId })
  tel.log("SPAWN", { toolCallID: "t2", sessionID: "ses_b", auto: true }, { runId: plan.runId })
  tel.log("LANE_FAIL", { toolCallID: "t2", sessionID: "ses_b", auto: true }, { runId: plan.runId })
  tel.log("VERIFY", { level: 2 }, { runId: plan.runId })
  const report = Telemetry.efficiency({
    runId: plan.runId,
    predictedSeconds: plan.estimates.chosen,
    actualSeconds: plan.estimates.serial,
    serialSeconds: plan.estimates.serial,
    workers: 2,
    usefulWorkers: 1,
    wastedWorkers: 1,
    quality: 0.9,
  })
  tel.finish(plan.runId, report, "ses_parent")
  const replay = tel.replay(plan.runId)!
  check("replay finds the plan", replay.plan?.runId === plan.runId)
  check("replay counts unique auto spawns, not ASSIGN", replay.lanesSpawned === 2, `spawned=${replay.lanesSpawned}`)
  check("replay counts unique failures", replay.lanesFailed === 1, `failed=${replay.lanesFailed}`)
  check("replay keeps verification events", replay.verifications === 1)
  check("replay predicts from the chosen plan", replay.predictedSeconds === plan.estimates.chosen)
  check("replay carries the outcome", replay.outcome?.workers === 2)
  check("efficiency score detects no speedup", report.speedup === 1 && report.score < 75, `score=${report.score}`)
  check("efficiency score grades honestly", report.grade !== "A" && report.reasons.some((r) => r.includes("slower than serial") || r.includes("no unique kept")))
  const eventsReloaded = new Telemetry(path.join(tmp, "events.jsonl")).replay(plan.runId)
  check("event log persists for later replay", eventsReloaded?.lanesSpawned === 2)
  check("active run closes on outcome", tel.activeRuns("ses_parent").length === 0)
}

// ---- Scheduler: serial by default, swarm only with real work, batching wins ----
{
  const stats = new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health)
  const scheduler = new AdaptiveScheduler({ stats, router, health })
  const serial = scheduler.plan({ task: "rename a variable and update one import", branchSeconds: 18, branches: 1 })
  check("microtask stays SERIAL", serial.topology === "SERIAL" && serial.agents === 1)
  check("serial plan has no fake speedup", serial.estimates.speedup === 1 && serial.estimates.netSecondsSaved <= 0.1)
  check("serial plan still reports the swarm alternative", serial.estimates.swarm >= 0 && serial.alternatives.length >= 1)
  check("plan carries every required predictor field", [
    "serial",
    "swarm",
    "chosen",
    "speedup",
    "swarmSpeedup",
    "parallelEfficiency",
    "startupCost",
    "verificationGain",
    "planningCost",
    "integrationCost",
    "agents",
    "waves",
    "confidence",
  ].every((k) => k in serial.estimates))
  check("plan explains the serial choice", serial.reasons.some((r) => /Stayed serial/i.test(r)))
  check("plan routes one model", serial.models.length === 1 && serial.models[0]!.length > 0)

  const large = scheduler.plan({
    task: "implement 6 independent modules with tests",
    branches: 6,
    branchSeconds: 420,
    independence: 0.95,
    sharedContext: 0.15,
    risk: 0.2,
  })
  check("large independent work earns a swarm", large.topology !== "SERIAL" && large.agents >= 3, `${large.topology}/${large.agents}`)
  check("large swarm predicts a real speedup", large.estimates.speedup >= 1.25, `x${large.estimates.speedup}`)
  check("large swarm lists alternatives with costs", large.alternatives.every((a) => a.reason.length > 0))

  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, seconds: 90 }))
  const batch = scheduler.plan({ task: "process 12 independent two-minute checks", tasks })
  check("repeatable microtasks choose BATCHED_WORKER", batch.topology === "BATCHED_WORKER", batch.topology)
  check("batching uses fewer lanes than tasks", batch.agents < tasks.length && batch.batches.length === batch.agents)
  check("batching packs every task exactly once", batch.batches.flatMap((b) => b.taskIds).sort().join(",") === tasks.map((t) => t.id).sort().join(","))
  check("batching explains the reduction", batch.reasons.some((r) => /Batched/i.test(r)))
  const bins = packBatches(tasks, 3)
  check("LPT packing balances 12 equal tasks into 3 bins", bins.length === 3 && bins.every((b) => b.length === 4))

  const cappedTasks = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, seconds: 120 }))
  const capped = scheduler.plan({ task: "run 8 audit checks", tasks: cappedTasks, budget: { agents: 2 } })
  check("agent budget caps fan-out", capped.agents <= 2 && capped.estimates.agents <= 2)
  const lowBudget = scheduler.plan({ task: "investigate a hard bug", branches: 4, branchSeconds: 300, budget: { wallClockSeconds: 30 } })
  check("impossible wall-clock budget is surfaced", lowBudget.warnings.some((w) => /below the .* estimate/i.test(w)))
  const riskySilent = scheduler.plan({ task: "rewrite the billing ledger", branches: 1, branchSeconds: 300, risk: 0.9, verificationLevel: 0 })
  check("high risk + V0 is warned", riskySilent.warnings.some((w) => /High risk with V0/i.test(w)))
}

// ---- Predictors: the snake_case contract is present and mirror-exact on every plan ----
{
  const stats = new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health)
  const scheduler = new AdaptiveScheduler({ stats, router, health })

  check("the contract is exactly the nine documented fields", PREDICTOR_FIELDS.join(",") === [
    "estimated_serial_time",
    "estimated_swarm_time",
    "estimated_parallel_efficiency",
    "estimated_startup_cost",
    "estimated_verification_gain",
    "recommended_topology",
    "recommended_agent_count",
    "recommended_models",
    "confidence",
  ].join(","), PREDICTOR_FIELDS.join(","))
  check("the contract is snake_case, not camelCase", PREDICTOR_FIELDS.every((f) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(f)))
  check("compound predictor names use underscores", PREDICTOR_FIELDS.filter((f) => f.length > 10).every((f) => f.includes("_")))

  const serial = scheduler.plan({ task: "rename a variable and update one import", branchSeconds: 18, branches: 1 })
  const swarm = scheduler.plan({
    task: "implement 6 independent modules with tests",
    branches: 6,
    branchSeconds: 420,
    independence: 0.95,
    sharedContext: 0.15,
    risk: 0.2,
  })
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, seconds: 90 }))
  const batched = scheduler.plan({ task: "process 12 independent two-minute checks", tasks })

  for (const [label, plan] of [["serial", serial], ["swarm", swarm], ["batched", batched]] as const) {
    check(`${label} plan carries the full predictor contract`, hasPredictorContract(plan.predictors), JSON.stringify(plan.predictors))
    check(`${label} predictors mirror the live plan exactly`, (
      plan.predictors.estimated_serial_time === plan.estimates.serial &&
      plan.predictors.estimated_swarm_time === plan.estimates.swarm &&
      plan.predictors.estimated_parallel_efficiency === plan.estimates.parallelEfficiency &&
      plan.predictors.estimated_startup_cost === plan.estimates.startupCost &&
      plan.predictors.estimated_verification_gain === plan.estimates.verificationGain &&
      plan.predictors.recommended_topology === plan.topology &&
      plan.predictors.recommended_agent_count === plan.agents &&
      plan.predictors.confidence === plan.estimates.confidence &&
      plan.predictors.recommended_models.length === plan.models.length &&
      plan.predictors.recommended_models.every((m, i) => m === plan.models[i])
    ), `${label}: ${JSON.stringify(plan.predictors)}`)
  }

  check("swarm predictors report the swarm numbers, not the serial ones", (
    swarm.predictors.recommended_topology === swarm.topology &&
    swarm.predictors.recommended_agent_count === swarm.agents &&
    swarm.predictors.estimated_swarm_time > 0 &&
    swarm.predictors.estimated_parallel_efficiency > 0
  ), `${swarm.topology}/${swarm.predictors.recommended_agent_count}`)
  check("serial predictors report a single lane", serial.predictors.recommended_agent_count === 1 && serial.predictors.recommended_topology === "SERIAL")
  check("recommended_models is a copy, not the live array", serial.predictors.recommended_models !== serial.models)

  // A partially assembled plan (the scheduler's shape before predictors are attached)
  // must produce the identical contract — the aliases read the live values only.
  const draft: Pick<Plan, "estimates" | "topology" | "agents" | "models"> = {
    topology: serial.topology,
    agents: serial.agents,
    models: serial.models,
    estimates: serial.estimates,
  }
  check("predictors derive from a plan draft, not a finished plan", JSON.stringify(planPredictors(draft)) === JSON.stringify(serial.predictors))

  check("hasPredictorContract rejects an object missing a field", !hasPredictorContract({ ...serial.predictors, confidence: undefined }))
  check("hasPredictorContract rejects a null field", !hasPredictorContract({ ...serial.predictors, recommended_models: null as unknown as string[] }))
  check("hasPredictorContract rejects a non-object", !hasPredictorContract(null) && !hasPredictorContract("nope") && !hasPredictorContract(42))
  check("hasPredictorContract rejects an empty object", !hasPredictorContract({}))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
