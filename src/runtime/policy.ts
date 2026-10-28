/**
 * Bounded self-tuning, shadow policy, promotion gates, rollback, and manual override.
 * Req 18: bounded self-tuning -- every parameter move is clamped to +/-20% relative
 *   (floor +/-0.05) so no single run can lurch the policy.
 * Req 19: shadow policy -- candidate parameters run in shadow for >= MIN_SHADOW_RUNS
 *   paired runs before anyone considers promotion; shadow vs active MAE is compared,
 *   never benchmark numbers (Req 52).
 * Req 20: promotion gate -- eligible only with measurable MAE improvement (>= 5%),
 *   directional consistency >= 70%, CI entirely above zero, bounded parameter
 *   movement, and zero per-run quality regression.
 * Req 21: rollback -- the active version rolls back to the most recent previously
 *   promoted version; version 1 (base defaults) is the immovable floor.
 * Req 22/50: manual override hard-wins over the learned policy every time; resolve()
 *   reports source, forced values, and disabled subsystems for explainability.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  ManualOverride,
  PolicyVersion,
  PromotionGate,
  SelfTuneProposal,
  TaskInput,
  Topology,
  TunableParameters,
} from "./types.js"
import { clamp, mean, round, safeReadJson, safeWriteJson } from "./util.js"

export type { ManualOverride, TaskInput } from "./types.js"

export const POLICY_VERSION = 3
export const MIN_SHADOW_RUNS = 8
export const MIN_IMPROVEMENT_PCT = 5
export const MAX_MOVE_FRACTION = 0.20
export const MIN_MOVE_ABSOLUTE = 0.05
export const MAX_WEIGHT_MOVE = 0.20
export const MIN_NEW_KEY_WEIGHT = 0.5
export const MAX_NEW_KEY_WEIGHT = 1.5
export const MIN_DIRECTIONAL_CONSISTENCY = 0.7
export const CI_Z = 1.96
export const MAX_SHADOW_VERSIONS = 2
/** Runs retained per shadow candidate for gate/proposal statistics. */
export const GATE_RUN_WINDOW = 4 * MIN_SHADOW_RUNS

export const SCALAR_KEYS = [
  "initialFanout",
  "maxFanout",
  "warmLanePoolSize",
  "microtaskBatchThreshold",
  "verificationThreshold",
  "convergenceThreshold",
  "hedgeDelaySeconds",
  "branchRoiKillThreshold",
  "confidenceEscalationThreshold",
] as const

/** The base defaults -- never derived from benchmark results (Req 52). */
export const DEFAULT_TUNABLES: TunableParameters = {
  initialFanout: 2,
  maxFanout: 6,
  warmLanePoolSize: 3,
  microtaskBatchThreshold: 8,
  verificationThreshold: 0.5,
  convergenceThreshold: 0.55,
  hedgeDelaySeconds: 30,
  branchRoiKillThreshold: 0.5,
  confidenceEscalationThreshold: 0.75,
  providerWeights: {},
}

/** Movement budget for one scalar parameter: max(20% of |from|, 0.05). */
export function movementLimit(from: number): number {
  return Math.max(MAX_MOVE_FRACTION * Math.abs(from), MIN_MOVE_ABSOLUTE)
}

/**
 * Every parameter whose move would exceed the movement budget. This is the
 * enforcement half of Req 18: submitShadow() clamps to these bounds and the
 * promotion gate refuses any candidate that violates them.
 */
export function movementViolations(active: TunableParameters, candidate: TunableParameters): string[] {
  const problems: string[] = []
  for (const key of SCALAR_KEYS) {
    const from = active[key]
    const to = candidate[key]
    const limit = movementLimit(from)
    if (Math.abs(to - from) > limit + 1e-9) {
      problems.push(`${key}: ${from} -> ${to} exceeds movement budget of +/-${round(limit, 3)}`)
    }
  }
  const wFrom = active.providerWeights ?? {}
  const wTo = candidate.providerWeights ?? {}
  const keys = new Set([...Object.keys(wFrom), ...Object.keys(wTo)])
  for (const key of keys) {
    const from = wFrom[key] ?? 0
    const to = wTo[key] ?? 0
    if (from === 0) {
      if (to < MIN_NEW_KEY_WEIGHT - 1e-9 || to > MAX_NEW_KEY_WEIGHT + 1e-9) {
        problems.push(
          `providerWeights[${key}]: new weight ${to} must start in [${MIN_NEW_KEY_WEIGHT}, ${MAX_NEW_KEY_WEIGHT}]`,
        )
      }
    } else {
      const limit = Math.max(MAX_WEIGHT_MOVE * Math.abs(from), MIN_MOVE_ABSOLUTE)
      if (Math.abs(to - from) > limit + 1e-9) {
        problems.push(`providerWeights[${key}]: ${from} -> ${to} exceeds movement budget of +/-${round(limit, 3)}`)
      }
    }
  }
  return problems
}

/**
 * Clamp `candidate` into the movement budget around `active`. Returns the
 * bounded parameters plus a human-readable list of what was clamped, so the
 * caller can see exactly how far the proposal moved (Req 18 transparency).
 */
export function clampTunables(active: TunableParameters, candidate: TunableParameters): {
  params: TunableParameters
  clamped: string[]
} {
  const clamped: string[] = []
  const params: TunableParameters = { ...candidate, providerWeights: { ...candidate.providerWeights } }

  for (const key of SCALAR_KEYS) {
    const from = active[key]
    const limit = movementLimit(from)
    let to = candidate[key]
    if (to > from + limit) {
      clamped.push(`${key}: clamped ${to} -> ${round(from + limit, 3)}`)
      to = from + limit
    } else if (to < from - limit) {
      clamped.push(`${key}: clamped ${to} -> ${round(from - limit, 3)}`)
      to = from - limit
    }
    if (to < 0) {
      clamped.push(`${key}: floored at 0`)
      to = 0
    }
    params[key] = round(to, 4)
  }

  const wFrom = active.providerWeights ?? {}
  const wTo = candidate.providerWeights ?? {}
  const keys = new Set([...Object.keys(wFrom), ...Object.keys(wTo)])
  for (const key of keys) {
    const from = wFrom[key] ?? 0
    let to = wTo[key] ?? 0
    if (from === 0) {
      if (to < MIN_NEW_KEY_WEIGHT) {
        clamped.push(`providerWeights[${key}]: raised ${to} to conservative floor ${MIN_NEW_KEY_WEIGHT}`)
        to = MIN_NEW_KEY_WEIGHT
      } else if (to > MAX_NEW_KEY_WEIGHT) {
        clamped.push(`providerWeights[${key}]: capped ${to} at conservative ceiling ${MAX_NEW_KEY_WEIGHT}`)
        to = MAX_NEW_KEY_WEIGHT
      }
    } else {
      const limit = Math.max(MAX_WEIGHT_MOVE * Math.abs(from), MIN_MOVE_ABSOLUTE)
      if (to > from + limit) {
        clamped.push(`providerWeights[${key}]: clamped ${to} -> ${round(from + limit, 3)}`)
        to = from + limit
      } else if (to < from - limit) {
        clamped.push(`providerWeights[${key}]: clamped ${to} -> ${round(from - limit, 3)}`)
        to = from - limit
      }
    }
    if (to < 0) to = 0
    params.providerWeights![key] = round(to, 4)
  }
  return { params, clamped }
}

export interface ShadowRun {
  runId: string
  ts: number
  /** Active policy's predicted wall clock for this run. */
  activePredictedSeconds: number
  /** Active policy's actual observed wall clock. */
  activeActualSeconds: number
  /** Shadow candidate's predicted wall clock for this run. */
  shadowPredictedSeconds: number
  /** Shadow candidate's actual observed wall clock. */
  shadowActualSeconds: number
  /** Active policy's observed quality score (0..1). */
  activeQuality: number
  /** Shadow candidate's observed quality score (0..1). */
  shadowQuality: number
}

function popStdDev(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = mean(xs)
  const v = xs.reduce((s, d) => s + (d - m) * (d - m), 0) / xs.length
  return Math.sqrt(v)
}

function maeOf(runs: ReadonlyArray<ShadowRun>, field: "active" | "shadow"): number | undefined {
  if (runs.length === 0) return undefined
  const errs = runs.map((r) => Math.abs(r[`${field}PredictedSeconds`] - r[`${field}ActualSeconds`]))
  return round(mean(errs), 3)
}

/** Decay-free shadow statistics attached to a PolicyVersion while it is a candidate. */
export function shadowStatsOf(runs: ReadonlyArray<ShadowRun>): {
  n: number
  activeMae?: number
  shadowMae?: number
} {
  return { n: runs.length, activeMae: maeOf(runs, "active"), shadowMae: maeOf(runs, "shadow") }
}

/** Per-run absolute-error savings: how many seconds the shadow candidate beat active on each run. */
export function perRunImprovements(runs: ReadonlyArray<ShadowRun>): number[] {
  return runs.map(
    (r) =>
      Math.abs(r.activePredictedSeconds - r.activeActualSeconds) -
      Math.abs(r.shadowPredictedSeconds - r.shadowActualSeconds),
  )
}

/** Mean MAE improvement of shadow over active, in percent of active MAE. */
export function improvementPctOf(runs: ReadonlyArray<ShadowRun>): number | undefined {
  const a = maeOf(runs, "active")
  const s = maeOf(runs, "shadow")
  if (a === undefined || a <= 0 || s === undefined) return undefined
  return round(((a - s) / a) * 100, 3)
}

export interface PromotionInput {
  runs: ReadonlyArray<ShadowRun>
  active: TunableParameters
  candidate: TunableParameters
}

/**
 * The promotion gate (Req 20). A candidate is eligible only when ALL of:
 *   - >= MIN_SHADOW_RUNS paired shadow runs exist,
 *   - active MAE is computable and positive,
 *   - mean absolute-error improvement >= MIN_IMPROVEMENT_PCT,
 *   - the per-run improvement CI is entirely above zero (statistical evidence,
 *     not a single lucky run),
 *   - directional consistency >= MIN_DIRECTIONAL_CONSISTENCY,
 *   - zero per-run quality regression (shadow quality >= active quality on
 *     every paired run, and aggregate too),
 *   - zero movement-budget violations.
 * Any failed check appends a reason; eligible === (reasons.length === 0).
 */
export function evaluatePromotionGate(input: PromotionInput): PromotionGate {
  const { runs, active, candidate } = input
  const reasons: string[] = []
  const n = runs.length
  const activeMae = maeOf(runs, "active")
  const shadowMae = maeOf(runs, "shadow")
  const improvement = improvementPctOf(runs)
  const improvements = perRunImprovements(runs)
  const consistency =
    n > 0 ? round(improvements.filter((v) => v > 0).length / n, 3) : 0
  const ciLow = round(mean(improvements) - CI_Z * (popStdDev(improvements) / Math.sqrt(Math.max(1, n))), 3)
  const ciHigh = round(mean(improvements) + CI_Z * (popStdDev(improvements) / Math.sqrt(Math.max(1, n))), 3)
  const shadowQualityWins = runs.filter((r) => r.shadowQuality >= r.activeQuality).length
  const meanQuality =
    n > 0 ? round(runs.reduce((s, r) => s + r.shadowQuality - r.activeQuality, 0) / n, 4) : 0

  if (n < MIN_SHADOW_RUNS) {
    reasons.push(`only ${n} paired shadow runs; need >= ${MIN_SHADOW_RUNS} before promotion`)
  }
  if (activeMae === undefined || activeMae <= 0) {
    reasons.push("no active error signal to improve against")
  } else if (improvement === undefined || improvement < MIN_IMPROVEMENT_PCT) {
    reasons.push(
      `shadow MAE improvement ${(improvement ?? 0).toFixed(1)}% is below the ${MIN_IMPROVEMENT_PCT}% measurable bar`,
    )
  } else if (ciLow <= 0) {
    reasons.push(`improvement CI [${ciLow}, ${ciHigh}] is not entirely above zero; evidence is not statistical`)
  }
  if (consistency < MIN_DIRECTIONAL_CONSISTENCY) {
    reasons.push(`directional consistency ${(consistency * 100).toFixed(0)}% is below ${(MIN_DIRECTIONAL_CONSISTENCY * 100).toFixed(0)}%`)
  }
  if (shadowQualityWins < n) {
    reasons.push(`${n - shadowQualityWins} of ${n} paired runs lost quality under the shadow candidate; zero regression required`)
  } else if (meanQuality < 0) {
    reasons.push(`aggregate quality regressed by ${Math.abs(meanQuality)}; zero regression required`)
  }
  const violations = movementViolations(active, candidate)
  for (const v of violations) reasons.push(`movement: ${v}`)

  return {
    eligible: reasons.length === 0,
    reasons,
    nRuns: n,
    improvementPct: improvement,
  }
}

/**
 * One shadow proposal per scalar parameter that differs between active and
 * the shadow candidate, with acceptance computed against the gate statistics.
 */
export function buildShadowProposals(
  active: TunableParameters,
  shadow: TunableParameters,
  runs: ReadonlyArray<ShadowRun>,
): SelfTuneProposal[] {
  const n = runs.length
  const gate = evaluatePromotionGate({ runs, active, candidate: shadow })
  const improvements = perRunImprovements(runs)
  const consistency =
    n > 0 ? round(improvements.filter((v) => v > 0).length / n, 3) : 0
  const ciLow = round(mean(improvements) - CI_Z * (popStdDev(improvements) / Math.sqrt(Math.max(1, n))), 3)
  const ciHigh = round(mean(improvements) + CI_Z * (popStdDev(improvements) / Math.sqrt(Math.max(1, n))), 3)
  const meanImprovement = mean(improvements)
  const proposals: SelfTuneProposal[] = []

  for (const key of SCALAR_KEYS) {
    const from = active[key]
    const to = shadow[key]
    if (Math.abs(to - from) <= 1e-9) continue
    const accepted =
      gate.eligible &&
      consistency >= MIN_DIRECTIONAL_CONSISTENCY &&
      meanImprovement > 0 &&
      ciLow > 0 &&
      movementViolations(active, shadow).length === 0
    proposals.push({
      parameter: key,
      from,
      to,
      n,
      directionalConsistency: consistency,
      ciLow,
      ciHigh,
      reason: accepted
        ? `shadow improved mean absolute error by ${(gate.improvementPct ?? 0).toFixed(1)}% over ${n} paired runs; every run kept quality >= active`
        : gate.reasons.length > 0
          ? gate.reasons.join("; ")
          : "no parameter delta",
      accepted,
    })
  }
  return proposals
}

export interface PolicyFile {
  version: number
  nextVersion: number
  runs: ShadowRun[]
  versions: PolicyVersion[]
  override?: ManualOverride
}

export type PolicyEvent = { type: "SHADOW" | "PROMOTE" | "ROLLBACK"; data: Record<string, unknown> }

export interface PolicyStoreOptions {
  now?: () => number
  onEvent?: (event: PolicyEvent) => void
}

export interface Resolution {
  /** Effective tunable parameters the runtime should use. */
  parameters: TunableParameters
  /** "learned" when a promoted version > 1 is active, else "defaults". */
  source: "defaults" | "learned"
  /** Values the manual override forced on top of the policy. */
  forced: { topology?: Topology; agents?: number; provider?: string }
  /** Subsystems the manual override disabled. */
  disabled: {
    learning: boolean
    checkpoints: boolean
    counterfactuals: boolean
    trustHistory: boolean
    selfTuning: boolean
  }
  /** Human-readable explainability trail (Req 50). */
  reasons: string[]
}

export interface PromotionResult {
  promoted: boolean
  reason: string
  gate: PromotionGate
  version?: PolicyVersion
}

export interface RollbackResult {
  rolledBack: boolean
  reason: string
  version?: PolicyVersion
}

function isPolicyVersion(v: unknown): v is PolicyVersion {
  if (!v || typeof v !== "object") return false
  const x = v as PolicyVersion
  return (
    typeof x.version === "number" &&
    typeof x.createdAt === "number" &&
    typeof x.status === "string" &&
    (x.status === "active" || x.status === "rolled_back" || x.status === "shadow") &&
    x.parameters &&
    typeof x.parameters === "object"
  )
}

function isShadowRun(v: unknown): v is ShadowRun {
  if (!v || typeof v !== "object") return false
  const x = v as ShadowRun
  return (
    typeof x.runId === "string" &&
    typeof x.ts === "number" &&
    typeof x.activePredictedSeconds === "number" &&
    typeof x.activeActualSeconds === "number" &&
    typeof x.shadowPredictedSeconds === "number" &&
    typeof x.shadowActualSeconds === "number" &&
    typeof x.activeQuality === "number" &&
    typeof x.shadowQuality === "number"
  )
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function cloneParameters(p: TunableParameters): TunableParameters {
  return { ...p, providerWeights: { ...p.providerWeights } }
}

/**
 * Versioned policy store (Req 49 pattern: schema version, unknown version
 * resets to fresh start). Exactly one version is active at a time; version 1
 * is the base defaults and is never rolled back out of existence.
 */
export class PolicyStore {
  private shadowRuns: ShadowRun[] = []
  private versionList: PolicyVersion[] = []
  private pendingOverride?: ManualOverride
  private readonly file: string | null
  private readonly now: () => number
  private readonly onEvent?: (event: PolicyEvent) => void

  constructor(file: string | null, opts: PolicyStoreOptions = {}) {
    this.file = file
    this.now = opts.now ?? (() => Date.now())
    this.onEvent = opts.onEvent
    this.load()
  }

  private load(): void {
    if (!this.file) {
      this.bootstrap()
      return
    }
    const data = safeReadJson<PolicyFile>(this.file, {
      version: POLICY_VERSION,
      nextVersion: 2,
      runs: [],
      versions: [],
      override: undefined,
    })
    if (!data || data.version !== POLICY_VERSION) {
      // Req 49: unknown schema version -> fresh start, never a crash.
      this.bootstrap()
      return
    }
    this.shadowRuns = (Array.isArray(data.runs) ? data.runs : []).filter(isShadowRun)
    this.versionList = (Array.isArray(data.versions) ? data.versions : []).filter(isPolicyVersion).map(deepClone)
    this.pendingOverride = data.override
    this.repairInvariants()
    this.save()
  }

  private bootstrap(): void {
    this.shadowRuns = []
    this.versionList = [
      {
        version: 1,
        parameters: deepClone(DEFAULT_TUNABLES),
        createdAt: this.now(),
        status: "active",
      },
    ]
    this.pendingOverride = undefined
    this.save()
  }

  private repairInvariants(): void {
    const actives = this.versionList.filter((v) => v.status === "active")
    if (actives.length === 0 && this.versionList.length > 0) {
      const best = this.versionList.reduce((a, b) => (b.version > a.version ? b : a))!
      best.status = "active"
      best.promotedAt = best.promotedAt ?? this.now()
    }
    if (actives.length > 1) {
      actives.sort((a, b) => b.version - a.version)
      for (const v of actives.slice(1)) {
        v.status = "rolled_back"
        v.rollbackReason = v.rollbackReason ?? "store repair: multiple active versions collapsed to one"
      }
    }
    if (this.versionList.length === 0) this.bootstrap()
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, {
      version: POLICY_VERSION,
      nextVersion: this.nextVersion(),
      runs: this.shadowRuns,
      versions: this.versionList,
      override: this.pendingOverride,
    } satisfies PolicyFile)
  }

  private nextVersion(): number {
    let max = 1
    for (const v of this.versionList) if (v.version >= max) max = v.version + 1
    return max
  }

  private emit(type: PolicyEvent["type"], data: Record<string, unknown>): void {
    if (this.onEvent) this.onEvent({ type, data })
  }

  /** Returns a copy of the active version (never version 0 / null: base v1 always exists). */
  active(): PolicyVersion | undefined {
    const actives = this.versionList.filter((v) => v.status === "active")
    if (actives.length === 0) return undefined
    return deepClone(actives.sort((a, b) => b.version - a.version)[0]!)
  }

  /** All versions, newest first, as copies. */
  versions(): ReadonlyArray<PolicyVersion> {
    return this.versionList.slice().sort((a, b) => b.version - a.version).map(deepClone)
  }

  /** The latest shadow candidate, if any. */
  latestShadow(): PolicyVersion | undefined {
    const shadows = this.versionList.filter((v) => v.status === "shadow")
    if (shadows.length === 0) return undefined
    return deepClone(shadows.sort((a, b) => b.version - a.version)[0]!)
  }

  /** Shadow runs recorded against the latest shadow candidate (windowed). */
  runs(): ReadonlyArray<ShadowRun> {
    return deepClone(this.shadowRuns.slice(-GATE_RUN_WINDOW))
  }

  /** Install a manual override. It hard-wins on the very next resolve() (Req 22/50). */
  setOverride(override: ManualOverride | undefined): void {
    this.pendingOverride = override ? { ...override } : undefined
    this.save()
  }

  override(): ManualOverride | undefined {
    return this.pendingOverride ? { ...this.pendingOverride } : undefined
  }

  /**
   * Submit a shadow candidate. Parameters are clamped into the movement budget
   * (Req 18); the clamped list is reported via the SHADOW telemetry event so
   * operators can see exactly how far the proposal moved.
   */
  submitShadow(params: TunableParameters, reason: string): PolicyVersion {
    if (this.pendingOverride?.disableSelfTuning) {
      throw new Error("self-tuning is disabled by manual override; shadow submission rejected")
    }
    const active = this.active()
    if (!active) throw new Error("no active policy version to tune against")
    const bounded = clampTunables(active.parameters, params)
    const version: PolicyVersion = {
      version: this.nextVersion(),
      parameters: bounded.params,
      createdAt: this.now(),
      status: "shadow",
    }
    this.versionList.push(version)
    const shadows = this.versionList.filter((v) => v.status === "shadow").sort((a, b) => b.version - a.version)
    for (const old of shadows.slice(MAX_SHADOW_VERSIONS)) {
      old.status = "rolled_back"
      old.rollbackReason = old.rollbackReason ?? "superseded by newer shadow candidate"
    }
    this.save()
    this.emit("SHADOW", {
      version: version.version,
      reason,
      clamped: bounded.clamped,
      parameterCount: SCALAR_KEYS.length,
    })
    return deepClone(version)
  }

  /**
   * Record one paired shadow run. Shadow statistics on the latest candidate are
   * refreshed so the gate and proposals always reflect current evidence.
   */
  recordShadowRun(run: ShadowRun): void {
    this.shadowRuns.push(run)
    this.shadowRuns = this.shadowRuns.slice(-10_000)
    const shadow = this.latestShadow()
    if (shadow) {
      // Find the stored version object to mutate its stats.
      const stored = this.versionList.find((v) => v.version === shadow.version)
      if (stored) stored.shadowStats = shadowStatsOf(this.shadowRuns.slice(-GATE_RUN_WINDOW))
    }
    this.save()
  }

  /** Shadow proposals for the latest candidate (or a named version). */
  propose(versionNumber?: number): ReadonlyArray<SelfTuneProposal> {
    const shadow =
      versionNumber === undefined
        ? this.latestShadow()
        : this.versionList.find((v) => v.version === versionNumber)
    const active = this.active()
    if (!shadow || !active || shadow.status !== "shadow") return []
    return buildShadowProposals(active.parameters, shadow.parameters, this.shadowRuns.slice(-GATE_RUN_WINDOW))
  }

  /** The gate verdict for the latest candidate (or a named version). */
  gate(versionNumber?: number): PromotionGate {
    const shadow =
      versionNumber === undefined
        ? this.latestShadow()
        : this.versionList.find((v) => v.version === versionNumber)
    const active = this.active()
    if (!shadow || !active || shadow.status !== "shadow") {
      return { eligible: false, reasons: ["no shadow version to evaluate"], nRuns: 0 }
    }
    return evaluatePromotionGate({
      runs: this.shadowRuns.slice(-GATE_RUN_WINDOW),
      active: active.parameters,
      candidate: shadow.parameters,
    })
  }

  /**
   * Promote a shadow candidate to active. Refuses unless the gate passes
   * (measurable improvement + bounded movement + zero quality regression) and
   * self-tuning is not overridden off. The previous active version is rolled
   * back, not deleted (Req 21 audit trail).
   */
  promote(versionNumber?: number): PromotionResult {
    // latestShadow() returns a deepClone; mutate the live entry in versionList
    // so the promotion actually takes effect (Req 21 audit trail).
    const shadow =
      versionNumber === undefined
        ? this.versionList
            .filter((v) => v.status === "shadow")
            .sort((a, b) => b.version - a.version)[0]
        : this.versionList.find((v) => v.version === versionNumber)
    const active = this.active()
    if (!shadow || !active || shadow.status !== "shadow") {
      return {
        promoted: false,
        reason: "no shadow version to promote",
        gate: { eligible: false, reasons: ["no shadow version to evaluate"], nRuns: 0 },
      }
    }
    if (this.pendingOverride?.disableSelfTuning) {
      return {
        promoted: false,
        reason: "self-tuning is disabled by manual override",
        gate: { eligible: false, reasons: ["manual override disables self-tuning"], nRuns: shadow.shadowStats?.n ?? 0 },
      }
    }
    const gate = evaluatePromotionGate({
      runs: this.shadowRuns.slice(-GATE_RUN_WINDOW),
      active: active.parameters,
      candidate: shadow.parameters,
    })
    if (!gate.eligible) {
      return { promoted: false, reason: gate.reasons.join("; "), gate }
    }
    shadow.status = "active"
    shadow.promotedAt = this.now()
    shadow.promotionReason = `promoted after ${gate.nRuns} shadow runs; MAE improved ${(gate.improvementPct ?? 0).toFixed(1)}%`
    shadow.shadowStats = shadowStatsOf(this.shadowRuns.slice(-GATE_RUN_WINDOW))
    for (const v of this.versionList) {
      if (v.version < shadow.version && v.status === "active") {
        v.status = "rolled_back"
        v.rollbackReason = v.rollbackReason ?? `superseded by version ${shadow.version}`
      }
    }
    this.save()
    this.emit("PROMOTE", {
      from: active.version,
      to: shadow.version,
      improvementPct: gate.improvementPct,
      nRuns: gate.nRuns,
    })
    return {
      promoted: true,
      reason: `promoted shadow version ${shadow.version} to active; MAE improved ${(gate.improvementPct ?? 0).toFixed(1)}% over ${gate.nRuns} runs`,
      gate,
      version: deepClone(shadow),
    }
  }

  /**
   * Roll the active version back to the most recent previously-promoted
   * version below it, else to version 1. Version 1 itself cannot be rolled
   * back (it is the floor).
   */
  rollback(reason: string): RollbackResult {
    // Operate on the live entry in versionList (active() returns a deepClone).
    const active = this.versionList.find((v) => v.status === "active")
    if (!active) return { rolledBack: false, reason: "no active version" }
    if (active.version === 1) {
      return { rolledBack: false, reason: "version 1 is the base default; nothing to roll back to", version: deepClone(active) }
    }
    active.status = "rolled_back"
    active.rollbackReason = reason
    const predecessor = this.versionList
      .filter((v) => v.version < active.version && (v.promotedAt !== undefined || v.version === 1))
      .sort((a, b) => b.version - a.version)[0]!
    predecessor.status = "active"
    predecessor.promotedAt = predecessor.promotedAt ?? this.now()
    this.save()
    this.emit("ROLLBACK", { from: active.version, to: predecessor.version, reason })
    return {
      rolledBack: true,
      reason: `rolled back version ${active.version} to ${predecessor.version}`,
      version: deepClone(predecessor),
    }
  }

  /**
   * Effective policy for the runtime consumer (Req 22 + Req 50 explainability):
   * active parameters + override-forced values + disabled subsystems. Manual
   * override hard-wins: forced topology/agents/provider are reported here and
   * applied to plans via applyManualOverrideToInput().
   */
  resolve(): Resolution {
    const active = this.active()
    const override = this.pendingOverride
    const parameters = active ? cloneParameters(active.parameters) : deepClone(DEFAULT_TUNABLES)
    const forced: { topology?: Topology; agents?: number; provider?: string } = {}
    const disabled = {
      learning: !!override?.disableLearning,
      checkpoints: !!override?.disableCheckpoints,
      counterfactuals: !!override?.disableCounterfactuals,
      trustHistory: !!override?.disableTrustHistory,
      selfTuning: !!override?.disableSelfTuning,
    }
    const reasons: string[] = []
    if (active) {
      const isBase = active.version === 1 && active.promotedAt === undefined
      reasons.push(`active policy version ${active.version} (${isBase ? "base defaults, never tuned" : "learned"})`)
    } else {
      reasons.push("no policy store; using base defaults")
    }
    const source = active && active.version > 1 && active.promotedAt !== undefined ? "learned" : "defaults"
    if (override) {
      if (override.forceTopology !== undefined) {
        forced.topology = override.forceTopology
        reasons.push(`manual override forces topology ${override.forceTopology}`)
      }
      if (override.forceAgents !== undefined) {
        forced.agents = override.forceAgents
        reasons.push(`manual override forces ${override.forceAgents} agent(s)`)
      }
      if (override.forceProvider !== undefined) {
        forced.provider = override.forceProvider
        reasons.push(`manual override forces provider ${override.forceProvider}`)
      }
      if (override.disableLearning) reasons.push("manual override disables learning")
      if (override.disableCheckpoints) reasons.push("manual override disables checkpoints")
      if (override.disableCounterfactuals) reasons.push("manual override disables counterfactuals")
      if (override.disableTrustHistory) reasons.push("manual override disables trust history")
      if (override.disableSelfTuning) reasons.push("manual override disables self-tuning")
      if (override.reason) reasons.push(`override reason: ${override.reason}`)
    }
    return { parameters, source, forced, disabled, reasons }
  }
}

/**
 * Apply a manual override to a TaskInput before planning (Req 22 hard-win).
 * forceAgents caps the swarm regardless of what the learned policy wants;
 * forceTopology SERIAL forces the agent cap to 1 so only the serial candidate
 * can run; non-serial forced topologies get their agent cap raised just enough
 * that fan-out remains possible.
 */
export interface OverrideApplied {
  input: TaskInput
  applied: string[]
}

export function applyManualOverrideToInput(input: TaskInput, override: ManualOverride): OverrideApplied {
  const out: TaskInput = { ...input }
  const applied: string[] = []

  if (override.forceAgents !== undefined) {
    out.budget = { ...out.budget, agents: override.forceAgents }
    applied.push(`override: budget.agents forced to ${override.forceAgents}`)
  }
  if (override.forceProvider !== undefined) {
    out.provider = override.forceProvider
    applied.push(`override: provider forced to ${override.forceProvider}`)
  }
  if (override.forceTopology !== undefined) {
    applied.push(`override: topology forced to ${override.forceTopology}`)
    if (override.forceTopology === "SERIAL") {
      out.budget = { ...out.budget, agents: 1 }
      applied.push("override: SERIAL forces agent cap to 1 (only the serial candidate can run)")
    } else if (input.branches !== undefined && input.branches >= 2) {
      const want = Math.min(2, input.branches)
      if ((out.budget?.agents ?? 0) < want) {
        out.budget = { ...out.budget, agents: want }
        applied.push(`override: raising agent cap to ${want} so ${override.forceTopology} can run`)
      }
    }
  }

  const flags = [
    ["disableLearning", override.disableLearning],
    ["disableCheckpoints", override.disableCheckpoints],
    ["disableCounterfactuals", override.disableCounterfactuals],
    ["disableTrustHistory", override.disableTrustHistory],
    ["disableSelfTuning", override.disableSelfTuning],
  ] as const
  for (const [name, value] of flags) {
    if (value) applied.push(`override: disables ${name}`)
  }
  if (override.reason) applied.push(`override reason: ${override.reason}`)
  return { input: out, applied }
}
