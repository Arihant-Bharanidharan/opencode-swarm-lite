/**
 * Integration planning for finished branches (Req 15-17).
 *
 * Req 15: when branches report what they changed, the runtime plans the
 *   integration instead of merging blindly: providers of symbols integrate
 *   before consumers, conflict-free branches integrate first, and every
 *   branch appears in the order - nothing merges silently.
 * Req 16: every overlapping branch pair is classified BEFORE the merge:
 *   TEXTUAL  - both branches changed the same symbol in the same source
 *              file; a text merge cannot pick between the edits.
 *   SEMANTIC - the overlap is invisible to a text merge: the same symbol
 *              defined/changed in two different files (duplicate
 *              definition), or a branch changing a symbol another branch
 *              consumes (breaking change).
 *   SAFE     - overlap exists but needs no judgment: a shared file with
 *              disjoint symbols, or a shared test file only.
 * Req 17: conflicts carry resolution guidance: only SAFE overlaps are
 *   auto-resolvable; TEXTUAL and SEMANTIC conflicts require review, and
 *   every reason names the exact shared files and symbols so a reviewer
 *   starts from evidence, not from a guess. Dependency cycles are
 *   reported and contained, never silently ordered.
 *
 * Pure and deterministic: the same changes always produce the same plan
 * (branch ids are sorted before any pairwise work, conflicts are emitted
 * in sorted pair order, and tie-breaks are lexicographic).
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { BranchChange, IntegrationConflict, IntegrationPlan } from "./types.js"

/** Sorted intersection of two string lists (duplicates removed). */
const shared = (a: readonly string[], b: readonly string[]): string[] => {
  const setB = new Set(b)
  return [...new Set(a)].filter((x) => setB.has(x)).sort()
}

const listOf = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(", ") : "none")

/**
 * Classify one branch pair (Req 16). Returns null when the branches do
 * not overlap at all. The branches tuple is sorted so the conflict reads
 * the same no matter which branch reported first.
 */
function classifyPair(a: BranchChange, b: BranchChange): IntegrationConflict | null {
  // File overlap counts shared test files too: a reviewer must see them.
  const filesA = [...a.filesChanged, ...(a.testFiles ?? [])]
  const filesB = [...b.filesChanged, ...(b.testFiles ?? [])]
  const sharedFiles = shared(filesA, filesB)
  const sharedSrcFiles = shared(a.filesChanged, b.filesChanged)
  const sharedSymbols = shared(a.symbolsChanged, b.symbolsChanged)
  // "I change what you consume" is a semantic break even with disjoint files.
  const aBreaks = shared(a.symbolsChanged, b.dependsOnSymbols ?? [])
  const bBreaks = shared(b.symbolsChanged, a.dependsOnSymbols ?? [])
  if (!sharedFiles.length && !sharedSymbols.length && !aBreaks.length && !bBreaks.length) return null

  const pair: [string, string] =
    a.branchId < b.branchId ? [a.branchId, b.branchId] : [b.branchId, a.branchId]

  if (sharedSymbols.length > 0 && sharedSrcFiles.length > 0) {
    return {
      kind: "TEXTUAL",
      branches: pair,
      files: sharedFiles,
      symbols: sharedSymbols,
      autoResolvable: false,
      requiresReview: true,
      reason: `both branches change ${listOf(sharedSymbols)} in ${listOf(sharedSrcFiles)}; a text merge cannot decide between the two edits`,
    }
  }
  if (aBreaks.length > 0 || bBreaks.length > 0) {
    const broken = [...new Set([...aBreaks, ...bBreaks])].sort()
    return {
      kind: "SEMANTIC",
      branches: pair,
      files: sharedFiles,
      symbols: broken,
      autoResolvable: false,
      requiresReview: true,
      reason:
        aBreaks.length > 0 && bBreaks.length > 0
          ? `mutual breakage: ${pair[0]} and ${pair[1]} each change symbols the other consumes (${listOf(broken)}); the conflict is invisible to a text merge`
          : aBreaks.length > 0
            ? `${b.branchId} consumes ${listOf(aBreaks)} which ${a.branchId} changes; the breakage is invisible to a text merge`
            : `${a.branchId} consumes ${listOf(bBreaks)} which ${b.branchId} changes; the breakage is invisible to a text merge`,
    }
  }
  if (sharedSymbols.length > 0) {
    return {
      kind: "SEMANTIC",
      branches: pair,
      files: sharedFiles,
      symbols: sharedSymbols,
      autoResolvable: false,
      requiresReview: true,
      reason: `both branches define or change ${listOf(sharedSymbols)} in different source files; two definitions cannot both survive the merge`,
    }
  }
  return {
    kind: "SAFE",
    branches: pair,
    files: sharedFiles,
    symbols: [],
    autoResolvable: true,
    requiresReview: false,
    reason: `branches share ${listOf(sharedFiles)} but change disjoint symbols; a text merge resolves this without judgment`,
  }
}

/**
 * Plan the integration of finished branches (Req 15-17).
 *
 * The order is a Kahn topological sort over symbol dependencies (a branch
 * that defines a symbol another branch consumes integrates first). Among
 * branches that are ready at the same time, conflict-free ones go first
 * (safe wins lock in quickly), then the lexicographic id. A dependency
 * cycle cannot be topologically ordered: its members are appended in id
 * order and the cycle is named in the reasons - never hidden.
 */
export function planIntegration(changes: readonly BranchChange[]): IntegrationPlan {
  // Deduplicate branch ids deterministically: first declaration wins.
  const byId = new Map<string, BranchChange>()
  for (const c of changes) if (!byId.has(c.branchId)) byId.set(c.branchId, c)
  const ids = [...byId.keys()].sort()

  // Classify every overlapping pair (Req 16).
  const conflicts: IntegrationConflict[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const c = classifyPair(byId.get(ids[i]!)!, byId.get(ids[j]!)!)
      if (c) conflicts.push(c)
    }
  }

  // Symbol dependencies become ordering edges: providers before consumers.
  const succ = new Map<string, string[]>(ids.map((id) => [id, [] as string[]]))
  const pred = new Map<string, string[]>(ids.map((id) => [id, [] as string[]]))
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue
      const provider = byId.get(ids[i]!)!
      const consumer = byId.get(ids[j]!)!
      if (shared(provider.symbolsChanged, consumer.dependsOnSymbols ?? []).length > 0) {
        succ.get(ids[i]!)!.push(ids[j]!)
        pred.get(ids[j]!)!.push(ids[i]!)
      }
    }
  }

  const conflicted = new Set(conflicts.flatMap((c) => [...c.branches]))
  const hasEdges = (id: string): boolean =>
    (succ.get(id)?.length ?? 0) + (pred.get(id)?.length ?? 0) > 0
  const independentBranches = ids.filter((id) => !conflicted.has(id) && !hasEdges(id))
  const independentSet = new Set(independentBranches)

  // Kahn topological order with a deterministic priority: conflict-free
  // branches first, then lexicographic id.
  const rank = (id: string): [number, string] => [independentSet.has(id) ? 0 : 1, id]
  const cmp = (x: string, y: string): number => {
    const [tx, ix] = rank(x)
    const [ty, iy] = rank(y)
    return tx - ty || (ix < iy ? -1 : ix > iy ? 1 : 0)
  }
  const indeg = new Map(ids.map((id) => [id, pred.get(id)!.length]))
  const ready = ids.filter((id) => indeg.get(id) === 0)
  const order: string[] = []
  while (ready.length > 0) {
    let best = 0
    for (let k = 1; k < ready.length; k++) if (cmp(ready[k]!, ready[best]!) < 0) best = k
    const id = ready.splice(best, 1)[0]!
    order.push(id)
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) ready.push(s)
    }
  }
  const cycle = ids.filter((id) => (indeg.get(id) ?? 0) > 0).sort()
  order.push(...cycle)

  const reasons: string[] = []
  if (ids.length === 0) {
    reasons.push("no branch changes to integrate")
  } else {
    reasons.push(
      `integration order: providers before consumers` +
        (independentBranches.length > 0
          ? `, conflict-free branches first (${listOf(independentBranches)})`
          : ""),
    )
    if (conflicts.length > 0) {
      const textual = conflicts.filter((c) => c.kind === "TEXTUAL").length
      const semantic = conflicts.filter((c) => c.kind === "SEMANTIC").length
      const safe = conflicts.filter((c) => c.kind === "SAFE").length
      const review = conflicts.filter((c) => c.requiresReview).length
      reasons.push(
        `${conflicts.length} overlap(s): ${textual} TEXTUAL, ${semantic} SEMANTIC, ${safe} SAFE; ${review} require review before merge`,
      )
    } else {
      reasons.push("no overlaps detected: every branch can merge independently")
    }
    if (cycle.length > 0) {
      reasons.push(
        `dependency cycle between ${listOf(cycle)}: their relative order is by id and every member needs review`,
      )
    }
  }

  return {
    order,
    independentBranches,
    conflicts,
    semanticConflicts: conflicts.filter((c) => c.kind === "SEMANTIC").length,
    reasons,
  }
}
