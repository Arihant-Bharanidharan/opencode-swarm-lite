/**
 * v3 trust + diversity tests: per-skill trust profiles with decay and
 * movement clamps (Req 5, 6), calibration buckets and evidence weighting
 * (Req 7, 8), versioned/safe persistence (Req 48, 49), diversity-aware
 * consensus with correlated-lane discounting (Req 9), and minority
 * preservation (Req 10).
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  TrustStore,
  bucketOf,
  calibrationReport,
  evidenceStrengthOf,
  evidenceWeightedTrust,
} from "../src/runtime/trust.js"
import { diversityConsensus, pairCorrelation } from "../src/runtime/consensus.js"
import type { CorrelatedFinding, TrustObservation } from "../src/runtime/types.js"

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++
    console.log(`[PASS] ${name}`)
  } else {
    fail++
    console.log(`[FAIL] ${name}${detail ? ` - ${detail}` : ""}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-trust-"))
process.on("exit", () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const NOW = 1_758_000_000_000
const DAY = 86_400_000

const mkObs = (over: Partial<TrustObservation> = {}): TrustObservation => {
  return {
    ts: NOW,
    model: "mimo",
    skillCategory: "coding",
    success: true,
    ...over,
  }
}

const mkFinding = (
  id: string,
  text: string,
  over: Partial<CorrelatedFinding> = {},
): CorrelatedFinding => {
  const base: CorrelatedFinding = { id, text, confidence: 0.8, evidence: [] }
  return { ...base, ...over }
}

/** Three paraphrase findings of one fact; models drive the correlation story. */
function trio(models: [string, string, string]): CorrelatedFinding[] {
  return [
    mkFinding("f1", "the cache layer returns stale rows after invalidation fails", {
      confidence: 0.9,
      evidence: ["test:unit-cache"],
      branch: "b1",
      correlation: { model: models[0] },
    }),
    mkFinding("f2", "cache returns stale rows when invalidation fails", {
      confidence: 0.8,
      evidence: ["test:cache-integration"],
      branch: "b2",
      correlation: { model: models[1] },
    }),
    mkFinding("f3", "stale rows are returned by the cache layer because invalidation fails", {
      confidence: 0.7,
      evidence: ["trace:logs"],
      branch: "b3",
      correlation: { model: models[2] },
    }),
  ]
}

// ---- Req 5/6: trust profiles, decay, movement ----
{
  const t = new TrustStore(null, { now: () => NOW })
  const one = t.record(mkObs())
  check(
    "profile starts at the prior and moves modestly after one success",
    one.n === 1 && one.successRate === 1 && one.effectiveScore === 0.57,
    JSON.stringify(one),
  )
  const two = t.record(mkObs())
  check("two successes reach 0.63, not 1.0", two.effectiveScore === 0.63, String(two.effectiveScore))
  const ten = new TrustStore(null, { now: () => NOW })
  for (let i = 0; i < 10; i++) ten.record(mkObs())
  check(
    "ten successes converge toward but never jump to 1.0",
    ten.snapshot("mimo", "coding").effectiveScore === 0.81,
    String(ten.snapshot("mimo", "coding").effectiveScore),
  )

  const tf = new TrustStore(null, { now: () => NOW })
  const afterFail = tf.record(mkObs({ success: false }))
  check("a single failure walks the prior down to 0.43", afterFail.effectiveScore === 0.43, String(afterFail.effectiveScore))

  const td = new TrustStore(null, { now: () => NOW })
  td.record(mkObs({ ts: NOW, success: true }))
  td.record(mkObs({ ts: NOW - 28 * DAY, success: false }))
  const decayed = td.snapshot("mimo", "coding")
  check(
    "28-day-old observation weighs 0.25 (14-day half-life)",
    decayed.nEffective === 1.25 && decayed.successRate === 0.8,
    JSON.stringify(decayed),
  )

  const tp = new TrustStore(null, { now: () => NOW })
  tp.record(mkObs({ ts: NOW - 91 * DAY, success: true }))
  const pruned = tp.snapshot("mimo", "coding")
  check(
    "observations older than the 90-day cutoff are pruned",
    pruned.n === 0 && pruned.successRate === 0 && pruned.effectiveScore === 0.5,
    JSON.stringify(pruned),
  )

  const ts = new TrustStore(null, { now: () => NOW })
  for (let i = 0; i < 3; i++) ts.record(mkObs({ skillCategory: "coding" }))
  const testing = ts.snapshot("mimo", "testing")
  check(
    "Req 5: skills are isolated profiles",
    testing.n === 0 && testing.effectiveScore === 0.5,
    JSON.stringify(testing),
  )
  const otherModel = ts.snapshot("other-model", "coding")
  check("Req 5: models are isolated profiles", otherModel.n === 0 && otherModel.effectiveScore === 0.5)

  const tmono = new TrustStore(null, { now: () => NOW })
  let monotone = true
  let prevEff = 0.5
  for (let i = 0; i < 10; i++) {
    const eff = tmono.record(mkObs()).effectiveScore
    if (eff < prevEff) monotone = false
    prevEff = eff
  }
  check("trust walks monotonically under consistent evidence", monotone)

  let clock = NOW
  const tclamp = new TrustStore(null, { now: () => clock })
  for (let i = 0; i < 10; i++) tclamp.record(mkObs({ ts: clock }))
  const before = tclamp.snapshot("mimo", "coding").effectiveScore
  clock += 80 * DAY
  tclamp.record(mkObs({ ts: clock, success: false }))
  const after = tclamp.snapshot("mimo", "coding").effectiveScore
  check(
    "Req 6: one catastrophic run moves the score at most 0.25",
    before === 0.81 && after === 0.56,
    `${before} -> ${after}`,
  )
}

// ---- Req 48/49: persistence, versioning, key whitelisting ----
{
  const file = path.join(tmp, "trust.json")
  const t = new TrustStore(file, { now: () => NOW })
  t.record(mkObs())
  t.record(mkObs())
  const reopened = new TrustStore(file, { now: () => NOW })
  check(
    "trust store persists observations and clamped scores",
    reopened.all().length === 2 && reopened.snapshot("mimo", "coding").effectiveScore === 0.63,
  )
  check(
    "persisted file declares schema version 3",
    JSON.parse(fs.readFileSync(file, "utf8")).version === 3,
  )

  const badFile = path.join(tmp, "trust-bad-version.json")
  fs.writeFileSync(
    badFile,
    JSON.stringify({ version: 99, observations: [mkObs()], effective: { "mimo|coding": 0.95 } }),
  )
  const fresh = new TrustStore(badFile, { now: () => NOW })
  check(
    "unknown schema version resets to fresh, never crashes (Req 49)",
    fresh.all().length === 0 && fresh.snapshot("mimo", "coding").effectiveScore === 0.5,
  )

  const leakFile = path.join(tmp, "trust-leak.json")
  const tl = new TrustStore(leakFile, { now: () => NOW })
  tl.record({ ...mkObs(), task: "rotate the key sk-secret-123" } as unknown as TrustObservation)
  const stored = fs.readFileSync(leakFile, "utf8")
  check(
    "Req 48: record() whitelists keys; task text and secrets cannot persist",
    !stored.includes("sk-secret-123") && !stored.includes("rotate the key"),
    stored.slice(0, 200),
  )
  const tpv = new TrustStore(path.join(tmp, "trust-prov.json"), { now: () => NOW })
  tpv.record(mkObs({ provider: "opencode" }))
  check("provider metadata survives the whitelist copy", tpv.all()[0]!.provider === "opencode")

  const tc = new TrustStore(file, { now: () => NOW })
  tc.clear()
  check("clear() empties the store", tc.all().length === 0)
}

// ---- Req 7: calibration buckets ----
{
  const rows: TrustObservation[] = []
  for (let i = 0; i < 4; i++) rows.push(mkObs({ model: "m", reportedConfidence: 0.9, success: true }))
  for (let i = 0; i < 4; i++) rows.push(mkObs({ model: "m", reportedConfidence: 0.9, success: false }))
  const rep = calibrationReport(rows, "m")
  const b9 = rep.buckets.find((b) => b.lo === 0.9)
  check(
    "bucket [0.9,1.0] aggregates 8 claims at 50% accuracy",
    !!b9 && b9.n === 8 && b9.meanReported === 0.9 && b9.observedAccuracy === 0.5 && b9.calibrationError === 0.4,
    JSON.stringify(b9),
  )
  check("MAE over non-empty buckets", rep.mae === 0.4, String(rep.mae))
  check(
    "negative bias = workers over-report confidence",
    rep.bias === -0.4,
    String(rep.bias),
  )
  check("all five 0.1-wide buckets are always listed", rep.buckets.length === 5 && rep.buckets[0]!.lo === 0.5 && rep.buckets[4]!.hi === 1)

  const bounds = calibrationReport(
    [
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
      mkObs({ model: "m", reportedConfidence: 0.5, success: true }),
      mkObs({ model: "m", reportedConfidence: 1, success: true }),
    ],
    "m",
  )
  check(
    "bucket boundaries: 0.6 -> [0.6,0.7), 0.5 -> [0.5,0.6), 1.0 -> [0.9,1.0]",
    bounds.buckets.find((b) => b.lo === 0.6)!.n === 1 &&
      bounds.buckets.find((b) => b.lo === 0.5)!.n === 1 &&
      bounds.buckets.find((b) => b.lo === 0.9)!.n === 1,
    JSON.stringify(bounds.buckets.map((b) => [b.lo, b.n])),
  )
  check(
    "sub-0.5 reports are excluded from calibration",
    calibrationReport([mkObs({ model: "m", reportedConfidence: 0.4, success: true })], "m").mae === 0,
  )
  const multi = calibrationReport(
    [
      mkObs({ model: "m", reportedConfidence: 0.9, success: false }),
      mkObs({ model: "m", reportedConfidence: 0.9, success: false }),
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
    ],
    "m",
  )
  check("MAE averages across non-empty buckets", multi.mae === 0.65, String(multi.mae))
  check(
    "positive bias = workers under-report confidence",
    calibrationReport([
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
      mkObs({ model: "m", reportedConfidence: 0.6, success: true }),
    ]).bias === 0.4,
  )
  const bOf = calibrationReport(rows, "m").buckets
  check(
    "bucketOf finds the containing bucket or null",
    bucketOf(0.65, bOf)?.lo === 0.6 && bucketOf(0.9, bOf)?.lo === 0.9 && bucketOf(0.42, bOf) === null,
  )
}

// ---- Req 7/8: evidence weighting and the calibration blend ----
{
  check(
    "evidence strength ladder (Req 8)",
    evidenceStrengthOf(["deterministic_test"]) === 1 &&
      evidenceStrengthOf(["command_output"]) === 0.85 &&
      evidenceStrengthOf(["file_line"]) === 0.7 &&
      evidenceStrengthOf(["derived"]) === 0.4 &&
      evidenceStrengthOf(["none"]) === 0.05 &&
      evidenceStrengthOf([]) === 0.05,
  )
  check(
    "the strongest cited evidence kind dominates",
    evidenceStrengthOf(["none", "deterministic_test", "derived"]) === 1,
  )

  const noHist = evidenceWeightedTrust({
    reportedConfidence: 0.9,
    evidenceKinds: ["deterministic_test"],
    model: "mimo",
  })
  check(
    "no history: reported value stands (0.9 x 1.0)",
    noHist.calibratedConfidence === 0.9 && noHist.reasons.some((r) => r.includes("no comparable history")),
    JSON.stringify(noHist),
  )
  check(
    "ladder discounts confidence without evidence",
    evidenceWeightedTrust({ reportedConfidence: 0.9, evidenceKinds: ["command_output"], model: "mimo" }).calibratedConfidence === 0.765 &&
      evidenceWeightedTrust({ reportedConfidence: 0.9, evidenceKinds: ["file_line"], model: "mimo" }).calibratedConfidence === 0.63 &&
      evidenceWeightedTrust({ reportedConfidence: 0.9, evidenceKinds: ["derived"], model: "mimo" }).calibratedConfidence === 0.36 &&
      evidenceWeightedTrust({ reportedConfidence: 0.9, evidenceKinds: ["none"], model: "mimo" }).calibratedConfidence === 0.045,
  )

  const rows: TrustObservation[] = []
  for (let i = 0; i < 4; i++) rows.push(mkObs({ model: "m", reportedConfidence: 0.9, success: true }))
  for (let i = 0; i < 4; i++) rows.push(mkObs({ model: "m", reportedConfidence: 0.9, success: false }))
  const calibrated = evidenceWeightedTrust(
    { reportedConfidence: 0.9, evidenceKinds: ["deterministic_test"], model: "m" },
    { observations: rows },
  )
  check(
    "Req 7: (observed*n_b + reported*4)/(n_b+4) blends 0.9 down to 0.633",
    calibrated.calibratedConfidence === 0.633,
    JSON.stringify(calibrated),
  )
  check(
    "the blend then multiplies by evidence strength",
    evidenceWeightedTrust(
      { reportedConfidence: 0.9, evidenceKinds: ["none"], model: "m" },
      { observations: rows },
    ).calibratedConfidence === 0.032,
  )
  check(
    "historical reliability is surfaced for consumers",
    calibrated.historicalReliability === 0.5 && noHist.historicalReliability === 0.5,
  )
  check(
    "claims below the bucket range keep their raw value",
    evidenceWeightedTrust({
      reportedConfidence: 0.4,
      evidenceKinds: ["deterministic_test"],
      model: "m",
    }).calibratedConfidence === 0.4,
  )
  check(
    "a historically under-reporting model gets UP-weighted",
    evidenceWeightedTrust(
      { reportedConfidence: 0.6, evidenceKinds: ["deterministic_test"], model: "u" },
      {
        observations: [
          mkObs({ model: "u", reportedConfidence: 0.6, success: true }),
          mkObs({ model: "u", reportedConfidence: 0.6, success: true }),
          mkObs({ model: "u", reportedConfidence: 0.6, success: true }),
          mkObs({ model: "u", reportedConfidence: 0.6, success: true }),
        ],
      },
    ).calibratedConfidence === 0.8,
  )
  check(
    "every weighting decision carries its reasons",
    calibrated.reasons.length >= 2 &&
      calibrated.reasons.some((r) => r.startsWith("calibration:")) &&
      calibrated.reasons.some((r) => r.startsWith("evidence:")),
    JSON.stringify(calibrated.reasons),
  )

  const tstore = new TrustStore(null, { now: () => NOW })
  for (const r of rows) tstore.record(r)
  check(
    "TrustStore.evidence mirrors the pure function",
    tstore.evidence({ reportedConfidence: 0.9, evidenceKinds: ["deterministic_test"], model: "m" })
      .calibratedConfidence === 0.633,
  )
}

// ---- Req 9: correlated lanes are not independent confirmations ----
{
  const corr = diversityConsensus(trio(["mimo", "mimo", "mimo"]))
  const c1 = corr.clusters[0]!
  check(
    "three same-model paraphrases cluster together",
    c1.members.length === 3 && c1.representative === "f1",
    JSON.stringify(c1.members),
  )
  check(
    "correlated lanes count 2.4, not 3 (Req 9)",
    c1.independentCount === 2.4 && c1.consensusScore === 0.8 && c1.consensus === "strong",
    JSON.stringify(c1),
  )
  check(
    "every correlated pair is named with its signals",
    c1.correlatedPairs.length === 3 &&
      c1.correlatedPairs.every((p) => p[2].length === 1 && p[2][0] === "same_model"),
    JSON.stringify(c1.correlatedPairs),
  )

  const ind = diversityConsensus(trio(["m1", "m2", "m3"]))
  const i1 = ind.clusters[0]!
  check(
    "independent lanes count fully: 3.0, no discounts",
    i1.independentCount === 3 && i1.consensusScore === 1 && i1.consensus === "strong" && i1.correlatedPairs.length === 0,
    JSON.stringify(i1),
  )
  check(
    "correlated consensus scores strictly below independent consensus",
    c1.consensusScore < i1.consensusScore,
  )

  const rate = (corrA: object, corrB: object, evA: string[], evB: string[]): number => {
    const a = mkFinding("r1", "the rate limit rejects the fifth burst request", {
      confidence: 0.85,
      evidence: evA,
      branch: "b1",
      correlation: corrA,
    })
    const b = mkFinding("r2", "the rate limiter rejects the fifth request in a burst", {
      confidence: 0.75,
      evidence: evB,
      branch: "b2",
      correlation: corrB,
    })
    const r = diversityConsensus([a, b])
    return r.clusters[0]!.independentCount
  }
  check(
    "copied evidence discounts hardest (0.7)",
    rate({ model: "m1" }, { model: "m2" }, ["test:rate"], ["test:rate"]) === 1.3,
  )
  check(
    "shared context capsule discounts 0.4",
    rate({ model: "m1", capsule: "caps-7" }, { model: "m2", capsule: "caps-7" }, ["test:ra"], ["test:rb"]) === 1.6,
  )
  check(
    "same upstream parent discounts 0.5",
    rate({ model: "m1", parent: "lane-root" }, { model: "m2", parent: "lane-root" }, ["test:ra"], ["test:rb"]) === 1.5,
  )
  check(
    "same initial hypothesis discounts 0.4",
    rate({ model: "m1", hypothesis: "too-many-requests" }, { model: "m2", hypothesis: "too-many-requests" }, ["test:ra"], ["test:rb"]) === 1.6,
  )
  check(
    "same source files discount 0.3",
    rate({ model: "m1", sourceFiles: ["src/rate.ts"] }, { model: "m2", sourceFiles: ["src/rate.ts"] }, ["test:ra"], ["test:rb"]) === 1.7,
  )

  const allSignals = diversityConsensus([
    mkFinding("r1", "the rate limit rejects the fifth burst request", {
      confidence: 0.85,
      evidence: ["test:rate"],
      branch: "b1",
      correlation: {
        model: "m1",
        capsule: "caps-7",
        parent: "lane-root",
        hypothesis: "too-many-requests",
        sourceFiles: ["src/rate.ts"],
      },
    }),
    mkFinding("r2", "the rate limiter rejects the fifth request in a burst", {
      confidence: 0.75,
      evidence: ["test:rate"],
      branch: "b2",
      correlation: {
        model: "m1",
        capsule: "caps-7",
        parent: "lane-root",
        hypothesis: "too-many-requests",
        sourceFiles: ["src/rate.ts"],
      },
    }),
  ])
  const ac = allSignals.clusters[0]!
  check(
    "fully correlated lanes floor at 1.05 (never zero)",
    ac.independentCount === 1.05 && ac.consensus === "weak",
    JSON.stringify(ac),
  )
  check(
    "all six signals are named, sorted",
    JSON.stringify(ac.correlatedPairs[0]![2]) ===
      JSON.stringify([
        "copied_evidence",
        "same_initial_hypothesis",
        "same_model",
        "same_source_files",
        "same_upstream_parent",
        "shared_context_capsule",
      ]),
    JSON.stringify(ac.correlatedPairs[0]![2]),
  )
  check(
    "explicit same-model flag fires without matching raw models",
    pairCorrelation(
      mkFinding("a", "x", { correlation: { sameModel: true } }),
      mkFinding("b", "y", {}),
    ).signals.includes("same_model"),
  )
  const solo = diversityConsensus([
    mkFinding("solo", "the auth token is checked twice per request", { confidence: 0.7, evidence: ["test:auth"] }),
  ])
  check(
    "a single unconfirmed finding is weak with no minority",
    solo.clusters[0]!.independentCount === 1 &&
      solo.clusters[0]!.consensus === "weak" &&
      solo.minority.length === 0,
  )
}

// ---- Req 10: minority preservation ----
{
  const scene: CorrelatedFinding[] = [
    ...trio(["mimo", "mimo", "mimo"]),
    mkFinding("contra", "the cache layer is correct; the defect is in the session dedupe logic", {
      confidence: 0.75,
      evidence: ["trace:session"],
      branch: "b4",
    }),
    mkFinding("docs", "the api endpoint signature changed in the docs", {
      confidence: 0.6,
      evidence: ["doc:api"],
      branch: "b5",
    }),
  ]
  const res = diversityConsensus(scene)
  check("scene splits into three clusters", res.clusters.length === 3, JSON.stringify(res.clusters.map((c) => c.members)))
  const contra = res.minority.find((m) => m.findingId === "contra")
  check(
    "topically-overlapping dissent is a high_value_contradiction",
    contra?.verdict === "high_value_contradiction" && contra?.preserved === true,
    JSON.stringify(contra),
  )
  const docs = res.minority.find((m) => m.findingId === "docs")
  check(
    "topically-unrelated dissent is marked redundant_dissent",
    docs?.verdict === "redundant_dissent" && docs?.preserved === true,
    JSON.stringify(docs),
  )
  const covered = new Set<string>()
  for (const c of res.clusters) for (const id of c.members) covered.add(id)
  for (const m of res.minority) covered.add(m.findingId)
  check(
    "Req 10: nothing is dropped - every finding is clustered or preserved",
    scene.every((f) => covered.has(f.id)),
    JSON.stringify([...covered]),
  )
  check("every minority verdict carries a reason", res.minority.every((m) => m.reason.length > 0))
  const why = res.reasons.join(" ")
  check(
    "summary reasons cite the discount and the preservation counts",
    why.includes("2.4 independent") && why.includes("1 high-value contradiction") && why.includes("1 redundant dissent"),
    why,
  )
  check(
    "consensus is deterministic",
    JSON.stringify(diversityConsensus(scene)) === JSON.stringify(res),
  )
}

console.log(`\n[trust] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
