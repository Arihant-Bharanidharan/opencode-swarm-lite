/**
 * Token-bucket rate limiter for subagent dispatches.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

export interface RateLimitOptions {
  enabled: boolean
  ratePerSecond: number
  burst: number
}

/** Token bucket for subagent dispatches. */
export class DispatchRateLimiter {
  private tokens: number
  private lastRefill: number
  constructor(private cfg: RateLimitOptions) {
    this.tokens = cfg.burst
    this.lastRefill = Date.now()
  }
  /** Consume one dispatch token, or throw with a retry hint. */
  consume(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.cfg.burst, this.tokens + elapsed * this.cfg.ratePerSecond)
    this.lastRefill = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const retryMs = Math.ceil(((1 - this.tokens) / this.cfg.ratePerSecond) * 1000)
    throw new Error(
      `swarm-lite rate limit: subagent dispatch budget exhausted (burst ${this.cfg.burst}, ${this.cfg.ratePerSecond}/s). Retry in ~${retryMs}ms or batch lanes into fewer dispatches.`,
    )
  }
}
