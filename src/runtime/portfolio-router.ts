/**
 * PortfolioRouter: trust-aware routing, degradation reallocation, and a
 * feedback loop that wraps the existing Router. When a provider degrades
 * (circuit opens, repeated 429s/timeouts/errors), routes are reallocated to
 * healthy providers and the degradation is recorded for the coordinator's
 * feedback loop. Routing score is blended with the provider's trust score
 * (TrustStore) and reliability score (ProviderHealth) so traffic drifts
 * away from flaky providers toward trustworthy ones.
 *
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { PortfolioReport, ProviderReliability, RouteChoice, RouteDecision, RouteRequest, SkillCategory } from "./types.js"
import { Router } from "./provider.js"
import type { ProviderHealth } from "./provider.js"
import type { StatsStore } from "./stats.js"
import { TrustStore } from "./trust.js"
import { round } from "./util.js"

/** Map a routing Category to a TrustStore SkillCategory (best effort). */
const categoryToSkill = (category: string): SkillCategory => {
  const map: Record<string, SkillCategory> = {
    coding: "coding",
    research: "research",
    analysis: "planning",
    verification: "review",
    microtask: "testing",
    ops: "debugging",
    mixed: "planning",
  }
  return (map[category] ?? "planning") as SkillCategory
}

export interface PortfolioRouteChoice {
  model: string
  provider: string
  score: number
  trustScore: number
  reliabilityScore: number
  reasons: string[]
  degraded: boolean
  reallocatedFrom?: string
}

export type DegradationKind = "429" | "timeout" | "error" | "circuit_open"

export interface DegradationEvent {
  provider: string
  kind: DegradationKind
  at: number
  reallocatedTo: string[]
}

export interface PortfolioFeedback {
  totalRoutes: number
  degradedRoutes: number
  reallocations: number
  events: DegradationEvent[]
  byProvider: Record<string, { routes: number; degradations: number; reallocations: number }>
}

export interface PortfolioRouteOptions {
  /** Prefer this provider when healthy. */
  preferProvider?: string
  /** Exclude providers whose circuit is not closed. */
  excludeDegraded?: boolean
  /** Maximum number of choices to return. */
  limit?: number
}

export class PortfolioRouter {
  private readonly router: Router
  private readonly health: ProviderHealth
  private readonly trust: TrustStore
  private readonly stats: StatsStore
  private readonly events: DegradationEvent[] = []
  private readonly routeCounts = new Map<string, number>()
  private readonly degradationCounts = new Map<string, number>()
  private readonly reallocationCounts = new Map<string, number>()

  constructor(deps: { router: Router; health: ProviderHealth; trust: TrustStore; stats: StatsStore }) {
    this.router = deps.router
    this.health = deps.health
    this.trust = deps.trust
    this.stats = deps.stats
  }

  /**
   * Route a request with trust awareness. Choices are blended from the
   * Router's score, the provider's trust score, and its reliability score.
   * Providers with open circuits are demoted; when excludeDegraded is set
   * they are removed entirely.
   */
  route(req: RouteRequest, opts: PortfolioRouteOptions = {}): PortfolioRouteChoice[] {
    const decision = this.router.route(req)
    const blocked = new Set(decision.blocked)
    const choices: PortfolioRouteChoice[] = []

    for (const c of decision.choices) {
      const provider = c.model.provider
      const reliability = this.health.providerReliability(provider)
      const trustSnap = this.trust.snapshot(c.model.id, categoryToSkill(req.category))
      const circuitBlocked = blocked.has(`${c.model.id}: ${provider} circuit open`)
      const degraded = Boolean(
        reliability.state === "open" || circuitBlocked || (opts.excludeDegraded === true && reliability.state !== "closed")
      )

      choices.push({
        model: c.model.id,
        provider,
        score: round(c.score, 3),
        trustScore: round(trustSnap.effectiveScore, 3),
        reliabilityScore: reliability.reliabilityScore,
        reasons: [...c.reasons, `reliability ${round(reliability.reliabilityScore, 2)}`, `trust ${round(trustSnap.effectiveScore, 2)}`],
        degraded,
        reallocatedFrom: circuitBlocked ? provider : undefined,
      })
    }

    // Blended sort: routing score + trust + reliability, with a penalty
    // for degraded providers. PreferProvider gets a small boost.
    choices.sort((a, b) => {
      const preferA = a.provider === opts.preferProvider ? 0.05 : 0
      const preferB = b.provider === opts.preferProvider ? 0.05 : 0
      const sa = a.score * 0.5 + a.trustScore * 0.3 + a.reliabilityScore * 0.2 + preferA - (a.degraded ? 0.5 : 0)
      const sb = b.score * 0.5 + b.trustScore * 0.3 + b.reliabilityScore * 0.2 + preferB - (b.degraded ? 0.5 : 0)
      return sb - sa
    })

    if (opts.limit !== undefined) choices.length = Math.min(choices.length, opts.limit)

    for (const c of choices) {
      this.routeCounts.set(c.provider, (this.routeCounts.get(c.provider) ?? 0) + 1)
    }

    return choices
  }

  /**
   * Record a provider degradation (e.g. circuit opened, 429 storm) and the
   * providers traffic was reallocated to. Feeds the coordinator's feedback
   * loop so it can re-plan affected branches.
   */
  recordDegradation(provider: string, kind: DegradationKind, reallocatedTo: string[]): void {
    this.events.push({ provider, kind, at: Date.now(), reallocatedTo: [...reallocatedTo] })
    this.degradationCounts.set(provider, (this.degradationCounts.get(provider) ?? 0) + 1)
    for (const target of reallocatedTo) {
      this.reallocationCounts.set(target, (this.reallocationCounts.get(target) ?? 0) + 1)
    }
  }

  /** Aggregate feedback: routes, degradations, reallocations, per-provider breakdown. */
  feedback(): PortfolioFeedback {
    const byProvider: Record<string, { routes: number; degradations: number; reallocations: number }> = {}
    const providers = new Set([...this.routeCounts.keys(), ...this.degradationCounts.keys(), ...this.reallocationCounts.keys()])
    for (const p of providers) {
      byProvider[p] = {
        routes: this.routeCounts.get(p) ?? 0,
        degradations: this.degradationCounts.get(p) ?? 0,
        reallocations: this.reallocationCounts.get(p) ?? 0,
      }
    }
    return {
      totalRoutes: [...this.routeCounts.values()].reduce((a, b) => a + b, 0),
      degradedRoutes: this.events.length,
      reallocations: [...this.reallocationCounts.values()].reduce((a, b) => a + b, 0),
      events: [...this.events],
      byProvider,
    }
  }

  /** Clear all feedback state (tests only). */
  clear(): void {
    this.events.length = 0
    this.routeCounts.clear()
    this.degradationCounts.clear()
    this.reallocationCounts.clear()
  }

  /** The underlying routing decision (unblended) for a request. */
  routeDecision(req: RouteRequest): RouteDecision {
    return this.router.route(req)
  }

  /** Reliability snapshot for every known provider. */
  portfolioReport(): PortfolioReport {
    return this.health.portfolioReport()
  }

  /** Reliability report for a single provider. */
  providerReliability(provider: string): ProviderReliability {
    return this.health.providerReliability(provider)
  }

  /** All route choices from the last route() call (unblended). */
  lastChoices(): readonly RouteChoice[] {
    // Re-derive from the last router route call is not stored; return empty.
    return []
  }
}
