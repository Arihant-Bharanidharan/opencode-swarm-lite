/**
 * Convergence and semantic dedup. This is deliberately transparent: a small
 * concept normalizer plus token overlap, not an embedding. Consensus requires
 * independent evidence; paraphrases alone are not consensus, and genuine
 * dissent is kept rather than averaged away.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { ConvergenceResult, Finding, FindingCluster } from "./types.js"
import { clamp, round, tokenize } from "./util.js"

const CONCEPTS: Record<string, string[]> = {
  geometry: [
    "geometry",
    "geometric",
    "vf",
    "capsulebox",
    "capsule-box",
    "physx",
    "wgsl",
    "mesh",
    "hull",
    "collision",
    "containment",
    "contains",
    "face",
    "plane",
    "poly",
    "shader",
  ],
  wrong: [
    "wrong",
    "incorrect",
    "inaccurate",
    "bug",
    "bugs",
    "defect",
    "defective",
    "error",
    "broken",
    "fails",
    "failing",
    "failure",
    "differs",
    "difference",
    "deviates",
    "mismatch",
    "not",
  ],
  check: [
    "test",
    "tests",
    "predicate",
    "check",
    "assert",
    "assertion",
    "logic",
    "rule",
    "condition",
    "verify",
    "validation",
    "comparison",
    "expectation",
  ],
  fix: ["fix", "repair", "correct", "patch", "update", "change", "resolve"],
  performance: ["slow", "latency", "performance", "fast", "speed", "optimi", "throughput", "bottleneck"],
  cache: ["cache", "caching", "memo", "memoize", "invalidat", "stale"],
  api: ["api", "endpoint", "interface", "signature", "export", "contract"],
  data: ["data", "dataset", "csv", "row", "rows", "column", "schema", "dedupe", "session"],
  auth: ["auth", "permission", "token", "login", "credential", "access"],
  rate: ["rate", "limit", "throttle", "429", "quota", "burst"],
}

const CONCEPT_OF = new Map<string, string>()
for (const [concept, words] of Object.entries(CONCEPTS)) {
  for (const w of words) CONCEPT_OF.set(w, concept)
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "it",
  "this",
  "that",
  "with",
  "as",
  "at",
  "by",
  "from",
  "has",
  "have",
  "had",
  "we",
  "you",
  "they",
  "i",
  "should",
  "would",
  "can",
  "could",
  "there",
  "their",
  "than",
  "then",
  "so",
  "if",
  "when",
])

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1)
  return w
}

export interface NormalizedFinding {
  tokens: Set<string>
  concepts: Set<string>
}

export function normalizeFinding(text: string): NormalizedFinding {
  const tokens = new Set<string>()
  const concepts = new Set<string>()
  for (const raw of tokenize(text)) {
    const concept = CONCEPT_OF.get(raw)
    if (concept) concepts.add(concept)
    if (STOP.has(raw)) continue
    const s = stem(raw)
    if (s.length > 1) tokens.add(s)
  }
  return { tokens, concepts }
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n
}

export function findingSimilarity(a: string, b: string): { score: number; sharedConcepts: number } {
  const x = normalizeFinding(a)
  const y = normalizeFinding(b)
  const inter = overlap(x.tokens, y.tokens)
  const uni = new Set([...x.tokens, ...y.tokens]).size
  const min = Math.min(x.tokens.size, y.tokens.size)
  const jaccard = uni ? inter / uni : 0
  const containment = min ? inter / min : 0
  const sharedConcepts = overlap(x.concepts, y.concepts)
  const conceptScore = Math.min(3, sharedConcepts) / 3
  const score = Math.max(jaccard, 0.55 * containment) + 0.15 * conceptScore
  return { score, sharedConcepts }
}

const conf = (f: Finding): number => clamp(f.confidence ?? 0.5, 0, 1)
const evidenceOf = (f: Finding): string[] =>
  [...(f.evidence ?? []), ...(f.source ? [`source:${f.source}`] : []), ...(f.branch ? [`branch:${f.branch}`] : [])]

function uniqueByText(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const f of findings) {
    const k = f.text.trim().toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

export function clusterFindings(
  findings: Finding[],
  opts: { threshold?: number; minSharedConcepts?: number; stopThreshold?: number } = {},
): ConvergenceResult {
  const threshold = opts.threshold ?? 0.42
  const minSharedConcepts = opts.minSharedConcepts ?? 2
  const stopThreshold = opts.stopThreshold ?? 0.65
  const uniq = uniqueByText(findings)
  // Strongest / best-evidenced findings become representatives first.
  const sorted = [...uniq].sort(
    (a, b) => conf(b) + evidenceOf(b).length * 0.02 - (conf(a) + evidenceOf(a).length * 0.02),
  )
  const consumed = new Set<string>()
  const clusters: FindingCluster[] = []
  let ci = 0
  for (const rep of sorted) {
    if (consumed.has(rep.id)) continue
    consumed.add(rep.id)
    const members: Finding[] = [rep]
    for (const other of sorted) {
      if (consumed.has(other.id)) continue
      const sim = findingSimilarity(rep.text, other.text)
      const related = sim.sharedConcepts >= minSharedConcepts || sim.score >= 0.5
      if (related && sim.score >= threshold) {
        members.push(other)
        consumed.add(other.id)
      }
    }
    const evidenceSet = new Set<string>()
    for (const m of members) for (const e of evidenceOf(m)) evidenceSet.add(e)
    const sources = new Set(members.map((m) => m.source ?? m.branch ?? m.id))
    const redundantIds = members
      .filter((m) => m.id !== rep.id)
      .filter((m) => {
        const own = new Set(evidenceOf(m).filter((e) => !e.startsWith("source:") && !e.startsWith("branch:")))
        const repEv = new Set(evidenceOf(rep).filter((e) => !e.startsWith("source:") && !e.startsWith("branch:")))
        const uniqueEvidence = [...own].some((e) => !repEv.has(e))
        return !uniqueEvidence && findingSimilarity(m.text, rep.text).score >= 0.6
      })
      .map((m) => m.id)
    const consensus = members.length > 1 && evidenceSet.size >= 1 && sources.size > 1
    clusters.push({
      id: `c${++ci}`,
      representative: rep,
      members,
      evidence: evidenceSet.size,
      confidence: round(Math.max(...members.map(conf)) + Math.min(0.08, 0.02 * (members.length - 1)), 2),
      consensus,
      dissent: false,
      redundantIds,
    })
  }

  clusters.sort((a, b) => b.members.length - a.members.length || b.confidence - a.confidence)
  const top = clusters[0]
  const strongDissent = clusters.filter(
    (c) => c !== top && c.confidence >= 0.7 && c.evidence >= 1 && c.representative.id !== top?.representative.id,
  )
  for (const c of strongDissent) c.dissent = true

  const redundant = clusters.flatMap((c) => (c.consensus ? c.redundantIds : []))
  const keep = clusters.flatMap((c) => {
    const ids = c.redundantIds.filter((id) => !redundant.includes(id))
    return [
      c.representative.id,
      ...c.members.filter((m) => m.id !== c.representative.id && !redundant.includes(m.id)).map((m) => m.id),
      ...ids,
    ]
  })
  const covered = top ? top.members.length / Math.max(1, uniq.length) : 0
  const topStrong = !!top && top.consensus && top.confidence >= 0.6
  const shouldStop =
    topStrong &&
    (strongDissent.length === 0 || top.confidence >= Math.max(...strongDissent.map((c) => c.confidence)) + 0.1) &&
    covered >= 0.6

  const reason = !top
    ? "no findings"
    : shouldStop
      ? `${top.members.length}/${uniq.length} findings converge on ${top.representative.id}; ${redundant.length} redundant; no stronger dissent`
      : strongDissent.length
        ? `keep exploring: ${strongDissent.length} strong dissent cluster(s) with independent evidence`
        : top.consensus
          ? `partial convergence (${Math.round(covered * 100)}% coverage); not enough independent evidence to stop`
          : `no independent consensus yet (${top.members.length} paraphrase(s), ${top.evidence} evidence source(s))`

  return {
    clusters,
    keep: [...new Set(keep)],
    redundant: [...new Set(redundant)],
    dissent: strongDissent.flatMap((c) => c.members.map((m) => m.id)),
    shouldStop,
    reason,
    confidence: top ? round(top.confidence, 2) : 0,
  }
}
