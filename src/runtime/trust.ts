/**
 * Trust profiles and calibration for the self-improving runtime.
 * Req 5: per-model, per-skill-category trust profiles (the 11 tracked
 *   categories). A model must earn trust per skill; a great coder lane says
 *   nothing about its summarization lane.
 * Req 6: observations decay with a 14-day half-life (90-day hard cutoff), so
 *   a model must keep earning trust; a great January licenses nothing in July.
 *   The effective score also moves at most +/-0.25 per observation, so one
 *   catastrophic run cannot nuke a profile and one lucky run cannot crown one.
 * Req 7: reported confidence is calibrated against observed accuracy in 0.5-1.0
 *   buckets (step 0.1). A new claim at C is blended as
 *   (observed*n_b + C*4)/(n_b+4) toward what the model actually achieves.
 * Req 8: evidence-kind weighting: deterministic_test 1.0, command_output 0.85,
 *   file_line 0.7, derived 0.4, none 0.05; the strongest cited kind dominates.
 *   Self-reported confidence is never taken at face value.
 * Req 48: observations are metric fields only; record() whitelists keys so
 *   learning data physically cannot carry task text or secrets.
 * Req 49: versioned store; an unknown schema version resets to a fresh start.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  CalibrationBucket,
  CalibrationReport,
  EvidenceKind,
  EvidenceWeightInput,
  EvidenceWeightResult,
  SkillCategory,
  TrustObservation,
  TrustSnapshot,
} from "./types.js"
import { clamp, round, safeReadJson, safeWriteJson } from "./util.js"

const HALF_LIFE_DAYS = 14
const PRIOR = 0.5
const PRIOR_K = 6
const MAX_MOVE = 0.25
const MIN_MEMBER_WEIGHT = 0.05
const MAX_AGE_DAYS = 90
const MAX_OBSERVATIONS = 2000
const DAY_MS = 86_400_000
const TRUST_VERSION = 3
/** Pseudo-count of the reported value in the calibration blend (Req 7). */
export const BLEND_PSEUDOCOUNT = 4

export interface TrustFile {
  version: number
  observations: TrustObservation[]
  /** `${model}|${skill}` -> last movement-clamped effective score. */
  effective: Record<string, number>
}

const profileKey = (model: string, skill: SkillCategory): string => `${model}|${skill}`

/**
 * Decay weight in [0,1]: 14-day half-life with a 90-day hard cutoff.
 * now <= 0 means "clock not modeled"; every observation then counts fresh,
 * which keeps the pure evidence-weighting helpers deterministic in tests.
 */
function weightOf(ts: number, now: number): number {
  if (now <= 0) return 1
  const ageDays = Math.max(0, now - ts) / DAY_MS
  if (ageDays > MAX_AGE_DAYS) return 0
  return 0.5 ** (ageDays / HALF_LIFE_DAYS)
}

interface WStat {
  value: number
  weight: number
  n: number
}

/** Decay-weighted mean over observations where `get` is defined. */
function wstat(
  obs: readonly TrustObservation[],
  now: number,
  get: (o: TrustObservation) => number | undefined,
): WStat {
  let wSum = 0
  let vSum = 0
  let n = 0
  for (const o of obs) {
    const v = get(o)
    if (v === undefined) continue
    const w = weightOf(o.ts, now)
    if (w <= 0) continue
    wSum += w
    vSum += w * v
    n++
  }
  return { value: wSum > 0 ? vSum / wSum : 0, weight: round(wSum, 2), n }
}

function computeSnapshot(
  obs: readonly TrustObservation[],
  now: number,
  model: string,
  skill: SkillCategory,
  storedEffective: number,
): TrustSnapshot {
  const fresh = obs.filter((o) => weightOf(o.ts, now) > 0)
  const success = wstat(fresh, now, (o) => (o.success ? 1 : 0))
  const bool01 = (v: boolean | undefined): number | undefined =>
    typeof v === "boolean" ? (v ? 1 : 0) : undefined
  return {
    model,
    skillCategory: skill,
    n: fresh.length,
    nEffective: success.weight,
    successRate: round(success.value, 2),
    firstAttemptPassRate: round(wstat(fresh, now, (o) => bool01(o.firstAttemptPass)).value, 2),
    verificationFailureRate: round(wstat(fresh, now, (o) => bool01(o.verificationFailed)).value, 2),
    hallucinationRate: round(wstat(fresh, now, (o) => bool01(o.hallucinationDetected)).value, 2),
    toolSuccessRate: round(wstat(fresh, now, (o) => o.toolSuccessRate).value, 2),
    judgeAgreement: round(wstat(fresh, now, (o) => o.judgeAgreement).value, 2),
    regressionRate: round(wstat(fresh, now, (o) => bool01(o.regression)).value, 2),
    avgLatency: round(wstat(fresh, now, (o) => o.latencySeconds).value, 1),
    avgTokens: round(wstat(fresh, now, (o) => o.tokens).value, 0),
    avgRequests: round(wstat(fresh, now, (o) => o.requests).value, 1),
    effectiveScore: round(storedEffective, 2),
    lastTs: fresh.length ? Math.max(...fresh.map((o) => o.ts)) : 0,
  }
}

const isObservation = (o: unknown): o is TrustObservation =>
  !!o &&
  typeof o === "object" &&
  typeof (o as TrustObservation).ts === "number" &&
  typeof (o as TrustObservation).model === "string" &&
  typeof (o as TrustObservation).skillCategory === "string" &&
  typeof (o as TrustObservation).success === "boolean"

/**
 * Calibration buckets for reported confidence, 0.5-1.0 in steps of 0.1
 * (Req 7). Comparisons run in integer thousandths so float dust (0.6 vs
 * 0.599999...) can never shift a boundary. Sub-0.5 reports are excluded:
 * the dashboard exists to catch over-confidence, not modesty.
 */
export function calibrationReport(
  observations: readonly TrustObservation[],
  model?: string,
): CalibrationReport {
  const rows = observations.filter(
    (o) =>
      typeof o.reportedConfidence === "number" &&
      o.reportedConfidence >= 0.5 &&
      (!model || o.model === model),
  )
  const buckets: CalibrationBucket[] = []
  for (let i = 0; i < 5; i++) {
    const loT = 500 + i * 100
    const hiT = loT + 100
    const inBucket = rows.filter((o) => {
      const t = Math.round(o.reportedConfidence! * 1000)
      return t >= loT && (i === 4 ? t <= 1000 : t < hiT)
    })
    const n = inBucket.length
    const meanReported =
      n > 0 ? round(inBucket.reduce((a, o) => a + (o.reportedConfidence ?? 0), 0) / n, 2) : 0
    const observedAccuracy = n > 0 ? round(inBucket.filter((o) => o.success).length / n, 2) : 0
    buckets.push({
      lo: round(0.5 + i / 10, 2),
      hi: i === 4 ? 1 : round(0.5 + (i + 1) / 10, 2),
      n,
      meanReported,
      observedAccuracy,
      calibrationError: n > 0 ? round(Math.abs(meanReported - observedAccuracy), 2) : 0,
    })
  }
  const nonEmpty = buckets.filter((b) => b.n > 0)
  const mae =
    nonEmpty.length > 0
      ? round(nonEmpty.reduce((a, b) => a + b.calibrationError, 0) / nonEmpty.length, 3)
      : 0
  const bias =
    rows.length > 0
      ? round(
          rows.reduce((a, o) => a + ((o.success ? 1 : 0) - (o.reportedConfidence ?? 0)), 0) /
            rows.length,
          3,
        )
      : 0
  return { buckets, mae, bias }
}

/** The calibration bucket a reported confidence value falls into, or null. */
export function bucketOf(
  reported: number,
  buckets: readonly CalibrationBucket[],
): CalibrationBucket | null {
  const t = Math.round(reported * 1000)
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!
    const loT = Math.round(b.lo * 1000)
    const hiT = Math.round(b.hi * 1000)
    if (t >= loT && (i === buckets.length - 1 ? t <= hiT : t < hiT)) return b
  }
  return null
}

const EVIDENCE_STRENGTH: Record<EvidenceKind, number> = {
  deterministic_test: 1,
  command_output: 0.85,
  file_line: 0.7,
  derived: 0.4,
  none: 0.05,
}

/** Strongest cited evidence kind dominates (Req 8); an empty list means "none". */
export function evidenceStrengthOf(kinds: readonly EvidenceKind[]): number {
  if (kinds.length === 0) return EVIDENCE_STRENGTH.none
  return Math.max(...kinds.map((k) => EVIDENCE_STRENGTH[k] ?? EVIDENCE_STRENGTH.none))
}

/**
 * Evidence-weighted, calibration-adjusted confidence for a single claim
 * (Req 7 + 8). Pure function: the caller passes the observation history.
 * calibrated = bucketBlend(reported) * evidenceStrength, where
 * bucketBlend = (observed*n_b + reported*4)/(n_b+4) when comparable history
 * exists, else the reported value itself.
 */
export function evidenceWeightedTrust(
  input: EvidenceWeightInput,
  ctx: { observations?: readonly TrustObservation[]; now?: () => number } = {},
): EvidenceWeightResult {
  const now = ctx.now ? ctx.now() : 0
  const reported = clamp(input.reportedConfidence, 0, 1)
  const reasons: string[] = []
  const strength = evidenceStrengthOf(input.evidenceKinds)

  const modelRows = (ctx.observations ?? []).filter((o) => o.model === input.model)
  const report = calibrationReport(modelRows)
  const bucket = bucketOf(reported, report.buckets)
  let calibrated = reported
  if (bucket && bucket.n > 0) {
    calibrated = round(
      (bucket.observedAccuracy * bucket.n + reported * BLEND_PSEUDOCOUNT) /
        (bucket.n + BLEND_PSEUDOCOUNT),
      3,
    )
    reasons.push(
      `calibration: ${bucket.n} past claim(s) reported at ${bucket.lo}-${bucket.hi} were right ${(bucket.observedAccuracy * 100).toFixed(0)}% of the time; blend (observed*${bucket.n} + reported*${BLEND_PSEUDOCOUNT})/(${bucket.n}+${BLEND_PSEUDOCOUNT}) = ${calibrated}`,
    )
  } else {
    reasons.push(
      "calibration: no comparable history for this model at this confidence; keeping the reported value",
    )
  }

  const out = clamp(round(calibrated * strength, 3), 0, 1)
  reasons.push(
    `evidence: strongest cited kind ${input.evidenceKinds.length === 0 ? "(none cited)" : `[${input.evidenceKinds.join(", ")}]`} scores ${strength}; calibrated confidence = calibrated x evidence strength = ${out}`,
  )

  const prof = modelRows.filter(
    (o) => !input.skillCategory || o.skillCategory === input.skillCategory,
  )
  const s = wstat(prof, now, (o) => (o.success ? 1 : 0))
  const reliability =
    s.weight > 0 ? clamp((s.value * s.weight + PRIOR * PRIOR_K) / (s.weight + PRIOR_K), 0, 1) : PRIOR

  return {
    rawConfidence: round(reported, 3),
    evidenceStrength: strength,
    historicalReliability: round(reliability, 2),
    calibratedConfidence: out,
    reasons,
  }
}

export class TrustStore {
  private observations: TrustObservation[] = []
  private effective: Record<string, number> = {}
  private readonly file: string | null
  private readonly now: () => number

  constructor(file: string | null, opts: { now?: () => number } = {}) {
    this.file = file
    this.now = opts.now ?? (() => Date.now())
    this.load()
  }

  private load(): void {
    if (!this.file) return
    const data = safeReadJson<TrustFile>(this.file, {
      version: TRUST_VERSION,
      observations: [],
      effective: {},
    })
    if (!data || data.version !== TRUST_VERSION) return // Req 49: fresh start
    this.observations = (Array.isArray(data.observations) ? data.observations : []).filter(isObservation)
    this.effective = data.effective && typeof data.effective === "object" ? data.effective : {}
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, {
      version: TRUST_VERSION,
      observations: this.observations,
      effective: this.effective,
    } satisfies TrustFile)
  }

  private prune(now: number): void {
    const cutoff = now - MAX_AGE_DAYS * DAY_MS
    this.observations = this.observations.filter((o) => o.ts >= cutoff).slice(-MAX_OBSERVATIONS)
  }

  /**
   * Record one observation and return the updated profile snapshot.
   * The observation is key-whitelisted (Req 48): unknown props — including
   * any task text or secrets a caller tried to smuggle in — are dropped
   * before the store ever sees them.
   */
  record(input: TrustObservation): TrustSnapshot {
    const obs: TrustObservation = {
      ts: input.ts > 0 ? input.ts : this.now(),
      model: input.model,
      provider: input.provider,
      skillCategory: input.skillCategory,
      success: input.success,
      firstAttemptPass: input.firstAttemptPass,
      verificationFailed: input.verificationFailed,
      hallucinationDetected: input.hallucinationDetected,
      toolSuccessRate: input.toolSuccessRate,
      judgeAgreement: input.judgeAgreement,
      regression: input.regression,
      latencySeconds: input.latencySeconds,
      tokens: input.tokens,
      requests: input.requests,
      reportedConfidence: input.reportedConfidence,
    }
    this.observations.push(obs)
    const now = this.now()
    this.prune(now)

    const prof = this.observations.filter(
      (o) => o.model === obs.model && o.skillCategory === obs.skillCategory,
    )
    // Prior-blended raw score (k=6 at 0.5), then movement clamp vs the last
    // stored score: trust changes by at most +/-0.25 per observation (Req 6).
    const s = wstat(prof, now, (o) => (o.success ? 1 : 0))
    const raw = (s.value * s.weight + PRIOR * PRIOR_K) / (s.weight + PRIOR_K)
    const k = profileKey(obs.model, obs.skillCategory)
    const prev = this.effective[k] ?? PRIOR
    this.effective[k] = clamp(prev + clamp(raw - prev, -MAX_MOVE, MAX_MOVE), 0, 1)
    this.save()
    return this.snapshot(obs.model, obs.skillCategory)
  }

  snapshot(model: string, skillCategory: SkillCategory): TrustSnapshot {
    const now = this.now()
    const prof = this.observations.filter(
      (o) => o.model === model && o.skillCategory === skillCategory,
    )
    return computeSnapshot(
      prof,
      now,
      model,
      skillCategory,
      this.effective[profileKey(model, skillCategory)] ?? PRIOR,
    )
  }

  calibration(model?: string): CalibrationReport {
    return calibrationReport(this.observations, model)
  }

  evidence(input: EvidenceWeightInput): EvidenceWeightResult {
    return evidenceWeightedTrust(input, { observations: this.observations, now: this.now })
  }

  all(): readonly TrustObservation[] {
    return this.observations
  }

  clear(): void {
    this.observations = []
    this.effective = {}
    this.save()
  }
}
