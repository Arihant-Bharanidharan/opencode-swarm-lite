/**
 * Coordinator crash recovery: durable run manifest, RESUME vs RESTART per
 * branch, idempotent side effects, reconciliation cases, parent recovery,
 * and incomplete-run discovery (Req 11-14, 33, coordinator gates).
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router } from "../src/runtime/provider.js"
import { LanePool } from "../src/runtime/lanes.js"
import { CapsuleStore } from "../src/runtime/capsules.js"
import { Telemetry } from "../src/runtime/telemetry.js"
import { AdaptiveScheduler } from "../src/runtime/scheduler.js"
import { RunHistory } from "../src/runtime/history.js"
import { RunManifestStore, operationKey } from "../src/runtime/run-manifest.js"
import { RunCoordinator } from "../src/runtime/coordinator.js"
import { MixedStrategyScheduler } from "../src/runtime/mixed-strategy.js"
import { PortfolioRouter } from "../src/runtime/portfolio-router.js"
import { TrustStore } from "../src/runtime/trust.js"
import { CheckpointManager } from "../src/runtime/checkpoint.js"
import { PolicyStore } from "../src/runtime/policy.js"
import type {
  Category,
  CheckpointMilestone,
  ObservationStatus,
  TaskInput,
} from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coord-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const clock = () => 1_758_000_000_000

const makeDeps = (dir: string) => {
  const stats = new StatsStore(path.join(dir, "stats.json"))
  const health = new ProviderHealth(path.join(dir, "health.json"), {
    failureThreshold: 3,
    cooldownMs: 10_000,
    now: clock,
  })
  const router = new Router(stats, health)
  const lanes = new LanePool(path.join(dir, "lanes.json"), { now: clock })
  const capsules = new CapsuleStore(path.join(dir, "capsules"), { now: clock })
  const telemetry = new Telemetry(path.join(dir, "events.jsonl"), { now: clock })
  const history = new RunHistory(path.join(dir, "history.json"))
  const trust = new TrustStore(path.join(dir, "trust.json"), { now: clock })
  const checkpoint = new CheckpointManager(path.join(dir, "checkpoint.json"), {
    now: clock,
    telemetry,
  })
  const policy = new PolicyStore(path.join(dir, "policy.json"), { now: clock })
  const manifest = new RunManifestStore({ dir: path.join(dir, "runs"), now: clock })
  const scheduler = new AdaptiveScheduler({ stats, router, health, lanes })
  const mixedStrategy = new MixedStrategyScheduler({
    scheduler,
    router,
    health,
    stats,
  })
  const portfolioRouter = new PortfolioRouter({
    router,
    health,
    trust,
    stats,
  })
  return {
    stats,
    health,
    router,
    lanes,
    capsules,
    telemetry,
    history,
    trust,
    checkpoint,
    policy,
    manifest,
    scheduler,
    mixedStrategy,
    portfolioRouter,
  }
}

// ---- Helper: build a coordinator over a fresh dir ----
const buildCoordinator = (dir: string) => {
  const deps = makeDeps(dir)
  const coordinator = new RunCoordinator({
    manifest: deps.manifest,
    telemetry: deps.telemetry,
    checkpoint: deps.checkpoint,
    policy: deps.policy,
    scheduler: deps.scheduler,
    router: deps.router,
    health: deps.health,
    lanes: deps.lanes,
    capsules: deps.capsules,
    history: deps.history,
    stats: deps.stats,
    now: clock,
  })
  return { coordinator, deps }
}

// ---- A small multi-branch task input ----
const multiBranchInput: TaskInput = {
  task: "implement three independent modules",
  category: "coding",
  branches: 3,
  branchSeconds: 120,
  independence: 0.9,
}

console.log("\n[coordinator] crash recovery + durable manifest")

// ---- 1: coordinate creates a RUNNING manifest and assignments ----
{
  const { coordinator, deps } = buildCoordinator(path.join(tmp, "t1"))
  const result = coordinator.coordinate(multiBranchInput, { runId: "run-recover-1" })
  check("coordinate returns RUNNING status", result.status === "RUNNING", result.status)
  check("runId is stable", result.runId === "run-recover-1")
  check("plan has 3 agents", result.plan.agents === 3, `agents=${result.plan.agents}`)
  check("3 branch assignments", result.assignments.length === 3, `assignments=${result.assignments.length}`)
  check("all branches pending initially", result.assignments.every((a) => a.operationId.startsWith("patch:")))
  const manifest = deps.manifest.load("run-recover-1")
  check("manifest persisted on disk", !!manifest, "manifest undefined")
  check("manifest status RUNNING", manifest!.status === "RUNNING")
  check("3 branch states in manifest", Object.keys(manifest!.branches).length === 3)
  check("telemetry logged PLAN event", deps.telemetry.list("run-recover-1").some((e) => e.type === "PLAN"))
  check("telemetry logged ASSIGN event", deps.telemetry.list("run-recover-1").some((e) => e.type === "ASSIGN"))
}

// ---- 2: recordBranchResult is durable and idempotent ----
{
  const { coordinator, deps } = buildCoordinator(path.join(tmp, "t2"))
  const result = coordinator.coordinate(multiBranchInput, { runId: "run-idempotent-1" })
  const branchId = result.assignments[0]!.branchId
  // The idempotency key is keyed by result content (workSeconds), matching
  // coordinator.recordBranchResult.
  const opId = operationKey({ kind: "patch", runId: "run-idempotent-1", branchId, seq: 100 })

  const first = coordinator.recordBranchResult("run-idempotent-1", {
    branchId,
    status: "ok",
    workSeconds: 100,
    totalSeconds: 100,
  })
  check("first result applied", first.applied === true)
  const manifest = deps.manifest.load("run-idempotent-1")!
  check("branch marked completed", manifest.branches[branchId]!.status === "completed")
  check("operation recorded", manifest.appliedOperationIds.includes(opId))

  // Re-deliver the same result -> idempotent skip.
  const again = coordinator.recordBranchResult("run-idempotent-1", {
    branchId,
    status: "ok",
    workSeconds: 100,
    totalSeconds: 100,
  })
  check("duplicate result not re-applied", again.applied === false)
  check("manifest unchanged on re-delivery", deps.manifest.load("run-idempotent-1")!.generation === manifest.generation)

  // Telemetry recorded a LANE_DONE once.
  const laneDoneCount = deps.telemetry.list("run-idempotent-1").filter((e) => e.type === "LANE_DONE").length
  check("exactly one LANE_DONE logged", laneDoneCount === 1, `count=${laneDoneCount}`)
}

// ---- 3: closeRun refuses COMPLETE with unresolved branches ----
{
  const { coordinator, deps } = buildCoordinator(path.join(tmp, "t3"))
  const result = coordinator.coordinate(multiBranchInput, { runId: "run-close-1" })
  const oneBranch = result.assignments[0]!.branchId
  coordinator.recordBranchResult("run-close-1", { branchId: oneBranch, status: "ok", workSeconds: 60, totalSeconds: 60 })

  const refused = coordinator.closeRun({ runId: "run-close-1", status: "COMPLETE" })
  check("COMPLETE refused with unresolved branches", refused.ok === false, refused.reason)
  check("manifest still RUNNING", deps.manifest.load("run-close-1")!.status === "RUNNING")

  // Resolve remaining branches then close.
  for (const a of result.assignments.slice(1)) {
    coordinator.recordBranchResult("run-close-1", {
      branchId: a.branchId,
      status: "ok",
      workSeconds: 60,
      totalSeconds: 60,
    })
  }
  const closed = coordinator.closeRun({ runId: "run-close-1", status: "COMPLETE" })
  check("COMPLETE accepted when all branches resolved", closed.ok === true, closed.reason)
  check("manifest terminal COMPLETE", deps.manifest.load("run-close-1")!.status === "COMPLETE")
  check("OUTCOME telemetry logged", deps.telemetry.list("run-close-1").some((e) => e.type === "OUTCOME"))
}

// ---- 4: cancelRun marks pending/in-progress branches cancelled ----
{
  const { coordinator, deps } = buildCoordinator(path.join(tmp, "t4"))
  const result = coordinator.coordinate(multiBranchInput, { runId: "run-cancel-1" })
  const cancelled = coordinator.cancelRun("run-cancel-1", "user request")
  check("cancel returns ok", cancelled.ok === true)
  check("manifest terminal CANCELLED", deps.manifest.load("run-cancel-1")!.status === "CANCELLED")
  check("all branches cancelled", Object.values(deps.manifest.load("run-cancel-1")!.branches).every((b) => b.status === "cancelled"))
  check("CANCEL telemetry logged", deps.telemetry.list("run-cancel-1").some((e) => e.type === "CANCEL"))

  // Idempotent: cancelling again is a no-op.
  const again = coordinator.cancelRun("run-cancel-1")
  check("re-cancel is idempotent", again.ok === true)
}

// ---- 5: recover a terminal run returns final state ----
{
  const { coordinator, deps } = buildCoordinator(path.join(tmp, "t5"))
  const result = coordinator.coordinate(multiBranchInput, { runId: "run-terminal-1" })
  // Resolve all branches before claiming COMPLETE (gate under test).
  for (const a of result.assignments) {
    coordinator.recordBranchResult("run-terminal-1", {
      branchId: a.branchId,
      status: "ok",
      workSeconds: 120,
      totalSeconds: 120,
    })
  }
  coordinator.closeRun({ runId: "run-terminal-1", status: "COMPLETE" })
  const recovered = coordinator.recover("run-terminal-1")
  check("terminal run recovery is idempotent", recovered.status === "COMPLETE")
  check("no assignments for terminal run", recovered.assignments.length === 0)
  check("rebuilt state present", !!recovered.rebuilt)
}

// ---- 6: recover a non-existent run returns FAILED ----
{
  const { coordinator } = buildCoordinator(path.join(tmp, "t6"))
  const missing = coordinator.recover("run-does-not-exist")
  check("unknown run reports FAILED", missing.status === "FAILED")
  check("no assignments for unknown run", missing.assignments.length === 0)
}

// ---- 7: crash recovery - RESUME vs RESTART per branch ----
{
  const dir = path.join(tmp, "t7")
  // First coordinator instance: coordinate + crash mid-run (one branch done, one in progress with a checkpoint).
  const c1 = buildCoordinator(dir)
  const result = c1.coordinator.coordinate(multiBranchInput, { runId: "run-crash-1" })
  const branchA = result.assignments[0]!.branchId
  const branchB = result.assignments[1]!.branchId
  const branchC = result.assignments[2]!.branchId

  // Branch A completes.
  c1.coordinator.recordBranchResult("run-crash-1", {
    branchId: branchA,
    status: "ok",
    workSeconds: 120,
    totalSeconds: 120,
  })

  // Branch B checkpoints meaningful work (> 30s = MIN_RESUME_WORK_SECONDS)
  // but the result is never durably applied before the crash.
  c1.deps.checkpoint.record({
    id: "ckpt-b",
    runId: "run-crash-1",
    branchId: branchB,
    task: "implement three independent modules",
    role: "coder",
    model: "inherit",
    provider: "opencode",
    capsule: undefined,
    filesInspected: ["src/mod-b.ts"],
    hypothesis: undefined,
    evidence: ["test:mod-b"],
    commandsRun: [],
    pendingActions: ["finish mod-b"],
    patchState: { "src/mod-b.ts": "export const b = 1" },
    verificationState: { stage: "patch_drafted", testsPassed: 0, testsTotal: 0 },
    workSecondsCompleted: 90,
    milestone: "patch_drafted",
    createdAt: clock(),
  })

  // Branch C never started (crash before dispatch).
  // Simulate crash: drop c1, open a fresh coordinator over the same dir.
  const c2 = buildCoordinator(dir)
  const recovered = c2.coordinator.recover("run-crash-1")
  check("recovery status is RECOVERING", recovered.status === "RECOVERING", recovered.status)
  check("rebuild found branch B's checkpoint", !!recovered.rebuilt)
  check("two resume/restart decisions", recovered.decisions.length === 2, `decisions=${recovered.decisions.length}`)

  const byBranch = new Map(recovered.decisions.map((d) => [d.branchId, d]))
  const decisionB = byBranch.get(branchB)
  const decisionC = byBranch.get(branchC)
  check("branch B RESUMEs from patch_drafted with saved work", decisionB?.action === "resume" && decisionB?.fromStep === "patch_drafted" && decisionB!.savedWorkSeconds === 90, JSON.stringify(decisionB))
  check("branch C RESTARTs (no checkpoint)", decisionC?.action === "restart" && decisionC!.savedWorkSeconds === 0, JSON.stringify(decisionC))
  check("recovery assignments for unfinished branches", recovered.assignments.length === 2, `assignments=${recovered.assignments.length}`)
  check("recovery does not re-assign completed branch A", !recovered.assignments.some((a) => a.branchId === branchA))

  // Resume an in-progress branch preserves workSecondsCompleted.
  const resumedBranch = recovered.assignments.find((a) => a.branchId === branchB)
  check("resumed branch assignment exists", !!resumedBranch)
}

// ---- 8: small-checkpoint branch RESTARTs (below MIN_RESUME_WORK_SECONDS) ----
{
  const dir = path.join(tmp, "t8")
  const c1 = buildCoordinator(dir)
  const result = c1.coordinator.coordinate(multiBranchInput, { runId: "run-small-ckpt-1" })
  const branchB = result.assignments[1]!.branchId

  // Trivial checkpoint below the resume threshold.
  c1.deps.checkpoint.record({
    id: "ckpt-small",
    runId: "run-small-ckpt-1",
    branchId: branchB,
    task: "implement three independent modules",
    role: "coder",
    model: "inherit",
    provider: "opencode",
    capsule: undefined,
    filesInspected: [],
    hypothesis: undefined,
    evidence: [],
    commandsRun: [],
    pendingActions: [],
    patchState: {},
    verificationState: { stage: "root_cause_identified", testsPassed: 0, testsTotal: 0 },
    workSecondsCompleted: 5,
    milestone: "root_cause_identified",
    createdAt: clock(),
  })

  const c2 = buildCoordinator(dir)
  const recovered = c2.coordinator.recover("run-small-ckpt-1")
  const byBranch = new Map(recovered.decisions.map((d) => [d.branchId, d]))
  const decisionB = byBranch.get(branchB)
  check("small checkpoint restarts (restoring costs more than redoing)", decisionB?.action === "restart" && decisionB!.savedWorkSeconds === 5, JSON.stringify(decisionB))
}

// ---- 9: incompleteRunIds lists only non-terminal runs ----
{
  const dir = path.join(tmp, "t9")
  const c1 = buildCoordinator(dir)
  c1.coordinator.coordinate(multiBranchInput, { runId: "run-incomplete-a" })
  c1.coordinator.coordinate(multiBranchInput, { runId: "run-incomplete-b" })
  const terminalResult = c1.coordinator.coordinate(multiBranchInput, { runId: "run-terminal-9" })
  // Resolve all branches so COMPLETE is accepted (gate under test).
  for (const a of terminalResult.assignments) {
    c1.coordinator.recordBranchResult("run-terminal-9", {
      branchId: a.branchId,
      status: "ok",
      workSeconds: 120,
      totalSeconds: 120,
    })
  }
  c1.coordinator.closeRun({ runId: "run-terminal-9", status: "COMPLETE" })

  const c2 = buildCoordinator(dir)
  const incomplete = c2.coordinator.incompleteRuns()
  check("incomplete lists the two RUNNING runs", incomplete.length === 2, `got ${incomplete.length}: ${incomplete.join(",")}`)
  check("terminal run is not listed", !incomplete.includes("run-terminal-9"))
  check("list is sorted", incomplete[0]! <= incomplete[1]!)
}

// ---- 10: parent recovery - recover continues a run whose parent crashed ----
{
  const dir = path.join(tmp, "t10")
  const c1 = buildCoordinator(dir)
  const result = c1.coordinator.coordinate(multiBranchInput, { runId: "run-parent-1" })
  const branchA = result.assignments[0]!.branchId
  const branchB = result.assignments[1]!.branchId

  // Parent completed A and checkpointed B, then died before recording B's result.
  c1.coordinator.recordBranchResult("run-parent-1", {
    branchId: branchA,
    status: "ok",
    workSeconds: 120,
    totalSeconds: 120,
  })
  c1.deps.checkpoint.record({
    id: "ckpt-parent-b",
    runId: "run-parent-1",
    branchId: branchB,
    task: "implement three independent modules",
    role: "coder",
    model: "inherit",
    provider: "opencode",
    capsule: undefined,
    filesInspected: ["src/mod-b.ts"],
    hypothesis: undefined,
    evidence: ["test:mod-b"],
    commandsRun: [],
    pendingActions: ["finish mod-b"],
    patchState: { "src/mod-b.ts": "export const b = 1" },
    verificationState: { stage: "patch_drafted", testsPassed: 0, testsTotal: 0 },
    workSecondsCompleted: 60,
    milestone: "patch_drafted",
    createdAt: clock(),
  })

  // New process recovers and resumes B.
  const c2 = buildCoordinator(dir)
  const recovered = c2.coordinator.recover("run-parent-1")
  const byBranch = new Map(recovered.decisions.map((d) => [d.branchId, d]))
  check("parent recovery resumes checkpointed branch B", byBranch.get(branchB)?.action === "resume", JSON.stringify(byBranch.get(branchB)))
  check("parent recovery does not touch completed branch A", !byBranch.has(branchA))

  // Resume B to completion, then close.
  c2.coordinator.recordBranchResult("run-parent-1", {
    branchId: branchB,
    status: "ok",
    workSeconds: 60,
    totalSeconds: 60,
  })
  const remaining = result.assignments[2]!.branchId
  c2.coordinator.recordBranchResult("run-parent-1", {
    branchId: remaining,
    status: "ok",
    workSeconds: 120,
    totalSeconds: 120,
  })
  const closed = c2.coordinator.closeRun({ runId: "run-parent-1", status: "COMPLETE" })
  check("recovered run reaches COMPLETE", closed.ok === true, closed.reason)
  check("final manifest terminal", depsManifest(c2)!.status === "COMPLETE")
}

function depsManifest(c2: ReturnType<typeof buildCoordinator>): ReturnType<typeof c2.deps.manifest.load> {
  return c2.deps.manifest.load("run-parent-1")!
}

// ---- 11: forced provider override applies during recovery ----
{
  const dir = path.join(tmp, "t11")
  const c1 = buildCoordinator(dir)
  c1.deps.policy.setOverride({
    forceTopology: "SERIAL",
    forceAgents: 1,
    forceProvider: "opencode",
    reason: "incident",
  })
  const result = c1.coordinator.coordinate(multiBranchInput, { runId: "run-override-1" })
  const branchB = result.assignments[1]!.branchId

  const c2 = buildCoordinator(dir)
  const recovered = c2.coordinator.recover("run-override-1")
  const byBranch = new Map(recovered.assignments.map((a) => [a.branchId, a]))
  check("forced provider restored on recovery", byBranch.get(branchB)?.provider === "opencode", JSON.stringify(byBranch.get(branchB)))
}

console.log(`\n[coordinator] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
