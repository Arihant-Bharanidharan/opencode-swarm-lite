/**
 * Classic token-bucket rate limiter.
 *
 * Contract:
 *   - `capacity` tokens max, refilled at `refillPerSec` tokens per second
 *     continuously based on elapsed wall-clock time.
 *   - `tryConsume(amount, nowMs)` returns true and deducts `amount` iff
 *     `amount` tokens are available; otherwise returns false and deducts
 *     nothing.
 *   - `available(nowMs)` returns the token count as of `nowMs`.
 *   - Refill is monotonic in time: a `nowMs` EARLIER than the last observed
 *     timestamp must add NO tokens and must never REMOVE tokens (out-of-order
 *     clock reads are ignored, i.e. clamped to zero elapsed).
 *   - Token count never exceeds `capacity`.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    if (refillPerSec < 0) throw new Error("refillPerSec must be >= 0");
    this.tokens = capacity;
    this.lastRefillMs = 0;
  }

  private refill(nowMs: number): void {
    if (nowMs < this.lastRefillMs) return; // out-of-order read: ignore
    const elapsedMs = nowMs - this.lastRefillMs;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs / 1000) * this.refillPerSec,
    );
    this.lastRefillMs = nowMs;
  }

  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  tryConsume(amount: number, nowMs: number): boolean {
    if (nowMs < this.lastRefillMs) return false; // out-of-order read: ignore
    this.refill(nowMs);
    if (this.tokens + 1e-9 >= amount && amount >= 0) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }
}
