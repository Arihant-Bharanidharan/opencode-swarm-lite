/**
 * Diversity-aware consensus (Req 9, 10). Layered on cluster.ts: the base
 * clusters group paraphrases; this module asks whether the confirming lanes
 * were actually INDEPENDENT.
 * Req 9: correlated lanes (same model, shared context capsule, same source
 *   files, same upstream parent, same initial hypothesis, copied evidence)
 *   do not count as independent confirmations. 3 fully-correlated lanes
 *   reporting the same thing are worth ~1.05 confirmations, not 3: each
 *   member is discounted by its strongest correlation to any counted member,
 *   with a floor so a lane never counts as literally zero.
 * Req 10: minority preservation. Every finding outside the dominant
 *   conclusion gets an explicit verdict — high_value_contradiction (topically
 *   overlapping the dominant claim but not merged: a genuine dissent worth
 *   human review) or redundant_dissent (no topical overlap: kept visible, but
 *   it adds no evidence to THIS debate). Nothing is ever silently dropped.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import { clusterFindings, findingSimilarity } from "./cluster.js"
import type {
  CorrelatedFinding,
  DiversityCluster,
  DiversityConsensusResult,
  MinorityVerdict,
} from "./types.js"
import { clamp, round } from "./util.js"

interface Signal {
  weight: number
  label: string
}

const SIGNALS: Record<string, Signal> = {
  copiedEvidence: { weight: 0.7, label: "copied_evidence" },
  sameUpstreamParent: { weight: 0.5, label: "same_upstream_parent" },
  sharedContextCapsule: { weight: 0.4, label: "shared_context_capsule" },
  sameInitialHypothesis: { weight: 0.4, label: "same_initial_hypothesis" },
  sameModel: { weight: 0.3, label: "same_model" },
  sameSourceFiles: { weight: 0.3, label: "same_source_files" },
}

/** A correlated confirmation still adds a floor of information, never zero. */
const MIN_MEMBER_WEIGHT = 0.05
const STRONG_INDEPENDENT = 2
const MODERATE_INDEPENDENT = 1.2

export interface PairCorrelation {
  /** 0..1; how much of an independent confirmation the second lane is NOT. */
  score: number
  signals: string[]
}

function evidenceOverlap(a: CorrelatedFinding, b: CorrelatedFinding): boolean {
  const ea = a.evidence ?? []
  const eb = b.evidence ?? []
  return ea.length > 0 && eb.length > 0 && ea.some((e) => eb.includes(e))
}

function fileOverlap(a?: string[], b?: string[]): boolean {
  if (!a?.length || !b?.length) return false
  return a.some((f) => b.includes(f))
}

/**
 * Correlation between two findings. Explicit boolean signals on either side
 * are honored (self-declared); otherwise the correlation is inferred from the
 * raw metadata both sides provide. Signal weights sum, clamped to [0,1].
 */
export function pairCorrelation(a: CorrelatedFinding, b: CorrelatedFinding): PairCorrelation {
  const sig: Signal[] = []
  const ca = a.correlation
  const cb = b.correlation
  const declared = (v: boolean | undefined): boolean => v === true
  if (declared(ca?.copiedEvidence) || declared(cb?.copiedEvidence) || evidenceOverlap(a, b)) {
    sig.push(SIGNALS.copiedEvidence)
  }
  if (
    declared(ca?.sharedContextCapsule) ||
    declared(cb?.sharedContextCapsule) ||
    (!!ca?.capsule && !!cb?.capsule && ca.capsule === cb.capsule)
  ) {
    sig.push(SIGNALS.sharedContextCapsule)
  }
  if (declared(ca?.sameModel) || declared(cb?.sameModel) || (!!ca?.model && !!cb?.model && ca.model === cb.model)) {
    sig.push(SIGNALS.sameModel)
  }
  if (
    declared(ca?.sameUpstreamParent) ||
    declared(cb?.sameUpstreamParent) ||
    (!!ca?.parent && !!cb?.parent && ca.parent === cb.parent)
  ) {
    sig.push(SIGNALS.sameUpstreamParent)
  }
  if (
    declared(ca?.sameInitialHypothesis) ||
    declared(cb?.sameInitialHypothesis) ||
    (!!ca?.hypothesis && !!cb?.hypothesis && ca.hypothesis === cb.hypothesis)
  ) {
    sig.push(SIGNALS.sameInitialHypothesis)
  }
  if (declared(ca?.sameSourceFiles) || declared(cb?.sameSourceFiles) || fileOverlap(ca?.sourceFiles, cb?.sourceFiles)) {
    sig.push(SIGNALS.sameSourceFiles)
  }
  const score = clamp(sig.reduce((s, x) => s + x.weight, 0), 0, 1)
  return { score, signals: sig.map((x) => x.label).sort() }
}

function independentConfirmations(
  members: readonly CorrelatedFinding[],
): { count: number; pairs: Array<[string, string, string[]]> } {
  const pairs: Array<[string, string, string[]]> = []
  const counted: CorrelatedFinding[] = []
  let count = 0
  for (const m of members) {
    let w = 1
    if (counted.length > 0) {
      let best = 0
      for (const c of counted) {
        const pc = pairCorrelation(m, c)
        if (pc.score > 0) pairs.push([c.id, m.id, pc.signals])
        if (pc.score > best) best = pc.score
      }
      w = clamp(1 - best, MIN_MEMBER_WEIGHT, 1)
    }
    counted.push(m)
    count += w
  }
  return { count: round(count, 2), pairs }
}

function consensusLabel(independent: number): DiversityCluster["consensus"] {
  if (independent >= STRONG_INDEPENDENT) return "strong"
  if (independent >= MODERATE_INDEPENDENT) return "moderate"
  return "weak"
}

/**
 * Diversity-aware consensus over correlated findings. Deterministic: the same
 * input array always yields the same clusters, discounts, and verdicts.
 */
export function diversityConsensus(
  findings: CorrelatedFinding[],
  opts: { threshold?: number; minSharedConcepts?: number } = {},
): DiversityConsensusResult {
  const base = clusterFindings(findings, opts)
  const byId = new Map(findings.map((f) => [f.id, f]))

  const clusters: DiversityCluster[] = base.clusters.map((c) => {
    const members = c.members.map((m) => byId.get(m.id) ?? (m as CorrelatedFinding))
    const { count, pairs } = independentConfirmations(members)
    return {
      id: c.id,
      representative: c.representative.id,
      members: c.members.map((m) => m.id),
      independentCount: count,
      consensusScore: round(clamp(count / 3, 0, 1), 2),
      correlatedPairs: pairs,
      consensus: consensusLabel(count),
    }
  })

  const minority: MinorityVerdict[] = []
  const dominantBase = base.clusters[0]
  if (dominantBase) {
    const domRep = dominantBase.representative
    for (const c of base.clusters.slice(1)) {
      for (const f of c.members) {
        const sim = findingSimilarity(f.text, domRep.text)
        if (sim.sharedConcepts >= 1 && sim.score >= 0.15) {
          minority.push({
            findingId: f.id,
            verdict: "high_value_contradiction",
            reason: `topically overlaps the dominant conclusion (${sim.sharedConcepts} shared concept(s), similarity ${round(sim.score, 2)}) but did not merge; a genuine dissent worth human review`,
            preserved: true,
          })
        } else {
          minority.push({
            findingId: f.id,
            verdict: "redundant_dissent",
            reason: `no topical overlap with the dominant conclusion (${sim.sharedConcepts} shared concept(s), similarity ${round(sim.score, 2)}); kept visible, but it adds no independent evidence to this debate`,
            preserved: true,
          })
        }
      }
    }
  }

  const reasons: string[] = []
  if (clusters.length === 0) {
    reasons.push("no findings to converge on")
  } else {
    const dom = clusters[0]!
    reasons.push(
      `${findings.length} finding(s) converged into ${clusters.length} cluster(s)`,
    )
    reasons.push(
      `strongest cluster ${dom.id} (${dom.representative}) counts ${dom.independentCount} independent confirmation(s) from ${dom.members.length} member(s)${dom.correlatedPairs.length > 0 ? `; ${dom.correlatedPairs.length} correlated pair(s) discounted` : ""}`,
    )
    const hv = minority.filter((m) => m.verdict === "high_value_contradiction").length
    const rd = minority.length - hv
    reasons.push(
      `minority preserved: ${hv} high-value contradiction(s), ${rd} redundant dissent(s); nothing dropped`,
    )
  }

  return { clusters, minority, reasons }
}
