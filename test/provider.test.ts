/**
 * Provider circuit breaker, reliability score, and portfolio report (Batch 6).
 * Pins ProviderHealth.record/allow/state/remainingSeconds/snapshot,
 * providerReliability, and portfolioReport behavior with a controllable clock.
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ProviderHealth } from "../src/runtime/provider.js"
import type { PortfolioReport, ProviderReliability } from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-provider-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

let now = 1_758_000_000_000
const health = new ProviderHealth(null, { now: () => now })
const advance = (ms: number) => {
  now += ms
}

// ---- fresh provider is closed and allowed ----
{
  check("fresh: state closed", health.state("p-fresh") === "closed")
  check("fresh: allow true", health.allow("p-fresh") === true)
  check("fresh: remainingSeconds 0", health.remainingSeconds("p-fresh") === 0)
  const snap = health.snapshot()["p-fresh"]
  check("fresh: failures 0", snap.failures === 0)
  check("fresh: opens 0", health.providerReliability("p-fresh").opens === 0)
  check("fresh: recoveryCount 0", snap.recoveryCount === 0)
}

// ---- threshold errors open the circuit (default threshold 3) ----
{
  health.record("p-err", "error")
  health.record("p-err", "error")
  check("2 errors: still closed", health.state("p-err") === "closed")
  health.record("p-err", "error")
  check("3 errors: open", health.state("p-err") === "open")
  const snap = health.snapshot()["p-err"]
  check("open: lastKind error", snap.lastKind === "error")
  check("open: opens === 1", health.providerReliability("p-err").opens === 1)
  check("open: allow false", health.allow("p-err") === false)
  check("open: remainingSeconds === 60 (base cooldown)", health.remainingSeconds("p-err") === 60)
}

// ---- cooldown expiry moves open to half_open ----
{
  advance(60_000)
  check("after cooldown: state half_open", health.state("p-err") === "half_open")
  check("after cooldown: allow true", health.allow("p-err") === true)
  check("after cooldown: remainingSeconds 0", health.remainingSeconds("p-err") === 0)
}

// ---- recovery: ok from half_open closes and increments recoveryCount ----
{
  health.record("p-err", "ok")
  check("ok from half_open: closed", health.state("p-err") === "closed")
  check("ok from half_open: recoveryCount 1", health.snapshot()["p-err"].recoveryCount === 1)
  check("ok resets failures to 0", health.snapshot()["p-err"].failures === 0)
  check("ok: lastSuccessAt set", health.providerReliability("p-err").lastSuccessAt === now)
  check("ok: allow true", health.allow("p-err") === true)
}

// ---- ok on an already-closed provider does not count a recovery ----
{
  health.record("p-fresh", "ok")
  check("ok on closed: recoveryCount stays 0", health.snapshot()["p-fresh"].recoveryCount === 0)
}

// ---- timeouts count 1.5 and open at timeoutThreshold(2) ----
{
  health.record("p-to", "timeout")
  check("1 timeout: still closed", health.state("p-to") === "closed")
  health.record("p-to", "timeout")
  check("2 timeouts: open", health.state("p-to") === "open")
  check("2 timeouts: failures === 3 (1.5 each)", health.snapshot()["p-to"].failures === 3)
  check("2 timeouts: lastKind timeout", health.snapshot()["p-to"].lastKind === "timeout")
}

// ---- re-open after recovery: ok reset opens to 0, so this is a 1x cooldown ----
{
  // p-err is closed again; ok reset opens to 0, so next open uses 1x base cooldown
  health.record("p-err", "error")
  health.record("p-err", "error")
  health.record("p-err", "error")
  check("re-open: opens === 1", health.providerReliability("p-err").opens === 1)
  check("re-open: remainingSeconds === 60 (1x base)", health.remainingSeconds("p-err") === 60)
}

// ---- providerReliability blends breaker state into the score ----
{
  // fresh, no stats: score 1
  const rFresh: ProviderReliability = health.providerReliability("p-rel-fresh")
  check("reliability fresh: score 1", rFresh.reliabilityScore === 1)
  check("reliability fresh: failureRate 0", rFresh.failureRate === 0)
  check("reliability fresh: rate429 0", rFresh.rate429 === 0)
  check("reliability fresh: recoveryCount 0", rFresh.recoveryCount === 0)
  check("reliability fresh: state closed", rFresh.state === "closed")

  // p-err is open right now: score 1 - 0.4 = 0.6
  const rOpen: ProviderReliability = health.providerReliability("p-err")
  check("reliability open: score 0.6", rOpen.reliabilityScore === 0.6, `got ${rOpen.reliabilityScore}`)
  check("reliability open: state open", rOpen.state === "open")
  check("reliability open: failures 3", rOpen.failures === 3)
  check("reliability open: opens 1", rOpen.opens === 1)
  check("reliability open: cooldownRemaining 60", rOpen.cooldownRemaining === 60)

  // cooldown elapsed; allow() mutates raw state to half_open -> score 1 - 0.2 = 0.8
  advance(60_000)
  health.allow("p-err")
  const rHalf: ProviderReliability = health.providerReliability("p-err")
  check("reliability half_open: score 0.8", rHalf.reliabilityScore === 0.8, `got ${rHalf.reliabilityScore}`)
  check("reliability half_open: state half_open", rHalf.state === "half_open")

  // ok -> closed: score back to 1, recoveryCount 2
  health.record("p-err", "ok")
  const rClosed: ProviderReliability = health.providerReliability("p-err")
  check("reliability closed after recovery: score 1", rClosed.reliabilityScore === 1)
  check("reliability closed after recovery: recoveryCount 2", rClosed.recoveryCount === 2)
  check("reliability closed after recovery: failures 0", rClosed.failures === 0)
}

// ---- portfolioReport aggregates across providers ----
{
  const ph = new ProviderHealth(null, { now: () => now })
  ph.state("clean-a") // creates closed provider
  ph.state("clean-b") // creates closed provider
  ph.record("flaky", "error")
  ph.record("flaky", "error")
  ph.record("flaky", "error") // open
  const report: PortfolioReport = ph.portfolioReport()
  check("portfolio: totalProviders 3", report.totalProviders === 3)
  check("portfolio: closedCount 2", report.closedCount === 2)
  check("portfolio: openCount 1", report.openCount === 1)
  check("portfolio: halfOpenCount 0", report.halfOpenCount === 0)
  check("portfolio: counts sum to total", report.openCount + report.halfOpenCount + report.closedCount === report.totalProviders)
  check("portfolio: aggregateFailureRate 0", report.aggregateFailureRate === 0)
  check("portfolio: aggregateRate429 0", report.aggregateRate429 === 0)
  check("portfolio: mostReliable clean-a", report.mostReliable === "clean-a", `got ${report.mostReliable}`)
  check("portfolio: leastRisky flaky", report.leastRisky === "flaky", `got ${report.leastRisky}`)
  check("portfolio one open clean: grade C", report.grade === "C", `got ${report.grade}`)
  for (const p of report.providers) {
    check(`portfolio entry ${p.provider}: score 0..1`, p.reliabilityScore >= 0 && p.reliabilityScore <= 1)
    check(`portfolio entry ${p.provider}: failureRate 0..1`, p.failureRate >= 0 && p.failureRate <= 1)
    check(`portfolio entry ${p.provider}: rate429 0..1`, p.rate429 >= 0 && p.rate429 <= 1)
  }
}

// ---- all-clean portfolio: grade A ----
{
  const ph = new ProviderHealth(null, { now: () => now })
  ph.state("clean-a")
  ph.state("clean-b")
  const report = ph.portfolioReport()
  check("all-clean: totalProviders 2", report.totalProviders === 2)
  check("all-clean: closedCount 2", report.closedCount === 2)
  check("all-clean: openCount 0", report.openCount === 0)
  check("all-clean: grade A", report.grade === "A", `got ${report.grade}`)
  check("all-clean: mostReliable clean-a", report.mostReliable === "clean-a")
  check("all-clean: leastRisky clean-b", report.leastRisky === "clean-b")
}

// ---- empty portfolio: vacuous grade A, null leaders ----
{
  const empty = new ProviderHealth(null, { now: () => now })
  const report = empty.portfolioReport()
  check("empty: totalProviders 0", report.totalProviders === 0)
  check("empty: openCount 0", report.openCount === 0)
  check("empty: mostReliable null", report.mostReliable === null)
  check("empty: leastRisky null", report.leastRisky === null)
  check("empty: grade A (no failures, no opens)", report.grade === "A", `got ${report.grade}`)
}

// ---- 429 kind opens the circuit and is recorded as lastKind ----
{
  health.record("p-429", "429")
  health.record("p-429", "429")
  health.record("p-429", "429")
  check("3x 429: open", health.state("p-429") === "open")
  check("3x 429: lastKind 429", health.snapshot()["p-429"].lastKind === "429")
  check("3x 429: allow false", health.allow("p-429") === false)
}

// ---- latency kind counts as a normal failure (weight 1) ----
{
  health.record("p-lat", "latency")
  health.record("p-lat", "latency")
  health.record("p-lat", "latency")
  check("3x latency: open (threshold 3)", health.state("p-lat") === "open")
}

console.log(`\n[provider] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
