/**
 * Opt-in chaos injection and recovery assertions (Req 29, 30).
 *
 * Chaos is never the default: TaskInput.chaosMode gates it. injectChaos only
 * records a telemetry NOTE event — no real fault is inflicted on a provider.
 * checkRecovery scans recorded events for self-healing violations: duplicate
 * commits, lost provenance, excessive retries, workspace corruption, orphan
 * workers, incorrect passes.
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Telemetry } from "../src/runtime/telemetry.js"
import {
  injectChaos,
  chaosPenalty,
  checkRecovery,
  CHAOS_PENALTY_SECONDS,
} from "../src/runtime/chaos.js"
import type { ChaosKind, RecoveryAssertions } from "../src/runtime/types.js"
import type { RuntimeEvent } from "../src/runtime/telemetry.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-chaos-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

// ---- Req 29: CHAOS_PENALTY_SECONDS / chaosPenalty cover every kind ----
{
  const kinds: ChaosKind[] = [
    "429",
    "timeout",
    "ECONNRESET",
    "slow_provider",
    "malformed_response",
    "worker_crash",
    "late_notification",
    "duplicate_completion",
    "lost_log_event",
    "partial_tool_failure",
  ]
  for (const k of kinds) {
    const p = chaosPenalty(k)
    check(`chaosPenalty(${k}) is a positive number`, typeof p === "number" && p > 0, `got ${p}`)
  }
  check("CHAOS_PENALTY_SECONDS covers all 10 kinds", Object.keys(CHAOS_PENALTY_SECONDS).length === 10)
  check("429 penalty is 30s", chaosPenalty("429") === 30)
  check("worker_crash penalty is 120s", chaosPenalty("worker_crash") === 120)
  check("lost_log_event penalty is 3s", chaosPenalty("lost_log_event") === 3)
}

// ---- Req 29: injectChaos records a NOTE event and returns the effect ----
{
  const tel = new Telemetry(null, { now: () => 1000 })
  const effect = injectChaos(
    { kind: "429", target: "lane-1", delaySeconds: 30, note: "rate limited" },
    "lane-1",
    tel,
    { runId: "run_1", now: () => 1000 },
  )

  check("injectChaos returns the injected kind", effect.kind === "429")
  check("effect target matches", effect.target === "lane-1")
  check("effect classifies 429 as failure", effect.effect === "failure")
  check("effect carries injectedAt timestamp", effect.injectedAt === 1000)
  check("effect has an eventId", typeof effect.eventId === "string" && effect.eventId.length > 0)

  const events = tel.list("run_1")
  check("one NOTE event recorded", events.length === 1)
  const e = events[0]!
  check("event type is NOTE", e.type === "NOTE")
  check("event is flagged chaos", e.data.chaos === true)
  check("event carries kind", e.data.kind === "429")
  check("event carries penaltySeconds", e.data.penaltySeconds === 30)
}

// ---- Req 29: every chaos kind classifies to a known effect ----
{
  const tel = new Telemetry(null)
  const cases: Array<[ChaosKind, "latency" | "failure" | "corruption" | "loss" | "duplicate"]> = [
    ["429", "failure"],
    ["timeout", "failure"],
    ["ECONNRESET", "failure"],
    ["worker_crash", "failure"],
    ["slow_provider", "latency"],
    ["malformed_response", "corruption"],
    ["partial_tool_failure", "corruption"],
    ["lost_log_event", "loss"],
    ["late_notification", "duplicate"],
    ["duplicate_completion", "duplicate"],
  ]
  for (const [kind, expected] of cases) {
    const effect = injectChaos({ kind }, "lane", tel)
    check(`${kind} classifies as ${expected}`, effect.effect === expected, `got ${effect.effect}`)
  }
}

// ---- Req 30: checkRecovery on clean events -> clean:true ----
{
  const now = () => 5000
  const events: RuntimeEvent[] = [
    { ts: 1, type: "PLAN", data: { source: "planner" }, runId: "run_x", eventId: "e1" },
    { ts: 2, type: "OUTCOME", data: { laneId: "lane-a", source: "lane-a" }, runId: "run_x", eventId: "e2" },
    { ts: 3, type: "AUTO_OUTCOME", data: { laneId: "lane-b", source: "lane-b" }, runId: "run_x", eventId: "e3" },
  ]
  const assertions: RecoveryAssertions = {
    duplicateCommits: [],
    lostProvenance: [],
    excessiveRetries: [],
    workspaceCorruption: [],
    orphanWorkers: [],
    incorrectPass: [],
    clean: true,
  }
  const result = checkRecovery(events, assertions, { now })

  check("clean events produce clean:true", result.clean === true)
  check("no duplicate commits", result.duplicateCommits.length === 0)
  check("no lost provenance", result.lostProvenance.length === 0)
  check("no excessive retries", result.excessiveRetries.length === 0)
  check("eventsReviewed counts all events", result.eventsReviewed === 3)
  check("checkedAt is set", result.checkedAt === 5000)
}

// ---- Req 30: duplicate commits on the same lane ----
{
  const events: RuntimeEvent[] = [
    { ts: 1, type: "OUTCOME", data: { laneId: "lane-a", source: "lane-a" }, runId: "run_y", eventId: "e1" },
    { ts: 2, type: "OUTCOME", data: { laneId: "lane-a", source: "lane-a" }, runId: "run_y", eventId: "e2" },
    { ts: 3, type: "OUTCOME", data: { laneId: "lane-b", source: "lane-b" }, runId: "run_y", eventId: "e3" },
  ]
  const result = checkRecovery(events, {
    duplicateCommits: [],
    lostProvenance: [],
    excessiveRetries: [],
    workspaceCorruption: [],
    orphanWorkers: [],
    incorrectPass: [],
    clean: true,
  })

  check("duplicate commit detected on lane-a", result.duplicateCommits.includes("lane-a"))
  check("lane-b not flagged as duplicate", !result.duplicateCommits.includes("lane-b"))
  check("clean is false when duplicates exist", result.clean === false)
}

// ---- Req 30: lost provenance (non-PLAN event without a source) ----
{
  const events: RuntimeEvent[] = [
    { ts: 1, type: "PLAN", data: { source: "planner" }, runId: "run_z", eventId: "e1" },
    { ts: 2, type: "NOTE", data: { foo: 1 }, runId: "run_z", eventId: "e2" },
    { ts: 3, type: "OUTCOME", data: { laneId: "lane-a", source: "lane-a" }, runId: "run_z", eventId: "e3" },
  ]
  const result = checkRecovery(events, {
    duplicateCommits: [],
    lostProvenance: [],
    excessiveRetries: [],
    workspaceCorruption: [],
    orphanWorkers: [],
    incorrectPass: [],
    clean: true,
  })

  check("lost provenance flagged for NOTE without source", result.lostProvenance.includes("e2"))
  check("PLAN not flagged as lost provenance", !result.lostProvenance.includes("e1"))
  check("OUTCOME with source not flagged", !result.lostProvenance.includes("e3"))
  check("clean is false when provenance lost", result.clean === false)
}

// ---- Req 30: excessive retries (retryCount > 3 per lane) ----
{
  const events: RuntimeEvent[] = [
    { ts: 1, type: "LANE_FAIL", data: { laneId: "lane-a", retryCount: 5 }, runId: "run_w", eventId: "e1" },
    { ts: 2, type: "LANE_FAIL", data: { laneId: "lane-b", retryCount: 3 }, runId: "run_w", eventId: "e2" },
  ]
  const result = checkRecovery(events, {
    duplicateCommits: [],
    lostProvenance: [],
    excessiveRetries: [],
    workspaceCorruption: [],
    orphanWorkers: [],
    incorrectPass: [],
    clean: true,
  })

  check("retryCount 5 flagged as excessive", result.excessiveRetries.some((r) => r.branchId === "lane-a" && r.retries === 5))
  check("retryCount 3 not excessive (<=3 threshold)", !result.excessiveRetries.some((r) => r.branchId === "lane-b"))
  check("clean is false when retries excessive", result.clean === false)
}

console.log(`\n[chaos] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
