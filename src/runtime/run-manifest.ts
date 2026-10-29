/**
 * Durable per-run manifest for coordinator crash recovery.
 *
 * One manifest file per run under <stateDir>/run-manifests/<runId>.json.
 * Updates are idempotent (keyed by stable operation IDs) and atomic
 * (tmp file + rename). The manifest is the source of truth for what work
 * is durable: a restarted coordinator loads it, replays the event log after
 * the last durable snapshot, restores provider/policy/capsule state, and
 * resumes only unfinished useful work.
 *
 * Statuses: RUNNING | RECOVERING | COMPLETE | FAILED | CANCELLED.
 * Completion is never claimed before the required state is durable.
 *
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import fs from "node:fs"
import path from "node:path"
import type {
  BranchCheckpoint,
  BranchSnapshot,
  Category,
  CheckpointMilestone,
  ModelProfile,
  Plan,
  PlanEstimates,
  ProviderReliability,
  ProviderState,
  Topology,
  VerificationLevel,
} from "./types.js"
import { round, safeReadJson, safeWriteJson, uid } from "./util.js"

export type RunManifestStatus = "RUNNING" | "RECOVERING" | "COMPLETE" | "FAILED" | "CANCELLED"

export interface BranchManifestState {
  branchId: string
  status: "pending" | "in_progress" | "checkpointed" | "completed" | "cancelled" | "failed"
  milestone?: CheckpointMilestone
  workSecondsCompleted: number
  patchApplied: boolean
  patchOperationId?: string
  verificationLevel?: VerificationLevel
  verificationPassed?: boolean
  verificationOperationId?: string
  completedAt?: number
  cancelledAt?: number
  cancelReason?: string
  topology?: Topology
  model?: string
  provider?: string
  category?: Category
  role?: string
  capsule?: { name: string; version: number }
  /** Stable operation IDs already durably applied for this branch. */
  appliedOperationIds: string[]
}

export interface ProviderStateSnapshot {
  provider: string
  state: ProviderState
  failures: number
  opens: number
  cooldownRemaining: number
  lastKind?: string
  lastFailureAt?: number
  lastSuccessAt?: number
  recoveryCount: number
}

export interface VerificationMarkState {
  branchId: string
  level: VerificationLevel
  passed: boolean
  completedAt: number
  operationId: string
}

export interface CapsuleRef {
  name: string
  version: number
  digest?: string
}

export interface RunManifest {
  runId: string
  status: RunManifestStatus
  plan: Plan
  policyVersion: number
  createdAt: number
  updatedAt: number
  generation: number
  branches: Record<string, BranchManifestState>
  completedTasks: string[]
  pendingTasks: string[]
  providerState: Record<string, ProviderStateSnapshot>
  verificationState: Record<string, VerificationMarkState>
  lastEventSequence: number
  capsuleRefs: Record<string, CapsuleRef>
  appliedOperationIds: string[]
}

export interface ManifestOptions {
  dir: string
  now?: () => number
}

const MANIFEST_VERSION = 1

interface ManifestFile {
  version: number
  manifest: RunManifest
}

const isManifestStatus = (v: unknown): v is RunManifestStatus =>
  typeof v === "string" &&
  ["RUNNING", "RECOVERING", "COMPLETE", "FAILED", "CANCELLED"].includes(v)

/**
 * Idempotency key for any durably-applied side effect. The coordinator
 * presents this key before patch/merge/verify/checkpoint/complete/etc.; if
 * the key is already in `appliedOperationIds`, the side effect is skipped
 * on replay.
 */
export interface OperationKey {
  kind: "patch" | "merge" | "verify" | "checkpoint" | "complete" | "provider" | "integrate"
  branchId?: string
  runId?: string
  provider?: string
  level?: VerificationLevel
  /** Content hash or sequence number that makes the key stable across replays. */
  seq?: number | string
}

export function operationKey(k: OperationKey): string {
  const parts = [k.kind, k.runId ?? "", k.branchId ?? "", k.provider ?? "", k.level ?? "", k.seq ?? ""]
  return parts.join(":")
}

const nowDefault = (): number => Date.now()

export class RunManifestStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly manifests = new Map<string, RunManifest>()

  constructor(opts: ManifestOptions) {
    this.dir = opts.dir
    this.now = opts.now ?? nowDefault
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
      } catch {
        // ignore; load() will handle missing files gracefully
      }
    }
  }

  private file(runId: string): string {
    return path.join(this.dir, `${runId}.json`)
  }

  private tmpFile(runId: string): string {
    return path.join(this.dir, `.${runId}.${process.pid}.${Date.now()}.tmp`)
  }

  /** Create a fresh RUNNING manifest for a plan. Idempotent: re-creating an
   *  existing RUNNING manifest returns it unchanged (never resets progress). */
  create(plan: Plan, policyVersion: number, capsuleRefs: Record<string, CapsuleRef> = {}): RunManifest {
    const runId = plan.runId
    const existing = this.load(runId)
    if (existing && existing.status !== "COMPLETE" && existing.status !== "FAILED" && existing.status !== "CANCELLED") {
      return existing
    }
    const now = this.now()
    const manifest: RunManifest = {
      runId,
      status: "RUNNING",
      plan,
      policyVersion,
      createdAt: now,
      updatedAt: now,
      generation: 1,
      branches: {},
      completedTasks: [],
      pendingTasks: [],
      providerState: {},
      verificationState: {},
      lastEventSequence: 0,
      capsuleRefs,
      appliedOperationIds: [],
    }
    this.manifests.set(runId, manifest)
    this.persist(manifest)
    return manifest
  }

  /** Load a manifest from disk (or memory cache). Returns undefined when absent. */
  load(runId: string): RunManifest | undefined {
    const cached = this.manifests.get(runId)
    if (cached) return cached
    const data = safeReadJson<ManifestFile>(this.file(runId), {} as ManifestFile)
    if (!data || data.version !== MANIFEST_VERSION || !data.manifest) return undefined
    const m = data.manifest as RunManifest
    if (!m.runId || !isManifestStatus(m.status)) return undefined
    this.manifests.set(runId, m)
    return m
  }

  /** List runIds that have a manifest on disk. */
  listRunIds(): string[] {
    if (!fs.existsSync(this.dir)) return []
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .map((f) => f.slice(0, -5))
    } catch {
      return []
    }
  }

  /** Discover incomplete (non-terminal) runIds on disk. */
  incompleteRunIds(): string[] {
    const out: string[] = []
    for (const id of this.listRunIds()) {
      const m = this.load(id)
      if (m && m.status !== "COMPLETE" && m.status !== "FAILED" && m.status !== "CANCELLED") out.push(id)
    }
    return out.sort()
  }

  /**
   * Atomically update the manifest. `mutate` receives the current manifest and
   * returns the next one (or undefined to abort). The write is atomic via
   * tmp + rename so a process termination never leaves a half-written file.
   * Idempotency: operation IDs already present are never re-added.
   */
  update(runId: string, mutate: (m: RunManifest) => RunManifest | undefined): RunManifest | undefined {
    let current = this.load(runId)
    if (!current) return undefined
    const next = mutate({ ...current })
    if (!next) return current
    next.updatedAt = this.now()
    next.generation = (current.generation ?? 0) + 1
    // Dedupe applied operation ids.
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const id of next.appliedOperationIds) {
      if (!seen.has(id)) {
        seen.add(id)
        deduped.push(id)
      }
    }
    next.appliedOperationIds = deduped
    this.manifests.set(runId, next)
    this.persist(next)
    return next
  }

  /** Mark a branch's state, creating or merging idempotently. */
  setBranch(
    runId: string,
    branchId: string,
    partial: Partial<BranchManifestState>,
  ): RunManifest | undefined {
    return this.update(runId, (m) => {
      const existing = m.branches[branchId]
      const next: BranchManifestState = existing
        ? { ...existing, ...partial, appliedOperationIds: existing.appliedOperationIds.slice() }
        : {
            branchId,
            status: "pending",
            milestone: undefined,
            workSecondsCompleted: 0,
            patchApplied: false,
            appliedOperationIds: [],
            ...partial,
          }
      m.branches[branchId] = next
      if (next.status === "completed" && !m.completedTasks.includes(branchId)) {
        m.completedTasks.push(branchId)
      }
      if (next.status === "cancelled" && !m.completedTasks.includes(branchId)) {
        // cancelled branches are tracked separately but not as completed
      }
      m.pendingTasks = m.pendingTasks.filter((t) => t !== branchId)
      return m
    })
  }

  /** Record that an operation ID was durably applied (idempotent). */
  recordOperation(runId: string, opId: string): RunManifest | undefined {
    return this.update(runId, (m) => {
      if (m.appliedOperationIds.includes(opId)) return m
      m.appliedOperationIds.push(opId)
      return m
    })
  }

  /** Has this operation already been durably applied? */
  hasOperation(runId: string, opId: string): boolean {
    const m = this.load(runId)
    return !!m && m.appliedOperationIds.includes(opId)
  }

  /** Set terminal status. Never claims COMPLETE unless all pending branches
   *  are resolved (completed, cancelled, or failed). */
  setStatus(runId: string, status: RunManifestStatus): RunManifest | undefined {
    return this.update(runId, (m) => {
      if (status === "COMPLETE") {
        const unresolved = Object.values(m.branches).filter(
          (b) => b.status !== "completed" && b.status !== "cancelled" && b.status !== "failed",
        )
        if (unresolved.length > 0) return undefined // refuse to claim completion
      }
      m.status = status
      return m
    })
  }

  /** Record provider state snapshot (idempotent per provider). */
  setProviderState(runId: string, snapshot: ProviderStateSnapshot): RunManifest | undefined {
    return this.update(runId, (m) => {
      m.providerState[snapshot.provider] = snapshot
      return m
    })
  }

  /** Record a verification mark (idempotent per branch+level). */
  setVerificationState(runId: string, mark: VerificationMarkState): RunManifest | undefined {
    const opId = operationKey({ kind: "verify", branchId: mark.branchId, runId, level: mark.level, seq: mark.completedAt })
    return this.update(runId, (m) => {
      if (m.appliedOperationIds.includes(opId)) return m
      m.verificationState[mark.branchId] = mark
      m.appliedOperationIds.push(opId)
      const b = m.branches[mark.branchId]
      if (b) {
        b.verificationLevel = mark.level
        b.verificationPassed = mark.passed
        b.verificationOperationId = opId
        if (mark.passed && b.status !== "completed") b.status = "completed"
      }
      return m
    })
  }

  /** Record a capsule reference exactly (version-pinned; no silent upgrade). */
  setCapsuleRef(runId: string, name: string, ref: CapsuleRef): RunManifest | undefined {
    return this.update(runId, (m) => {
      m.capsuleRefs[name] = ref
      return m
    })
  }

  /** Set the last durable event sequence number (for replay starting point). */
  setLastEventSequence(runId: string, seq: number): RunManifest | undefined {
    return this.update(runId, (m) => {
      if (seq > (m.lastEventSequence ?? 0)) m.lastEventSequence = seq
      return m
    })
  }

  private persist(m: RunManifest): void {
    if (!this.dir) return
    const file = this.file(m.runId)
    const tmp = this.tmpFile(m.runId)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({ version: MANIFEST_VERSION, manifest: m } satisfies ManifestFile, null, 2))
      fs.renameSync(tmp, file)
    } catch {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
  }

  /** Build a ProviderStateSnapshot from a ProviderReliability report. */
  static providerSnapshot(r: ProviderReliability): ProviderStateSnapshot {
    return {
      provider: r.provider,
      state: r.state,
      failures: r.failures,
      opens: r.opens,
      cooldownRemaining: r.cooldownRemaining,
      lastKind: r.lastKind,
      lastFailureAt: r.lastFailureAt,
      lastSuccessAt: r.lastSuccessAt,
      recoveryCount: r.recoveryCount,
    }
  }
}

/**
 * Build the initial branch manifest states from a plan: one entry per
 * independent branch / task, all pending.
 */
export function initialBranches(plan: Plan): Record<string, BranchManifestState> {
  const out: Record<string, BranchManifestState> = {}
  const now = Date.now()
  const branchIds: string[] = []
  if (plan.task.branches && plan.task.branches > 1) {
    for (let i = 0; i < plan.task.branches; i++) branchIds.push(`branch-${i + 1}`)
  } else if (plan.task.tasks?.length) {
    for (const t of plan.task.tasks) branchIds.push(t.id)
  } else if (plan.task.nodes?.length) {
    for (const n of plan.task.nodes) branchIds.push(n.id)
  } else {
    branchIds.push("root")
  }
  for (const id of branchIds) {
    out[id] = {
      branchId: id,
      status: "pending",
      milestone: undefined,
      workSecondsCompleted: 0,
      patchApplied: false,
      appliedOperationIds: [],
    }
  }
  return out
}

export function defaultPlanEstimates(): PlanEstimates {
  return {
    serial: 0,
    swarm: 0,
    chosen: 0,
    speedup: 1,
    swarmSpeedup: 1,
    parallelEfficiency: 1,
    startupCost: 0,
    verificationGain: 0,
    integrationCost: 0,
    planningCost: 0,
    criticalPath: 0,
    agents: 1,
    waves: 1,
    requests: 0,
    tokens: 0,
    confidence: 0.5,
    netSecondsSaved: 0,
  }
}

export function emptyPlan(runId: string, task: { task: string }): Plan {
  return {
    runId,
    createdAt: Date.now(),
    task: task as never,
    topology: "SERIAL",
    agents: 1,
    waves: 1,
    batches: [],
    models: [],
    verification: { level: 0, steps: [], estimatedCost: 0, expectedGain: 0, judgeAllowed: false },
    estimates: defaultPlanEstimates(),
    predictors: {
      estimated_serial_time: 0,
      estimated_swarm_time: 0,
      estimated_parallel_efficiency: 1,
      estimated_startup_cost: 0,
      estimated_verification_gain: 0,
      recommended_topology: "SERIAL",
      recommended_agent_count: 1,
      recommended_models: [],
      confidence: 0.5,
    },
    budget: { requests: 0, tokens: 0, agents: 1, wallClockSeconds: 0, verificationSeconds: 0, reserve: 0 },
    reasons: [],
    warnings: [],
    alternatives: [],
  } satisfies Plan
}
