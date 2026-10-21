/**
 * Unit test for the DispatchRateLimiter in src/index.ts (rate 2/s, burst 4).
 * Verifies: burst allows 4 immediate dispatches, 5th rejects, recovery after wait.
 */
import { DispatchRateLimiter, type RateLimitOptions } from "../src/index.js"

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
