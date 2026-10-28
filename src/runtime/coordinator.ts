/**
 * RunCoordinator: closes the loop between telemetry, persistence, policy,
 * and execution. One coordinator can survive failure and dynamically use
 * multiple orchestration strategies inside a single mixed workload.
 *
 * The coordinator is record-keeping and orchestration-advisory: it plans
 * work, creates a durable per-run manifest, assigns branches to routed
 * providers, logs every lifecycle event, and tracks idempotent side effects.
 * It does NOT spawn lanes itself; the parent model dispatches lanes via
 * `subagent` and reports results back through recordBranchResult/closeRun.
 * On restart, recover() loads the manifest, sets RECOVERING, replays the
 * event log after the last durable sequence, restores provider state, and
 * resumes only unfinished useful work (RESUME vs RESTART per branch).
 *
 * Statuses: RUNNING | RECOVERING | COMPLETE | FAILED | CANCELLED.
 * Completion is never claimed before all branches are resolved.
 * Every durably-applied side effect carries a stable operation key; replay
 * skips already-applied operations (idempotent).
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  Category,
  CheckpointMilestone,
  ObservationStatus,
  Plan,
  ResumeDecision,
  RouteDecision,
  TaskInput,
  Topology,
} from "./types.js"
import type { RunManifest } from "./run-manifest.js"
import {
  RunManifestStore,
  RunManifestStatus,
  BranchManifestState,
  ProviderStateSnapshot,
  VerificationMarkState,
  CapsuleRef,
  operationKey,
} from "./run-manifest.js"
import { Telemetry, RebuiltState } from "./telemetry.js"
import { CheckpointManager } from "./checkpoint.js"
import type { PolicyStore, Resolution } from "./policy.js"
import type { AdaptiveScheduler } from "./scheduler.js"
import type { Router } from "./provider.js"
import type { ProviderHealth } from "./provider.js"
import type { LanePool } from "./lanes.js"
import type { CapsuleStore } from "./capsules.js"
import type { RunHistory } from "./history.js"
import type { StatsStore } from "./stats.js"
import { uid } from "./util.js"

export interface CoordinatorDeps {
  manifest: RunManifestStore
  telemetry: Telemetry
  checkpoint: CheckpointManager
  policy: PolicyStore
  scheduler: AdaptiveScheduler
  router: Router
  health: ProviderHealth
  lanes: LanePool
  capsules: CapsuleStore
  history: RunHistory
  stats: StatsStore
  now?: () => number
}

export interface BranchAssignment {
  branchId: string
  topology: Topology
  model: string
  provider: string
  role: string
  category: Category
  estimatedSeconds: number
  operationId: string
  criticalPath: boolean
}

export interface CoordinateResult {
  runId: string
  status: RunManifestStatus
  plan: Plan
  manifest: RunManifest
  assignments: BranchAssignment[]
  routing: RouteDecision
  resolution: Resolution
  decisions: string[]
}

export interface RecoverResult {
  runId: string
  status: RunManifestStatus
  rebuilt: RebuiltState | undefined
  decisions: ResumeDecision[]
  notes: string[]
  assignments: BranchAssignment[]
  message: string
}

export interface BranchResult {
  branchId: string
  status: ObservationStatus
  workSeconds?: number
  totalSeconds?: number
  tokensIn?: number
  tokensOut?: number
  quality?: number
  failureKind?: string
  checkpoint?: {
    milestone?: CheckpointMilestone
    workSecondsCompleted?: number
    evidence?: string[]
    pendingActions?: string[]
    patchState?: Record<string, string>
  }
}

export interface CloseRunInput {
  runId: string
  status?: RunManifestStatus
  actualSeconds?: number
  serialSeconds?: number
  workers?: number
  usefulWorkers?: number
  wastedWorkers?: number
  quality?: number
  qualityGain?: number
  verificationSeconds?: number
  reason?: string
}

const nowDefault = (): number => Date.now()

type BreakerKind = "ok" | "429" | "timeout" | "error" | "latency"

/** Map an ObservationStatus to a breaker record kind. */
const toBreakerKind = (status: ObservationStatus): BreakerKind => {
  switch (status) {
    case "ok":
      return "ok"
    case "429":
      return "429"
    case "timeout":
      return "timeout"
    case "interrupted":
      return "error"
    default:
      return "error"
  }
}

/** Map a TaskInput category to a specialist role. */
const roleForCategory = (category: Category, explicit?: string): string => {
  if (explicit) return explicit
  switch (category) {
    case "research":
    case "analysis":
      return "researcher"
    case "coding":
      return "coder"
    case "verification":
      return "verifier"
    case "ops":
      return "builder"
    case "microtask":
      return "builder"
    default:
      return "builder"
  }
}

const branchIdForTask = (t: { id?: string }, idx: number): string =>
  t && typeof t.id === "string" ? t.id : `branch-${idx + 1}`

/** Pick the routed model/provider, honoring a forced provider override. */
const chooseModel = (
  route: RouteDecision,
  forcedProvider: string | undefined,
): { model: string; provider: string } => {
  if (forcedProvider) {
    const forced = route.choices.find((c) => c.model.provider === forcedProvider)
    if (forced) return { model: forced.model.id, provider: forced.model.provider }
  }
  const choice = route.choices[0]
  return choice ? { model: choice.model.id, provider: choice.model.provider } : { model: "inherit", provider: "unknown" }
}

export class RunCoordinator {
  private readonly manifest: RunManifestStore
  private readonly telemetry: Telemetry
  private readonly checkpoint: CheckpointManager
  private readonly policy: PolicyStore
  private readonly scheduler: AdaptiveScheduler
  private readonly router: Router
  private readonly health: ProviderHealth
  private readonly lanes: LanePool
  private readonly capsules: CapsuleStore
  private readonly history: RunHistory
  private readonly stats: StatsStore
  private readonly now: () => number

  constructor(deps: CoordinatorDeps) {
    this.manifest = deps.manifest
    this.telemetry = deps.telemetry
    this.checkpoint = deps.checkpoint
    this.policy = deps.policy
    this.scheduler = deps.scheduler
    this.router = deps.router
    this.health = deps.health
    this.lanes = deps.lanes
    this.capsules = deps.capsules
    this.history = deps.history
    this.stats = deps.stats
    this.now = deps.now ?? nowDefault
  }

  /**
   * Plan and durably start a run. Creates a RUNNING manifest, resolves the
   * policy (manual overrides hard-win), routes every branch, assigns each
   * branch to a provider/model, logs PLAN + ASSIGN events, and returns the
   * full coordinate result so the parent model can dispatch lanes.
   *
   * Idempotent: re-coordinating an existing non-terminal run returns the
   * existing manifest and assignments without resetting progress.
   */
  coordinate(input: TaskInput, opts: { runId?: string; capsuleName?: string; capsuleVersion?: number } = {}): CoordinateResult {
    const decisions: string[] = []
    const runId = opts.runId ?? uid("run")

    // ---- 1. Resolve policy (manual override hard-wins, Req 22/50) ----
    const resolution = this.policy.resolve()
    if (resolution.disabled.learning) decisions.push("learning disabled by manual override")
    if (resolution.disabled.checkpoints) decisions.push("checkpoints disabled by manual override")
    if (resolution.disabled.selfTuning) decisions.push("self-tuning disabled by manual override")
    if (resolution.disabled.trustHistory) decisions.push("trust history disabled by manual override")
    if (resolution.disabled.counterfactuals) decisions.push("counterfactuals disabled by manual override")

    let effectiveInput = { ...input }
    if (resolution.forced.topology !== undefined) {
      decisions.push(`policy override forces topology ${resolution.forced.topology}`)
    }
    if (resolution.forced.agents !== undefined) {
      effectiveInput = {
        ...effectiveInput,
        budget: { ...(effectiveInput.budget ?? {}), agents: resolution.forced.agents },
      }
      decisions.push(`policy override forces ${resolution.forced.agents} agent(s)`)
    }
    if (resolution.forced.provider !== undefined) {
      effectiveInput = { ...effectiveInput, provider: resolution.forced.provider }
      decisions.push(`policy override forces provider ${resolution.forced.provider}`)
    }

    // ---- 2. Plan via the adaptive scheduler ----
    const plan = this.scheduler.plan(effectiveInput)
    // Align the plan's runId with the coordinator's runId so the durable
    // manifest is stored under the caller-supplied runId (Req: durable run manifest).
    plan.runId = runId
    decisions.push(`scheduler chose ${plan.topology} with ${plan.agents} agent(s) in ${plan.waves} wave(s)`)
    decisions.push(`estimated ${plan.estimates.chosen}s vs ${plan.estimates.serial}s serial (${plan.estimates.speedup}x)`)

    // ---- 3. Create / load the durable RUNNING manifest ----
    const policyVersion = this.policy.active()?.version ?? 1
    const capsuleRefs: Record<string, CapsuleRef> = {}
    if (opts.capsuleName) {
      capsuleRefs[opts.capsuleName] = { name: opts.capsuleName, version: opts.capsuleVersion ?? 1 }
    }
    const manifest = this.manifest.create(plan, policyVersion, capsuleRefs)

    let assignments: BranchAssignment[]
    if (manifest.status !== "RUNNING" || Object.keys(manifest.branches).length === 0) {
      // Fresh run: initialize branch states and build assignments.
      const branchStates = this.initializeBranches(plan)
      for (const [branchId, state] of Object.entries(branchStates)) {
        this.manifest.setBranch(runId, branchId, state)
      }
      assignments = this.buildAssignments(plan, branchStates, resolution.forced.provider)
      for (const a of assignments) {
        this.manifest.setBranch(runId, a.branchId, {
          topology: a.topology,
          model: a.model,
          provider: a.provider,
          role: a.role,
          category: a.category,
          status: "pending",
          appliedOperationIds: [a.operationId],
        })
      }
    } else {
      // Recovery path within coordinate: rebuild assignments from the manifest.
      assignments = this.rebuildAssignments(plan, manifest)
    }

    // ---- 4. Route every branch (trust-aware, degradation-aware) ----
    const routing = this.router.route({
      role: roleForCategory(effectiveInput.category ?? "mixed", effectiveInput.role),
      category: effectiveInput.category ?? "mixed",
      contextTokens: effectiveInput.contextTokens,
      qualityWeight: effectiveInput.qualityWeight,
      warm: effectiveInput.warm,
    })
    if (routing.blocked.length) decisions.push(...routing.blocked.slice(0, 3).map((b) => `route blocked: ${b}`))

    // ---- 5. Log PLAN + ASSIGN + SHADOW events ----
    this.telemetry.startRun(plan)
    this.telemetry.log(
      "ASSIGN",
      {
        assignments: assignments.map((a) => ({ branchId: a.branchId, model: a.model, provider: a.provider, topology: a.topology })),
        topology: plan.topology,
        agents: plan.agents,
        waves: plan.waves,
      },
      { runId },
    )
    this.telemetry.log(
      "SHADOW",
      {
        alternatives: plan.alternatives,
        chosen: plan.topology,
        note: "shadow ranking uses the same priors; it is not a second dispatch",
      },
      { runId },
    )

    // Record durable provider state snapshots (idempotent per provider).
    for (const provider of Object.keys(this.health.snapshot())) {
      const rel = this.health.providerReliability(provider)
      this.manifest.setProviderState(runId, {
        provider,
        state: rel.state,
        failures: rel.failures,
        opens: rel.opens,
        cooldownRemaining: rel.cooldownRemaining,
        lastKind: rel.lastKind,
        lastFailureAt: rel.lastFailureAt,
        lastSuccessAt: rel.lastSuccessAt,
        recoveryCount: rel.recoveryCount,
      })
    }

    return { runId, status: manifest.status, plan, manifest, assignments, routing, resolution, decisions }
  }

  /**
   * Recover a run after a crash or restart. Loads the manifest, sets
   * RECOVERING, rebuilds lane + checkpoint state from the event log after the
   * last durable sequence, decides RESUME vs RESTART for each unfinished
   * branch, and returns assignments for the work that still needs doing.
   *
   * Idempotent: recovering an already-terminal run returns its final state.
   */
  recover(runId: string): RecoverResult {
    const manifest = this.manifest.load(runId)
    if (!manifest) {
      return { runId, status: "FAILED", rebuilt: undefined, decisions: [], notes: [], assignments: [], message: `no manifest for run ${runId}` }
    }

    // Terminal runs are already resolved; nothing to recover.
    if (manifest.status === "COMPLETE" || manifest.status === "FAILED" || manifest.status === "CANCELLED") {
      return {
        runId,
        status: manifest.status,
        rebuilt: this.telemetry.rebuildState(runId),
        decisions: [],
        notes: [],
        assignments: [],
        message: `run ${runId} is already ${manifest.status.toLowerCase()}`,
      }
    }

    // Transition to RECOVERING (durable).
    this.manifest.setStatus(runId, "RECOVERING")
    const decisions: ResumeDecision[] = []
    const notes: string[] = []

    // Rebuild state from the durable event log (Req 33).
    const rebuilt = this.telemetry.rebuildState(runId)

    // Resolve policy so forced provider overrides apply during recovery.
    const resolution = this.policy.resolve()

    // Restore provider state snapshots into the health circuit breaker so the
    // breaker reflects the pre-crash state.
    for (const [provider, snap] of Object.entries(manifest.providerState)) {
      for (let i = 0; i < snap.failures; i++) {
        this.health.record(provider, (snap.lastKind ?? "error") as BreakerKind)
      }
    }

    // ---- Decide RESUME vs RESTART for every unresolved branch ----
    const unresolved: BranchManifestState[] = Object.values(manifest.branches).filter(
      (b) => b.status !== "completed" && b.status !== "cancelled" && b.status !== "failed",
    )

    const assignments: BranchAssignment[] = []
    const plan = manifest.plan

    for (const branch of unresolved) {
      const cp = this.checkpoint.latest(branch.branchId)
      // checkpoint.resume decides resume-vs-restart (Req 12) and logs it.
      const decision = this.checkpoint.resume({
        branchId: branch.branchId,
        failureKind: "unknown",
        checkpoint: cp,
      })
      decisions.push(decision)

      if (decision.action === "resume") {
        notes.push(`resume branch ${branch.branchId} from "${decision.fromStep ?? "<none>"}" (${decision.savedWorkSeconds}s preserved)`)
        this.manifest.setBranch(runId, branch.branchId, {
          status: "in_progress",
          workSecondsCompleted: decision.savedWorkSeconds,
          milestone: (decision.fromStep ?? undefined) as CheckpointMilestone | undefined,
        })
      } else {
        notes.push(`restart branch ${branch.branchId}: ${decision.reason}`)
        this.manifest.setBranch(runId, branch.branchId, { status: "pending", workSecondsCompleted: 0 })
      }

      // (Re)assign the branch for execution.
      const category = (branch.category ?? plan.task.category ?? "mixed") as Category
      const role = roleForCategory(category, branch.role)
      const route = this.router.route({ role, category })
      const { model, provider } = chooseModel(route, resolution.forced.provider)
      const opId = operationKey({ kind: "patch", runId, branchId: branch.branchId, seq: branch.workSecondsCompleted })
      assignments.push({
        branchId: branch.branchId,
        topology: plan.topology,
        model,
        provider,
        role,
        category,
        estimatedSeconds: branch.workSecondsCompleted > 0 ? Math.max(1, plan.estimates.chosen / Math.max(1, Object.values(manifest.branches).length)) : plan.estimates.chosen,
        operationId: opId,
        criticalPath: false,
      })
      this.manifest.setBranch(runId, branch.branchId, {
        status: "in_progress",
        model,
        provider,
        role,
        category,
        topology: plan.topology,
        appliedOperationIds: [opId],
      })
    }

    const lastSeq = rebuilt ? Math.max(0, ...rebuilt.lanes.map((l) => l.eventCount)) : 0
    this.manifest.setLastEventSequence(runId, lastSeq)

    const message =
      unresolved.length === 0
        ? `run ${runId} has no unresolved branches; all branches resolved`
        : `recovering run ${runId}: ${unresolved.length} branch(es) need ${decisions.filter((d) => d.action === "resume").length} resume(s), ${decisions.filter((d) => d.action === "restart").length} restart(s)`

    return { runId, status: "RECOVERING", rebuilt, decisions, notes, assignments, message }
  }

  /**
   * Record the result of one executed branch. Durable and idempotent: the
   * operation key (patch + branch + sequence) ensures a re-delivered result
   * is never applied twice. Updates the manifest branch state, logs LANE_DONE
   * or LANE_FAIL, records the observation in the learned cost model and
   * provider breaker, and checkpoints when a milestone is supplied.
   */
  recordBranchResult(runId: string, result: BranchResult, opts: { resume?: boolean } = {}): { applied: boolean; manifest: RunManifest | undefined } {
    const manifest = this.manifest.load(runId)
    if (!manifest) return { applied: false, manifest: undefined }

    const branch = manifest.branches[result.branchId]
    if (!branch) return { applied: false, manifest }

    // The idempotency key identifies *this result delivery*, not accumulated
    // progress: re-delivering the same result must yield the same key and be
    // skipped. workSecondsCompleted still accumulates separately below.
    const totalSeconds = branch.workSecondsCompleted + (result.workSeconds ?? 0)
    const opId = operationKey({ kind: "patch", runId, branchId: result.branchId, seq: result.workSeconds ?? 0 })

    // Idempotent: skip if this patch was already durably applied.
    if (this.manifest.hasOperation(runId, opId)) {
      return { applied: false, manifest }
    }

    const completed = result.status === "ok"
    const failed = result.status === "error" || result.status === "timeout" || result.status === "429" || result.status === "interrupted"

    // Record checkpoint if a milestone was supplied (Req 11).
    if (result.checkpoint) {
      this.checkpoint.record({
        id: uid("ckpt"),
        runId,
        branchId: result.branchId,
        task: (manifest.plan.task as { task?: string }).task,
        role: branch.role,
        model: branch.model,
        provider: branch.provider,
        capsule: branch.capsule,
        filesInspected: [],
        hypothesis: undefined,
        evidence: result.checkpoint.evidence ?? [],
        commandsRun: [],
        pendingActions: result.checkpoint.pendingActions ?? [],
        patchState: result.checkpoint.patchState ?? {},
        verificationState: {
          stage: (result.checkpoint.milestone ?? "root_cause_identified") as CheckpointMilestone,
          testsPassed: 0,
          testsTotal: 0,
        },
        workSecondsCompleted: result.workSeconds ?? branch.workSecondsCompleted,
        milestone: (result.checkpoint.milestone ?? "root_cause_identified") as CheckpointMilestone,
        createdAt: this.now(),
      })
    }

    // Update manifest branch state.
    const nextStatus: BranchManifestState["status"] = completed ? "completed" : failed ? "failed" : "in_progress"
    this.manifest.setBranch(runId, result.branchId, {
      status: nextStatus,
      workSecondsCompleted: totalSeconds,
      patchApplied: true,
      verificationPassed: completed,
      completedAt: completed ? this.now() : undefined,
    })
    this.manifest.recordOperation(runId, opId)

    // Log the lane outcome.
    this.telemetry.log(
      completed ? "LANE_DONE" : "LANE_FAIL",
      {
        laneId: result.branchId,
        provider: branch.provider,
        model: branch.model,
        role: branch.role,
        category: branch.category ?? "mixed",
        warm: false,
        startupSeconds: 0,
        workSeconds: result.workSeconds ?? 0,
        totalSeconds: result.totalSeconds ?? result.workSeconds ?? 0,
        status: result.status,
        failureKind: result.failureKind,
        branch: result.branchId,
      },
      { runId },
    )

    // Record into the learned cost model and provider breaker.
    const provider = branch.provider ?? "unknown"
    const model = branch.model ?? "unknown"
    const category = (branch.category ?? "mixed") as Category
    const role = branch.role ?? "builder"
    const obs: Parameters<StatsStore["add"]>[0] = {
      ts: this.now(),
      runId,
      laneId: result.branchId,
      provider,
      model,
      role,
      category,
      warm: false,
      startupSeconds: 0,
      workSeconds: result.workSeconds ?? 0,
      totalSeconds: result.totalSeconds ?? result.workSeconds ?? 0,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      status: result.status,
      failureKind: result.failureKind,
      branch: result.branchId,
      source: "tool:swarm_coordinate",
    }
    this.stats.add(obs)
    this.health.record(provider, toBreakerKind(result.status))

    return { applied: true, manifest: this.manifest.load(runId) ?? manifest }
  }

  /**
   * Close a run with a terminal status. Never claims COMPLETE unless every
   * branch is resolved (completed, cancelled, or failed). Records the OUTCOME
   * telemetry event and an efficiency report.
   */
  closeRun(input: CloseRunInput): { ok: boolean; manifest: RunManifest | undefined; reason?: string } {
    const manifest = this.manifest.load(input.runId)
    if (!manifest) return { ok: false, manifest: undefined, reason: `no manifest for run ${input.runId}` }

    const status = input.status ?? "COMPLETE"

    // Guard: COMPLETE requires all branches resolved.
    if (status === "COMPLETE") {
      const unresolved = Object.values(manifest.branches).filter(
        (b) => b.status !== "completed" && b.status !== "cancelled" && b.status !== "failed",
      )
      if (unresolved.length > 0) {
        return { ok: false, manifest, reason: `cannot complete: ${unresolved.length} branch(es) still unresolved` }
      }
    }

    const next = this.manifest.setStatus(input.runId, status)
    if (!next) return { ok: false, manifest, reason: `status transition to ${status} was refused` }

    // Build and record the efficiency report.
    const plan = manifest.plan
    const actualSeconds = input.actualSeconds ?? plan.estimates.chosen
    const serialSeconds = input.serialSeconds ?? plan.estimates.serial
    const workers = Math.max(1, input.workers ?? plan.agents)
    const wasted = Math.max(0, input.wastedWorkers ?? 0)
    const useful = Math.max(0, input.usefulWorkers ?? Math.max(0, workers - wasted))
    const report = Telemetry.efficiency({
      runId: input.runId,
      predictedSeconds: plan.estimates.chosen,
      actualSeconds,
      serialSeconds,
      workers,
      usefulWorkers: useful,
      wastedWorkers: wasted,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      quality: input.quality,
      qualityGain: input.qualityGain,
      verificationSeconds: input.verificationSeconds,
      startupSeconds: 0,
    })

    this.telemetry.finish(input.runId, report)

    if (input.reason) {
      this.telemetry.log("NOTE", { reason: input.reason, status }, { runId: input.runId })
    }

    return { ok: true, manifest: next, reason: report.reasons.join("; ") }
  }

  /**
   * Cancel a run: marks every in-progress/pending branch cancelled and sets
   * terminal CANCELLED status. Idempotent.
   */
  cancelRun(runId: string, reason?: string): { ok: boolean; manifest: RunManifest | undefined } {
    const manifest = this.manifest.load(runId)
    if (!manifest) return { ok: false, manifest: undefined }

    for (const [branchId, branch] of Object.entries(manifest.branches)) {
      if (branch.status === "pending" || branch.status === "in_progress") {
        this.manifest.setBranch(runId, branchId, {
          status: "cancelled",
          cancelledAt: this.now(),
          cancelReason: reason,
        })
      }
    }

    const next = this.manifest.setStatus(runId, "CANCELLED")
    if (next && reason) {
      this.telemetry.log("CANCEL", { reason }, { runId })
    }
    return { ok: !!next, manifest: next ?? manifest }
  }

  /** Get the current manifest for a run (read-only). */
  getManifest(runId: string): RunManifest | undefined {
    return this.manifest.load(runId)
  }

  /** List all incomplete run IDs on disk (candidates for recovery). */
  incompleteRuns(): string[] {
    return this.manifest.incompleteRunIds()
  }

  // ---- internal helpers ----

  private initializeBranches(plan: Plan): Record<string, BranchManifestState> {
    const states: Record<string, BranchManifestState> = {}
    const now = this.now()
    const branchIds: string[] = []
    const task = plan.task as { branches?: number; tasks?: Array<{ id?: string }>; nodes?: Array<{ id?: string }>; category?: Category }

    if (task.branches && task.branches > 1) {
      for (let i = 0; i < task.branches; i++) branchIds.push(`branch-${i + 1}`)
    } else if (task.tasks?.length) {
      for (const t of task.tasks) branchIds.push(branchIdForTask(t, branchIds.length))
    } else if (task.nodes?.length) {
      for (const n of task.nodes) branchIds.push(branchIdForTask(n, branchIds.length))
    } else {
      branchIds.push("root")
    }

    for (const branchId of branchIds) {
      states[branchId] = {
        branchId,
        status: "pending",
        milestone: undefined,
        workSecondsCompleted: 0,
        patchApplied: false,
        appliedOperationIds: [],
        createdAt: now,
      } as BranchManifestState
    }
    return states
  }

  private buildAssignments(plan: Plan, branchStates: Record<string, BranchManifestState>, forcedProvider: string | undefined): BranchAssignment[] {
    const assignments: BranchAssignment[] = []
    const task = plan.task as { category?: Category }
    let idx = 0
    for (const branchId of Object.keys(branchStates)) {
      const category = (task.category ?? "mixed") as Category
      const role = roleForCategory(category)
      const route = this.router.route({ role, category })
      const { model, provider } = chooseModel(route, forcedProvider)
      const opId = operationKey({ kind: "patch", runId: plan.runId, branchId, seq: 0 })
      assignments.push({
        branchId,
        topology: plan.topology,
        model,
        provider,
        role,
        category,
        estimatedSeconds: plan.estimates.chosen / Math.max(1, Object.keys(branchStates).length),
        operationId: opId,
        criticalPath: idx === 0,
      })
      idx++
    }
    return assignments
  }

  private rebuildAssignments(plan: Plan, manifest: RunManifest): BranchAssignment[] {
    const assignments: BranchAssignment[] = []
    for (const [branchId, branch] of Object.entries(manifest.branches)) {
      if (branch.status === "pending" || branch.status === "in_progress") {
        const category = (branch.category ?? plan.task.category ?? "mixed") as Category
        const role = branch.role ?? roleForCategory(category)
        assignments.push({
          branchId,
          topology: branch.topology ?? plan.topology,
          model: branch.model ?? (plan.models[0] ?? "inherit"),
          provider: branch.provider ?? "unknown",
          role,
          category,
          estimatedSeconds: Math.max(1, plan.estimates.chosen / Math.max(1, Object.keys(manifest.branches).length)),
          operationId: operationKey({ kind: "patch", runId: plan.runId, branchId, seq: branch.workSecondsCompleted }),
          criticalPath: false,
        })
      }
    }
    return assignments
  }
}
