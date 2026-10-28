/**
 * Straggler assessment and hedged execution (Req 27-28).
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import { assessStraggler, decideHedge, HedgeCoordinator } from "../src/runtime/straggler.js"
import type { StragglerInput } from "../src/runtime/types.js"

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

function mkInput(over: Partial<StragglerInput> = {}): StragglerInput {
  return {
    branchId: "b",
    elapsedSeconds: 100,
    expectedSeconds: 100,
    progressEvents: 0,
    toolActivity: 0,
    ...over,
  }
}

// ---- Req 27: false-positive avoidance -- active-but-overdue lanes are never hedged ----
{
  // Active (progress events + tool activity) but 2x overdue: continue, never hedge.
  const activeOverdue = assessStraggler(mkInput({ elapsedSeconds: 200, expectedSeconds: 100, progressEvents: 8, toolActivity: 4 }))
  check(
    "active-but-overdue at 2x continues and is not hedged",
    activeOverdue.action === "continue" &&
      activeOverdue.stragglerRisk < 0.5 &&
      /benefit is 0/.test(activeOverdue.reason) &&
      /no hedge/.test(activeOverdue.reason),
    JSON.stringify(activeOverdue),
  )

  // Active but deep into straggler territory (4x): still active, still never hedged.
  const activeDeep = assessStraggler(mkInput({ elapsedSeconds: 400, expectedSeconds: 100, progressEvents: 3, toolActivity: 1 }))
  check(
    "active-but-overdue at 4x still has benefit 0 and is not hedged",
    activeDeep.action === "continue" && /benefit is 0/.test(activeDeep.reason),
    JSON.stringify(activeDeep),
  )

  // Within the 1.5x envelope and active: plain continue.
  const within = assessStraggler(mkInput({ elapsedSeconds: 140, expectedSeconds: 100, progressEvents: 2 }))
  check("within envelope and active continues", within.action === "continue" && within.stragglerRisk < 0.4)

  // Silent but within the envelope: checkpoint, not hedge.
  const quiet = assessStraggler(mkInput({ elapsedSeconds: 140, expectedSeconds: 100 }))
  check("quiet-but-within-envelope checkpoints instead of hedging", quiet.action === "checkpoint")

  // Silent and beyond the envelope: checkpoint first (not a hedge yet).
  const silentOver = assessStraggler(mkInput({ elapsedSeconds: 200, expectedSeconds: 100, lastProgressSeconds: 200 }))
  check("silent beyond envelope checkpoints", silentOver.action === "checkpoint")

  // Silent stall beyond the envelope: hedge.
  const stalled = assessStraggler(mkInput({ elapsedSeconds: 200, expectedSeconds: 100, lastProgressSeconds: 50 }))
  check("silent stall beyond envelope is hedged", stalled.action === "hedge")

  // Deep silent stall: replace.
  const deep = assessStraggler(mkInput({ elapsedSeconds: 400, expectedSeconds: 100, lastProgressSeconds: 10 }))
  check("deep silent stall is replaced", deep.action === "replace" && deep.stragglerRisk >= 0.9)
}

// ---- Req 28: decideHedge -- hedge only when expected saved latency > cost ----
{
  const good = decideHedge({ expectedLatencySeconds: 300, hedgeLatencySeconds: 60, hedgeCostSeconds: 40 })
  check("saved latency 240 > cost 40 => hedge", good.hedge === true)
  check("expectedBenefitSeconds is gross saved latency", good.expectedBenefitSeconds === 240)
  check("expectedCostSeconds is the hedge cost", good.expectedCostSeconds === 40)

  const expensive = decideHedge({ expectedLatencySeconds: 100, hedgeLatencySeconds: 80, hedgeCostSeconds: 50 })
  check("saved 20 <= cost 50 => no hedge", expensive.hedge === false && expensive.expectedBenefitSeconds === 20)

  const slower = decideHedge({ expectedLatencySeconds: 100, hedgeLatencySeconds: 150, hedgeCostSeconds: 10 })
  check("hedge slower than incumbent => saved <= 0 => no hedge", slower.hedge === false && slower.expectedBenefitSeconds === 0)

  const conf = decideHedge({ expectedLatencySeconds: 300, hedgeLatencySeconds: 60, hedgeCostSeconds: 200, hedgeConfidence: 0.5 })
  check("confidence discounts benefit: 120 <= 200 => no hedge", conf.hedge === false && conf.expectedBenefitSeconds === 120)

  const edge = decideHedge({ expectedLatencySeconds: 100, hedgeLatencySeconds: 90, hedgeCostSeconds: 10 })
  check("strictly greater: 10 saved vs 10 cost => no hedge", edge.hedge === false)

  const barely = decideHedge({ expectedLatencySeconds: 100, hedgeLatencySeconds: 89, hedgeCostSeconds: 10 })
  check("11 saved > 10 cost => hedge", barely.hedge === true)
}

// ---- Req 28: HedgeCoordinator -- first valid completion wins, clean cancel, dedupe ----
{
  const cancelled: string[] = []
  const completed: string[] = []
  const c = new HedgeCoordinator({
    onCancel: (id) => cancelled.push(id),
    onComplete: (id) => completed.push(id),
  })
  c.register("a")
  c.register("b")
  c.register("c")
  check("three lanes registered", c.size() === 3)

  // Lane b finishes first and validly: it wins; a and c are cancelled cleanly.
  const rb = c.complete("b", { answer: 42 }, true)
  check("first valid completion wins", rb.won === true && rb.duplicate === false)
  check("onComplete fired once for the winner", completed.join(",") === "b")
  check("losers cancelled exactly once each", cancelled.sort().join(",") === "a,c")
  check("result reports winner b", c.result().winnerId === "b" && c.result().decided === true && (c.result().result as { answer: number })?.answer === 42)
  check("winner not cancelled", c.isCancelled("b") === false)
  check("losers marked cancelled", c.isCancelled("a") === true && c.isCancelled("c") === true)
  check("losers marked completed=false", c.isCompleted("a") === false && c.isCompleted("c") === false)

  // The loser's late completion is deduplicated: no second win, no new cancel.
  const late = c.complete("a", { answer: 99 }, true)
  check("late valid completion is deduplicated", late.won === false && late.duplicate === true)
  check("winner unchanged after late completion", c.result().winnerId === "b")
  check("no extra cancel for the late loser", cancelled.filter((id) => id === "a").length === 1)

  // cancel() is idempotent.
  const ca1 = c.cancel("a")
  check("re-cancelling a cancelled lane is a no-op", ca1.cancelled === false && ca1.alreadyCancelled === true)
  const ca2 = c.cancel("a")
  check("third cancel is also a no-op", ca2.cancelled === false && ca2.alreadyCancelled === true)
  check("cancel events are not duplicated", cancelled.filter((id) => id === "a").length === 1)

  // Event log: exactly one completion, one cancel per loser, dedupes recorded.
  const ev = c.events()
  check("exactly one completion event", ev.filter((e) => e.type === "completion").length === 1)
  check("one cancel per loser", ev.filter((e) => e.type === "cancel" && e.branchId === "a").length === 1)
  check("one cancel per loser c", ev.filter((e) => e.type === "cancel" && e.branchId === "c").length === 1)
  check("late completion recorded as dedupe", ev.filter((e) => e.type === "dedupe" && e.branchId === "a").length >= 1)
}

// ---- Invalid completions never win; the other lane still wins ----
{
  const c = new HedgeCoordinator()
  c.register("x")
  c.register("y")
  const bad = c.complete("x", null, false)
  check("invalid completion does not win", bad.won === false && bad.duplicate === false)
  const good = c.complete("y", "ok", true)
  check("other lane still wins", good.won === true && c.result().winnerId === "y")

  // A duplicate completion on the same lane is deduped too.
  const dup = c.complete("y", "ok-again", true)
  check("repeat completion on the winner is deduped", dup.won === false && dup.duplicate === true)
}

// ---- No lanes registered: completes/cancels are safe no-ops ----
{
  const c = new HedgeCoordinator()
  const r = c.complete("missing", "x", true)
  check("completing an unregistered lane is a safe no-op", r.won === false && r.duplicate === false)
  const cx = c.cancel("missing")
  check("cancelling an unregistered lane is a safe no-op", cx.cancelled === false && cx.alreadyCancelled === false)
  check("nothing decided", c.result().decided === false)
}

console.log(`\n[straggler] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
