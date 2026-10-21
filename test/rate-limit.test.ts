/**
 * Unit test for the DispatchRateLimiter in src/index.ts (rate 2/s, burst 4).
 * Verifies: burst allows 4 immediate dispatches, 5th rejects, recovery after wait.
 */
import { DispatchRateLimiter, num, type RateLimitOptions } from "../src/index.js"

const cfg: RateLimitOptions = { enabled: true, ratePerSecond: 2, burst: 4 }
const rl = new DispatchRateLimiter(cfg)

let pass = 0
let fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`[PASS] ${name}`) } else { fail++; console.log(`[FAIL] ${name}`) }
}

// 1. burst: 4 immediate dispatches succeed
let ok = 0
for (let i = 0; i < 4; i++) {
  try { rl.consume(); ok++ } catch { /* reject */ }
}
check(`burst allows exactly ${cfg.burst} immediate dispatches (got ${ok})`, ok === 4)

// 2. 5th immediate dispatch rejected with retry hint
let rejected = false
let msg = ""
try { rl.consume() } catch (e) { rejected = true; msg = (e as Error).message }
check("5th immediate dispatch is rejected", rejected)
check("rejection message includes retry hint (ms)", /Retry in ~\d+ms/.test(msg))

// 3. recovery: after 500ms at 2/s, ~1 token refills -> 1 dispatch succeeds
await new Promise((r) => setTimeout(r, 550))
let recovered = 0
try { rl.consume(); recovered++ } catch { /* reject */ }
check("one dispatch succeeds after 550ms refill (got " + recovered + ")", recovered === 1)

// 4. but not two more immediately
let second = false
try { rl.consume(); second = true } catch { /* reject */ }
check("second dispatch immediately after still rejected", !second)

// 5. the rejection message names the plugin and the configured budget
check("rejection message names the plugin", msg.includes("swarm-lite rate limit"))
check("rejection message reports the configured burst and rate", msg.includes(`burst ${cfg.burst}`) && msg.includes(`${cfg.ratePerSecond}/s`))

// 6. a second refill window grants one more dispatch, and only one
await new Promise((r) => setTimeout(r, 550))
let refilled = 0
try { rl.consume(); refilled++ } catch { /* reject */ }
check("one more dispatch succeeds after a second 550ms refill (got " + refilled + ")", refilled === 1)

let third = false
try { rl.consume(); third = true } catch { /* reject */ }
check("dispatch immediately after the second refill is still rejected", !third)

// 7. an independent limiter with burst 1 allows exactly one dispatch
const solo = new DispatchRateLimiter({ enabled: true, ratePerSecond: 0.01, burst: 1 })
let soloOk = 0
try { solo.consume(); soloOk++ } catch { /* reject */ }
let soloRejected = false
try { solo.consume() } catch { soloRejected = true }
check("burst-1 limiter allows 1 dispatch then rejects (got " + soloOk + ")", soloOk === 1 && soloRejected)

// 8. status() on a fresh limiter reports the full configured burst
const fresh = new DispatchRateLimiter({ enabled: true, ratePerSecond: 4, burst: 8 })
const fst = fresh.status()
check("status() on a fresh limiter shows a full burst", fst.tokens === 8)
check("status() reports configured burst, rate, and enabled flag", fst.burst === 8 && fst.ratePerSecond === 4 && fst.enabled === true)

// 9. status() is read-only: it does not consume tokens
const before = fresh.status().tokens
fresh.status()
check("calling status() twice does not drain the budget", fresh.status().tokens >= before)
fresh.consume()
const afterConsume = fresh.status()
check("status() reflects consumption immediately", afterConsume.tokens < 8)

// 10. status() on a disabled limiter reports enabled=false
const off = new DispatchRateLimiter({ enabled: false, ratePerSecond: 4, burst: 8 })
check("status() reports enabled=false when rate limiting is off", off.status().enabled === false)

// 11. (v1.2.1) a disabled limiter never rejects: consume() is a no-op
const disabled = new DispatchRateLimiter({ enabled: false, ratePerSecond: 4, burst: 1 })
let disabledThrew = false
for (let i = 0; i < 5; i++) {
  try { disabled.consume() } catch { disabledThrew = true }
}
check("disabled limiter never rejects (consume() is a no-op)", !disabledThrew)
check("disabled consume() does not drain tokens", disabled.status().tokens >= 1)

// 12. (v1.2.1) degenerate configs are sanitized: no Infinity/NaN/negative budgets
const degenerate = new DispatchRateLimiter({ enabled: true, ratePerSecond: 0, burst: -3 })
const dst = degenerate.status()
check("rate 0 / burst -3 config is sanitized to finite positive values", dst.ratePerSecond >= 0.01 && dst.burst >= 1)
const nanCfg = new DispatchRateLimiter({ enabled: true, ratePerSecond: NaN, burst: Infinity })
const nst = nanCfg.status()
check("NaN/Infinity config is sanitized to finite values", Number.isFinite(nst.ratePerSecond) && Number.isFinite(nst.burst) && nst.burst >= 1)
const dg = new DispatchRateLimiter({ enabled: true, ratePerSecond: 0, burst: 0 })
let dgThrew = false
let dgHint = ""
for (let i = 0; i < 64; i++) {
  try { dg.consume() } catch (e) { dgThrew = true; dgHint = (e as Error).message; break }
}
check("sanitized degenerate config still enforces a bucket", dgThrew)
check("rejection hint never contains Infinity or NaN", dgThrew && !/Infinity|NaN/.test(dgHint))

// 13. (v1.2.1) clock regression: a backwards wall clock never grants tokens or goes negative
const skewed = new DispatchRateLimiter({ enabled: true, ratePerSecond: 4, burst: 2 })
skewed.consume(); skewed.consume()
const realNow = Date.now
const base = realNow()
Date.now = () => base - 10_000
let skewRejected = false
let skewHint = ""
try { skewed.consume() } catch (e) { skewRejected = true; skewHint = (e as Error).message }
const skewTokens = skewed.status().tokens
Date.now = realNow
check("backward clock step grants no free dispatch", skewRejected)
check("tokens never go negative under clock regression", Number.isFinite(skewTokens) && skewTokens >= 0)
check("rejection hint stays finite under clock regression", skewRejected && !/Infinity|NaN/.test(skewHint))

// 14. (v1.2.1) num() boundary behavior: rejects NaN, Infinity, and values below the floor
check("num rejects NaN", num(NaN, 4, 0.01) === 4)
check("num rejects Infinity", num(Infinity, 4, 0.01) === 4)
check("num rejects values below the floor", num(0, 4, 0.01) === 4 && num(-1, 8, 1) === 8)
check("num accepts valid values", num(5, 4, 0.01) === 5 && num(30, 40, 1) === 30)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
