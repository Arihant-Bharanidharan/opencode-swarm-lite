/**
 * Deterministic DAG scheduling: critical path, slack, waves, lane assignment.
 * Used for pipeline planning and straggler prioritization.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { DagNode, ScheduleNodeResult, ScheduleResult } from "./types.js"
import { clamp, round } from "./util.js"

export interface ScheduleOptions {
  concurrency?: number
}

export function scheduleDag(nodes: DagNode[], edges: Array<[string, string]>, opts: ScheduleOptions = {}): ScheduleResult {
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const dur = new Map(nodes.map((n) => [n.id, Math.max(0, n.seconds)]))
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]))
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]))
  const seen = new Set<string>()
  for (const [a, b] of edges) {
    if (!idSet.has(a) || !idSet.has(b) || a === b) continue
    const k = `${a}->${b}`
    if (seen.has(k)) continue
    seen.add(k)
    succ.get(a)!.push(b)
    pred.get(b)!.push(a)
  }
  if (nodes.length === 0) {
    return {
      order: [],
      waves: [],
      criticalPath: [],
      makespan: 0,
      serialTime: 0,
      concurrency: 0,
      utilization: 0,
      nodes: [],
    }
  }
  const serialTime = sum(ids.map((id) => dur.get(id)!))
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? nodes.length, nodes.length))

  // Kahn topological order (cycle detection).
  const indeg = new Map(ids.map((id) => [id, pred.get(id)!.length]))
  const queue = ids.filter((id) => indeg.get(id) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) queue.push(s)
    }
  }
  if (order.length !== nodes.length) {
    const cycle = ids.filter((id) => (indeg.get(id) ?? 0) > 0)
    return {
      order,
      waves: [],
      criticalPath: [],
      makespan: serialTime,
      serialTime,
      concurrency,
      utilization: 0,
      nodes: nodes.map((n) => ({
        id: n.id,
        earliestStart: 0,
        earliestFinish: n.seconds,
        latestStart: 0,
        latestFinish: n.seconds,
        slack: 0,
        critical: cycle.includes(n.id),
      })),
      cycle,
    }
  }

  // Longest downstream path drives priority (stragglers first).
  const longestFrom = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const children = succ.get(id)!
    longestFrom.set(id, dur.get(id)! + (children.length ? Math.max(...children.map((c) => longestFrom.get(c) ?? 0)) : 0))
  }
  const longestTo = new Map<string, number>()
  for (const id of order) {
    const parents = pred.get(id)!
    longestTo.set(id, dur.get(id)! + (parents.length ? Math.max(...parents.map((p) => longestTo.get(p) ?? 0)) : 0))
  }
  const criticalLength = Math.max(...ids.map((id) => longestTo.get(id) ?? 0))

  // Event-driven list scheduling onto individual "lanes".
  const laneFree = Array<number>(concurrency).fill(0)
  const laneOf = new Map<string, number>()
  const start = new Map<string, number>()
  const finish = new Map<string, number>()
  const running = new Map<string, number>() // id -> finish time
  const done = new Set<string>()
  const readyAt = new Map<string, number>() // earliest predecessor finish
  for (const id of ids) readyAt.set(id, 0)
  let time = 0
  let guard = 0
  while (done.size < nodes.length && guard++ < nodes.length * 8 + 64) {
    // Complete everything finishing at/before now.
    for (const [id, f] of [...running]) {
      if (f <= time + 1e-9) {
        running.delete(id)
        done.add(id)
        for (const s of succ.get(id)!) readyAt.set(s, Math.max(readyAt.get(s) ?? 0, f))
      }
    }
    const ready = ids.filter(
      (id) =>
        !done.has(id) &&
        !running.has(id) &&
        !start.has(id) &&
        pred.get(id)!.every((p) => done.has(p)) &&
        (readyAt.get(id) ?? 0) <= time + 1e-9,
    )
    ready.sort((a, b) => (longestFrom.get(b) ?? 0) - (longestFrom.get(a) ?? 0) || dur.get(b)! - dur.get(a)!)
    for (const id of ready) {
      const lane = laneFree.findIndex((f) => f <= time + 1e-9)
      if (lane < 0) break
      const s = Math.max(time, laneFree[lane]!)
      const f = s + dur.get(id)!
      start.set(id, s)
      finish.set(id, f)
      laneOf.set(id, lane)
      laneFree[lane] = f
      running.set(id, f)
    }
    if (running.size === 0) {
      // No runnable node and no running work: cycle would have been caught above.
      const unscheduled = ids.filter((id) => !done.has(id) && !start.has(id))
      if (!unscheduled.length) break
      time += 1
      continue
    }
    const next = Math.min(...running.values())
    if (next <= time + 1e-9 && running.size > 0) {
      // Defensive: force progress if a zero-duration node is stuck.
      time += 0.001
    } else {
      time = next
    }
  }

  const makespan = Math.max(0, ...ids.map((id) => finish.get(id) ?? 0))
  const latest = new Map<string, { ls: number; lf: number }>()
  for (const id of [...order].reverse()) {
    const children = succ.get(id)!
    const lf = children.length ? Math.min(...children.map((c) => latest.get(c)!.ls)) : makespan
    latest.set(id, { lf, ls: lf - dur.get(id)! })
  }
  const resultNodes: ScheduleNodeResult[] = ids.map((id) => {
    const es = start.get(id) ?? 0
    const ef = finish.get(id) ?? dur.get(id)!
    const ls = latest.get(id)?.ls ?? es
    const lf = latest.get(id)?.lf ?? ef
    return {
      id,
      earliestStart: round(es, 2),
      earliestFinish: round(ef, 2),
      latestStart: round(ls, 2),
      latestFinish: round(lf, 2),
      slack: round(Math.max(0, ls - es), 2),
      critical: Math.abs(ls - es) < 1e-6,
      lane: laneOf.get(id),
    }
  })

  // Critical path: longest chain by duration (not capacity-induced slack).
  const cp: string[] = []
  let cursor = [...ids].sort((a, b) => (longestTo.get(b) ?? 0) - (longestTo.get(a) ?? 0))[0]
  if (cursor) {
    cp.push(cursor)
    const target = longestTo.get(cursor) ?? 0
    let acc = target
    while (acc - (dur.get(cursor) ?? 0) > 0.001) {
      const parents = pred.get(cursor)!
      const want = acc - (dur.get(cursor) ?? 0)
      const parent = parents.find((p) => Math.abs((longestTo.get(p) ?? 0) - want) < 0.001)
      if (!parent) break
      cp.push(parent)
      cursor = parent
      acc = want
    }
    cp.reverse()
  }

  const waves: string[][] = []
  const byStart = new Map<number, string[]>()
  for (const n of resultNodes) {
    const key = round(n.earliestStart, 2)
    const arr = byStart.get(key) ?? []
    arr.push(n.id)
    byStart.set(key, arr)
  }
  for (const key of [...byStart.keys()].sort((a, b) => a - b)) waves.push(byStart.get(key)!.sort())

  const usedLanes = Math.max(1, ...resultNodes.map((n) => (n.lane ?? 0) + 1))
  return {
    order,
    waves,
    criticalPath: cp,
    makespan: round(makespan, 1),
    serialTime: round(serialTime, 1),
    concurrency,
    utilization: round(clamp(serialTime / Math.max(1e-6, makespan * usedLanes), 0, 1), 2),
    nodes: resultNodes,
  }
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}
