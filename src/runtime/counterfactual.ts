/**
 * Counterfactual estimation and regret analysis.
 * Req 1: every alternative the scheduler did NOT run is labeled
 *   ESTIMATED_COUNTERFACTUAL; the executed plan is OBSERVED with measured
 *   wall clock. Counterfactual rows are diagnostic labels only — they are
 *   never citable as benchmark evidence (gates use OBSERVED rows only).
 * Req 2: regret decomposed per dimension (latency / requests / verification /
 *   provider / agent count / quality), each nonzero component carries a
 *   human-readable reason. Components are diagnostic seconds estimates and may
 *   overlap; totalRegret is their sum (an upper bound), not a physical quantity.
 * Req 52: agent-count sweeps derive from the plan's own alternatives and
 *   branch structure — never fixed magic counts like "6 agents, 2 waves".
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import { classifyShape } from "./history.js"
import type { RunHistory } from "./history.js"
import type {
  Category,
  CounterfactualRecord,
  ModelProfile,
  Plan,
  RegretReport,
  RunActuals,
} from "./types.js"
import { clamp, median, round } from "./util.js"

/** Structural slice of StatsStore so tests can pass fakes; prod passes the real store. */
export interface CounterfactualCostModel {
  estimateStartup?: (filter: { warm?: boolean }) => number
  estimateVerification?: (category?: Category, model?: string) => number
}

export interface CounterfactualContext {
  history?: RunHistory
  stats?: CounterfactualCostModel
  /** Available model profiles; enables provider/model-mix counterfactuals. */
  profiles?: ModelProfile[]
}

export interface RunAftermath {
  counterfactuals: CounterfactualRecord[]
  regret: RegretReport
}

const NO_HISTORY_CONFIDENCE = 0.3
const PRIOR_UNCERTAINTY = 0.35

function estimateConfidence(historyCount: number, mape: number): number {
  const depth = NO_HISTORY_CONFIDENCE + 0.4 * Math.min(1, historyCount / 8)
  return round(clamp(depth * (1 - clamp(mape, 0, 0.5)), 0.15, 0.8), 2)
}

function estimateQuality(plan: Plan, level: number): number {
  const qw = plan.task.qualityWeight ?? 0.5
  return round(clamp(0.5 + 0.08 * level + (qw - 0.5) * 0.2, 0.3, 0.98), 2)
}

/** Estimated request count for a counterfactual row relative to the real plan. */
function estimateRequestsFor(plan: Plan, row: CounterfactualRecord): number {
  const base = Math.max(1, plan.estimates.requests)
  const samePlan = row.topology === plan.topology && (row.modelMix?.[0] ?? "") === (plan.models[0] ?? "")
  if (samePlan) {
    // Verification-level variant: each ladder step is roughly one extra lane.
    const dl = (row.verificationLevel ?? plan.verification.level) - plan.verification.level
    return Math.max(1, base + dl)
  }
  return Math.max(1, Math.round(base * (row.agents / Math.max(1, plan.agents))))
}

/** Seconds per request, derived from history when available (evidence, not a constant). */
function perRequestSeconds(ctx: CounterfactualContext, plan: Plan, actuals: RunActuals): number {
  const rows = (ctx.history?.all() ?? []).filter(
    (r) => (r.requests ?? 0) > 0 && r.actualSeconds > 0,
  )
  if (rows.length >= 3) {
    return round(clamp(median(rows.map((r) => r.actualSeconds / (r.requests ?? 1))), 0.5, 120), 2)
  }
  const req = actuals.requests ?? plan.estimates.requests
  return req > 0 ? round(clamp(actuals.actualSeconds / req, 0.5, 120), 2) : 1
}

/**
 * Build the counterfactual comparison table for a finished run.
 * Row 0 is always the OBSERVED plan. Alternatives come from the plan's own
 * candidate engine, corrected by the learned prediction bias for this shape.
 */
export function estimateCounterfactuals(
  plan: Plan,
  actuals: RunActuals,
  ctx: CounterfactualContext = {},
): CounterfactualRecord[] {
  const shape = classifyShape(plan.task, plan)
  const bias = ctx.history ? clamp(1 + ctx.history.predictionBias(shape), 0.5, 2) : 1
  const historyCount = ctx.history?.forShape(shape).length ?? 0
  const mape = ctx.history?.predictionMape(shape) ?? PRIOR_UNCERTAINTY
  const confidence = estimateConfidence(historyCount, mape)

  const observed: CounterfactualRecord = {
    label: "OBSERVED",
    topology: plan.topology,
    agents: actuals.agents ?? plan.agents,
    modelMix: [...plan.models],
    verificationLevel: plan.verification.level,
    estimatedRuntime: actuals.actualSeconds,
    estimatedQuality: actuals.quality,
    estimatedCost: actuals.requests ?? plan.estimates.requests,
    estimatedRisk: plan.task.risk,
    confidence: 1,
    reason: "executed plan; wall clock measured",
  }
  const rows: CounterfactualRecord[] = [observed]
  const seen = new Set<string>([`${plan.topology}:${observed.agents}`])

  for (const alt of plan.alternatives) {
    const key = `${alt.topology}:${alt.agents}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      label: "ESTIMATED_COUNTERFACTUAL",
      topology: alt.topology,
      agents: alt.agents,
      modelMix: [...plan.models],
      verificationLevel: plan.verification.level,
      estimatedRuntime: round(Math.max(1, alt.seconds * bias)),
      estimatedQuality: estimateQuality(plan, plan.verification.level),
      estimatedCost: round(plan.estimates.requests * (alt.agents / Math.max(1, plan.agents))),
      estimatedRisk: plan.task.risk,
      confidence,
      reason: `scheduler candidate not run: ${alt.reason}`,
    })
  }

  // Verification-depth variants of the chosen plan (+/- 1 level, bounded 0..4).
  const level = plan.verification.level
  const verifyLaneSeconds = ctx.stats?.estimateVerification?.("verification") ?? 30
  for (const delta of [-1, 1]) {
    const v = clamp(level + delta, 0, 4)
    if (v === level) continue
    rows.push({
      label: "ESTIMATED_COUNTERFACTUAL",
      topology: plan.topology,
      agents: plan.agents,
      modelMix: [...plan.models],
      verificationLevel: v as 0 | 1 | 2 | 3 | 4,
      estimatedRuntime: round(Math.max(1, actuals.actualSeconds + (v - level) * verifyLaneSeconds)),
      estimatedQuality: estimateQuality(plan, v),
      estimatedCost: Math.max(1, (actuals.requests ?? plan.estimates.requests) + (v - level)),
      estimatedRisk: plan.task.risk,
      confidence,
      reason: `chosen topology with verification level ${v} instead of ${level}`,
    })
  }

  // Provider/model-mix variant: same plan on a cheaper eligible profile.
  const providerRow = providerCounterfactual(plan, actuals, ctx, confidence)
  if (providerRow) rows.push(providerRow)

  return rows
}

function providerCounterfactual(
  plan: Plan,
  actuals: RunActuals,
  ctx: CounterfactualContext,
  confidence: number,
): CounterfactualRecord | null {
  if (!ctx.profiles?.length) return null
  const chosen = ctx.profiles.find((p) => p.id === plan.models[0])
  if (!chosen) return null
  const requiredQuality = 0.5 + 0.4 * (plan.task.qualityWeight ?? 0.5)
  const contextTokens = plan.task.contextTokens ?? 12000
  const eligible = ctx.profiles.filter(
    (p) =>
      p.id !== chosen.id &&
      p.quality >= requiredQuality &&
      p.contextLimit >= contextTokens &&
      p.costTier <= chosen.costTier &&
      p.speed > 0,
  )
  if (eligible.length === 0) return null
  const best = eligible.reduce((a, b) =>
    b.costTier < a.costTier || (b.costTier === a.costTier && b.speed > a.speed) ? b : a,
  )
  const est = round(Math.max(1, (actuals.actualSeconds * chosen.speed) / best.speed))
  if (est >= actuals.actualSeconds) return null
  return {
    label: "ESTIMATED_COUNTERFACTUAL",
    topology: plan.topology,
    agents: plan.agents,
    modelMix: [best.id],
    verificationLevel: plan.verification.level,
    estimatedRuntime: est,
    estimatedQuality: estimateQuality(plan, plan.verification.level),
    estimatedCost: round((actuals.requests ?? plan.estimates.requests) * (chosen.costTier - best.costTier > 0 ? 0.8 : 1)),
    estimatedRisk: plan.task.risk,
    confidence,
    reason: `same plan on ${best.id} (costTier ${best.costTier}, speed ${best.speed})`,
  }
}

/**
 * Regret per dimension, all in seconds except qualityRegret (quality points).
 * Every nonzero component gets an explicit reason; when the executed plan was
 * the best option in hindsight, all regrets are 0 and the report says so.
 */
export function regretReport(
  plan: Plan,
  actuals: RunActuals,
  rows: CounterfactualRecord[],
  ctx: CounterfactualContext = {},
): RegretReport {
  const observed = rows.find((r) => r.label === "OBSERVED")
  if (!observed) throw new Error("regretReport: rows must include the OBSERVED record")
  const alternatives = rows.filter((r) => r.label === "ESTIMATED_COUNTERFACTUAL")
  const best = alternatives.length
    ? alternatives.reduce((a, b) => (b.estimatedRuntime < a.estimatedRuntime ? b : a))
    : observed

  const reasons: string[] = []
  const latencyRegret = Math.max(0, round(actuals.actualSeconds - best.estimatedRuntime, 1))
  if (latencyRegret > 0) {
    reasons.push(
      `latency: ${actuals.actualSeconds}s observed vs ${best.estimatedRuntime}s estimated for ${best.topology}x${best.agents} (${best.reason})`,
    )
  }

  const actualRequests = actuals.requests ?? plan.estimates.requests
  const estRequestsBest = estimateRequestsFor(plan, best)
  const perReq = perRequestSeconds(ctx, plan, actuals)
  const requestRegret = Math.max(0, round((actualRequests - estRequestsBest) * perReq, 1))
  if (requestRegret > 0) {
    reasons.push(
      `requests: ${actualRequests} vs ~${estRequestsBest} for the best alternative (~${perReq}s/request)`,
    )
  }

  const verifyLaneSeconds = ctx.stats?.estimateVerification?.("verification") ?? 30
  const actualVerify =
    actuals.verificationSeconds ?? Math.max(0, plan.verification.estimatedCost)
  const estVerifyBest = (best.verificationLevel ?? plan.verification.level) * verifyLaneSeconds
  const verificationRegret = Math.max(0, round(actualVerify - estVerifyBest, 1))
  if (verificationRegret > 0) {
    reasons.push(
      `verification: ${actualVerify}s spent vs ~${estVerifyBest}s the best alternative needed`,
    )
  }

  const providerRow = rows.find(
    (r) => r.modelMix?.[0] !== undefined && r.modelMix[0] !== plan.models[0],
  )
  const providerRegret = providerRow
    ? Math.max(0, round(actuals.actualSeconds - providerRow.estimatedRuntime, 1))
    : 0
  if (providerRegret > 0 && providerRow) {
    reasons.push(`provider: ${providerRow.reason} would have saved ~${providerRegret}s`)
  }

  const startupSeconds = ctx.stats?.estimateStartup?.({ warm: true }) ?? 12
  const extraAgents = Math.max(0, observed.agents - best.agents)
  const agentCountRegret = round(extraAgents * startupSeconds, 1)
  if (agentCountRegret > 0) {
    reasons.push(
      `agents: ${observed.agents} ran vs ${best.agents} in the best alternative (~${startupSeconds}s startup per extra lane)`,
    )
  }

  const qualityRegret =
    actuals.targetQuality !== undefined
      ? round(Math.max(0, actuals.targetQuality - (actuals.quality ?? 1)), 2)
      : undefined
  if (qualityRegret !== undefined && qualityRegret > 0) {
    reasons.push(
      `quality: ${qualityRegret} points below target (${actuals.quality ?? 1} vs ${actuals.targetQuality})`,
    )
  }

  const totalRegret = round(
    latencyRegret + requestRegret + verificationRegret + providerRegret + agentCountRegret,
    1,
  )
  if (reasons.length === 0) {
    reasons.push(
      totalRegret === 0
        ? "chosen plan was best in hindsight; no regret on any dimension"
        : "regret components below reporting threshold",
    )
  }

  return {
    actualCostSeconds: actuals.actualSeconds,
    bestAlternative: best,
    totalRegret,
    latencyRegret,
    requestRegret,
    verificationRegret,
    providerRegret,
    agentCountRegret,
    qualityRegret,
    reasons,
  }
}

/** Combined entry point used by the swarm_aftermath tool and benchmarks. */
export function analyzeRun(
  plan: Plan,
  actuals: RunActuals,
  ctx: CounterfactualContext = {},
): RunAftermath {
  const counterfactuals = estimateCounterfactuals(plan, actuals, ctx)
  return { counterfactuals, regret: regretReport(plan, actuals, counterfactuals, ctx) }
}
