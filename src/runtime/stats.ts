/**
 * Learned cost model: provider/model/role/category/context/warm observations.
 * Priors are deliberately conservative; live observations replace them as they
 * accumulate. Nothing here calls a model or a provider.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { Category, Observation, ObservationStatus, TaskInput } from "./types.js"
import { clamp, median, percentile, round, safeReadJson, safeWriteJson } from "./util.js"

export interface Priors {
  startupColdSeconds: number
  startupWarmSeconds: number
  workSeconds: Record<Category, number>
  tokensOut: number
  tokensIn: number
  tokPerSecond: number
  failureRate: number
  rate429: number
  toolCalls: number
}

export const DEFAULT_PRIORS: Priors = {
  startupColdSeconds: 45,
  startupWarmSeconds: 12,
  workSeconds: {
    microtask: 20,
    research: 80,
    coding: 120,
    analysis: 90,
    verification: 45,
    mixed: 100,
    ops: 30,
  },
  tokensOut: 3000,
  tokensIn: 12000,
  tokPerSecond: 35,
  failureRate: 0.08,
  rate429: 0.03,
  toolCalls: 8,
}

export interface StatsFile {
  version: 2
  observations: Observation[]
  updatedAt: number
}

export interface Aggregate {
  n: number
  startupP50: number
  startupP90: number
  workP50: number
  workP90: number
  totalP50: number
  tokPerSecond: number
  failureRate: number
  rate429: number
  tokensIn: number
  tokensOut: number
  toolCalls: number
  lastTs: number
}

export interface StatsFilter {
  provider?: string
  model?: string
  role?: string
  category?: Category
  warm?: boolean
  status?: ObservationStatus
  runId?: string
}

const matches = (o: Observation, f: StatsFilter): boolean =>
  (f.provider === undefined || o.provider === f.provider) &&
  (f.model === undefined || o.model === f.model) &&
  (f.role === undefined || o.role === f.role) &&
  (f.category === undefined || o.category === f.category) &&
  (f.warm === undefined || o.warm === f.warm) &&
  (f.status === undefined || o.status === f.status) &&
  (f.runId === undefined || o.runId === f.runId)

export class StatsStore {
  private observations: Observation[] = []
  private readonly file: string | null
  readonly priors: Priors

  constructor(file: string | null, priors: Partial<Priors> = {}) {
    this.file = file
    this.priors = {
      ...DEFAULT_PRIORS,
      ...priors,
      workSeconds: { ...DEFAULT_PRIORS.workSeconds, ...(priors.workSeconds ?? {}) },
    }
    this.load()
  }

  private load(): void {
    if (!this.file) return
    const data = safeReadJson<StatsFile | Observation[]>(this.file, {
      version: 2,
      observations: [],
      updatedAt: 0,
    })
    const arr = Array.isArray(data) ? data : data.observations
    if (Array.isArray(arr)) {
      this.observations = arr
        .filter((o): o is Observation => !!o && typeof o === "object" && typeof o.ts === "number")
        .slice(-1500)
    }
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, {
      version: 2,
      observations: this.observations.slice(-1500),
      updatedAt: Date.now(),
    } satisfies StatsFile)
  }

  all(): readonly Observation[] {
    return this.observations
  }

  recent(n = 20): Observation[] {
    return this.observations.slice(-n).reverse()
  }

  count(filter: StatsFilter = {}): number {
    return this.observations.reduce((n, o) => n + (matches(o, filter) ? 1 : 0), 0)
  }

  add(o: Observation, persist = true): void {
    this.observations.push(o)
    if (this.observations.length > 1500) this.observations = this.observations.slice(-1500)
    if (persist) this.save()
  }

  addMany(obs: Observation[]): void {
    for (const o of obs) this.observations.push(o)
    if (this.observations.length > 1500) this.observations = this.observations.slice(-1500)
    this.save()
  }

  clear(): void {
    this.observations = []
    this.save()
  }

  aggregate(filter: StatsFilter = {}): Aggregate {
    const rows = this.observations.filter((o) => matches(o, filter))
    const startups = rows.map((o) => o.startupSeconds).filter((n) => Number.isFinite(n) && n >= 0.5)
    const works = rows.map((o) => o.workSeconds).filter((n) => Number.isFinite(n) && n >= 0.2)
    const totals = rows.map((o) => o.totalSeconds).filter((n) => Number.isFinite(n) && n > 0)
    const ok = rows.filter((o) => o.status === "ok")
    const out = ok.reduce((n, o) => n + (o.tokensOut ?? 0), 0)
    const work = ok.reduce((n, o) => n + (o.workSeconds || o.totalSeconds), 0)
    const failures = rows.filter((o) => o.status !== "ok").length
    const throttled = rows.filter((o) => o.status === "429").length
    return {
      n: rows.length,
      startupP50: median(startups),
      startupP90: percentile(startups, 0.9),
      workP50: median(works),
      workP90: percentile(works, 0.9),
      totalP50: median(totals),
      tokPerSecond: out > 0 && work > 0 ? out / work : 0,
      failureRate: (failures + this.priors.failureRate * 6) / (rows.length + 6),
      rate429: (throttled + this.priors.rate429 * 6) / (rows.length + 6),
      tokensIn: ok.length ? ok.reduce((n, o) => n + (o.tokensIn ?? 0), 0) / ok.length : 0,
      tokensOut: ok.length ? out / ok.length : 0,
      toolCalls: ok.length ? ok.reduce((n, o) => n + (o.toolCalls ?? 0), 0) / ok.length : 0,
      lastTs: rows.length ? Math.max(...rows.map((o) => o.ts)) : 0,
    }
  }

  successRate(filter: StatsFilter = {}): number {
    const a = this.aggregate(filter)
    return clamp(1 - a.failureRate, 0, 1)
  }

  /** Blended startup estimate (seconds). */
  estimateStartup(filter: StatsFilter): number {
    const rows = this.observations.filter((o) => matches(o, filter))
    const xs = rows.map((o) => o.startupSeconds).filter((n) => Number.isFinite(n) && n >= 0.5)
    const prior = filter.warm ? this.priors.startupWarmSeconds : this.priors.startupColdSeconds
    if (xs.length === 0) {
      if (filter.warm) {
        const cold = this.observations
          .filter((o) => matches(o, { ...filter, warm: false }))
          .map((o) => o.startupSeconds)
          .filter((n) => n >= 0.5)
        if (cold.length) return Math.max(4, median(cold) * 0.35)
      }
      return prior
    }
    const k = 6
    return (median(xs) * xs.length + prior * k) / (xs.length + k)
  }

  /** Blended lane work estimate (seconds), excluding startup. */
  estimateWork(filter: StatsFilter, fallbackCategory?: Category): number {
    const rows = this.observations.filter((o) => matches(o, filter))
    const xs = rows.map((o) => o.workSeconds).filter((n) => Number.isFinite(n) && n >= 0.2)
    const cat = filter.category ?? fallbackCategory ?? "mixed"
    const prior = this.priors.workSeconds[cat]
    if (xs.length === 0) return prior
    const k = 6
    return (median(xs) * xs.length + prior * k) / (xs.length + k)
  }

  estimateTotal(filter: StatsFilter, fallbackCategory?: Category): number {
    return this.estimateStartup(filter) + this.estimateWork(filter, fallbackCategory)
  }

  /** Estimated seconds to run one verification lane at a given depth. */
  estimateVerification(category: Category = "verification", model?: string): number {
    const f: StatsFilter = { category }
    if (model) f.model = model
    return this.estimateTotal(f, category)
  }

  contextTokens(input: TaskInput): number {
    if (input.contextTokens && input.contextTokens > 0) return input.contextTokens
    const rows = this.observations.filter(
      (o) => o.status === "ok" && (!input.model || o.model === input.model),
    )
    if (rows.length >= 5) {
      const avgIn = rows.reduce((n, o) => n + (o.tokensIn ?? 0), 0) / rows.length
      if (avgIn > 1000) return avgIn
    }
    return this.priors.tokensIn
  }

  outputTokens(input: TaskInput): number {
    if (input.outputTokens && input.outputTokens > 0) return input.outputTokens
    const rows = this.observations.filter(
      (o) => o.status === "ok" && (!input.model || o.model === input.model),
    )
    if (rows.length >= 5) {
      const avgOut = rows.reduce((n, o) => n + (o.tokensOut ?? 0), 0) / rows.length
      if (avgOut > 0) return avgOut
    }
    return this.priors.tokensOut
  }

  /** Compact learned-profile summary for swarm_status. */
  summary(limit = 8): Array<Record<string, unknown>> {
    const groups = new Map<string, Observation[]>()
    for (const o of this.observations) {
      const key = `${o.provider}/${o.model}|${o.role}|${o.category}|${o.warm ? "warm" : "cold"}`
      const arr = groups.get(key) ?? []
      arr.push(o)
      groups.set(key, arr)
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, limit)
      .map(([key, rows]) => {
        const startup = median(rows.map((o) => o.startupSeconds).filter((n) => n >= 0.5))
        const work = median(rows.map((o) => o.workSeconds).filter((n) => n >= 0.2))
        const ok = rows.filter((o) => o.status === "ok")
        const tokensOut = ok.reduce((n, o) => n + (o.tokensOut ?? 0), 0)
        const workSeconds = ok.reduce((n, o) => n + (o.workSeconds || o.totalSeconds), 0)
        const pick = (keyName: keyof Observation): number[] =>
          rows
            .map((o) => o[keyName])
            .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
        const firstToken = pick("firstTokenSeconds")
        const tool = pick("toolSeconds")
        const completion = pick("completionSeconds")
        const judge = pick("judgeSeconds")
        const integration = pick("integrationSeconds")
        return {
          key,
          n: rows.length,
          startupP50: round(startup),
          workP50: round(work),
          firstTokenP50: firstToken.length ? round(median(firstToken)) : undefined,
          toolP50: tool.length ? round(median(tool)) : undefined,
          completionP50: completion.length ? round(median(completion)) : undefined,
          judgeP50: judge.length ? round(median(judge)) : undefined,
          integrationP50: integration.length ? round(median(integration)) : undefined,
          retries: rows.reduce((n, o) => n + (o.retryCount ?? 0), 0),
          failureRate: round(rows.filter((o) => o.status !== "ok").length / Math.max(1, rows.length), 2),
          sampleTokPerSecond: tokensOut > 0 && workSeconds > 0 ? round(tokensOut / workSeconds) : undefined,
        }
      })
  }
}
