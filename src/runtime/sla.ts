/**
 * SLA modes, deadline honesty, deadline pressure, and anytime stages.
 *
 * Req 23: five SLA modes (FASTEST, CHEAPEST, HIGHEST_QUALITY, BALANCED,
 *   LOWEST_PROVIDER_RISK) with hand-set, pairwise-distinct profile signatures
 *   that steer the scheduler so the same fixture yields observably different
 *   plans per mode.
 * Req 24: deadline honesty -- a hard deadline the plan cannot credibly meet
 *   is reported as impossible; the runtime never silently degrades to a
 *   slower plan to pretend it can make the deadline.
 * Req 25: deadline pressure -- when the deadline is plausible but tight,
 *   tiered actions steer the plan (reserve verification, prioritize the
 *   critical path, skip optional work, reduce low-value branches).
 * Req 26: anytime stages PRELIMINARY < VERIFIED < FINAL are monotone -- a
 *   run never regresses to an earlier stage -- and a cost guard declines a
 *   swarm whose verification/effort cannot be repaid by predicted savings.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { AdaptiveScheduler } from "./scheduler.js"
import type {
  AnytimeResult,
  AnytimeStage,
  DeadlineAction,
  DeadlineCheck,
  DeadlinePressure,
  Plan,
  SlaMode,
  SlaProfile,
  TaskInput,
} from "./types.js"
import { clamp, round } from "./util.js"

/**
 * Pairwise-distinct SLA profile signatures. No two modes share the same
 * (fanoutFactor, qualityWeight, verificationBias, costSensitivity,
 * providerSpread, hedgeDelayFactor) tuple, so the same fixture steers to
 * measurably different plans under each mode.
 */
export const SLA_PROFILES: Record<SlaMode, SlaProfile> = {
  FASTEST: {
    mode: "FASTEST",
    fanoutFactor: 1.4,
    qualityWeight: 0.15,
    /** Negative = bias toward cheaper, lighter verification. */
    verificationBias: -0.6,
    costSensitivity: 0.2,
    providerSpread: 0.3,
    hedgeDelayFactor: 1.0,
    reasons: [
      "Minimize predicted wall clock: raise the fan-out ceiling, prefer the fastest routed model, and keep verification at the cheapest informative level.",
      "Accept higher cost and modestly higher provider risk for latency.",
    ],
  },
  CHEAPEST: {
    mode: "CHEAPEST",
    fanoutFactor: 0.7,
    qualityWeight: 0.35,
    verificationBias: -0.4,
    costSensitivity: 0.9,
    providerSpread: 0.15,
    hedgeDelayFactor: 1.6,
    reasons: [
      "Minimize predicted cost: cap lanes low, prefer batched workers over per-task fan-out, defer hedges, and skip optional verification.",
      "Accept longer wall clock and lower provider diversity for cost.",
    ],
  },
  HIGHEST_QUALITY: {
    mode: "HIGHEST_QUALITY",
    fanoutFactor: 1.2,
    qualityWeight: 0.85,
    verificationBias: 0.5,
    costSensitivity: 0.1,
    providerSpread: 0.5,
    hedgeDelayFactor: 0.6,
    reasons: [
      "Maximize predicted quality: raise the verification floor, hedge early, and tolerate extra lanes and cost for correctness.",
      "Accept the slowest, most expensive plan the evidence justifies.",
    ],
  },
  BALANCED: {
    mode: "BALANCED",
    fanoutFactor: 1.0,
    qualityWeight: 0.5,
    verificationBias: 0.0,
    costSensitivity: 0.5,
    providerSpread: 0.3,
    hedgeDelayFactor: 1.0,
    reasons: [
      "Balance speed, cost, and quality: default fan-out ceiling, adaptive verification, and moderate provider spread.",
    ],
  },
  LOWEST_PROVIDER_RISK: {
    mode: "LOWEST_PROVIDER_RISK",
    fanoutFactor: 0.9,
    qualityWeight: 0.45,
    verificationBias: 0.2,
    costSensitivity: 0.4,
    providerSpread: 0.8,
    hedgeDelayFactor: 1.2,
    reasons: [
      "Minimize provider risk: spread lanes across providers, avoid single-provider concentration, and keep a verification reserve.",
      "Accept moderate cost for provider diversity.",
    ],
  },
} satisfies Record<SlaMode, SlaProfile>

/** Agent ceiling each mode imposes on the planner (a user budget can still go lower). */
export const AGENT_CAP_BY_MODE: Record<SlaMode, number> = {
  FASTEST: 8,
  CHEAPEST: 2,
  HIGHEST_QUALITY: 6,
  BALANCED: 4,
  LOWEST_PROVIDER_RISK: 3,
}

/** Verification value each mode steers the planner toward. */
export const VERIFICATION_VALUE_BY_MODE: Record<SlaMode, number> = {
  FASTEST: 0.15,
  CHEAPEST: 0.2,
  HIGHEST_QUALITY: 0.85,
  BALANCED: 0.5,
  LOWEST_PROVIDER_RISK: 0.5,
}

export interface SlaAppliedInput {
  input: TaskInput
  /** Human-readable trail of what the profile changed on the input. */
  applied: string[]
  profile: SlaProfile
}

/**
 * Apply an SLA profile to a TaskInput before planning (Req 23 steering).
 * qualityWeight and verificationValue are forced to the profile's values;
 * budget.agents is capped at the mode's ceiling. SLA is a hard steering
 * contract, not a hint.
 */
export function applySlaToInput(input: TaskInput, profile: SlaProfile): SlaAppliedInput {
  const out: TaskInput = { ...input }
  const applied: string[] = []

  out.qualityWeight = profile.qualityWeight
  applied.push(`qualityWeight forced to ${profile.qualityWeight} (${profile.mode})`)

  const verificationValue = VERIFICATION_VALUE_BY_MODE[profile.mode]
  out.verificationValue = verificationValue
  applied.push(`verificationValue forced to ${verificationValue}`)

  const cap = AGENT_CAP_BY_MODE[profile.mode]
  const current = out.budget?.agents
  out.budget = { ...(out.budget ?? {}), agents: Math.min(current ?? Infinity, cap) }
  applied.push(
    `budget.agents capped at ${cap}${current !== undefined ? ` (from ${current})` : ""}`,
  )

  return { input: out, applied, profile }
}

/**
 * Req 24: deadline honesty. The fastest credibly achievable estimate is the
 * better of serial and the best swarm candidate the scheduler priced. A
 * deadline tighter than that is IMPOSSIBLE: we say so, name the fastest
 * estimate and the shortfall, and never silently degrade to a slower plan.
 */
export function deadlineCheck(input: TaskInput, plan: Plan): DeadlineCheck {
  const deadline = input.deadlineSeconds ?? 0
  const fastest = Math.min(plan.estimates.serial, plan.estimates.swarm)
  const slack = round(deadline - fastest, 1)
  const plausible = deadline > 0 && slack >= 0
  let reason: string
  if (deadline <= 0) {
    reason = `no positive deadline provided (${deadline}s); nothing to check`
  } else if (!plausible) {
    reason = `deadline ${deadline}s is IMPOSSIBLE: fastest credible estimate is ${fastest}s (shortfall ${Math.max(0, -slack)}s); refusing to silently degrade to a slower plan`
  } else {
    reason = `deadline ${deadline}s is plausible with ${slack}s of slack vs the fastest credible estimate of ${fastest}s`
  }
  return {
    plausible,
    deadlineSeconds: deadline,
    estimatedFastestSeconds: round(fastest, 1),
    slackSeconds: slack,
    reason,
  }
}

/**
 * Req 25: tiered deadline-pressure actions. Pressure is fastest/deadline,
 * so ~0 means a comfortable deadline and ~1 means the deadline equals the
 * fastest estimate (zero slack). Tighter deadlines escalate through
 * reserve -> critical-path/optional-work cut -> full degradation set.
 */
export function deadlinePressure(plan: Plan, check: DeadlineCheck): DeadlinePressure {
  const fastest = check.estimatedFastestSeconds
  const deadline = check.deadlineSeconds
  const pressure = round(clamp(deadline > 0 ? fastest / Math.max(deadline, 0.001) : 1, 0, 1), 3)

  let actions: DeadlineAction[] = []
  let reason: string
  if (!check.plausible) {
    reason = `deadline is impossible (${check.reason}); no pressure tier applies`
  } else if (pressure < 0.33) {
    reason = `comfortable deadline (${deadline}s vs ${fastest}s fastest); no forced pressure actions`
  } else if (pressure < 0.6) {
    actions = ["reserve_verification"]
    reason = `tight deadline (pressure ${(pressure * 100).toFixed(0)}%): reserve verification budget and keep the chosen verification level`
  } else if (pressure < 0.85) {
    actions = ["prioritize_critical_path", "skip_optional_work"]
    reason = `critical deadline (pressure ${(pressure * 100).toFixed(0)}%): prioritize the critical path and skip optional work`
  } else {
    actions = [
      "prioritize_critical_path",
      "reduce_low_value_branches",
      "increase_parallelism",
      "skip_optional_work",
    ]
    reason = `emergency deadline (pressure ${(pressure * 100).toFixed(0)}%): prioritize critical path, reduce low-value branches, increase parallelism, skip optional work`
  }
  return { pressure, actions, reason }
}

const STAGE_ORDER: Readonly<Record<AnytimeStage, number>> = { PRELIMINARY: 0, VERIFIED: 1, FINAL: 2 }

/** Derive the anytime stage from a plan's verification level. */
export function stageOf(plan: Plan): AnytimeStage {
  return plan.verification.level >= 4 ? "FINAL" : plan.verification.level >= 2 ? "VERIFIED" : "PRELIMINARY"
}

/**
 * Req 26: advance the anytime stage monotonically (PRELIMINARY < VERIFIED <
 * FINAL). A regression (e.g. VERIFIED -> PRELIMINARY) is refused and the
 * current stage is held, so a run never exposes a less-verified result after
 * a more-verified one.
 */
export function anytimeResult(previous: AnytimeStage | undefined, plan: Plan): AnytimeResult {
  const next = stageOf(plan)
  const monotone = previous === undefined || STAGE_ORDER[next] >= STAGE_ORDER[previous]!
  const stage = monotone ? next : previous!
  return {
    stage,
    label: `anytime:${stage}`,
    safeToExpose: stage !== "PRELIMINARY",
    reason: monotone
      ? `advanced to ${stage} (verification V${plan.verification.level})`
      : `refused to regress ${previous} -> ${next}; holding ${stage}`,
  }
}

/**
 * Result of the cost guard: whether to decline a swarm and why, plus the
 * overhead vs predicted savings so callers can see the trade-off.
 */
export interface CostGuardResult {
  decline: boolean
  reason: string
  overheadSeconds: number
  savedSeconds: number
}

/**
 * Req 26: decline a swarm when its predicted savings cannot repay the
 * planning, startup, integration, and verification effort. Serial plans
 * pass through (nothing to guard).
 */
export function costGuardDeclinesSwarm(plan: Plan): CostGuardResult {
  if (plan.topology === "SERIAL") {
    return {
      decline: false,
      reason: "serial plan: no swarm effort to guard",
      overheadSeconds: 0,
      savedSeconds: 0,
    }
  }
  const { estimates, verification } = plan
  const overhead = round(
    estimates.planningCost + estimates.startupCost + estimates.integrationCost + verification.estimatedCost,
    1,
  )
  const saved = estimates.netSecondsSaved
  const speedup = estimates.speedup
  const repaid = saved > overhead * 0.5 && speedup >= 1.05
  if (!repaid) {
    return {
      decline: true,
      reason: `declining swarm: ${saved}s predicted savings vs ${overhead}s planning/startup/integration/verification effort at ${speedup}x; effort is not repaid`,
      overheadSeconds: overhead,
      savedSeconds: saved,
    }
  }
  return {
    decline: false,
    reason: `swarm effort ${overhead}s is repaid by ${saved}s predicted savings (${speedup}x)`,
    overheadSeconds: overhead,
    savedSeconds: saved,
  }
}

export interface SlaPlanResult {
  plan: Plan
  mode: SlaMode
  profile: SlaProfile
  applied: string[]
  deadline: DeadlineCheck | null
  pressure: DeadlinePressure | null
  /** True when the hard deadline cannot be met. The plan is still returned
   *  but warnings flag the impossibility: never silent degradation. */
  impossible: boolean
  guard: CostGuardResult
  anytime: AnytimeResult
  warnings: string[]
}

/**
 * Steer a real AdaptiveScheduler.plan() with an SLA mode: apply the profile
 * to the input, plan, then run the deadline check, pressure tier, cost
 * guard, and anytime stage derivation.
 */
export function planWithSla(scheduler: AdaptiveScheduler, input: TaskInput): SlaPlanResult {
  const mode = input.sla ?? "BALANCED"
  const profile = SLA_PROFILES[mode]
  const { input: adjusted, applied } = applySlaToInput(input, profile)
  const plan = scheduler.plan(adjusted)

  const deadline = input.deadlineSeconds !== undefined ? deadlineCheck(input, plan) : null
  const pressure = deadline ? deadlinePressure(plan, deadline) : null
  const impossible = deadline ? !deadline.plausible : false
  const guard = costGuardDeclinesSwarm(plan)
  const anytime = anytimeResult(undefined, plan)

  const warnings: string[] = []
  if (impossible) warnings.push(`DEADLINE IMPOSSIBLE: ${deadline!.reason}`)
  if (guard.decline) warnings.push(`COST GUARD DECLINES SWARM: ${guard.reason}`)
  if (pressure && pressure.actions.length > 0) {
    warnings.push(`DEADLINE PRESSURE (${round(pressure.pressure * 100, 0)}%): ${pressure.actions.join(", ")} -- ${pressure.reason}`)
  }

  return { plan, mode, profile, applied, deadline, pressure, impossible, guard, anytime, warnings }
}
