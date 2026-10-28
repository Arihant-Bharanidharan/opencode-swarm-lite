/**
 * v3 integration + forecast tests: integration planning with conflict
 * classification (Req 15-17), failure-class risk (Req 34), information
 * gain per second (Req 35), capacity-free critical path with slack and
 * downstream work (Req 36), and opportunity cost (Req 37).
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next
 * statement starts with `{` (a bare section block). bun parses both fine.
 * All pinned values are hand-computed from the documented formulas.
 */
import { planIntegration } from "../src/runtime/integration.js"
import {
  FAILURE_CLASSES,
  FAILURE_PRIOR,
  FORECAST_HALF_LIFE_DAYS,
  MIN_DISCRIMINATION,
  chooseInformationGain,
  criticalPathReport,
  forecastFailureRisk,
  opportunityCost,
} from "../src/runtime/forecast.js"
import type { FailureObservation } from "../src/runtime/forecast.js"
import type { BranchChange, InformationGainOption } from "../src/runtime/types.js"

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

const br = (over: Partial<BranchChange> & { branchId: string }): BranchChange => {
  return {
    branchId: over.branchId,
    filesChanged: over.filesChanged ?? [],
    symbolsChanged: over.symbolsChanged ?? [],
    testFiles: over.testFiles,
    dependsOnSymbols: over.dependsOnSymbols,
  }
}

const obs = (over: Partial<FailureObservation> = {}): FailureObservation => {
  return { status: "ok", ...over }
}

const ig = (id: string, costSeconds: number, discriminationPower: number, distinguishes: string[]): InformationGainOption => {
  return { id, costSeconds, discriminationPower, distinguishes }
}

// ---- Req 15: the integration planner ----
{
  const plan = planIntegration([
    br({ branchId: "auth", filesChanged: ["src/auth.ts"], symbolsChanged: ["signIn"] }),
    br({ branchId: "cache", filesChanged: ["src/cache.ts"], symbolsChanged: ["memoize"] }),
  ])
  check(
    "disjoint branches: zero conflicts, both independent, sorted order",
    plan.conflicts.length === 0 &&
      plan.semanticConflicts === 0 &&
      plan.independentBranches.length === 2 &&
      plan.independentBranches[0] === "auth" &&
      JSON.stringify(plan.order) === JSON.stringify(["auth", "cache"]),
    JSON.stringify(plan),
  )
  check(
    "a conflict-free plan says every branch can merge independently",
    plan.reasons.some((r) => r.includes("independently")),
    JSON.stringify(plan.reasons),
  )

  const empty = planIntegration([])
  check(
    "empty input: an empty plan with an honest reason",
    empty.order.length === 0 &&
      empty.independentBranches.length === 0 &&
      empty.conflicts.length === 0 &&
      empty.semanticConflicts === 0 &&
      empty.reasons.length === 1 &&
      empty.reasons[0]!.includes("no branch changes to integrate"),
    JSON.stringify(empty),
  )

  const reordered = planIntegration([
    br({ branchId: "cache", filesChanged: ["src/cache.ts"], symbolsChanged: ["memoize"] }),
    br({ branchId: "auth", filesChanged: ["src/auth.ts"], symbolsChanged: ["signIn"] }),
  ])
  check(
    "the planner is deterministic regardless of input order",
    JSON.stringify(reordered) === JSON.stringify(plan),
  )

  const depOrder = planIntegration([
    br({ branchId: "alpha", filesChanged: ["src/api.ts"], symbolsChanged: ["handler"], dependsOnSymbols: ["connect"] }),
    br({ branchId: "zeta", filesChanged: ["src/db.ts"], symbolsChanged: ["connect"] }),
  ])
  check(
    "providers integrate before consumers, even against alphabetical order",
    depOrder.order[0] === "zeta" && depOrder.order[1] === "alpha" && depOrder.independentBranches.length === 0,
    JSON.stringify(depOrder.order),
  )

  const chain = planIntegration([
    br({ branchId: "c", dependsOnSymbols: ["sB"] }),
    br({ branchId: "b", symbolsChanged: ["sB"], dependsOnSymbols: ["sA"] }),
    br({ branchId: "a", symbolsChanged: ["sA"] }),
  ])
  check(
    "a dependency chain integrates in topological order",
    JSON.stringify(chain.order) === JSON.stringify(["a", "b", "c"]),
    JSON.stringify(chain.order),
  )

  const soloFirst = planIntegration([
    br({ branchId: "x2", filesChanged: ["src/shared.ts"], symbolsChanged: ["f"] }),
    br({ branchId: "solo", filesChanged: ["src/solo.ts"], symbolsChanged: ["soloFn"] }),
    br({ branchId: "x1", filesChanged: ["src/shared.ts"], symbolsChanged: ["f"] }),
  ])
  check(
    "conflict-free branches integrate before conflicted ones",
    soloFirst.order[0] === "solo" &&
      soloFirst.independentBranches.length === 1 &&
      soloFirst.independentBranches[0] === "solo",
    JSON.stringify(soloFirst.order),
  )
}

// ---- Req 16: conflict classification before the merge ----
{
  const safe = planIntegration([
    br({ branchId: "fmt", filesChanged: ["src/util.ts"], symbolsChanged: ["fmtDate"] }),
    br({ branchId: "parse", filesChanged: ["src/util.ts"], symbolsChanged: ["parseDate"] }),
  ])
  check(
    "same file, disjoint symbols is a SAFE auto-resolvable overlap",
    safe.conflicts.length === 1 &&
      safe.conflicts[0]!.kind === "SAFE" &&
      safe.conflicts[0]!.autoResolvable &&
      !safe.conflicts[0]!.requiresReview &&
      JSON.stringify(safe.conflicts[0]!.files) === JSON.stringify(["src/util.ts"]) &&
      safe.conflicts[0]!.symbols.length === 0,
    JSON.stringify(safe.conflicts),
  )

  const testOnly = planIntegration([
    br({ branchId: "a-tests", filesChanged: ["src/a.ts"], testFiles: ["test/a.test.ts"] }),
    br({ branchId: "b-tests", filesChanged: ["src/b.ts"], testFiles: ["test/a.test.ts"] }),
  ])
  check(
    "a shared test file only is SAFE and the file is named",
    testOnly.conflicts.length === 1 &&
      testOnly.conflicts[0]!.kind === "SAFE" &&
      JSON.stringify(testOnly.conflicts[0]!.files) === JSON.stringify(["test/a.test.ts"]),
    JSON.stringify(testOnly.conflicts),
  )

  const textual = planIntegration([
    br({ branchId: "t1", filesChanged: ["src/api.ts"], symbolsChanged: ["handleAuth", "extra"] }),
    br({ branchId: "t2", filesChanged: ["src/api.ts"], symbolsChanged: ["handleAuth"] }),
  ])
  check(
    "the same symbol in the same file is a TEXTUAL conflict that requires review",
    textual.conflicts.length === 1 &&
      textual.conflicts[0]!.kind === "TEXTUAL" &&
      !textual.conflicts[0]!.autoResolvable &&
      textual.conflicts[0]!.requiresReview &&
      JSON.stringify(textual.conflicts[0]!.symbols) === JSON.stringify(["handleAuth"]),
    JSON.stringify(textual.conflicts),
  )
  check(
    "the TEXTUAL reason names the exact file and symbol",
    textual.conflicts[0]!.reason.includes("src/api.ts") &&
      textual.conflicts[0]!.reason.includes("handleAuth"),
    textual.conflicts[0]!.reason,
  )

  const dup = planIntegration([
    br({ branchId: "d1", filesChanged: ["src/a.ts"], symbolsChanged: ["Config"] }),
    br({ branchId: "d2", filesChanged: ["src/b.ts"], symbolsChanged: ["Config"] }),
  ])
  check(
    "the same symbol defined in two different files is SEMANTIC (duplicate definition)",
    dup.conflicts.length === 1 &&
      dup.conflicts[0]!.kind === "SEMANTIC" &&
      dup.semanticConflicts === 1 &&
      dup.conflicts[0]!.files.length === 0 &&
      JSON.stringify(dup.conflicts[0]!.symbols) === JSON.stringify(["Config"]) &&
      dup.conflicts[0]!.requiresReview,
    JSON.stringify(dup.conflicts),
  )

  const consumed = planIntegration([
    br({ branchId: "db", filesChanged: ["src/db.ts"], symbolsChanged: ["connect"] }),
    br({ branchId: "api", filesChanged: ["src/api.ts"], symbolsChanged: ["handler"], dependsOnSymbols: ["connect"] }),
  ])
  check(
    "changing a symbol another branch consumes is SEMANTIC despite disjoint files",
    consumed.conflicts.length === 1 &&
      consumed.conflicts[0]!.kind === "SEMANTIC" &&
      JSON.stringify(consumed.conflicts[0]!.symbols) === JSON.stringify(["connect"]) &&
      consumed.conflicts[0]!.reason.includes("api") &&
      consumed.conflicts[0]!.reason.includes("connect"),
    JSON.stringify(consumed.conflicts),
  )
}

// ---- Req 17: every pair reported, guidance attached, cycles contained ----
{
  const mixed = planIntegration([
    br({ branchId: "A", filesChanged: ["src/x.ts"], symbolsChanged: ["shared"] }),
    br({ branchId: "B", filesChanged: ["src/x.ts"], symbolsChanged: ["shared"] }),
    br({ branchId: "C", filesChanged: ["src/c.ts"], dependsOnSymbols: ["shared"] }),
    br({ branchId: "D", filesChanged: ["src/util.ts"], symbolsChanged: ["u1"] }),
    br({ branchId: "E", filesChanged: ["src/util.ts"], symbolsChanged: ["u2"] }),
  ])
  check(
    "every overlapping pair is classified: 1 TEXTUAL + 2 SEMANTIC + 1 SAFE",
    mixed.conflicts.length === 4 &&
      mixed.semanticConflicts === 2 &&
      mixed.conflicts.filter((c) => c.kind === "TEXTUAL").length === 1 &&
      mixed.conflicts.filter((c) => c.kind === "SAFE").length === 1,
    JSON.stringify(mixed.conflicts.map((c) => [c.branches, c.kind])),
  )
  check(
    "autoResolvable is exactly the negation of requiresReview",
    mixed.conflicts.every((c) => c.autoResolvable === !c.requiresReview),
  )
  check(
    "every conflict carries a reason, a sorted pair, and a real overlap",
    mixed.conflicts.every(
      (c) =>
        c.reason.length > 0 &&
        c.branches.length === 2 &&
        c.branches[0]! < c.branches[1]! &&
        (c.files.length > 0 || c.symbols.length > 0),
    ),
  )

  const triangle = planIntegration([
    br({ branchId: "m1", filesChanged: ["src/x.ts"], symbolsChanged: ["f"] }),
    br({ branchId: "m2", filesChanged: ["src/x.ts"], symbolsChanged: ["f"] }),
    br({ branchId: "m3", filesChanged: ["src/x.ts"], symbolsChanged: ["f"] }),
  ])
  check(
    "three mutually overlapping branches produce all three pairs - nothing merges silently",
    triangle.conflicts.length === 3 && triangle.conflicts.every((c) => c.kind === "TEXTUAL"),
    JSON.stringify(triangle.conflicts.map((c) => c.branches)),
  )

  const cyc = planIntegration([
    br({ branchId: "p", symbolsChanged: ["sP"], dependsOnSymbols: ["sQ"] }),
    br({ branchId: "q", symbolsChanged: ["sQ"], dependsOnSymbols: ["sP"] }),
  ])
  check(
    "a dependency cycle is reported and ordered deterministically by id",
    cyc.order.length === 2 &&
      cyc.order[0] === "p" &&
      cyc.order[1] === "q" &&
      cyc.reasons.some((r) => r.includes("cycle")),
    JSON.stringify({ order: cyc.order, reasons: cyc.reasons }),
  )
  check(
    "a cyclic pair surfaces its mutual semantic breakage",
    cyc.conflicts.length === 1 &&
      cyc.conflicts[0]!.kind === "SEMANTIC" &&
      JSON.stringify(cyc.conflicts[0]!.symbols) === JSON.stringify(["sP", "sQ"]),
    JSON.stringify(cyc.conflicts),
  )
  const cycAgain = planIntegration([
    br({ branchId: "q", symbolsChanged: ["sQ"], dependsOnSymbols: ["sP"] }),
    br({ branchId: "p", symbolsChanged: ["sP"], dependsOnSymbols: ["sQ"] }),
  ])
  check("cycle handling is deterministic", JSON.stringify(cycAgain) === JSON.stringify(cyc))
}

// ---- Req 34: failure-class forecast ----
{
  check(
    "the forecast covers exactly the 8 failure classes",
    FAILURE_CLASSES.length === 8,
    String(FAILURE_CLASSES.length),
  )
  check(
    "policy constants: 14-day half-life, Laplace prior 1, MIN_DISCRIMINATION 0.1",
    FORECAST_HALF_LIFE_DAYS === 14 && FAILURE_PRIOR === 1 && MIN_DISCRIMINATION === 0.1,
  )

  const none = forecastFailureRisk([])
  check(
    "no evidence yields the uniform prior: every class exactly 0.125",
    FAILURE_CLASSES.every((c) => none[c] === 0.125),
    JSON.stringify(none),
  )
  check(
    "uniform risks sum to exactly 1",
    Object.values(none).reduce((a, b) => a + b, 0) === 1,
  )

  const one = forecastFailureRisk([obs({ status: "429", failureClass: "rate_limit" })])
  check(
    "a single rate-limit failure concentrates risk: 0.222 vs 0.111 elsewhere",
    one["rate_limit"] === 0.222 && one["logic_failure"] === 0.111,
    JSON.stringify(one),
  )
  const oneSum = Object.values(one).reduce((a, b) => a + b, 0)
  check("risks still sum to ~1 after evidence", oneSum > 0.99 && oneSum < 1.001, String(oneSum))

  const diluted = forecastFailureRisk([
    obs({ status: "429", failureClass: "rate_limit" }),
    obs({}),
    obs({}),
    obs({}),
  ])
  check(
    "successes dilute per-class risk: 0.167 vs 0.083",
    diluted["rate_limit"] === 0.167 && diluted["tool_failure"] === 0.083,
    JSON.stringify(diluted),
  )

  const old = forecastFailureRisk([obs({ status: "429", failureClass: "rate_limit", ageDays: 28 })])
  check(
    "a 28-day-old failure weighs 0.25 (14-day half-life): 0.152 vs 0.121",
    old["rate_limit"] === 0.152 && old["dependency_issue"] === 0.121,
    JSON.stringify(old),
  )

  const blend = forecastFailureRisk([
    obs({ status: "429", failureClass: "rate_limit" }),
    obs({ status: "429", failureClass: "rate_limit", ageDays: 28 }),
  ])
  check(
    "recent evidence dominates old evidence: 0.243 vs 0.108",
    blend["rate_limit"] === 0.243 && blend["context_failure"] === 0.108,
    JSON.stringify(blend),
  )

  const unclassified = forecastFailureRisk([obs({ status: "error" })])
  check(
    "an unclassified failure still counts in the denominator: 0.111 everywhere",
    FAILURE_CLASSES.every((c) => unclassified[c] === 0.111),
    JSON.stringify(unclassified),
  )

  check(
    "the forecast is deterministic",
    JSON.stringify(blend) ===
      JSON.stringify(
        forecastFailureRisk([
          obs({ status: "429", failureClass: "rate_limit", ageDays: 28 }),
          obs({ status: "429", failureClass: "rate_limit" }),
        ]),
      ),
  )
}

// ---- Req 35: information gain per second ----
{
  const win = chooseInformationGain(
    [ig("o_big", 100, 1.0, ["h1", "h2", "h3"]), ig("o_a", 10, 0.5, ["h1"])],
    1000,
  )
  check(
    "the best separation-per-second wins, not the most powerful experiment",
    win.chosen === "o_a" && win.expectedReduction === 0.5,
    JSON.stringify(win),
  )
  check(
    "the reason names the winner, its cost, and the runner-up",
    win.reason.includes("o_a") && win.reason.includes("10") && win.reason.includes("o_big"),
    win.reason,
  )

  const weak = chooseInformationGain([ig("weak", 10, 0.05, ["h1"])], 1000)
  check(
    "an experiment too weak to change any decision is rejected",
    weak.chosen === null && weak.expectedReduction === 0,
    JSON.stringify(weak),
  )

  const broke = chooseInformationGain([ig("pricey", 10, 0.9, ["h1"])], 5)
  check(
    "an unaffordable experiment is an honest null that names the budget",
    broke.chosen === null && broke.reason.includes("budget"),
    JSON.stringify(broke),
  )

  const offered = chooseInformationGain([], 100)
  check(
    "no offered experiments -> null with a reason",
    offered.chosen === null && offered.reason.length > 0,
    JSON.stringify(offered),
  )

  const fake = chooseInformationGain(
    [ig("free", 0, 0.9, ["h1"]), ig("distinguishes-nothing", 10, 0.9, [])],
    100,
  )
  check(
    "zero-cost probes and experiments distinguishing nothing are never chosen",
    fake.chosen === null,
    JSON.stringify(fake),
  )

  const tie = chooseInformationGain([ig("o2", 10, 0.5, ["h1"]), ig("o1", 10, 0.5, ["h1"])], 100)
  check("ties break by lower cost then by id", tie.chosen === "o1", JSON.stringify(tie))

  const clamped = chooseInformationGain([ig("big", 10, 5, ["h1"])], 100)
  check(
    "discrimination power is clamped to [0,1]: 5 acts as 1.0",
    clamped.chosen === "big" && clamped.expectedReduction === 1,
    JSON.stringify(clamped),
  )
  const negative = chooseInformationGain([ig("neg", 10, -3, ["h1"])], 100)
  check("negative discrimination power is rejected", negative.chosen === null, JSON.stringify(negative))
}

// ---- Req 36: capacity-free critical path ----
{
  const diamondNodes = [
    { id: "a", remainingTime: 10 },
    { id: "b", remainingTime: 30 },
    { id: "c", remainingTime: 20 },
    { id: "d", remainingTime: 5 },
  ]
  const diamondEdges: Array<[string, string]> = [
    ["a", "b"],
    ["a", "c"],
    ["b", "d"],
    ["c", "d"],
  ]
  const diamond = criticalPathReport(diamondNodes, diamondEdges)
  check(
    "the critical path is the longest chain: a,b,d = 45s",
    JSON.stringify(diamond.criticalPath) === JSON.stringify(["a", "b", "d"]) &&
      diamond.estimatedCriticalPathTime === 45,
    JSON.stringify(diamond.criticalPath),
  )
  const byId = new Map(diamond.nodes.map((n) => [n.id, n]))
  check(
    "off-path slack is quantified: c can slip 10s, critical nodes slip 0",
    byId.get("c")!.slack === 10 &&
      !byId.get("c")!.critical &&
      byId.get("a")!.slack === 0 &&
      byId.get("b")!.slack === 0 &&
      byId.get("d")!.slack === 0,
    JSON.stringify(diamond.nodes),
  )
  check(
    "downstreamBlockedWork sums ALL work waiting behind a node",
    byId.get("a")!.downstreamBlockedWork === 55 &&
      byId.get("b")!.downstreamBlockedWork === 5 &&
      byId.get("c")!.downstreamBlockedWork === 5 &&
      byId.get("d")!.downstreamBlockedWork === 0,
    JSON.stringify(diamond.nodes.map((n) => [n.id, n.downstreamBlockedWork])),
  )

  const loner = criticalPathReport([...diamondNodes, { id: "e", remainingTime: 3 }], diamondEdges)
  const e = loner.nodes.find((n) => n.id === "e")!
  check(
    "an isolated node blocks nothing and carries the full slack",
    e.slack === 42 && e.downstreamBlockedWork === 0 && !e.critical,
    JSON.stringify(e),
  )

  const cycle = criticalPathReport(
    [
      { id: "p", remainingTime: 10 },
      { id: "q", remainingTime: 20 },
    ],
    [
      ["p", "q"],
      ["q", "p"],
    ],
  )
  check(
    "a dependency cycle is contained: members critical, worst-case time, no hang",
    JSON.stringify(cycle.criticalPath) === JSON.stringify(["p", "q"]) &&
      cycle.estimatedCriticalPathTime === 30 &&
      cycle.nodes.every((n) => n.critical && n.slack === 0),
    JSON.stringify(cycle),
  )

  const lone = criticalPathReport([{ id: "only", remainingTime: 7 }], [])
  check(
    "a lone branch is trivially critical",
    JSON.stringify(lone.criticalPath) === JSON.stringify(["only"]) &&
      lone.estimatedCriticalPathTime === 7 &&
      lone.nodes[0]!.critical,
    JSON.stringify(lone),
  )

  const none = criticalPathReport([], [])
  check(
    "an empty graph reports an empty critical path",
    none.criticalPath.length === 0 && none.estimatedCriticalPathTime === 0 && none.nodes.length === 0,
  )

  check(
    "the report is deterministic",
    JSON.stringify(diamond) === JSON.stringify(criticalPathReport([...diamondNodes], [...diamondEdges])),
  )
}

// ---- Req 37: opportunity cost ----
{
  const cost = opportunityCost(
    { id: "chosen", seconds: 300 },
    [
      { id: "spec", seconds: 200 },
      { id: "batch", seconds: 250 },
    ],
  )
  check(
    "a faster foregone alternative costs exactly the gap",
    cost.seconds === 100 && cost.reason.includes("spec") && cost.reason.includes("chosen"),
    JSON.stringify(cost),
  )

  const best = opportunityCost({ id: "chosen", seconds: 180 }, [{ id: "spec", seconds: 200 }])
  check(
    "choosing the fastest path costs nothing, and says so",
    best.seconds === 0 && best.reason.includes("nothing faster"),
    JSON.stringify(best),
  )

  const none = opportunityCost({ id: "chosen", seconds: 300 }, [])
  check(
    "no alternatives -> zero cost with an honest reason",
    none.seconds === 0 && none.reason.includes("no alternatives"),
    JSON.stringify(none),
  )

  const tie = opportunityCost(
    { id: "chosen", seconds: 300 },
    [
      { id: "spec", seconds: 200 },
      { id: "batch", seconds: 200 },
    ],
  )
  check(
    "tied alternatives name the deterministic id-ordered winner",
    tie.seconds === 100 && tie.reason.includes("batch") && !tie.reason.includes("spec"),
    JSON.stringify(tie),
  )

  const mirror = opportunityCost({ id: "chosen", seconds: 300 }, [{ id: "chosen", seconds: 100 }])
  check(
    "the chosen path never competes with itself",
    mirror.seconds === 0,
    JSON.stringify(mirror),
  )
}

console.log(`\n[integration] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
