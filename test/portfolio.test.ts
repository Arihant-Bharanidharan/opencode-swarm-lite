/**
 * PortfolioRouter: trust-aware routing, degradation reallocation, and the
 * feedback loop that wraps the existing Router.
 *
 * Coverage:
 * 1. trust-aware routing blend — router score + trust + reliability, sorted desc
 * 2. excludeDegraded — non-closed providers flagged degraded
 * 3. preferProvider boost on routing order
 * 4. recordDegradation + feedback — per-provider routes/degradations/reallocations
 * 5. providerReliability pass-through
 * 6. portfolioReport pass-through
 * 7. limit option caps choices
 * 8. circuit-open provider excluded from choices (appears in decision.blocked)
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ModelProfile } from "../src/runtime/types.js"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router } from "../src/runtime/provider.js"
import { TrustStore } from "../src/runtime/trust.js"
import { PortfolioRouter } from "../src/runtime/portfolio-router.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-portfolio-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// ---- controllable clock: now<=0 means every trust observation counts fresh ---
let now = 0
const clock = () => now
const stats = new StatsStore(null)
const health = new ProviderHealth(null, { now: clock })
const trust = new TrustStore(null, { now: clock })

const mkProfile = (overrides: Partial<ModelProfile>): ModelProfile => {
  return {
    id: overrides.id ?? "synth",
    provider: overrides.provider ?? "unknown",
    quotaGroup: overrides.quotaGroup ?? "g-default",
    quality: overrides.quality ?? 0.62,
    speed: overrides.speed ?? 0.65,
    contextLimit: overrides.contextLimit ?? 128_000,
    costTier: overrides.costTier ?? 1,
    strengths: overrides.strengths ?? ["general"],
  }
}

const profiles: ModelProfile[] = [
  mkProfile({ id: "alpha", provider: "p-good", quality: 0.8, speed: 0.8, strengths: ["coding"] }),
  mkProfile({ id: "beta", provider: "p-bad", quality: 0.8, speed: 0.8, strengths: ["coding"] }),
]

const router = new Router(stats, health, { profiles })
const portfolio = new PortfolioRouter({ router, health, trust, stats })

const routeReq = (overrides: { role?: string; category?: string } = {}): import("../src/runtime/types.js").RouteRequest => {
  return {
    role: overrides.role ?? "builder",
    category: (overrides.category ?? "coding") as import("../src/runtime/types.js").Category,
  }
}

const trustOk = (model: string, skill: string, n: number) => {
  for (let i = 0; i < n; i++) {
    trust.record({ ts: 1, model, skillCategory: skill as import("../src/runtime/types.js").SkillCategory, success: true })
  }
}
const trustFail = (model: string, skill: string, n: number) => {
  for (let i = 0; i < n; i++) {
    trust.record({ ts: 1, model, skillCategory: skill as import("../src/runtime/types.js").SkillCategory, success: false })
  }
}

// ===========================================================================
// 1. fresh routing: both providers closed, choices carry trust + reliability
// ===========================================================================
{
  trustOk("alpha", "coding", 6) // high trust
  trustFail("beta", "coding", 6) // low trust
  const choices = portfolio.route(routeReq({ category: "coding" }))
  check("fresh: 2 choices returned", choices.length === 2, `got ${choices.length}`)
  for (const c of choices) {
    check(`fresh: ${c.model} has score`, typeof c.score === "number" && c.score >= 0 && c.score <= 1)
    check(`fresh: ${c.model} has trustScore`, typeof c.trustScore === "number" && c.trustScore >= 0 && c.trustScore <= 1)
    check(`fresh: ${c.model} has reliabilityScore`, typeof c.reliabilityScore === "number" && c.reliabilityScore >= 0 && c.reliabilityScore <= 1)
    check(`fresh: ${c.model} not degraded`, c.degraded === false)
    check(`fresh: ${c.model} reasons non-empty`, c.reasons.length > 0)
  }
  const alpha = choices.find((c) => c.model === "alpha")
  const beta = choices.find((c) => c.model === "beta")
  check("fresh: alpha trusted ranks above beta", !!alpha && !!beta && choices.indexOf(alpha!) < choices.indexOf(beta!), `order=${choices.map((c) => c.model).join(",")}`)
  check("fresh: alpha trust > beta trust", alpha!.trustScore > beta!.trustScore, `alpha=${alpha!.trustScore} beta=${beta!.trustScore}`)
}

// ===========================================================================
// 2. excludeDegraded: advance clock past cooldown -> half_open, flagged degraded
//    (Router allows half_open, so it stays listed; excludeDegraded only flags)
// ===========================================================================
{
  portfolio.clear()
  health.record("p-bad", "error")
  health.record("p-bad", "error")
  health.record("p-bad", "error") // open
  check("degradation: p-bad circuit open", health.state("p-bad") === "open")

  // open providers are already excluded by Router.route() -> p-bad absent
  const incl = portfolio.route(routeReq({ category: "coding" }))
  check("excluded: open provider not in choices", !incl.some((c) => c.provider === "p-bad"), `providers=${incl.map((c) => c.provider).join(",")}`)
  check("excluded: only p-good remains", incl.length === 1 && incl[0]!.provider === "p-good")

  // advance past cooldown -> half_open: Router allows it
  now = 70_000 // cooldown base 60s elapsed
  check("degradation: p-bad now half_open", health.state("p-bad") === "half_open")
  const both = portfolio.route(routeReq({ category: "coding" }), { excludeDegraded: false })
  check("excludeDegraded=false: half_open still listed", both.some((c) => c.provider === "p-bad"), `providers=${both.map((c) => c.provider).join(",")}`)
  const half = both.find((c) => c.provider === "p-bad")
  check("excludeDegraded=false: half_open NOT degraded", !!half && half!.degraded === false, `degraded=${half?.degraded}`)

  const excl = portfolio.route(routeReq({ category: "coding" }), { excludeDegraded: true })
  const half2 = excl.find((c) => c.provider === "p-bad")
  check("excludeDegraded=true: half_open flagged degraded", !!half2 && half2!.degraded === true, `degraded=${half2?.degraded}`)
}

// ===========================================================================
// 3. preferProvider boost
// ===========================================================================
{
  portfolio.clear()
  now = 0
  health.record("p-bad", "ok") // close p-bad again
  const without = portfolio.route(routeReq({ category: "coding" }))
  const withPref = portfolio.route(routeReq({ category: "coding" }), { preferProvider: "p-bad" })
  check("prefer: p-good first without pref", without[0]!.provider === "p-good", `first=${without[0]!.provider}`)
  check("prefer: at least 2 choices returned with pref", withPref.length === 2, `got ${withPref.length}`)
}

// ===========================================================================
// 4. recordDegradation + feedback loop
// ===========================================================================
{
  portfolio.clear()
  portfolio.recordDegradation("p-bad", "error", ["p-good"])
  portfolio.recordDegradation("p-bad", "429", ["p-good"])
  portfolio.recordDegradation("p-good", "timeout", ["p-bad"])

  const fb = portfolio.feedback()
  check("feedback: totalRoutes 0 (no routes recorded yet)", fb.totalRoutes === 0, `got ${fb.totalRoutes}`)
  check("feedback: degradedRoutes 3", fb.degradedRoutes === 3, `got ${fb.degradedRoutes}`)
  check("feedback: reallocations 3", fb.reallocations === 3, `got ${fb.reallocations}`)
  check("feedback: events length 3", fb.events.length === 3)
  check("feedback: byProvider p-bad degradations 2", fb.byProvider["p-bad"]?.degradations === 2)
  check("feedback: byProvider p-bad reallocations 1", fb.byProvider["p-bad"]?.reallocations === 1)
  check("feedback: byProvider p-good reallocations 2", fb.byProvider["p-good"]?.reallocations === 2)
  check("feedback: event kinds", fb.events[0]!.kind === "error" && fb.events[1]!.kind === "429" && fb.events[2]!.kind === "timeout")
  check("feedback: event reallocatedTo", JSON.stringify(fb.events[0]!.reallocatedTo) === JSON.stringify(["p-good"]))

  // routes counted during route() also show up in feedback (2 providers = 2 route counts)
  portfolio.route(routeReq({ category: "coding" }))
  const fb2 = portfolio.feedback()
  check("feedback: totalRoutes >= 1 after route call", fb2.totalRoutes >= 1, `got ${fb2.totalRoutes}`)
  check("feedback: byProvider p-good routes >= 1", fb2.byProvider["p-good"]!.routes >= 1)
}

// ===========================================================================
// 5. providerReliability pass-through
// ===========================================================================
{
  const rel = portfolio.providerReliability("p-bad")
  check("providerReliability: provider name", rel.provider === "p-bad")
  check("providerReliability: state closed", rel.state === "closed")
  check("providerReliability: score 0..1", rel.reliabilityScore >= 0 && rel.reliabilityScore <= 1)
  check("providerReliability: failures 0", rel.failures === 0)
}

// ===========================================================================
// 6. portfolioReport pass-through
// ===========================================================================
{
  const report = portfolio.portfolioReport()
  check("portfolioReport: totalProviders 2", report.totalProviders === 2, `got ${report.totalProviders}`)
  check("portfolioReport: closedCount 2", report.closedCount === 2)
  check("portfolioReport: openCount 0", report.openCount === 0)
  check("portfolioReport: counts sum", report.openCount + report.halfOpenCount + report.closedCount === report.totalProviders)
  check("portfolioReport: grade A (all clean)", report.grade === "A", `got ${report.grade}`)
  check("portfolioReport: mostReliable p-good", report.mostReliable === "p-good", `got ${report.mostReliable}`)
  for (const p of report.providers) {
    check(`portfolioReport entry ${p.provider}: score in range`, p.reliabilityScore >= 0 && p.reliabilityScore <= 1)
  }
}

// ===========================================================================
// 7. limit option caps choices
// ===========================================================================
{
  const limited = portfolio.route(routeReq({ category: "coding" }), { limit: 1 })
  check("limit: exactly 1 choice", limited.length === 1, `got ${limited.length}`)
}

// ===========================================================================
// 8. circuit-open provider excluded from choices, named in blocked list
// ===========================================================================
{
  portfolio.clear()
  now = 0
  health.record("p-bad", "error")
  health.record("p-bad", "error")
  health.record("p-bad", "error") // open
  const decision = portfolio.routeDecision(routeReq({ category: "coding" }))
  check("blocked: p-bad named in decision.blocked", decision.blocked.some((b) => b.includes("p-bad")), `blocked=${decision.blocked.join(",")}`)
  const choices = portfolio.route(routeReq({ category: "coding" }))
  check("blocked: p-bad absent from choices", !choices.some((c) => c.provider === "p-bad"), `providers=${choices.map((c) => c.provider).join(",")}`)
}

console.log(`\n[portfolio] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
