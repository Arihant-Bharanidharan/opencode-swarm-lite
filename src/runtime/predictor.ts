/**
 * Predictor field contract.
 *
 * Internally the runtime speaks camelCase (`serial`, `parallelEfficiency`,
 * `startupCost`, ...). The snake_case predictor contract below is the published
 * boundary: it is what `swarm_plan` hands back to the parent model, so callers
 * have a stable set of names to read instead of the internal estimate locals.
 *
 * The nine fields are derived from the live plan (no recomputation), so they
 * can never drift from the numbers the scheduler actually decided on.
 *
 * The interface itself lives in types.ts so it can be referenced from `Plan`
 * without a circular import; this module is the derivation and the validator.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { Plan, PlanPredictors } from "./types.js"

export type { PlanPredictors }

/** The nine snake_case predictor names, in the order they are documented. */
export const PREDICTOR_FIELDS = [
  "estimated_serial_time",
  "estimated_swarm_time",
  "estimated_parallel_efficiency",
  "estimated_startup_cost",
  "estimated_verification_gain",
  "recommended_topology",
  "recommended_agent_count",
  "recommended_models",
  "confidence",
] as const

/**
 * Derive the snake_case predictor contract from a plan.
 * Mirrors the plan's live values; nothing is recomputed or second-guessed.
 * Takes only the fields it reads, so it also works on a partially assembled
 * plan (the scheduler derives predictors after the plan body is complete).
 */
export function planPredictors(
  plan: Pick<Plan, "estimates" | "topology" | "agents" | "models">,
): PlanPredictors {
  return {
    estimated_serial_time: plan.estimates.serial,
    estimated_swarm_time: plan.estimates.swarm,
    estimated_parallel_efficiency: plan.estimates.parallelEfficiency,
    estimated_startup_cost: plan.estimates.startupCost,
    estimated_verification_gain: plan.estimates.verificationGain,
    recommended_topology: plan.topology,
    recommended_agent_count: plan.agents,
    recommended_models: [...plan.models],
    confidence: plan.estimates.confidence,
  }
}

/** True when every predictor field is present on the object. */
export function hasPredictorContract(value: unknown): value is PlanPredictors {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  for (const field of PREDICTOR_FIELDS) {
    if (!(field in record)) return false
    if (record[field] === undefined || record[field] === null) return false
  }
  return Array.isArray(record.recommended_models)
}
