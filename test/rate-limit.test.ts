/**
 * Unit test for the DispatchRateLimiter in src/index.ts (rate 2/s, burst 4).
 * Verifies: burst allows 4 immediate dispatches, 5th rejects, recovery after wait.
 */
import { DispatchRateLimiter, type RateLimitOptions } from "../src/rate-limit.js"

const cfg = { enabled: true, ratePerSecond: 2, burst: 4 }
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
