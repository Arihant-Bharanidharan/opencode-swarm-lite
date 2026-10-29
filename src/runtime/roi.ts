/**
 * Branch return-on-investment scoring and dynamic priority.
 * Req 3: ROI-driven cancels are hysteresis-gated — a single low score NEVER
 *   cancels a branch. A cancel requires consecutive low scores AND real
 *   remaining time AND off-critical-path AND low novelty, so late dips and
 *   unique-evidence branches survive.
 * Req 4: every priority move (PRIORITY_UP / PRIORITY_DOWN / CANCEL / KEEP)
 *   carries a machine-readable reason string.
 *
 * ROI units: value points per 100 cost-seconds, so thresholds are readable
 * (~1.0 = excellent, <0.5 = a dip, <0.15 = cancel-eligible once hysteresis
 * clears).
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { BranchRoi, BranchRoiInput, PriorityAction } from "./types.js"
import { round } from "./util.js"

const VALUE_INFO = 0.35
const VALUE_COMPLETION = 0.35
const VALUE_VERIFICATION = 0.3
const CRITICAL_PATH_BOOST = 1.25
/** value multiplier floor at zero novelty (fully redundant branch). */
const NOVELTY_FLOOR = 0.5
/** seconds-equivalent charged per expected request. */
const REQUEST_COST_SECONDS = 0.5

/** Score one branch observation. Pure: same input, same ROI. */
export function scoreBranchRoi(input: BranchRoiInput): BranchRoi {
  let value =
    VALUE_INFO * input.expectedInformationGain +
    VALUE_COMPLETION * input.expectedCompletionValue +
    VALUE_VERIFICATION * input.expectedVerificationValue
  value *= NOVELTY_FLOOR + (1 - NOVELTY_FLOOR) * input.branchNovelty
  if (input.onCriticalPath) value *= CRITICAL_PATH_BOOST
  const costSeconds =
    Math.max(1, input.expectedRemainingTime) * (1 + 0.5 * input.providerRisk) +
    input.expectedRequests * REQUEST_COST_SECONDS
  const roi = round((value / Math.max(1, costSeconds)) * 100, 4)
  return {
    ...input,
    roi,
    reason: `value=${round(value, 2)} cost≈${round(costSeconds, 1)}s roi=${roi}/100s`,
  }
}

export interface RoiTrackerOptions {
  /** Below this a branch is cancel-eligible (once hysteresis clears). */
  killThreshold?: number
  /** Below this counts as a "low dip" for hysteresis. */
  softThreshold?: number
  /** Consecutive low scores required before a cancel is allowed. */
  minConsecutiveLows?: number
  /** Never cancel a branch that is about to finish anyway. */
  minRemainingSeconds?: number
  /** Novel branches are never auto-cancelled. */
  noveltyProtect?: number
  /** Rolling window of scores kept per branch. */
  window?: number
}

interface BranchState {
  last: BranchRoi
  history: number[]
  consecutiveLow: number
  initialRemaining: number
}

/**
 * Rolling per-branch ROI tracker. `decide()` returns one action per tracked
 * branch, sorted by branch id for determinism.
 */
export class BranchRoiTracker {
  private readonly branches = new Map<string, BranchState>()
  private readonly opts: Required<RoiTrackerOptions>

  constructor(opts: RoiTrackerOptions = {}) {
    this.opts = {
      killThreshold: 0.15,
      softThreshold: 0.5,
      minConsecutiveLows: 3,
      minRemainingSeconds: 30,
      noveltyProtect: 0.5,
      window: 6,
      ...opts,
    }
  }

  update(roi: BranchRoi): void {
    const st = this.branches.get(roi.branchId)
    if (!st) {
      this.branches.set(roi.branchId, {
        last: roi,
        history: [roi.roi],
        consecutiveLow: roi.roi < this.opts.softThreshold ? 1 : 0,
        initialRemaining: roi.expectedRemainingTime,
      })
      return
    }
    st.last = roi
    st.history.push(roi.roi)
    if (st.history.length > this.opts.window) st.history.shift()
    st.consecutiveLow = roi.roi < this.opts.softThreshold ? st.consecutiveLow + 1 : 0
  }

  get(branchId: string): BranchRoi | undefined {
    return this.branches.get(branchId)?.last
  }

  dips(branchId: string): number {
    return this.branches.get(branchId)?.consecutiveLow ?? 0
  }

  /**
   * Hysteresis decision pass. CANCEL requires ALL of: roi below kill
   * threshold, `minConsecutiveLows` consecutive dips, remaining time worth
   * saving, off critical path, and low novelty. A single dip can never cancel.
   */
  decide(): PriorityAction[] {
    const actions: PriorityAction[] = []
    for (const [id, st] of this.branches) {
      const r = st.last
      const cancelable =
        r.roi < this.opts.killThreshold &&
        st.consecutiveLow >= this.opts.minConsecutiveLows &&
        r.expectedRemainingTime >= this.opts.minRemainingSeconds &&
        !r.onCriticalPath &&
        r.branchNovelty < this.opts.noveltyProtect
      if (cancelable) {
        actions.push({
          branchId: id,
          action: "CANCEL",
          reason: `roi ${r.roi} < ${this.opts.killThreshold} for ${st.consecutiveLow} consecutive scores with ${r.expectedRemainingTime}s remaining; off critical path; novelty ${r.branchNovelty} < ${this.opts.noveltyProtect}`,
        })
        continue
      }
      if (r.onCriticalPath) {
        actions.push({ branchId: id, action: "PRIORITY_UP", reason: "branch is on the critical path" })
        continue
      }
      if (r.branchNovelty >= 0.8) {
        actions.push({
          branchId: id,
          action: "PRIORITY_UP",
          reason: `unique evidence no other branch covers (novelty ${r.branchNovelty})`,
        })
        continue
      }
      if (st.consecutiveLow >= 2 && r.roi < this.opts.softThreshold) {
        actions.push({
          branchId: id,
          action: "PRIORITY_DOWN",
          reason: `roi below ${this.opts.softThreshold} for ${st.consecutiveLow} consecutive scores`,
        })
        continue
      }
      if (r.expectedRemainingTime <= 0.25 * st.initialRemaining && r.branchConfidence >= 0.6) {
        actions.push({
          branchId: id,
          action: "PRIORITY_UP",
          reason: "nearly done with solid confidence; finishing is cheap",
        })
        continue
      }
      actions.push({ branchId: id, action: "KEEP", reason: `roi ${r.roi} within hysteresis band` })
    }
    return actions.sort((a, b) => a.branchId.localeCompare(b.branchId))
  }
}
