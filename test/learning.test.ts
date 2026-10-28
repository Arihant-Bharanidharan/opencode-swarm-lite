/**
 * v3 learning tests: task-shape history, versioned/safe persistence,
 * counterfactual tables + regret (Req 1, 2), branch ROI hysteresis and
 * dynamic priority (Req 3, 4), run history/baselines (Req 40, 48, 49),
 * and decision explainability (Req 51).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AdaptiveScheduler } from "../src/runtime/scheduler.js"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router } from "../src/runtime/provider.js"
import { RunHistory, classifyShape, completedRunFromPlan } from "../src/runtime/history.js"
import { analyzeRun, estimateCounterfactuals, type CounterfactualContext } from "../src/runtime/counterfactual.js"
import { BranchRoiTracker, scoreBranchRoi } from "../src/runtime/roi.js"
import { DecisionLog, renderDecision } from "../src/runtime/explain.js"
import type { CompletedRun, ModelProfile, Plan, RunActuals, TaskInput } from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-learning-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// ---- fixtures ----

const mkTask = (over: Partial<TaskInput> = {}): TaskInput => ({
  task: "refactor the parser module",
  branches: 2,
  branchSeconds: 300,
  ...over,
})

const mkPlan = (taskOver: Partial<TaskInput> = {}, planOver: Partial<Plan> = {}): Plan => ({
  runId: "run_fixture",
  createdAt: 1_700_000_000_000,
  task: mkTask(taskOver),
  topology: "SMALL_SWARM",
  agents: 3,
  waves: 1,
  batches: [],
  models: ["mimo-v2.6-flash-free"],
  verification: { level: 1, steps: ["unit"], estimatedCost: 30, expectedGain: 0.2, judgeAllowed: false },
  estimates: {
    serial: 600,
    swarm: 300,
    chosen: 300,
    speedup: 2,
    swarmSpeedup: 2,
    parallelEfficiency: 0.67,
    startupCost: 45,
    verificationGain: 0.2,
    integrationCost: 30,
    planningCost: 5,
    criticalPath: 300,
    agents: 3,
    waves: 1,
    requests: 6,
    tokens: 50000,
    confidence: 0.7,
    netSecondsSaved: 300,
  },
  predictors: {
    estimated_serial_time: 600,
    estimated_swarm_time: 300,
    estimated_parallel_efficiency: 0.67,
    estimated_startup_cost: 45,
    estimated_verification_gain: 0.2,
    recommended_topology: "SMALL_SWARM",
    recommended_agent_count: 3,
    recommended_models: ["mimo-v2.6-flash-free"],
    confidence: 0.7,
  },
  budget: {
    requests: 50,
    tokens: 200000,
    agents: 8,
    wallClockSeconds: 3600,
    verificationSeconds: 600,
    reserve: 10,
  },
  reasons: ["fixture"],
  warnings: [],
  alternatives: [
    { topology: "SERIAL", agents: 1, seconds: 200, reason: "serial baseline" },
    { topology: "FULL_SWARM", agents: 5, seconds: 260, reason: "more lanes" },
  ],
  ...planOver,
})

// NOTE: this builder uses a block body on purpose. tsc 7.0.2 mis-parses an
// `=> ({ ... })` arrow whose NEXT statement begins with `{` (a bare section
// block below): it retroactively re-reads the object literal as an arrow
// parameter destructuring pattern. bun parses both forms fine. Rule for this
// codebase: any `=> ({ ... })` builder directly followed by a `{ }` section
// block must use `=> { return { ... } }` instead.
const mkRun = (over: Partial<CompletedRun> = {}): CompletedRun => {
  return {
    ts: 1,
    runId: "run_x",
    shape: "medium_branch",
    category: "coding",
    topology: "SMALL_SWARM",
    agents: 2,
    predictedSerialSeconds: 600,
    predictedChosenSeconds: 300,
    actualSeconds: 300,
    status: "ok",
    provider: "opencode",
    model: "mimo-v2.6-flash-free",
    ...over,
  }
}

// ---- Req 40: task-shape classification is deterministic ----
{
  const t = mkTask({ task: "run the benchmark suite", branches: 1, branchSeconds: 300 })
  check("classifyShape deterministic", classifyShape(t) === classifyShape(t))
  check(
    "shape: tiny task -> microtask",
    classifyShape(mkTask({ task: "rename variable", branches: 1, branchSeconds: 20 })) === "microtask",
  )
  check(
    "shape: tasks array -> batched_microtasks",
    classifyShape(mkTask({ branches: undefined, tasks: [{ id: "t1", seconds: 30 }, { id: "t2", seconds: 40 }] })) ===
      "batched_microtasks",
  )
  check(
    "shape: 6 branches -> large_parallel",
    classifyShape(mkTask({ branches: 6 })) === "large_parallel",
  )
  check(
    "shape: ambiguity>=0.6 -> ambiguous_debug",
    classifyShape(mkTask({ task: "find why tests fail", branches: 1, branchSeconds: 100, ambiguity: 0.7 })) ===
      "ambiguous_debug",
  )
  check(
    "shape: verificationValue>=0.7 -> high_verification",
    classifyShape(mkTask({ branches: 1, branchSeconds: 100, verificationValue: 0.8 })) === "high_verification",
  )
  check(
    "shape: huge context -> research",
    classifyShape(mkTask({ branches: 1, branchSeconds: 100, contextTokens: 50000 })) === "research",
  )
  check(
    "shape: tool-verbs + size -> tool_heavy",
    classifyShape(mkTask({ task: "run the deploy command", branches: 1, branchSeconds: 300 })) === "tool_heavy",
  )
  check("shape: 200s serial -> code_write", classifyShape(mkTask({ branches: 1, branchSeconds: 200 })) === "code_write")
  check("shape: 600s -> medium_branch", classifyShape(mkTask()) === "medium_branch")
  check("shape: 100s -> small_serial", classifyShape(mkTask({ branches: 1, branchSeconds: 100 })) === "small_serial")
}

// ---- Req 48/49: persistence, versioning, data safety ----
{
  const file = path.join(tmp, "history.json")
  const h = new RunHistory(file)
  h.add(mkRun({ runId: "run_a", actualSeconds: 250 }))
  const h2 = new RunHistory(file)
  check("history persists across instances", h2.all().length === 1 && h2.all()[0]!.runId === "run_a")

  const badFile = path.join(tmp, "history-bad-version.json")
  fs.writeFileSync(badFile, JSON.stringify({ version: 99, runs: [mkRun({ runId: "old" })] }))
  check(
    "history: unknown schema version resets to fresh (never crashes)",
    new RunHistory(badFile).all().length === 0,
  )

  const legacyFile = path.join(tmp, "history-legacy.json")
  fs.writeFileSync(legacyFile, JSON.stringify([mkRun({ runId: "legacy" })]))
  const h4 = new RunHistory(legacyFile)
  check("history: legacy bare-array format loads", h4.all().length === 1 && h4.all()[0]!.runId === "legacy")

  const secretPlan = mkPlan({ task: "rotate the API key sk-live-secret123 in the vault" })
  const rec = completedRunFromPlan(secretPlan, { runId: "run_s", actualSeconds: 120 })
  const json = JSON.stringify(rec)
  check("history record whitelists keys (no task field)", !("task" in rec))
  check("history record carries no task text or secrets", !json.includes("sk-live-secret123") && !json.includes("vault"))
}

// ---- Req 40: shape baselines and prediction error ----
{
  const h = new RunHistory(null)
  const secs = [100, 200, 300, 400]
  secs.forEach((s, i) =>
    h.add(mkRun({ shape: "code_write", runId: `run_${i}`, actualSeconds: s, status: i === 3 ? "error" : "ok" })),
  )
  const b = h.baseline("code_write")
  check("baseline computed from same-shape runs", b !== null && b!.n === 4)
  // nearest-rank percentile: p50 of 4 items = 2nd, p90 = 4th
  check("baseline p50/p90 (nearest-rank)", b!.p50Seconds === 200 && b!.p90Seconds === 400, JSON.stringify(b))
  check("baseline success rate", b!.successRate === 0.75)
  check("baseline null without evidence", h.baseline("research") === null)

  const h2 = new RunHistory(null)
  h2.add(mkRun({ shape: "small_serial", predictedChosenSeconds: 200, actualSeconds: 240 }))
  h2.add(mkRun({ shape: "small_serial", predictedChosenSeconds: 200, actualSeconds: 300 }))
  h2.add(mkRun({ shape: "small_serial", predictedChosenSeconds: 200, actualSeconds: 200 }))
  // nearest-rank median of the ratios [0, 0.2, 0.5] is the 2nd item: 0.2
  check("prediction bias = median(actual/predicted - 1)", h2.predictionBias("small_serial") === 0.2)
  check("prediction MAPE", h2.predictionMape("small_serial") === 0.23)
}

// ---- Req 1/52: counterfactual table from a REAL scheduler plan ----
{
  const stats = new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health)
  const scheduler = new AdaptiveScheduler({ stats, router, health })
  const plan = scheduler.plan({ task: "explore three independent library options", branches: 3, branchSeconds: 300 })
  const actuals: RunActuals = {
    runId: plan.runId,
    actualSeconds: plan.estimates.chosen + 40,
    requests: plan.estimates.requests,
    agents: plan.agents,
    verificationSeconds: plan.verification.estimatedCost,
  }
  const ctx: CounterfactualContext = { history: new RunHistory(null), stats }
  const after = analyzeRun(plan, actuals, ctx)

  check("table row 0 is OBSERVED with measured runtime", after.counterfactuals[0]!.label === "OBSERVED" && after.counterfactuals[0]!.estimatedRuntime === actuals.actualSeconds)
  check("observed row confidence is exactly 1", after.counterfactuals[0]!.confidence === 1)
  check("exactly one OBSERVED row", after.counterfactuals.filter((r) => r.label === "OBSERVED").length === 1)
  check(
    "all non-observed rows labeled ESTIMATED_COUNTERFACTUAL",
    after.counterfactuals.slice(1).every((r) => r.label === "ESTIMATED_COUNTERFACTUAL"),
  )
  check(
    "estimated rows carry sub-1 confidence >= 0.15",
    after.counterfactuals.slice(1).every((r) => r.confidence >= 0.15 && r.confidence < 1),
  )
  check("estimated rows all have reasons", after.counterfactuals.slice(1).every((r) => r.reason.length > 0))
  check("at least one counterfactual exists", after.counterfactuals.length >= 2)
  const validAgents = new Set<number>([plan.agents, ...plan.alternatives.map((a) => a.agents)])
  check(
    "Req52: agent sweep derives from the plan, not fixed counts",
    after.counterfactuals.every((r) => validAgents.has(r.agents)),
    JSON.stringify([...validAgents]),
  )
  check(
    "regret components all >= 0",
    after.regret.latencyRegret >= 0 &&
      after.regret.requestRegret >= 0 &&
      after.regret.verificationRegret >= 0 &&
      after.regret.providerRegret >= 0 &&
      after.regret.agentCountRegret >= 0 &&
      after.regret.totalRegret >= 0,
  )
  check("regret always reports reasons", after.regret.reasons.length > 0)
}

// ---- Req 1: counterfactual confidence reflects evidence depth ----
{
  const p = mkPlan()
  const act: RunActuals = { runId: "rc", actualSeconds: 300, requests: 6 }
  const noHist = estimateCounterfactuals(p, act, {})
  const hist = new RunHistory(null)
  for (let i = 0; i < 8; i++) {
    hist.add(mkRun({ runId: `run_${i}`, shape: "medium_branch", predictedChosenSeconds: 300, actualSeconds: 300 }))
  }
  const withHist = estimateCounterfactuals(p, act, { history: hist })
  const conf = (rows: ReturnType<typeof estimateCounterfactuals>) =>
    rows.find((r) => r.label === "ESTIMATED_COUNTERFACTUAL")!.confidence
  check("no-history confidence = 0.2 (prior uncertainty)", conf(noHist) === 0.2, String(conf(noHist)))
  check("8-run history confidence = 0.7", conf(withHist) === 0.7, String(conf(withHist)))
  check("confidence rises with evidence depth", conf(withHist) > conf(noHist))
}

// ---- Req 2: regret decomposed per dimension with exact math ----
{
  const p = mkPlan()
  const act: RunActuals = {
    runId: "rr",
    actualSeconds: 500,
    requests: 6,
    verificationSeconds: 100,
    quality: 0.6,
    targetQuality: 0.9,
    agents: 3,
  }
  const profiles: ModelProfile[] = [
    { id: "mimo-v2.6-flash-free", provider: "opencode", quotaGroup: "opencode", quality: 0.9, speed: 1, contextLimit: 200000, costTier: 0, strengths: ["coding"] },
    { id: "fast-alt", provider: "opencode", quotaGroup: "opencode", quality: 0.8, speed: 1.4, contextLimit: 200000, costTier: 0, strengths: [] },
  ]
  const ctx: CounterfactualContext = {
    stats: { estimateVerification: () => 30, estimateStartup: () => 12 },
    profiles,
  }
  const after = analyzeRun(p, act, ctx)
  const r = after.regret
  check("best alternative is the fastest estimated row", r.bestAlternative.topology === "SERIAL" && r.bestAlternative.label === "ESTIMATED_COUNTERFACTUAL")
  check("latency regret = actual - best estimated", r.latencyRegret === 300, String(r.latencyRegret))
  check("request regret priced from evidence-derived seconds/request", r.requestRegret === 333.3, String(r.requestRegret))
  check("verification regret = spent - needed by best", r.verificationRegret === 70, String(r.verificationRegret))
  check("provider regret = savings from better model fit", r.providerRegret === 142.9, String(r.providerRegret))
  check("agent-count regret = extra lanes x startup", r.agentCountRegret === 24, String(r.agentCountRegret))
  check("quality regret in quality points", r.qualityRegret === 0.3, String(r.qualityRegret))
  check("total regret = sum of second components", r.totalRegret === 870.2, String(r.totalRegret))
  const text = r.reasons.join(" | ")
  check(
    "every nonzero dimension has a reason",
    ["latency:", "requests:", "verification:", "provider:", "agents:", "quality:"].every((k) => text.includes(k)),
    text,
  )
}

// ---- Req 2: zero regret when the plan was best in hindsight ----
{
  const zeroPlan = mkPlan(
    { task: "tiny lookup" },
    {
      topology: "SERIAL",
      agents: 1,
      verification: { level: 0, steps: [], estimatedCost: 0, expectedGain: 0, judgeAllowed: false },
      alternatives: [{ topology: "SERIAL", agents: 1, seconds: 600, reason: "baseline" }],
      estimates: { ...mkPlan().estimates, chosen: 600, speedup: 1, swarmSpeedup: 1, agents: 1 },
    },
  )
  const after = analyzeRun(zeroPlan, { runId: "rz", actualSeconds: 600, requests: 6, verificationSeconds: 0 }, {})
  check("best-in-hindsight run has zero total regret", after.regret.totalRegret === 0, String(after.regret.totalRegret))
  check(
    "zero-regret report says so explicitly",
    after.regret.reasons[0]!.includes("best in hindsight"),
    after.regret.reasons.join(" | "),
  )
}

// ---- Req 3: ROI scoring ----
{
  const great = scoreBranchRoi({
    branchId: "b1",
    expectedInformationGain: 0.9,
    expectedCompletionValue: 0.9,
    expectedVerificationValue: 0.9,
    expectedRemainingTime: 60,
    expectedRequests: 2,
    providerRisk: 0,
    branchConfidence: 0.9,
    branchNovelty: 1,
  })
  const poor = scoreBranchRoi({
    branchId: "b2",
    expectedInformationGain: 0.1,
    expectedCompletionValue: 0.1,
    expectedVerificationValue: 0,
    expectedRemainingTime: 300,
    expectedRequests: 3,
    providerRisk: 0.2,
    branchConfidence: 0.3,
    branchNovelty: 0.1,
  })
  check("high-value low-cost branch outscores low-value high-cost", great.roi > poor.roi && great.roi > 1)
  check("roi scoring is pure/deterministic", scoreBranchRoi(poor).roi === poor.roi)
  const plain = scoreBranchRoi({ ...great, branchId: "b1p", branchNovelty: 0.7, onCriticalPath: false })
  const crit = scoreBranchRoi({ ...great, branchId: "b1c", branchNovelty: 0.7, onCriticalPath: true })
  check("critical-path branches get ROI boost", crit.roi > plain.roi)
  check("scored rows carry reasons", great.reason.length > 0 && poor.reason.length > 0)
}

// ---- Req 3: hysteresis — single dips never cancel ----
{
  const poorInput = {
    branchId: "b2",
    expectedInformationGain: 0.1,
    expectedCompletionValue: 0.1,
    expectedVerificationValue: 0,
    expectedRemainingTime: 300,
    expectedRequests: 3,
    providerRisk: 0.2,
    branchConfidence: 0.3,
    branchNovelty: 0.1,
  }
  const tr = new BranchRoiTracker()
  tr.update(scoreBranchRoi(poorInput))
  const single = tr.decide().find((a) => a.branchId === "b2")
  check("single low score does NOT cancel", single?.action === "KEEP", JSON.stringify(single))
  tr.update(scoreBranchRoi(poorInput))
  tr.update(scoreBranchRoi(poorInput))
  const triple = tr.decide().find((a) => a.branchId === "b2")
  check("3 consecutive lows + real remaining time cancels", triple?.action === "CANCEL", JSON.stringify(triple))
  check("cancel reason cites the hysteresis evidence", (triple?.reason ?? "").includes("consecutive"))
}

// ---- Req 3/4: protected branches and priority moves ----
{
  const base = {
    expectedInformationGain: 0.1,
    expectedCompletionValue: 0.1,
    expectedVerificationValue: 0,
    expectedRemainingTime: 300,
    expectedRequests: 3,
    providerRisk: 0.2,
    branchConfidence: 0.3,
    branchNovelty: 0.1,
  }
  const tc = new BranchRoiTracker()
  for (let i = 0; i < 3; i++) tc.update(scoreBranchRoi({ ...base, branchId: "crit", onCriticalPath: true }))
  const critAction = tc.decide().find((a) => a.branchId === "crit")
  check(
    "critical-path branch survives 3 dips and is boosted",
    critAction?.action === "PRIORITY_UP" && critAction.reason.includes("critical path"),
    JSON.stringify(critAction),
  )

  const tn = new BranchRoiTracker()
  for (let i = 0; i < 3; i++) tn.update(scoreBranchRoi({ ...base, branchId: "novel", branchNovelty: 0.9 }))
  const novelAction = tn.decide().find((a) => a.branchId === "novel")
  check(
    "unique-evidence branch is never auto-cancelled",
    novelAction?.action === "PRIORITY_UP" && novelAction.reason.includes("unique evidence"),
    JSON.stringify(novelAction),
  )

  const td = new BranchRoiTracker()
  const mid = {
    expectedInformationGain: 0.3,
    expectedCompletionValue: 0.3,
    expectedVerificationValue: 0.3,
    expectedRemainingTime: 100,
    expectedRequests: 2,
    providerRisk: 0,
    branchConfidence: 0.5,
    branchNovelty: 0.6,
    branchId: "mid",
  }
  td.update(scoreBranchRoi(mid))
  td.update(scoreBranchRoi(mid))
  const downAction = td.decide().find((a) => a.branchId === "mid")
  check(
    "2 dips demote priority before any cancel is considered",
    downAction?.action === "PRIORITY_DOWN",
    JSON.stringify(downAction),
  )

  const te = new BranchRoiTracker()
  te.update(
    scoreBranchRoi({
      ...mid,
      branchId: "almost",
      expectedInformationGain: 0.6,
      expectedCompletionValue: 0.6,
      expectedVerificationValue: 0.6,
      expectedRemainingTime: 400,
    }),
  )
  te.update(
    scoreBranchRoi({
      ...mid,
      branchId: "almost",
      expectedInformationGain: 0.6,
      expectedCompletionValue: 0.6,
      expectedVerificationValue: 0.6,
      expectedRemainingTime: 80,
      branchConfidence: 0.7,
    }),
  )
  const upAction = te.decide().find((a) => a.branchId === "almost")
  check(
    "nearly-done confident branch gets PRIORITY_UP",
    upAction?.action === "PRIORITY_UP" && upAction.reason.includes("nearly done"),
    JSON.stringify(upAction),
  )

  const tf = new BranchRoiTracker()
  tf.update(scoreBranchRoi(poorRow("keepme")))
  const keepAction = tf.decide().find((a) => a.branchId === "keepme")
  check("actions always carry reasons", (keepAction?.reason ?? "").length > 0)

  function poorRow(branchId: string) {
    return {
      branchId,
      expectedInformationGain: 0.6,
      expectedCompletionValue: 0.6,
      expectedVerificationValue: 0.6,
      expectedRemainingTime: 60,
      expectedRequests: 2,
      providerRisk: 0,
      branchConfidence: 0.8,
      branchNovelty: 0.7,
    }
  }
}

// ---- Req 51: explainability ----
{
  const log = new DecisionLog(50)
  log.record({
    ts: 1,
    runId: "r1",
    decision: "topology=SMALL_SWARM",
    kind: "topology",
    reasons: ["serial gate failed", "speedup 1.9x"],
    data: { agents: 3 },
  })
  log.record({ ts: 2, runId: "r2", decision: "cancel=b2", kind: "roi", reasons: [] })
  const blocks = log.explain()
  check("decision log renders blocks", blocks.length === 2)
  check(
    "block format: DECISION header + reason bullets",
    blocks[0]!.startsWith("DECISION: topology=SMALL_SWARM") &&
      blocks[0]!.includes("reason:") &&
      blocks[0]!.includes("- serial gate failed"),
    blocks[0],
  )
  check("missing reasons are surfaced, not hidden", blocks[1]!.includes("no reasons recorded"), blocks[1])
  check("forRun filters decisions", log.forRun("r1").length === 1)
  check(
    "renderDecision standalone",
    renderDecision({ ts: 3, decision: "x", kind: "y", reasons: ["z"] }).includes("kind=y"),
  )
  let lines = 0
  const mirrored = new DecisionLog(5, () => {
    lines++
  })
  mirrored.record({ ts: 4, decision: "m", kind: "k", reasons: ["r"] })
  check("decision log mirrors entries to a sink", lines === 1)
}

console.log(`\n[learning] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
