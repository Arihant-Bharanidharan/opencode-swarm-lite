/**
 * Checkpoints, resume decisions, snapshots and selective rollback
 * (Req 11-14).
 * Req 11: branches checkpoint their progress at meaningful milestones
 *   (root cause identified, patch drafted, build complete, tests partial,
 *   verification pending, complete). Checkpoints persist in a versioned
 *   store, so a crashed or killed lane can be followed by a brand-new
 *   process that still sees them.
 * Req 12: after a failure the runtime decides RESUME vs RESTART from what
 *   the checkpoint actually preserves. Restoring state costs a reload plus
 *   re-orientation, so below MIN_RESUME_WORK_SECONDS of saved work a restart
 *   is simply cheaper. Every decision reports the saved work honestly,
 *   including restarts.
 * Req 13: snapshots record per-file before/after content for THIS branch's
 *   edits only - never another branch's files.
 * Req 14: rollback is selective: one branch, optionally one snapshot,
 *   optionally a subset of files. Rolling branch A back cannot touch
 *   branch B's state, and files the branch never touched are named as
 *   skipped rather than silently ignored.
 * Checkpoints are operational resume state, not learning data, so they may
 * carry the branch task text; the learning stores (history, trust) stay
 * task-text-free (Req 48). Telemetry events emitted here carry only
 * summaries (branchId, milestone, seconds, counts) - never file contents.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { Telemetry } from "./telemetry.js"
import type { BranchCheckpoint, BranchSnapshot, ResumeDecision, ResumeFailureKind } from "./types.js"
import { safeReadJson, safeWriteJson, uid } from "./util.js"

const CHECKPOINT_VERSION = 3
const MAX_RECORDS = 2000

/**
 * Runtime policy constant (NOT benchmark-derived, Req 52): restoring a
 * checkpoint costs a state reload plus re-orientation before the lane can
 * continue. Below this much preserved work, redoing the task from scratch is
 * cheaper than paying the restore.
 */
export const MIN_RESUME_WORK_SECONDS = 30

export interface CheckpointFile {
  version: number
  checkpoints: BranchCheckpoint[]
  snapshots: BranchSnapshot[]
}

export interface ResumeInput {
  branchId: string
  failureKind: ResumeFailureKind
  checkpoint?: BranchCheckpoint
}

export interface RollbackResult {
  branchId: string
  snapshotId: string | null
  /** Files to restore, with their pre-edit content. Never touches files the
   * branch did not itself edit. */
  restores: Array<{ path: string; before: string }>
  /** Requested files this branch never touched; left alone and named. */
  skipped: string[]
  reason: string
}

/**
 * The resume-vs-restart decision (Req 12), as a pure function so it can be
 * tested and replayed independently of any store. Deterministic: the same
 * inputs always yield the same decision and the same reason.
 */
export function decideResume(input: ResumeInput): ResumeDecision {
  const cp = input.checkpoint
  if (!cp) {
    return {
      branchId: input.branchId,
      action: "restart",
      savedWorkSeconds: 0,
      reason: `no checkpoint preserved for branch ${input.branchId} (${input.failureKind}); nothing to resume, restarting from scratch`,
    }
  }
  if (cp.workSecondsCompleted < MIN_RESUME_WORK_SECONDS) {
    return {
      branchId: input.branchId,
      action: "restart",
      checkpoint: cp,
      savedWorkSeconds: cp.workSecondsCompleted,
      reason: `checkpoint at milestone ${cp.milestone} preserves only ${cp.workSecondsCompleted}s of work; a restart is cheaper than restoring state (${input.failureKind})`,
    }
  }
  return {
    branchId: input.branchId,
    action: "resume",
    fromStep: cp.milestone,
    checkpoint: cp,
    savedWorkSeconds: cp.workSecondsCompleted,
    reason: `checkpoint at milestone ${cp.milestone} preserves ${cp.workSecondsCompleted}s of work (${Object.keys(cp.patchState).length} file(s) edited, ${cp.evidence.length} evidence item(s), ${cp.pendingActions.length} pending action(s)); resuming from "${cp.milestone}" after ${input.failureKind}`,
  }
}

const isCheckpoint = (o: unknown): o is BranchCheckpoint =>
  !!o &&
  typeof o === "object" &&
  typeof (o as BranchCheckpoint).branchId === "string" &&
  typeof (o as BranchCheckpoint).milestone === "string" &&
  typeof (o as BranchCheckpoint).workSecondsCompleted === "number" &&
  typeof (o as BranchCheckpoint).createdAt === "number"

const isSnapshot = (o: unknown): o is BranchSnapshot =>
  !!o &&
  typeof o === "object" &&
  typeof (o as BranchSnapshot).branchId === "string" &&
  Array.isArray((o as BranchSnapshot).files) &&
  typeof (o as BranchSnapshot).createdAt === "number"

export class CheckpointManager {
  private cps: BranchCheckpoint[] = []
  private snaps: BranchSnapshot[] = []
  private readonly file: string | null
  private readonly now: () => number
  private readonly telemetry: Telemetry | null

  constructor(
    file: string | null,
    opts: { now?: () => number; telemetry?: Telemetry } = {},
  ) {
    this.file = file
    this.now = opts.now ?? (() => Date.now())
    this.telemetry = opts.telemetry ?? null
    this.load()
  }

  private load(): void {
    if (!this.file) return
    const data = safeReadJson<CheckpointFile>(this.file, {
      version: CHECKPOINT_VERSION,
      checkpoints: [],
      snapshots: [],
    })
    // Req 49 discipline: unknown schema version resets to a fresh start,
    // never crashes the runtime.
    if (!data || data.version !== CHECKPOINT_VERSION) return
    this.cps = (Array.isArray(data.checkpoints) ? data.checkpoints : []).filter(isCheckpoint)
    this.snaps = (Array.isArray(data.snapshots) ? data.snapshots : []).filter(isSnapshot)
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, {
      version: CHECKPOINT_VERSION,
      checkpoints: this.cps,
      snapshots: this.snaps,
    } satisfies CheckpointFile)
  }

  /**
   * Record a milestone checkpoint (Req 11). The input is key-whitelisted to
   * the BranchCheckpoint contract: unknown props a caller tried to smuggle
   * in are dropped before the store ever sees them.
   */
  record(input: BranchCheckpoint): BranchCheckpoint {
    const cp: BranchCheckpoint = {
      id: input.id || uid("ckpt"),
      runId: input.runId,
      branchId: input.branchId,
      task: input.task,
      role: input.role,
      model: input.model,
      provider: input.provider,
      capsule: input.capsule,
      filesInspected: input.filesInspected ?? [],
      hypothesis: input.hypothesis,
      evidence: input.evidence ?? [],
      commandsRun: input.commandsRun ?? [],
      pendingActions: input.pendingActions ?? [],
      patchState: input.patchState ?? {},
      verificationState: input.verificationState ?? {
        stage: "root_cause_identified",
        testsPassed: 0,
        testsTotal: 0,
      },
      workSecondsCompleted: input.workSecondsCompleted ?? 0,
      milestone: input.milestone,
      createdAt: input.createdAt || this.now(),
    }
    this.cps.push(cp)
    if (this.cps.length > MAX_RECORDS) this.cps = this.cps.slice(-MAX_RECORDS)
    this.save()
    // Summary only: the durable event log never carries file contents.
    this.telemetry?.log(
      "CHECKPOINT",
      {
        checkpoint: {
          branchId: cp.branchId,
          milestone: cp.milestone,
          workSecondsCompleted: cp.workSecondsCompleted,
          evidenceCount: cp.evidence.length,
          commandsRunCount: cp.commandsRun.length,
          pendingActionsCount: cp.pendingActions.length,
          filesInspectedCount: cp.filesInspected.length,
        },
      },
      { runId: cp.runId },
    )
    return cp
  }

  /** Most recent checkpoint for a branch, or undefined. */
  latest(branchId: string): BranchCheckpoint | undefined {
    const list = this.cps.filter((c) => c.branchId === branchId)
    return list.length ? list[list.length - 1] : undefined
  }

  checkpoints(branchId?: string): readonly BranchCheckpoint[] {
    return branchId ? this.cps.filter((c) => c.branchId === branchId) : [...this.cps]
  }

  /**
   * Decide resume-vs-restart for a failed branch (Req 12) using its stored
   * latest checkpoint, and log the decision. The decision (not just the
   * outcome) lands in the durable event log so replay can explain it.
   */
  resume(input: ResumeInput): ResumeDecision {
    const decision = decideResume({
      ...input,
      checkpoint: input.checkpoint ?? this.latest(input.branchId),
    })
    this.telemetry?.log(
      "RESUME",
      {
        decision: decision.action,
        branchId: decision.branchId,
        failureKind: input.failureKind,
        savedWorkSeconds: decision.savedWorkSeconds,
        fromStep: decision.fromStep,
      },
      { runId: decision.checkpoint?.runId },
    )
    return decision
  }

  /**
   * Snapshot a branch's own edits: per-file before/after content (Req 13).
   * Snapshots persist, so rollback survives crashes too.
   */
  snapshot(input: {
    branchId: string
    runId?: string
    files: Array<{ path: string; before: string; after: string }>
    provenance?: string[]
  }): BranchSnapshot {
    const snap: BranchSnapshot = {
      id: uid("snap"),
      branchId: input.branchId,
      runId: input.runId,
      files: input.files.map((f) => ({ path: f.path, before: f.before, after: f.after })),
      createdAt: this.now(),
      provenance: input.provenance ?? [],
    }
    this.snaps.push(snap)
    if (this.snaps.length > MAX_RECORDS) this.snaps = this.snaps.slice(-MAX_RECORDS)
    this.save()
    this.telemetry?.log(
      "SNAPSHOT",
      { snapshotId: snap.id, branchId: snap.branchId, fileCount: snap.files.length },
      { runId: snap.runId },
    )
    return snap
  }

  snapshots(branchId?: string): readonly BranchSnapshot[] {
    return branchId ? this.snaps.filter((s) => s.branchId === branchId) : [...this.snaps]
  }

  /**
   * Selective rollback (Req 14): produce the restore plan for ONE branch,
   * from its latest snapshot by default (or a specific one), optionally
   * limited to named files. Other branches' state is untouched by
   * construction: this method never reads anything but this branch's
   * snapshots, and returns restore content only for files this branch
   * actually edited.
   */
  rollback(branchId: string, opts: { snapshotId?: string; files?: string[] } = {}): RollbackResult {
    const mine = this.snaps.filter((s) => s.branchId === branchId)
    const target = opts.snapshotId ? mine.find((s) => s.id === opts.snapshotId) : mine[mine.length - 1]
    if (!target) {
      const reason =
        opts.snapshotId && mine.length > 0
          ? `snapshot ${opts.snapshotId} not found for branch ${branchId}; nothing was rolled back`
          : `branch ${branchId} has no snapshot; nothing was rolled back`
      return {
        branchId,
        snapshotId: opts.snapshotId ?? null,
        restores: [],
        skipped: opts.files ?? [],
        reason,
      }
    }
    const wanted = opts.files
    const restores = target.files
      .filter((f) => !wanted || wanted.includes(f.path))
      .map((f) => ({ path: f.path, before: f.before }))
    const skipped = wanted ? wanted.filter((p) => !target.files.some((f) => f.path === p)) : []
    this.telemetry?.log(
      "ROLLBACK",
      {
        branchId,
        snapshotId: target.id,
        restoredFiles: restores.map((r) => r.path),
        skippedCount: skipped.length,
      },
      { runId: target.runId },
    )
    return {
      branchId,
      snapshotId: target.id,
      restores,
      skipped,
      reason:
        `restoring ${restores.length} file(s) of branch ${branchId} to their state before its edits (snapshot ${target.id})` +
        (skipped.length > 0
          ? `; ${skipped.length} requested file(s) were never touched by this branch, so they were left alone`
          : ""),
    }
  }

  clear(): void {
    this.cps = []
    this.snaps = []
    this.save()
  }
}
