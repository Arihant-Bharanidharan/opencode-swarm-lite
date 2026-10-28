/**
 * v3 resilience tests: durable, idempotent, replayable events (Req 31-33),
 * milestone checkpoints that survive crashes (Req 11), honest
 * resume-vs-restart economics (Req 12), per-branch snapshots (Req 13), and
 * selective rollback that cannot touch other branches (Req 14).
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AdaptiveScheduler } from "../src/runtime/scheduler.js"
import { StatsStore } from "../src/runtime/stats.js"
import { ProviderHealth, Router } from "../src/runtime/provider.js"
import { Telemetry } from "../src/runtime/telemetry.js"
import { CheckpointManager, MIN_RESUME_WORK_SECONDS, decideResume } from "../src/runtime/checkpoint.js"
import type { BranchCheckpoint, Plan } from "../src/runtime/types.js"

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-resilience-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const NOW = 1_758_000_000_000

const mkCp = (over: Partial<BranchCheckpoint> = {}): BranchCheckpoint => {
  return {
    id: "",
    runId: "run_cp",
    branchId: "b1",
    filesInspected: ["src/a.ts"],
    evidence: ["test:one"],
    commandsRun: [{ cmd: "bun test/resilience.test.ts", ok: true }],
    pendingActions: ["run the full suite"],
    patchState: { "src/a.ts": "export const a = 2" },
    verificationState: { stage: "tests_partial", testsPassed: 5, testsTotal: 8 },
    workSecondsCompleted: 120,
    milestone: "tests_partial",
    createdAt: NOW,
    ...over,
  }
}

/** A REAL scheduler plan - no synthetic Plan shapes (Req 55 discipline). */
function freshPlan(task: string): Plan {
  const stats = new StatsStore(null)
  const health = new ProviderHealth(null)
  const router = new Router(stats, health)
  const scheduler = new AdaptiveScheduler({ stats, router, health })
  return scheduler.plan({ task, branches: 2, branchSeconds: 300 })
}

// ---- Req 31: durable events ----
{
  const durFile = path.join(tmp, "dur.jsonl")
  const tel = new Telemetry(durFile, { now: () => NOW })
  tel.log("NOTE", { i: 1 }, { runId: "run_p" })
  tel.log("NOTE", { i: 2 }, { runId: "run_p" })
  tel.log("NOTE", { i: 3 }, { runId: "run_p" })
  const reloaded = new Telemetry(durFile, { now: () => NOW })
  check(
    "events survive a crash: a new instance reads them back",
    reloaded.list("run_p").length === 3,
    String(reloaded.list("run_p").length),
  )
  const raw = fs.readFileSync(durFile, "utf8")
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  check(
    "the log is append-only JSONL: one object per event, each with eventId + sequence",
    lines.length === 3 &&
      lines.every((l) => {
        try {
          const o = JSON.parse(l) as { type?: string; eventId?: string; sequence?: number }
          return typeof o.type === "string" && typeof o.eventId === "string" && typeof o.sequence === "number"
        } catch {
          return false
        }
      }),
    `${lines.length} lines`,
  )

  const blocker = path.join(tmp, "blocked-is-a-file")
  fs.writeFileSync(blocker, "i am a regular file, not a directory")
  const tb = new Telemetry(path.join(blocker, "events.jsonl"), { now: () => NOW })
  tb.log("NOTE", { i: 1 }, { runId: "run_b1" })
  tb.log("NOTE", { i: 2 }, { runId: "run_b1" })
  check(
    "durability failures are COUNTED, never silently swallowed",
    tb.lostEvents === 2 && tb.list("run_b1").length === 2,
    `lost=${tb.lostEvents}`,
  )
  check("a clean file counts zero lost events", tel.lostEvents === 0)

  const brokenFile = path.join(tmp, "broken.jsonl")
  fs.writeFileSync(
    brokenFile,
    [
      JSON.stringify({ ts: 1, runId: "run_m", type: "NOTE", data: { i: 1 }, eventId: "m1", sequence: 1 }),
      "{this line was truncated mid-write by a crash",
      JSON.stringify({ ts: 2, runId: "run_m", type: "NOTE", data: { i: 2 }, eventId: "m2", sequence: 2 }),
    ].join("\n") + "\n",
  )
  const tm = new Telemetry(brokenFile, { now: () => NOW })
  check(
    "malformed/truncated lines are skipped on reload without crashing",
    tm.list("run_m").length === 2,
    String(tm.list("run_m").length),
  )
}

// ---- Req 32: idempotent dedupe + per-run monotonic sequence ----
{
  const seqFile = path.join(tmp, "seq.jsonl")
  const tel = new Telemetry(seqFile, { now: () => NOW })
  const first = tel.log("NOTE", { n: 1 }, { runId: "run_d", eventId: "evt-1" })
  const dup = tel.log("NOTE", { n: 99 }, { runId: "run_d", eventId: "evt-1" })
  check(
    "at-least-once delivery dedupes to an exactly-once log",
    tel.list("run_d").length === 1 && (dup.data.n as number) === 1 && dup.eventId === first.eventId,
    `events=${tel.list("run_d").length}`,
  )
  const reopened = new Telemetry(seqFile, { now: () => NOW })
  reopened.log("NOTE", { n: 42 }, { runId: "run_d", eventId: "evt-1" })
  check(
    "dedupe survives a crash: a re-delivered eventId is still a no-op",
    reopened.list("run_d").length === 1 && (reopened.list("run_d")[0]!.data.n as number) === 1,
    String(reopened.list("run_d").length),
  )

  const seq2File = path.join(tmp, "seq2.jsonl")
  const t2 = new Telemetry(seq2File, { now: () => NOW })
  for (let i = 0; i < 4; i++) t2.log("NOTE", { i }, { runId: "run_a" })
  for (let i = 0; i < 2; i++) t2.log("NOTE", { i }, { runId: "run_b" })
  check(
    "sequences are per-run, 1-based, strictly monotonic",
    JSON.stringify(t2.list("run_a").map((e) => e.sequence)) === "[1,2,3,4]" &&
      JSON.stringify(t2.list("run_b").map((e) => e.sequence)) === "[1,2]",
    JSON.stringify(t2.list("run_a").map((e) => e.sequence)),
  )
  const t3 = new Telemetry(seq2File, { now: () => NOW })
  const next = t3.log("NOTE", { i: 5 }, { runId: "run_a" })
  check("sequence numbering continues after a reload", next.sequence === 5, String(next.sequence))
  check(
    "a run with every event present reports no sequence gaps",
    t3.sequenceGaps("run_a").length === 0,
    JSON.stringify(t3.sequenceGaps()),
  )

  const gapFile = path.join(tmp, "gaps.jsonl")
  fs.writeFileSync(
    gapFile,
    [
      JSON.stringify({ ts: 1, runId: "run_g", type: "NOTE", data: {}, eventId: "g1", sequence: 1 }),
      JSON.stringify({ ts: 2, runId: "run_g", type: "NOTE", data: {}, eventId: "g3", sequence: 3 }),
    ].join("\n") + "\n",
  )
  const gaps = new Telemetry(gapFile, { now: () => NOW }).sequenceGaps()
  check(
    "sequenceGaps names the events the durable log lost",
    gaps.length === 1 &&
      gaps[0]!.runId === "run_g" &&
      gaps[0]!.expected === 3 &&
      gaps[0]!.found === 2 &&
      JSON.stringify(gaps[0]!.missing) === "[2]",
    JSON.stringify(gaps),
  )

  const legacyFile = path.join(tmp, "legacy.jsonl")
  fs.writeFileSync(legacyFile, JSON.stringify({ ts: 1, runId: "run_l", type: "NOTE", data: {} }) + "\n")
  const tl = new Telemetry(legacyFile, { now: () => NOW })
  check(
    "legacy events without sequences report no gaps",
    tl.list("run_l").length === 1 && tl.sequenceGaps().length === 0,
    JSON.stringify(tl.sequenceGaps()),
  )
}

// ---- Req 33: deterministic state rebuild from the log alone ----
{
  const plan = freshPlan("fix the flaky checkpoint test and harden the durable event log")
  const tel = new Telemetry(path.join(tmp, "rebuild.jsonl"), { now: () => NOW })
  tel.startRun(plan)
  tel.log("SPAWN", { toolCallID: "t1", sessionID: "ses_a", auto: true }, { runId: plan.runId, workerId: "w1" })
  tel.log("LANE_DONE", { sessionID: "ses_a" }, { runId: plan.runId, workerId: "w1" })
  tel.log("SPAWN", { toolCallID: "t2", sessionID: "ses_b", auto: true }, { runId: plan.runId, workerId: "w2" })
  tel.log("LANE_FAIL", { sessionID: "ses_b" }, { runId: plan.runId, workerId: "w2" })

  const mgr = new CheckpointManager(null, { now: () => NOW, telemetry: tel })
  mgr.record(mkCp({ runId: plan.runId, branchId: "b1", milestone: "patch_drafted", workSecondsCompleted: 60 }))
  mgr.record(mkCp({ runId: plan.runId, branchId: "b1", milestone: "tests_partial", workSecondsCompleted: 120 }))
  mgr.record(mkCp({ runId: plan.runId, branchId: "b2", milestone: "complete", workSecondsCompleted: 200 }))

  tel.log("RESUME", { decision: "resume" }, { runId: plan.runId })
  tel.log("RESUME", { decision: "restart" }, { runId: plan.runId })
  tel.log("SNAPSHOT", {}, { runId: plan.runId })
  tel.log("ROLLBACK", {}, { runId: plan.runId })
  tel.log("VERIFY", { level: 2 }, { runId: plan.runId })

  const rb = tel.rebuildState(plan.runId)!
  check(
    "rebuildState reconstructs lane lifecycle from the log",
    rb.lanes.length === 2 &&
      rb.lanes[0]!.laneId === "ses_a" &&
      rb.lanes[0]!.status === "done" &&
      rb.lanes[0]!.spawned &&
      rb.lanes[0]!.eventCount === 2 &&
      rb.lanes[0]!.workerId === "w1" &&
      rb.lanes[1]!.laneId === "ses_b" &&
      rb.lanes[1]!.status === "failed" &&
      rb.lanes[1]!.workerId === "w2",
    JSON.stringify(rb.lanes),
  )
  check(
    "rebuildState recovers the LATEST checkpoint per branch",
    rb.checkpoints.length === 2 &&
      rb.checkpoints[0]!.branchId === "b1" &&
      rb.checkpoints[0]!.milestone === "tests_partial" &&
      rb.checkpoints[0]!.workSecondsCompleted === 120 &&
      rb.checkpoints[1]!.branchId === "b2" &&
      rb.checkpoints[1]!.milestone === "complete" &&
      rb.checkpoints[1]!.workSecondsCompleted === 200,
    JSON.stringify(rb.checkpoints),
  )
  check(
    "rebuildState counts resume/restart/snapshot/rollback/verify events",
    rb.resumes === 1 &&
      rb.restarts === 1 &&
      rb.snapshots === 1 &&
      rb.rollbacks === 1 &&
      rb.verifications === 1 &&
      rb.lostEvents === 0,
    JSON.stringify({ r: rb.resumes, s: rb.snapshots, rb: rb.rollbacks, v: rb.verifications }),
  )
  check("a run without an outcome is still open", rb.open === true)
  check(
    "rebuildState is deterministic: same log, same state",
    JSON.stringify(tel.rebuildState(plan.runId)) === JSON.stringify(tel.rebuildState(plan.runId)),
  )
  check("rebuildState of an unknown run returns undefined", tel.rebuildState("run_nope") === undefined)

  const report = Telemetry.efficiency({
    runId: plan.runId,
    predictedSeconds: plan.estimates.chosen,
    actualSeconds: 400,
    serialSeconds: plan.estimates.serial,
    workers: 2,
    usefulWorkers: 1,
    wastedWorkers: 1,
  })
  tel.finish(plan.runId, report)
  check("a run closes in the rebuild once the outcome lands", tel.rebuildState(plan.runId)!.open === false)

  const plan2 = freshPlan("harden replay counting against the new event fields")
  const t4 = new Telemetry(path.join(tmp, "replay.jsonl"), { now: () => NOW })
  t4.startRun(plan2)
  t4.log("SPAWN", { toolCallID: "t1", sessionID: "ses_a", auto: true }, { runId: plan2.runId })
  t4.log("ASSIGN", { toolCallID: "t1", sessionID: "ses_a" }, { runId: plan2.runId })
  t4.log("SPAWN", { toolCallID: "t2", sessionID: "ses_b", auto: true }, { runId: plan2.runId })
  t4.log("LANE_FAIL", { toolCallID: "t2", sessionID: "ses_b", auto: true }, { runId: plan2.runId })
  const rep = t4.replay(plan2.runId)!
  const secondEvent = t4.list(plan2.runId)[1]!
  check(
    "hardening does not break replay: unique auto spawns still counted",
    rep.lanesSpawned === 2 && rep.lanesFailed === 1,
    `spawned=${rep.lanesSpawned} failed=${rep.lanesFailed}`,
  )
  check(
    "new events carry eventId + sequence; replay keys stay stable",
    !!secondEvent.eventId && secondEvent.sequence === 2 && rep.verifications === 0,
    JSON.stringify({ sequence: secondEvent.sequence }),
  )
}

// ---- Req 11: milestone checkpoints survive crashes ----
{
  const cpsFile = path.join(tmp, "cps.json")
  const m = new CheckpointManager(cpsFile, { now: () => NOW })
  m.record(mkCp({ branchId: "b1", milestone: "root_cause_identified", workSecondsCompleted: 45 }))
  m.record(mkCp({ branchId: "b1", milestone: "patch_drafted", workSecondsCompleted: 90 }))
  m.record(mkCp({ branchId: "b2", milestone: "complete", workSecondsCompleted: 300 }))
  const reloaded = new CheckpointManager(cpsFile, { now: () => NOW })
  check(
    "milestone checkpoints persist across a crash",
    reloaded.checkpoints().length === 3 &&
      reloaded.latest("b1")!.milestone === "patch_drafted" &&
      reloaded.latest("b1")!.workSecondsCompleted === 90,
    JSON.stringify(reloaded.checkpoints().map((c) => [c.branchId, c.milestone])),
  )
  check(
    "latest() is per-branch; an unknown branch has none",
    reloaded.latest("b2")!.milestone === "complete" && reloaded.latest("b-nope") === undefined,
  )
  check(
    "checkpoint store declares schema version 3",
    (JSON.parse(fs.readFileSync(cpsFile, "utf8")) as { version: number }).version === 3,
  )

  const badFile = path.join(tmp, "cps-bad.json")
  fs.writeFileSync(badFile, JSON.stringify({ version: 99, checkpoints: [mkCp()], snapshots: [] }))
  const fresh = new CheckpointManager(badFile, { now: () => NOW })
  check(
    "unknown schema version resets to fresh, never crashes",
    fresh.checkpoints().length === 0 && fresh.latest("b1") === undefined,
  )

  const leakFile = path.join(tmp, "cps-leak.json")
  const ml = new CheckpointManager(leakFile, { now: () => NOW })
  ml.record({ ...mkCp(), secret: "sk-leak-123" } as unknown as BranchCheckpoint)
  const stored = fs.readFileSync(leakFile, "utf8")
  check(
    "record() whitelists keys; smuggled fields cannot persist",
    !stored.includes("sk-leak-123"),
    stored.slice(0, 160),
  )

  const telE = new Telemetry(path.join(tmp, "cps-events.jsonl"), { now: () => NOW })
  const me = new CheckpointManager(null, { now: () => NOW, telemetry: telE })
  me.record(mkCp({ runId: "run_ce", branchId: "bx", milestone: "build_complete", workSecondsCompleted: 75 }))
  const ev = telE.list("run_ce").find((e) => e.type === "CHECKPOINT")
  const summary = ev?.data.checkpoint as
    | { branchId: string; milestone: string; workSecondsCompleted: number }
    | undefined
  check(
    "record() emits a CHECKPOINT summary event to the durable log",
    !!ev &&
      ev.sequence === 1 &&
      summary?.branchId === "bx" &&
      summary.milestone === "build_complete" &&
      summary.workSecondsCompleted === 75,
    JSON.stringify(ev?.data),
  )
  check(
    "the event log never carries file contents from the patch state",
    !!ev && !JSON.stringify(ev.data).includes("export const a = 2"),
  )
}

// ---- Req 12: honest resume-vs-restart ----
{
  check("the resume threshold is the documented 30s policy constant", MIN_RESUME_WORK_SECONDS === 30)

  const d = decideResume({ branchId: "b1", failureKind: "429", checkpoint: mkCp() })
  check(
    "transient failure with meaningful work resumes from the milestone",
    d.action === "resume" && d.savedWorkSeconds === 120 && d.fromStep === "tests_partial" && !!d.checkpoint,
    JSON.stringify(d),
  )
  check(
    "the resume reason quantifies what the checkpoint preserves",
    d.reason.includes("120s") && d.reason.includes("1 pending action") && d.reason.includes("tests_partial"),
    d.reason,
  )
  check(
    "the boundary is inclusive: exactly 30s saved still resumes",
    decideResume({
      branchId: "b1",
      failureKind: "provider_timeout",
      checkpoint: mkCp({ workSecondsCompleted: 30 }),
    }).action === "resume",
  )
  const none = decideResume({ branchId: "b1", failureKind: "connection_loss" })
  check(
    "no checkpoint means restart, honestly reported as 0 saved work",
    none.action === "restart" && none.savedWorkSeconds === 0 && none.checkpoint === undefined && none.reason.includes("no checkpoint"),
    JSON.stringify(none),
  )
  const tiny = decideResume({
    branchId: "b1",
    failureKind: "worker_crash",
    checkpoint: mkCp({ workSecondsCompleted: 10, milestone: "root_cause_identified" }),
  })
  check(
    "a trivial checkpoint restarts because restoring costs more than redoing",
    tiny.action === "restart" && tiny.savedWorkSeconds === 10 && tiny.reason.includes("cheaper"),
    JSON.stringify(tiny),
  )
  check(
    "a zero-work checkpoint also restarts",
    decideResume({ branchId: "b1", failureKind: "model_failure", checkpoint: mkCp({ workSecondsCompleted: 0 }) })
      .action === "restart",
  )

  const telR = new Telemetry(path.join(tmp, "resume-events.jsonl"), { now: () => NOW })
  const mr = new CheckpointManager(path.join(tmp, "resume-cps.json"), { now: () => NOW, telemetry: telR })
  mr.record(mkCp({ runId: "run_r", branchId: "b9", milestone: "patch_drafted", workSecondsCompleted: 60 }))
  mr.record(mkCp({ runId: "run_r", branchId: "b9", milestone: "tests_partial", workSecondsCompleted: 180 }))
  const recovered = new CheckpointManager(path.join(tmp, "resume-cps.json"), { now: () => NOW, telemetry: telR })
  const dec = recovered.resume({ branchId: "b9", failureKind: "provider_timeout" })
  const rev = telR.list("run_r").find((e) => e.type === "RESUME")
  check(
    "a recovered manager resumes from the NEWEST stored checkpoint",
    dec.action === "resume" && dec.savedWorkSeconds === 180 && dec.fromStep === "tests_partial",
    JSON.stringify(dec),
  )
  check(
    "the resume decision itself lands in the durable log",
    !!rev && rev.sequence === 3 && rev.data.decision === "resume" && rev.data.savedWorkSeconds === 180,
    JSON.stringify(rev?.data),
  )
  const ghost = recovered.resume({ branchId: "b-ghost", failureKind: "worker_crash" })
  const gev = telR.list().filter((e) => e.type === "RESUME")
  check(
    "a restart decision is logged too, with 0 saved work",
    ghost.action === "restart" && ghost.savedWorkSeconds === 0 && gev.length === 2 && gev[1]!.data.decision === "restart",
    JSON.stringify(gev.map((e) => e.data.decision)),
  )
}

// ---- Req 13: per-branch snapshots ----
{
  const snapsFile = path.join(tmp, "snaps.json")
  const ms = new CheckpointManager(snapsFile, { now: () => NOW })
  const s1 = ms.snapshot({
    branchId: "b1",
    runId: "run_s",
    files: [
      { path: "src/a.ts", before: "a1", after: "a2" },
      { path: "src/b.ts", before: "b1", after: "b2" },
    ],
    provenance: ["lane b1"],
  })
  ms.snapshot({ branchId: "b2", runId: "run_s", files: [{ path: "src/c.ts", before: "c1", after: "c2" }] })
  const reloadedS = new CheckpointManager(snapsFile, { now: () => NOW })
  check(
    "snapshots capture per-file before/after and persist",
    reloadedS.snapshots().length === 2 &&
      reloadedS.snapshots("b1").length === 1 &&
      reloadedS.snapshots("b1")[0]!.files.length === 2 &&
      reloadedS.snapshots("b1")[0]!.files[0]!.path === "src/a.ts" &&
      reloadedS.snapshots("b1")[0]!.files[0]!.before === "a1" &&
      reloadedS.snapshots("b1")[0]!.files[0]!.after === "a2",
    JSON.stringify(reloadedS.snapshots("b1")[0]?.files),
  )
  check(
    "snapshots are isolated per branch",
    reloadedS.snapshots("b2").length === 1 && reloadedS.snapshots("b2")[0]!.files[0]!.path === "src/c.ts",
  )
  check(
    "snapshot ids and timestamps come from the injected clock",
    s1.id.startsWith("snap_") && s1.createdAt === NOW && s1.provenance[0] === "lane b1",
  )

  const telSN = new Telemetry(path.join(tmp, "snap-events.jsonl"), { now: () => NOW })
  const msn = new CheckpointManager(null, { now: () => NOW, telemetry: telSN })
  const s2 = msn.snapshot({ branchId: "bx", runId: "run_sn", files: [{ path: "p/x.ts", before: "x", after: "y" }] })
  const sev = telSN.list("run_sn").find((e) => e.type === "SNAPSHOT")
  check(
    "snapshot() emits a SNAPSHOT event with the file count",
    !!sev && sev.data.snapshotId === s2.id && sev.data.fileCount === 1,
    JSON.stringify(sev?.data),
  )
}

// ---- Req 14: selective rollback ----
{
  const telRB = new Telemetry(path.join(tmp, "roll-events.jsonl"), { now: () => NOW })
  const mr2 = new CheckpointManager(path.join(tmp, "roll.json"), { now: () => NOW, telemetry: telRB })
  const early = mr2.snapshot({
    branchId: "b1",
    runId: "run_rb",
    files: [
      { path: "src/a.ts", before: "v1", after: "v2" },
      { path: "src/b.ts", before: "w1", after: "w2" },
    ],
  })
  const late = mr2.snapshot({
    branchId: "b1",
    runId: "run_rb",
    files: [{ path: "src/a.ts", before: "v2", after: "v3" }],
  })
  mr2.snapshot({ branchId: "b2", runId: "run_rb", files: [{ path: "src/z.ts", before: "z1", after: "z2" }] })

  const rb = mr2.rollback("b1")
  check(
    "rollback targets the latest snapshot of that branch only",
    rb.snapshotId === late.id &&
      rb.restores.length === 1 &&
      rb.restores[0]!.path === "src/a.ts" &&
      rb.restores[0]!.before === "v2",
    JSON.stringify(rb),
  )
  const earlier = mr2.rollback("b1", { snapshotId: early.id })
  check(
    "rollback can restore an earlier snapshot by id",
    earlier.restores.length === 2 && earlier.restores[0]!.before === "v1" && earlier.restores[1]!.before === "w1",
    JSON.stringify(earlier.restores),
  )
  const filtered = mr2.rollback("b1", { snapshotId: early.id, files: ["src/b.ts", "src/not-mine.ts"] })
  check(
    "a file filter restores a subset and names what was skipped",
    filtered.restores.length === 1 &&
      filtered.restores[0]!.path === "src/b.ts" &&
      filtered.restores[0]!.before === "w1" &&
      JSON.stringify(filtered.skipped) === JSON.stringify(["src/not-mine.ts"]) &&
      filtered.reason.includes("left alone"),
    JSON.stringify(filtered),
  )
  const noop = mr2.rollback("b7")
  check(
    "rollback without any snapshot is an honest no-op",
    noop.restores.length === 0 && noop.snapshotId === null && noop.reason.includes("no snapshot"),
    JSON.stringify(noop),
  )
  const missing = mr2.rollback("b1", { snapshotId: "snap_missing" })
  check(
    "an unknown snapshot id is reported, not guessed",
    missing.restores.length === 0 && missing.reason.includes("not found"),
    missing.reason,
  )
  const isolation = mr2.rollback("b1")
  check(
    "rolling back one branch never touches another branch's snapshots",
    mr2.snapshots("b2").length === 1 &&
      mr2.snapshots("b2")[0]!.files[0]!.before === "z1" &&
      !JSON.stringify(isolation.restores).includes("src/z.ts"),
    JSON.stringify(isolation),
  )
  const rbe = telRB.list("run_rb").filter((e) => e.type === "ROLLBACK")
  check(
    "each applied rollback emits a ROLLBACK event; no-ops emit none",
    rbe.length === 4 && JSON.stringify(rbe[0]!.data.restoredFiles) === JSON.stringify(["src/a.ts"]),
    JSON.stringify(rbe.map((e) => e.data.restoredFiles)),
  )
}

console.log(`\n[resilience] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
