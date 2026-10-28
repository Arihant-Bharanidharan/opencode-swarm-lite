/**
 * Provider specialization, quota groups, and circuit breakers.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { Category, ModelProfile, PortfolioReport, ProviderReliability, ProviderState, RouteChoice, RouteDecision, RouteRequest } from "./types.js"
import { clamp, round, safeReadJson, safeWriteJson } from "./util.js"
import type { StatsStore } from "./stats.js"

export interface BreakerState {
  state: ProviderState
  failures: number
  opens: number
  openedAt: number
  cooldownMs: number
  lastKind?: string
  lastFailureAt?: number
  lastSuccessAt?: number
  /** Times the circuit recovered from open/half_open back to closed. */
  recoveryCount: number
}

interface HealthFile {
  version: 2
  providers: Record<string, BreakerState>
  updatedAt: number
}

export interface HealthOptions {
  failureThreshold?: number
  cooldownMs?: number
  timeoutThreshold?: number
  timeoutCooldownMs?: number
  now?: () => number
  stats?: StatsStore
}

const freshState = (): BreakerState => ({
  state: "closed",
  failures: 0,
  opens: 0,
  openedAt: 0,
  cooldownMs: 0,
  recoveryCount: 0,
})

export class ProviderHealth {
  private providers: Record<string, BreakerState> = {}
  private readonly file: string | null
  private readonly threshold: number
  private readonly baseCooldown: number
  private readonly timeoutThreshold: number
  private readonly timeoutCooldown: number
  private readonly now: () => number
  private readonly stats: StatsStore | null

  constructor(file: string | null, opts: HealthOptions = {}) {
    this.file = file
    this.threshold = opts.failureThreshold ?? 3
    this.baseCooldown = opts.cooldownMs ?? 60_000
    this.timeoutThreshold = opts.timeoutThreshold ?? 2
    this.timeoutCooldown = opts.timeoutCooldownMs ?? 45_000
    this.now = opts.now ?? (() => Date.now())
    this.stats = opts.stats ?? null
    this.load()
  }

  private load(): void {
    if (!this.file) return
    const data = safeReadJson<HealthFile>(this.file, { version: 2, providers: {}, updatedAt: 0 })
    if (data && data.providers && typeof data.providers === "object") this.providers = data.providers
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, { version: 2, providers: this.providers, updatedAt: this.now() } satisfies HealthFile)
  }

  private get(provider: string): BreakerState {
    const s = this.providers[provider]
    if (s) return s
    const created = freshState()
    this.providers[provider] = created
    return created
  }

  state(provider: string): ProviderState {
    const s = this.get(provider)
    if (s.state === "open" && this.now() - s.openedAt >= s.cooldownMs) return "half_open"
    return s.state
  }

  allow(provider: string): boolean {
    const s = this.get(provider)
    if (s.state === "closed") return true
    if (s.state === "half_open") return true
    if (this.now() - s.openedAt >= s.cooldownMs) {
      s.state = "half_open"
      this.save()
      return true
    }
    return false
  }

  remainingSeconds(provider: string): number {
    const s = this.get(provider)
    if (s.state !== "open") return 0
    return Math.max(0, Math.ceil((s.openedAt + s.cooldownMs - this.now()) / 1000))
  }

  record(provider: string, kind: "ok" | "429" | "timeout" | "error" | "latency"): BreakerState {
    const s = this.get(provider)
    const now = this.now()
    if (kind === "ok") {
      const wasOpenOrHalf = s.state === "open" || s.state === "half_open"
      s.state = "closed"
      s.failures = 0
      s.opens = 0
      s.lastSuccessAt = now
      if (wasOpenOrHalf) s.recoveryCount += 1
      this.save()
      return s
    }
    s.failures += kind === "timeout" ? 1.5 : 1
    s.lastKind = kind
    s.lastFailureAt = now
    const need = kind === "timeout" ? this.timeoutThreshold : this.threshold
    if (s.state === "half_open" || s.failures >= need) {
      s.state = "open"
      s.opens += 1
      s.openedAt = now
      // Exponential backoff, capped at 8x the base cooldown (1x, 2x, 4x, 8x).
      const base = kind === "timeout" ? this.timeoutCooldown : this.baseCooldown
      s.cooldownMs = base * 2 ** Math.min(Math.max(0, s.opens - 1), 3)
    }
    this.save()
    return s
  }

  snapshot(): Record<string, { state: ProviderState; failures: number; cooldownRemaining: number; lastKind?: string; recoveryCount: number }> {
    const out: Record<string, { state: ProviderState; failures: number; cooldownRemaining: number; lastKind?: string; recoveryCount: number }> = {}
    for (const [p, s] of Object.entries(this.providers)) {
      out[p] = {
        state: this.state(p),
        failures: s.failures,
        cooldownRemaining: this.remainingSeconds(p),
        lastKind: s.lastKind,
        recoveryCount: s.recoveryCount,
      }
    }
    return out
  }

  /** Reliability report for a single provider, blending breaker state with
   * the learned cost model's failureRate/rate429 priors. */
  providerReliability(provider: string): ProviderReliability {
    const s = this.get(provider)
    const a = this.stats ? this.stats.aggregate({ provider }) : { failureRate: 0, rate429: 0, n: 0 }
    const cooldownRemaining = this.remainingSeconds(provider)
    const reliabilityScore = clamp(
      1 - (a.failureRate * 0.7 + a.rate429 * 0.3) - (s.state === "open" ? 0.4 : s.state === "half_open" ? 0.2 : 0),
      0,
      1,
    )
    return {
      provider,
      state: this.state(provider),
      failures: s.failures,
      opens: s.opens,
      cooldownRemaining,
      lastKind: s.lastKind,
      lastFailureAt: s.lastFailureAt,
      lastSuccessAt: s.lastSuccessAt,
      failureRate: a.failureRate,
      rate429: a.rate429,
      recoveryCount: s.recoveryCount,
      reliabilityScore: round(reliabilityScore, 4),
    }
  }

  /** Portfolio report across every tracked provider, plus aggregates and grade. */
  portfolioReport(): PortfolioReport {
    const providers = Object.keys(this.providers).map((p) => this.providerReliability(p))
    const openCount = providers.filter((x) => x.state === "open").length
    const halfOpenCount = providers.filter((x) => x.state === "half_open").length
    const closedCount = providers.filter((x) => x.state === "closed").length
    const aggregateFailureRate =
      providers.length > 0
        ? providers.reduce((sum, x) => sum + x.failureRate, 0) / providers.length
        : 0
    const aggregateRate429 =
      providers.length > 0 ? providers.reduce((sum, x) => sum + x.rate429, 0) / providers.length : 0
    const scored = providers.slice().sort((a, b) => b.reliabilityScore - a.reliabilityScore)
    const mostReliable = scored.length ? scored[0].provider : null
    const leastRisky = scored.length ? scored[scored.length - 1].provider : null
    let grade: "A" | "B" | "C" | "D" | "F" = "F"
    if (aggregateFailureRate === 0 && openCount === 0) grade = "A"
    else if (aggregateFailureRate < 0.1 && openCount === 0) grade = "B"
    else if (aggregateFailureRate < 0.25 && openCount <= 1) grade = "C"
    else if (aggregateFailureRate < 0.4 || openCount <= 2) grade = "D"
    else grade = "F"
    return {
      providers,
      totalProviders: providers.length,
      openCount,
      halfOpenCount,
      closedCount,
      aggregateFailureRate: round(aggregateFailureRate, 4),
      aggregateRate429: round(aggregateRate429, 4),
      mostReliable,
      leastRisky,
      grade,
    }
  }
}

export interface RouterOptions {
  profiles?: ModelProfile[]
  qualityWeight?: number
  quotaGroups?: Record<string, { maxConcurrent: number }>
}

export const DEFAULT_PROFILES: ModelProfile[] = [
  {
    id: "mimo-v2.6-flash-free",
    provider: "opencode",
    quotaGroup: "opencode-free",
    quality: 0.66,
    speed: 0.84,
    contextLimit: 200_000,
    costTier: 0,
    strengths: ["fast", "coding", "bulk", "research", "tools", "analysis"],
  },
]

const ROLE_STRENGTHS: Record<string, string[]> = {
  researcher: ["research", "analysis", "large-context"],
  explorer: ["research", "fast", "analysis"],
  coder: ["coding", "tools", "bulk"],
  builder: ["coding", "tools"],
  verifier: ["verification", "analysis", "tools"],
  reviewer: ["verification", "analysis"],
  judge: ["verification", "analysis", "judge"],
  architect: ["analysis", "large-context", "research"],
  multimodal: ["vision", "analysis"],
}

const CATEGORY_STRENGTHS: Record<Category, string[]> = {
  microtask: ["fast", "bulk"],
  research: ["research", "analysis"],
  coding: ["coding", "tools"],
  analysis: ["analysis", "research"],
  verification: ["verification", "analysis"],
  mixed: ["analysis", "coding"],
  ops: ["tools", "fast"],
}

export function synthesizeProfile(id: string, provider = "unknown"): ModelProfile {
  return {
    id,
    provider,
    quotaGroup: `${provider}-default`,
    quality: 0.62,
    speed: 0.65,
    contextLimit: 128_000,
    costTier: 1,
    strengths: ["general"],
  }
}

export class Router {
  private readonly profiles: ModelProfile[]
  private readonly qualityWeight: number
  readonly quotaGroups: Record<string, { maxConcurrent: number }>

  constructor(
    private readonly stats: StatsStore,
    private readonly health: ProviderHealth,
    opts: RouterOptions = {},
  ) {
    this.profiles = opts.profiles?.length ? opts.profiles : DEFAULT_PROFILES
    this.qualityWeight = clamp(opts.qualityWeight ?? 0.5, 0, 1)
    this.quotaGroups = opts.quotaGroups ?? { "opencode-free": { maxConcurrent: 6 } }
  }

  getProfiles(): readonly ModelProfile[] {
    return this.profiles
  }

  profileFor(id: string, provider = "unknown"): ModelProfile {
    return this.profiles.find((p) => p.id === id) ?? synthesizeProfile(id, provider)
  }

  quotaCap(provider: string): number {
    const p = this.profiles.find((x) => x.provider === provider)
    const group = p ? this.quotaGroups[p.quotaGroup] : undefined
    return group?.maxConcurrent ?? 6
  }

  route(req: RouteRequest): RouteDecision {
    const wanted = new Set([
      ...(ROLE_STRENGTHS[req.role] ?? ["general"]),
      ...(CATEGORY_STRENGTHS[req.category] ?? []),
    ])
    const blocked: string[] = []
    const scored: RouteChoice[] = []

    for (const p of this.profiles) {
      if (req.exclude?.includes(p.id)) continue
      if ((req.contextTokens ?? 0) > p.contextLimit) {
        blocked.push(`${p.id}: context ${req.contextTokens} > ${p.contextLimit}`)
        continue
      }
      if (!this.health.allow(p.provider)) {
        blocked.push(`${p.id}: ${p.provider} circuit open (${this.health.remainingSeconds(p.provider)}s)`)
        continue
      }
      const a = this.stats.aggregate({ provider: p.provider, model: p.id })
      const startup = this.stats.estimateStartup({ provider: p.provider, model: p.id, warm: req.warm })
      const work = this.stats.estimateWork(
        { provider: p.provider, model: p.id, category: req.category },
        req.category,
      )
      const speed = clamp(
        0.55 * p.speed + 0.45 * clamp(1 - (startup + work) / 420, 0, 1),
        0,
        1,
      )
      const match = p.strengths.some((s) => wanted.has(s)) ? 1 : 0
      const warmBonus = req.warm && this.stats.count({ model: p.id, warm: true }) > 0 ? 0.06 : 0
      const failurePenalty = a.failureRate * 0.9 + a.rate429 * 0.6
      const costPenalty = p.costTier * 0.015
      const qw = req.qualityWeight ?? this.qualityWeight
      const score =
        qw * p.quality +
        (1 - qw) * speed +
        0.16 * match +
        warmBonus -
        failurePenalty -
        costPenalty
      const reasons = [
        `quality ${round(p.quality, 2)}`,
        `speed ${round(speed, 2)}`,
        match ? `strength match: ${p.strengths.filter((s) => wanted.has(s)).join(",")}` : "generalist",
        a.n ? `n=${a.n}, fail ${round(a.failureRate * 100)}%` : "no history (prior)",
      ]
      if (req.warm) reasons.push("warm-lane eligible")
      scored.push({ model: p, score, reasons })
    }

    scored.sort((x, y) => y.score - x.score)
    const health: Record<string, ProviderState> = {}
    for (const p of this.profiles) health[p.provider] = this.health.state(p.provider)
    return { choices: scored, blocked, health }
  }
}
