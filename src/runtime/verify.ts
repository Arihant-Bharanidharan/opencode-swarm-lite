/**
 * Adaptive verification policy V0-V4. The policy starts at the cheapest level
 * that fits the evidence and escalates only on disagreement, low confidence,
 * weak tests or risk. A judge is one optional step, never the default.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { VerificationInput, VerificationLevel, VerificationPlan } from "./types.js"
import { clamp, round } from "./util.js"

const STEPS: Record<VerificationLevel, string[]> = {
  0: ["self-check the claim against the stated success criteria"],
  1: ["reproduce the claim once", "check one boundary/edge value"],
  2: [
    "independent verifier lane re-derives the result from the source",
    "run deterministic checks",
    "compare against capsule invariants/failed approaches",
  ],
  3: [
    "verifier derives tests from the spec, not the implementation",
    "run the deterministic suite",
    "targeted judge only on disputed points",
  ],
  4: [
    "adversarial verifier tries to break the claim",
    "independent judge audits evidence and provenance",
    "re-run the full suite from a clean state",
    "compare independent results and preserve dissent",
  ],
}

const ESCALATE: Record<VerificationLevel, string[]> = {
  0: ["a concrete counterexample appears", "confidence drops below 0.75"],
  1: ["reproduction fails", "the claim depends on an untested edge case"],
  2: ["verifier disagrees", "evidence is missing or stale", "risk rises above 0.6"],
  3: ["judge disagrees", "disagreement remains after one fix", "blast radius is critical"],
  4: [],
}

const GAIN: Record<VerificationLevel, number> = { 0: 0, 1: 0.015, 2: 0.04, 3: 0.075, 4: 0.11 }

export function chooseVerification(input: VerificationInput = {}): VerificationPlan {
  const risk = clamp(input.risk ?? 0.3, 0, 1)
  const disagreement = clamp(input.disagreement ?? 0, 0, 1)
  const confidence = clamp(input.confidence ?? 0.8, 0, 1)
  const testStrength = clamp(input.testStrength ?? 0.35, 0, 1)
  const impact = clamp(input.impact ?? risk, 0, 1)
  // Blast radius / verification value can raise the effective risk signal even
  // when the immediate error probability looks low.
  const impactRisk = Math.max(risk, impact)
  const work = Math.max(1, input.workSeconds ?? 120)
  const judgeCost = Math.max(0, input.judgeCostSeconds ?? 45)
  const judgeAvailable = input.judgeAvailable ?? true
  const trivial = input.trivial ?? false

  let level: VerificationLevel
  if (input.level !== undefined) {
    level = input.level
  } else if (
    trivial ||
    (input.deterministicTests && testStrength >= 0.8 && disagreement <= 0.1 && confidence >= 0.9 && impactRisk <= 0.4)
  ) {
    level = 0
  } else if (confidence >= 0.85 && disagreement <= 0.15 && impactRisk <= 0.3) {
    level = 0
  } else if (confidence >= 0.75 && disagreement < 0.3 && impactRisk < 0.5) {
    level = 1
  } else if (disagreement >= 0.6 || impactRisk >= 0.7 || testStrength < 0.3 || confidence < 0.55) {
    level = judgeAvailable ? 4 : 3
  } else if (disagreement >= 0.35 || confidence < 0.7 || impactRisk >= 0.5) {
    level = 3
  } else {
    level = 2
  }

  let judgeAllowed =
    judgeAvailable && (level === 4 || (level === 3 && (disagreement >= 0.5 || impactRisk >= 0.8)))
  let skipReason: string | undefined
  if (level === 0) {
    skipReason = trivial
      ? "trivial/self-evident task: a separate verifier adds cost without information"
      : input.deterministicTests && testStrength >= 0.8
        ? "strong deterministic checks + high confidence: V0 self-check is sufficient"
        : "low risk, high confidence, no disagreement: no judge"
  }

  const costFor = (l: VerificationLevel): number => {
    const base = l === 0 ? 0 : l === 1 ? 3 : l === 2 ? 20 : l === 3 ? 40 : 70
    const workPart = l === 0 ? 0 : l === 1 ? work * 0.01 : l === 2 ? work * 0.05 : l === 3 ? work * 0.1 : work * 0.15
    const judgePart = l >= 3 && judgeAllowed ? judgeCost * (l === 4 ? 1.5 : 1) : 0
    return base + workPart + judgePart
  }
  let cost = round(costFor(level))

  // Budget gate: never let verification eat the run.
  if (input.budgetSeconds !== undefined && input.budgetSeconds > 0) {
    const cap = input.budgetSeconds * 0.25
    while (level > 0 && cost > cap) {
      level = (level - 1) as VerificationLevel
      cost = round(costFor(level))
      if (level < 3) judgeAllowed = false
      skipReason = `verification downgraded to V${level}: V${level + 1} cost ${cost}s exceeded 25% budget`
    }
  }

  // Diminishing returns / judge addiction gate.
  if ((level === 3 || level === 4) && impactRisk < 0.5 && cost > work * 0.25 && disagreement < 0.5) {
    level = 2
    judgeAllowed = false
    cost = round(costFor(2))
    skipReason = "verification capped at V2: risk is moderate and judge cost outweighed expected gain"
  }
  if (level === 4 && !judgeAvailable) {
    level = 3
    judgeAllowed = false
    cost = round(costFor(3))
    skipReason = "V4 judge unavailable; using adversarial verifier + deterministic suite (V3)"
  }
  if (level === 0) cost = 0

  const need = Math.max(impactRisk, disagreement, 1 - confidence, 0.5 - testStrength)
  const expectedGain = round(GAIN[level] * (0.5 + need), 3)
  const steps = [...STEPS[level]]
  if (level >= 3 && judgeAllowed) steps.push("judge only the disputed/uncertain points")
  if (level >= 3 && !judgeAllowed) steps.push("no judge: rely on independent derivation and deterministic checks")

  return {
    level,
    steps,
    estimatedCost: cost,
    expectedGain,
    skipReason,
    escalateIf: ESCALATE[level],
    judgeAllowed,
  }
}
