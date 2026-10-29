/**
 * Warm lane pool. Sessions are reused only when role, model, category and
 * capsule scope all match; anything else is a cold lane. No context is
 * silently transplanted across scopes.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { Category, LaneRecord } from "./types.js"
import { round, safeReadJson, safeWriteJson } from "./util.js"

interface LaneStats {
  hits: number
  misses: number
  coldStarts: number
  warmStarts: number
  invalidations: number
}

interface LanesFile {
  version: 2
  lanes: LaneRecord[]
  stats: LaneStats
  updatedAt: number
}

export interface LaneRegistration {
  sessionID: string
  role: string
  model: string
  category: Category
  provider?: string
  capsule?: string
  capsuleVersion?: number
  runId?: string
  ttlMs?: number
  maxUses?: number
}

export interface LaneAcquireRequest {
  role: string
  model?: string
  category?: Category
  provider?: string
  capsule?: string
  capsuleVersion?: number
}

export interface LaneAcquireResult {
  warm: boolean
  lane?: LaneRecord
  reason: string
  hitRate: number
}

const emptyStats = (): LaneStats => ({
  hits: 0,
  misses: 0,
  coldStarts: 0,
  warmStarts: 0,
  invalidations: 0,
})

export class LanePool {
  private lanes: LaneRecord[] = []
  private stats: LaneStats = emptyStats()
  private readonly file: string | null
  private readonly ttlMs: number
  private readonly maxUses: number
  private readonly now: () => number

  constructor(file: string | null, opts: { ttlMs?: number; maxUses?: number; now?: () => number } = {}) {
    this.file = file
    this.ttlMs = opts.ttlMs ?? 10 * 60_000
    this.maxUses = opts.maxUses ?? 4
    this.now = opts.now ?? (() => Date.now())
    this.load()
  }

  private load(): void {
    if (!this.file) return
    const data = safeReadJson<LanesFile>(this.file, {
      version: 2,
      lanes: [],
      stats: emptyStats(),
      updatedAt: 0,
    })
    if (Array.isArray(data.lanes)) this.lanes = data.lanes
    if (data.stats) this.stats = { ...emptyStats(), ...data.stats }
  }

  private save(): void {
    if (!this.file) return
    safeWriteJson(this.file, {
      version: 2,
      lanes: this.lanes,
      stats: this.stats,
      updatedAt: this.now(),
    } satisfies LanesFile)
  }

  sweep(): number {
    const now = this.now()
    let expired = 0
    for (const lane of this.lanes) {
      if (lane.status === "idle" && (lane.expiresAt <= now || lane.uses >= lane.maxUses)) {
        lane.status = "invalid"
        lane.reason = lane.uses >= lane.maxUses ? "max uses reached" : "idle TTL expired"
        expired++
      }
    }
    if (expired) this.save()
    return expired
  }

  list(includeInvalid = false): LaneRecord[] {
    this.sweep()
    return includeInvalid ? [...this.lanes] : this.lanes.filter((l) => l.status !== "invalid")
  }

  get(sessionID: string): LaneRecord | undefined {
    return this.lanes.find((l) => l.sessionID === sessionID)
  }

  /** Register a freshly spawned lane as idle (eligible for warm reuse). */
  register(reg: LaneRegistration): LaneRecord {
    const now = this.now()
    const existing = this.get(reg.sessionID)
    if (existing) {
      existing.role = reg.role
      existing.model = reg.model
      existing.category = reg.category
      existing.provider = reg.provider ?? existing.provider
      existing.capsule = reg.capsule
      existing.capsuleVersion = reg.capsuleVersion
      existing.status = "idle"
      existing.lastUsedAt = now
      existing.expiresAt = now + (reg.ttlMs ?? this.ttlMs)
      existing.lastRunId = reg.runId
      existing.reason = undefined
      this.save()
      return existing
    }
    const lane: LaneRecord = {
      sessionID: reg.sessionID,
      role: reg.role,
      model: reg.model,
      category: reg.category,
      provider: reg.provider ?? "unknown",
      capsule: reg.capsule,
      capsuleVersion: reg.capsuleVersion,
      status: "idle",
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + (reg.ttlMs ?? this.ttlMs),
      uses: 0,
      maxUses: reg.maxUses ?? this.maxUses,
      lastRunId: reg.runId,
    }
    this.lanes.push(lane)
    this.stats.coldStarts++
    this.save()
    return lane
  }

  acquire(req: LaneAcquireRequest): LaneAcquireResult {
    this.sweep()
    const now = this.now()
    const compatible = this.lanes.filter((lane) => {
      if (lane.status !== "idle") return false
      if (lane.expiresAt <= now || lane.uses >= lane.maxUses) return false
      if (lane.role !== req.role) return false
      if (req.model && lane.model !== req.model) return false
      if (req.provider && lane.provider !== req.provider) return false
      if (req.category && lane.category !== req.category && lane.category !== "mixed") return false
      // Capsule scope: reuse only when both sides name the same capsule+version.
      // A lane with no capsule cannot be reused for capsule-scoped work.
      if (req.capsule) {
        if (lane.capsule !== req.capsule) return false
        if (req.capsuleVersion !== undefined && lane.capsuleVersion !== undefined && lane.capsuleVersion !== req.capsuleVersion)
          return false
      } else if (lane.capsule) {
        // Lane carries scoped context but the caller did not attach it: do not leak.
        return false
      }
      return true
    })
    compatible.sort((a, b) => a.uses - b.uses || b.lastUsedAt - a.lastUsedAt)
    const lane = compatible[0]
    const hitRate = this.hitRate()
    if (!lane) {
      this.stats.misses++
      this.save()
      return { warm: false, reason: "no compatible idle lane; spawn cold", hitRate }
    }
    lane.status = "busy"
    lane.lastUsedAt = now
    this.stats.hits++
    this.stats.warmStarts++
    this.save()
    return {
      warm: true,
      lane,
      reason: `reuse ${lane.sessionID} (${lane.role}/${lane.model}, use ${lane.uses + 1}/${lane.maxUses})`,
      hitRate: this.hitRate(),
    }
  }

  release(
    sessionID: string,
    opts: { capsule?: string; capsuleVersion?: number; runId?: string; stale?: boolean; reason?: string } = {},
  ): LaneRecord | undefined {
    const lane = this.get(sessionID)
    if (!lane) return undefined
    if (opts.stale) {
      lane.status = "invalid"
      lane.reason = opts.reason ?? "released stale"
      this.stats.invalidations++
      this.save()
      return lane
    }
    lane.status = "idle"
    lane.uses++
    lane.lastUsedAt = this.now()
    lane.expiresAt = lane.lastUsedAt + this.ttlMs
    lane.lastRunId = opts.runId ?? lane.lastRunId
    if (opts.capsule !== undefined) lane.capsule = opts.capsule
    if (opts.capsuleVersion !== undefined) lane.capsuleVersion = opts.capsuleVersion
    lane.reason = undefined
    if (lane.uses >= lane.maxUses) {
      lane.status = "invalid"
      lane.reason = "max uses reached"
    }
    this.save()
    return lane
  }

  invalidate(sessionID: string, reason = "invalidated"): boolean {
    const lane = this.get(sessionID)
    if (!lane) return false
    lane.status = "invalid"
    lane.reason = reason
    this.stats.invalidations++
    this.save()
    return true
  }

  hitRate(): number {
    const total = this.stats.hits + this.stats.misses
    return total === 0 ? 0 : this.stats.hits / total
  }

  statsSummary(): LaneStats & {
    total: number
    idle: number
    busy: number
    invalid: number
    hitRate: number
    hitRatePct: number
  } {
    const total = this.lanes.length
    const idle = this.lanes.filter((l) => l.status === "idle").length
    const busy = this.lanes.filter((l) => l.status === "busy").length
    const invalid = this.lanes.filter((l) => l.status === "invalid").length
    return {
      ...this.stats,
      total,
      idle,
      busy,
      invalid,
      hitRate: round(this.hitRate(), 3),
      hitRatePct: round(this.hitRate() * 100),
    }
  }
}
