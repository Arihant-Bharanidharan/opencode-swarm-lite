/**
 * In-flight forecasts: failure-class risk, information gain, critical
 * path, and opportunity cost (Req 34-37).
 *
 * Req 34: forecastFailureRisk estimates the chance the next run hits each
 *   failure class from decay-weighted history (recent evidence dominates;
 *   a 14-day half-life, the same recency discipline as trust). With no
 *   evidence every class gets the uniform prior - never a guess of zero.
 *   Unclassified failures still count in the denominator: they dilute
 *   every class honestly instead of disappearing.
 * Req 35: chooseInformationGain picks the experiment with the best
 *   separation-per-second, not the most powerful one, and refuses to run
 *   experiments that cannot change any decision (MIN_DISCRIMINATION
 *   floor) or distinguish any hypothesis.
 * Req 36: criticalPathReport is the capacity-free longest-path analysis
 *   that complements scheduleDag (which schedules under a lane cap):
 *   per-branch slack, downstream blocked work, and the critical chain.
 *   Cycles are contained, never hung on: members are marked critical and
 *   the estimated time falls back to full serialization.
 * Req 37: opportunityCost names the fastest foregone alternative and
 *   prices the gap. The chosen path never competes with itself.
 *
 * All constants below are runtime policy (Req 52): they are NOT derived
 * from any benchmark run. Everything is pure and deterministic.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type {
  CriticalPathNode,
  CriticalPathReport,
  FailureClass,
  FailureClassRisk,
  InformationGainChoice,
  InformationGainOption,
  ObservationStatus,
  OpportunityCost,
} from "./types.js"
import { clamp, round } from "./util.js"

/** The eight failure classes the runtime distinguishes (Req 34). */
export const FAILURE_CLASSES: readonly FailureClass[] = [
  "logic_failure",
  "tool_failure",
  "merge_conflict",
  "context_failure",
  "provider_timeout",
  "rate_limit",
  "test_flake",
  "dependency_issue",
]

/** Runtime policy constants (NOT benchmark-derived, Req 52). */
export const FORECAST_HALF_LIFE_DAYS = 14
export const FAILURE_PRIOR = 1
export const MIN_DISCRIMINATION = 0.1

/** One observed past run, as evidence for the failure forecast. */
export interface FailureObservation {
  status: ObservationStatus
  /** Class assigned to the failure; required for a failed run to count
   * toward a class (unclassified failures only dilute). */
  failureClass?: FailureClass
  /** Age in days; older evidence weighs less (14-day half-life). */
  ageDays?: number
}

/**
 * Per-class failure risk for the next run (Req 34). A Laplace-smoothed,
 * decay-weighted rate: risk[c] = (w_failedWithC + 1) / (w_all + 8). With
 * no evidence this is exactly 1/8 per class; successes and old failures
 * dilute; a fresh failure concentrates risk on its class.
 */
export function forecastFailureRisk(observations: readonly FailureObservation[]): FailureClassRisk {
  let wAll = 0
  const wByClass = new Map<FailureClass, number>()
  for (const o of observations) {
    const w = 0.5 ** (clamp(o.ageDays ?? 0, 0, 36_500) / FORECAST_HALF_LIFE_DAYS)
    wAll += w
    if (o.status !== "ok" && o.failureClass) {
      wByClass.set(o.failureClass, (wByClass.get(o.failureClass) ?? 0) + w)
    }
  }
  const risk = {} as FailureClassRisk
  for (const c of FAILURE_CLASSES) {
    risk[c] = round(
      ((wByClass.get(c) ?? 0) + FAILURE_PRIOR) / (wAll + FAILURE_PRIOR * FAILURE_CLASSES.length),
      3,
    )
  }
  return risk
}

/**
 * Choose the next experiment by expected information gain per second
 * (Req 35). An experiment is only worth running when it can separate at
 * least one live hypothesis, costs real seconds (a zero-cost probe is a
 * re-read, not an experiment), fits the remaining budget, and clears the
 * MIN_DISCRIMINATION floor - weak experiments cannot change decisions.
 * Ties break by lower cost, then by id. When nothing qualifies the
 * choice is an honest null with the reason why.
 */
export function chooseInformationGain(
  options: readonly InformationGainOption[],
  budgetSeconds: number,
): InformationGainChoice {
  // Non-finite or negative budgets buy nothing; the runtime never books
  // infinite work on a hunch.
  const budget = Number.isFinite(budgetSeconds) ? Math.max(0, budgetSeconds) : 0
  const usable = options
    .map((o) => ({ ...o, power: clamp(o.discriminationPower, 0, 1), cost: Math.max(0, o.costSeconds) }))
    .filter(
      (o) =>
        o.power >= MIN_DISCRIMINATION &&
        o.cost > 0 &&
        o.cost <= budget &&
        o.distinguishes.length > 0,
    )
  if (usable.length === 0) {
    return {
      chosen: null,
      expectedReduction: 0,
      reason:
        options.length === 0
          ? "no candidate experiments were offered"
          : budget <= 0
            ? "no experiment is affordable within the remaining budget"
            : `no offered experiment clears the bar: each is over budget, under MIN_DISCRIMINATION (${MIN_DISCRIMINATION}), or distinguishes no hypotheses`,
    }
  }
  const density = (o: { power: number; cost: number }): number => o.power / o.cost
  const ranked = [...usable].sort(
    (x, y) =>
      density(y) - density(x) ||
      x.cost - y.cost ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  )
  const best = ranked[0]!
  const runner = ranked[1]
  return {
    chosen: best.id,
    expectedReduction: round(best.power, 3),
    reason:
      `${best.id} separates ${best.distinguishes.length} hypothesis id(s) for ${best.cost}s ` +
      `(${round(density(best), 4)} separation per second)` +
      (runner
        ? `; runner-up ${runner.id} at ${round(density(runner), 4)}/s`
        : "; no runner-up"),
  }
}

export interface CriticalPathInput {
  id: string
  /** Work this branch still owes, in seconds. */
  remainingTime: number
}

/**
 * Capacity-free critical path over in-flight branches (Req 36): the
 * longest remaining-work chain, per-node slack (how long a branch can
 * slip without extending the run) and downstreamBlockedWork (how many
 * seconds of work are waiting behind a branch). Complements
 * scheduleDag, which schedules the same DAG under a lane cap.
 *
 * Deterministic: ids are sorted before any traversal, edges to unknown
 * ids and self-loops are ignored, and the critical chain breaks ties by
 * picking the smallest predecessor id.
 */
export function criticalPathReport(
  nodes: readonly CriticalPathInput[],
  edges: ReadonlyArray<[string, string]>,
): CriticalPathReport {
  if (nodes.length === 0) {
    return { criticalPath: [], estimatedCriticalPathTime: 0, nodes: [] }
  }
  // First declaration wins for duplicate ids; durations are never negative.
  const dur = new Map<string, number>()
  for (const n of nodes) if (!dur.has(n.id)) dur.set(n.id, Math.max(0, n.remainingTime))
  const ids = [...dur.keys()].sort()

  const succ = new Map<string, string[]>(ids.map((id) => [id, [] as string[]]))
  const pred = new Map<string, string[]>(ids.map((id) => [id, [] as string[]]))
  const seen = new Set<string>()
  for (const [a, b] of edges) {
    if (!dur.has(a) || !dur.has(b) || a === b) continue
    const k = `${a}->${b}`
    if (seen.has(k)) continue
    seen.add(k)
    succ.get(a)!.push(b)
    pred.get(b)!.push(a)
  }

  // Downstream work blocked behind a node: every transitive successor's
  // remaining time, each counted once. The visited set guarantees
  // termination even inside a cycle.
  const blockedWork = (start: string): number => {
    const visited = new Set<string>([start])
    const stack = [...succ.get(start)!]
    let total = 0
    while (stack.length > 0) {
      const id = stack.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      total += dur.get(id)!
      for (const s of succ.get(id)!) if (!visited.has(s)) stack.push(s)
    }
    return total
  }

  // Kahn topological order; leftovers are the cycle members.
  const indeg = new Map(ids.map((id) => [id, pred.get(id)!.length]))
  const queue = ids.filter((id) => indeg.get(id) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) queue.push(s)
    }
  }
  const cycle = ids.filter((id) => (indeg.get(id) ?? 0) > 0).sort()

  if (cycle.length > 0) {
    // A cycle cannot be timed honestly: every promise downstream of it is
    // void. Cycle members are the pathology, so they are the critical
    // path; the estimate falls back to full serialization (the sum of all
    // remaining work) and no node is promised any slack.
    return {
      criticalPath: cycle,
      estimatedCriticalPathTime: round(
        ids.reduce((acc, id) => acc + (dur.get(id) ?? 0), 0),
        2,
      ),
      nodes: ids.map((id): CriticalPathNode => {
        const inCycle = cycle.includes(id)
        return {
          id,
          remainingTime: dur.get(id)!,
          downstreamBlockedWork: round(blockedWork(id), 2),
          slack: 0,
          critical: inCycle,
        }
      }),
    }
  }

  // Forward pass: longest chain ending at each node.
  const longestTo = new Map<string, number>()
  for (const id of order) {
    const ps = pred.get(id)!
    longestTo.set(
      id,
      dur.get(id)! + (ps.length > 0 ? Math.max(...ps.map((p) => longestTo.get(p) ?? 0)) : 0),
    )
  }
  const criticalLength = Math.max(...ids.map((id) => longestTo.get(id) ?? 0))

  // Backward pass: latest finish without extending the run.
  const latestFinish = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const ss = succ.get(id)!
    latestFinish.set(
      id,
      ss.length > 0
        ? Math.min(...ss.map((s) => (latestFinish.get(s) ?? 0) - dur.get(s)!))
        : criticalLength,
    )
  }

  const nodesOut: CriticalPathNode[] = ids.map((id): CriticalPathNode => {
    const ef = longestTo.get(id) ?? 0
    const lf = latestFinish.get(id) ?? ef
    return {
      id,
      remainingTime: dur.get(id)!,
      downstreamBlockedWork: round(blockedWork(id), 2),
      slack: round(Math.max(0, lf - ef), 2),
      critical: Math.abs(lf - ef) < 1e-9,
    }
  })

  // Walk the critical chain backwards from the node with the longest
  // ending chain; among equally long predecessors take the smallest id.
  let cursor = [...ids].sort(
    (a, b) => (longestTo.get(b) ?? 0) - (longestTo.get(a) ?? 0) || (a < b ? -1 : 1),
  )[0]!
  const path = [cursor]
  let acc = longestTo.get(cursor) ?? 0
  while (acc - (dur.get(cursor) ?? 0) > 1e-9) {
    const want = acc - (dur.get(cursor) ?? 0)
    const parent = [...pred.get(cursor)!].sort().find((p) => Math.abs((longestTo.get(p) ?? 0) - want) < 1e-9)
    if (!parent) break
    path.push(parent)
    acc = want
    cursor = parent
  }
  path.reverse()

  return {
    criticalPath: path,
    estimatedCriticalPathTime: round(criticalLength, 2),
    nodes: nodesOut,
  }
}

/**
 * Opportunity cost of the chosen path (Req 37): how many seconds the
 * fastest foregone alternative would have saved. Zero when the choice
 * was already the fastest (or nothing was foregone) - never negative,
 * never self-referential.
 */
export function opportunityCost(
  chosen: { id: string; seconds: number },
  alternatives: ReadonlyArray<{ id: string; seconds: number }>,
): OpportunityCost {
  const mine = Math.max(0, chosen.seconds)
  // The chosen path never competes with itself.
  const best = alternatives
    .filter((a) => a.id !== chosen.id && Number.isFinite(a.seconds))
    .map((a) => ({ id: a.id, seconds: Math.max(0, a.seconds) }))
    .sort((x, y) => x.seconds - y.seconds || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0]
  if (!best || best.seconds >= mine) {
    return {
      seconds: 0,
      reason: best
        ? `the chosen path (${round(mine, 1)}s) is at least as fast as every foregone alternative; nothing faster was given up`
        : "no alternatives were foregone",
    }
  }
  return {
    seconds: round(mine - best.seconds, 1),
    reason:
      `choosing ${chosen.id} (${round(mine, 1)}s) forwent ${best.id} ` +
      `(${round(best.seconds, 1)}s): ${round(mine - best.seconds, 1)}s of faster completion was given up`,
  }
}
