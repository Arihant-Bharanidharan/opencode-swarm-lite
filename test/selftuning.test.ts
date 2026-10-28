/**
 * Bounded self-tuning: shadow policy, promotion gates, rollback, and manual
 * override (Req 18-22, 50). These pin the policy store's evidence chain, not
 * wall-clock agent benchmarks.
 *
 * NOTE: fixture builders use block bodies (`=> { return { ... } }`) on
 * purpose: tsc 7.0.2 mis-parses an `=> ({ ... })` arrow whose next statement
 * starts with `{` (a bare section block). bun parses both forms fine.
 */
import {
  DEFAULT_TUNABLES,
  evaluatePromotionGate,
  PolicyStore,
  applyManualOverrideToInput,
  clampTunables,
  movementLimit,
  movementViolations,
  type ShadowRun,
} from "../src/runtime/policy.js"
import type { ManualOverride, TaskInput } from "../src/runtime/types.js"

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

const T0 = 1_758_000_000_000
const clock = () => T0

const mkRun = (
  i: number,
  shadowActualSeconds: number,
  shadowQuality = 0.9,
): ShadowRun => ({
  runId: `shadow-${i}`,
  ts: T0 + i * 1000,
  activePredictedSeconds: 100,
  activeActualSeconds: 120,
  shadowPredictedSeconds: 110,
  shadowActualSeconds,
  activeQuality: 0.9,
  shadowQuality,
})

/** 8 paired runs: shadow cuts MAE in half (20 vs 10), zero quality regression. */
const goodRuns: ShadowRun[] = Array.from({ length: 8 }, (_, i) => mkRun(i, 120))

// ---- Req 18: movement clamps ----
{
  check("movementLimit(2) = max(0.4, 0.05) = 0.4", movementLimit(2) === 0.4)
  check("movementLimit(6) = max(1.2, 0.05) = 1.2", Math.abs(movementLimit(6) - 1.2) < 1e-9)
  check("movementLimit(0.1) = max(0.02, 0.05) = 0.05", movementLimit(0.1) === 0.05)

  const violated = movementViolations(DEFAULT_TUNABLES, { ...DEFAULT_TUNABLES, maxFanout: 9 })
  check("maxFanout 6 -> 9 exceeds the 1.2 movement budget", violated.length === 1 && /maxFanout/.test(violated[0]!), JSON.stringify(violated))

  const clean = movementViolations(DEFAULT_TUNABLES, { ...DEFAULT_TUNABLES, maxFanout: 7 })
  check("maxFanout 6 -> 7 is within the budget", clean.length === 0)

  const clamped = clampTunables(DEFAULT_TUNABLES, { ...DEFAULT_TUNABLES, initialFanout: 50, maxFanout: 100 })
  check("initialFanout clamped 2 -> 2.4", clamped.params.initialFanout === 2.4, String(clamped.params.initialFanout))
  check("maxFanout clamped 6 -> 7.2", clamped.params.maxFanout === 7.2, String(clamped.params.maxFanout))
  check("clamp list is human-readable", clamped.clamped.length === 2 && /clamped 50 -> 2.4/.test(clamped.clamped[0]!), JSON.stringify(clamped.clamped))
}

// ---- Req 19/20/21: shadow -> gate -> promote -> rollback chain ----
{
  const store = new PolicyStore(null, { now: clock })

  check("store boots with base v1 active", store.active()!.version === 1 && store.active()!.status === "active")
  const baseResolve = store.resolve()
  check("no override fields are set by default", baseResolve.forced.topology === undefined && baseResolve.disabled.selfTuning === false)
  check("base source is defaults", baseResolve.source === "defaults")

  const shadow = store.submitShadow({ ...DEFAULT_TUNABLES, initialFanout: 4, maxFanout: 10 }, "candidate shrinks MAE")
  check("shadow version 2 is created", shadow.version === 2 && shadow.status === "shadow")
  check("submission clamped into the movement budget", shadow.parameters.initialFanout === 2.4 && shadow.parameters.maxFanout === 7.2)

  const events: string[] = []
  const eventStore = new PolicyStore(null, { now: clock, onEvent: (e) => events.push(e.type) })
  eventStore.submitShadow({ ...DEFAULT_TUNABLES, initialFanout: 3 }, "evented")
  check("SHADOW telemetry event is emitted", events.includes("SHADOW"))

  for (const run of goodRuns) store.recordShadowRun(run)

  const gate = store.gate()
  check("gate is eligible after 8 good runs", gate.eligible === true, JSON.stringify(gate.reasons))
  check("gate reports 8 runs", gate.nRuns === 8)
  check("improvement is measurable (50%)", gate.improvementPct === 50, String(gate.improvementPct))

  const proposals = store.propose()
  check("two parameter proposals are produced", proposals.length === 2)
  check("both proposals are accepted", proposals.every((p) => p.accepted === true), JSON.stringify(proposals))

  const promoted = store.promote()
  check("promotion succeeds", promoted.promoted === true, promoted.reason)
  check("v2 is now active", store.active()!.version === 2)
  check("resolve reports a learned source", store.resolve().source === "learned")
  const all = store.versions()
  check("v1 rolled back, not deleted", all.find((v) => v.version === 1)!.status === "rolled_back")
  check("promotion audit trail keeps both versions", all.length === 2)

  // A second, better candidate: v3.
  const betterRuns = goodRuns.map((r, i) => mkRun(i, 115, 0.95)) // shadow err 5 vs active err 20
  store.submitShadow({ ...DEFAULT_TUNABLES, initialFanout: 3, maxFanout: 8 }, "round two")
  for (const run of betterRuns) store.recordShadowRun(run)
  const promoted2 = store.promote()
  check("second promotion succeeds (v3 active)", promoted2.promoted === true && store.active()!.version === 3)
  check("v2 is rolled back by v3", store.versions().find((v) => v.version === 2)!.status === "rolled_back")

  // Req 21: rollback to the most recent previously-promoted version.
  const rb1 = store.rollback("incident drill")
  check("rollback v3 -> v2", rb1.rolledBack === true && store.active()!.version === 2, rb1.reason)
  const rb2 = store.rollback("second rollback")
  check("rollback v2 -> v1", rb2.rolledBack === true && store.active()!.version === 1, rb2.reason)
  check("v1 is never rolled out of existence", store.active()!.version === 1)
  const rb3 = store.rollback("cannot roll back the floor")
  check("rollback of v1 is refused", rb3.rolledBack === false && /base default/.test(rb3.reason), rb3.reason)
}

// ---- Req 20: bad shadow policies are rejected by the gate ----
{
  const store = new PolicyStore(null, { now: clock })

  // Low improvement: 2% MAE gain (shadow err 19.6 vs active err 20), below the 5% bar.
  const weakRuns = Array.from({ length: 8 }, (_, i) => ({
    ...mkRun(i, 120),
    shadowActualSeconds: 129.6,
  }))
  const weakGate = evaluatePromotionGate({ runs: weakRuns, active: DEFAULT_TUNABLES, candidate: DEFAULT_TUNABLES })
  check("2% improvement is rejected (below the 5% bar)", weakGate.eligible === false && /5%/.test(weakGate.reasons.join("; ")), JSON.stringify(weakGate.reasons))
  check("weak gate reports 8 runs", weakGate.nRuns === 8)

  // Quality regression on one of eight runs: zero regression required.
  const regressedRuns = [...goodRuns.slice(0, 7), mkRun(7, 120, 0.8)]
  const qualityGate = evaluatePromotionGate({ runs: regressedRuns, active: DEFAULT_TUNABLES, candidate: DEFAULT_TUNABLES })
  check("one quality regression rejects the gate", qualityGate.eligible === false && /lost quality/.test(qualityGate.reasons.join("; ")), JSON.stringify(qualityGate.reasons))

  store.submitShadow({ ...DEFAULT_TUNABLES, maxFanout: 7 }, "regressing candidate")
  for (const run of regressedRuns) store.recordShadowRun(run)
  const rejected = store.promote()
  check("promote refuses a bad shadow policy", rejected.promoted === false && rejected.gate.eligible === false, rejected.reason)
  check("active version is unchanged", store.active()!.version === 1)

  // Movement violation at the gate level.
  const moveGate = evaluatePromotionGate({
    runs: goodRuns,
    active: DEFAULT_TUNABLES,
    candidate: { ...DEFAULT_TUNABLES, initialFanout: 100 },
  })
  check("movement violation rejects the gate", moveGate.eligible === false && /movement/.test(moveGate.reasons.join("; ")), JSON.stringify(moveGate.reasons))
}

// ---- Req 22/50: manual override hard-wins over the learned policy ----
{
  const store = new PolicyStore(null, { now: clock })

  // Promote a learned version first so override supremacy is meaningful.
  store.submitShadow({ ...DEFAULT_TUNABLES, initialFanout: 3 }, "learned")
  for (const run of goodRuns) store.recordShadowRun(run)
  store.promote()
  check("learned v2 is active before the override", store.active()!.version === 2 && store.resolve().source === "learned")

  const override: ManualOverride = {
    forceTopology: "SERIAL",
    forceAgents: 1,
    forceProvider: "opencode",
    disableSelfTuning: true,
    reason: "incident drill",
  }
  store.setOverride(override)

  const resolution = store.resolve()
  check("override forces topology SERIAL", resolution.forced.topology === "SERIAL")
  check("override forces 1 agent", resolution.forced.agents === 1)
  check("override forces provider opencode", resolution.forced.provider === "opencode")
  check("override disables self-tuning", resolution.disabled.selfTuning === true)
  check("override reasons are explainable", resolution.reasons.some((r) => /forces topology SERIAL/.test(r)) && /override reason: incident drill/.test(resolution.reasons.join(" ")))

  // submitShadow throws under the override.
  let threw = false
  try {
    store.submitShadow({ ...DEFAULT_TUNABLES, initialFanout: 5 }, "rejected by override")
  } catch {
    threw = true
  }
  check("shadow submission is rejected under disableSelfTuning", threw)

  // promote is rejected under the override even though a shadow exists.
  store.setOverride(undefined) // clear so the shadow candidate can be recorded
  store.submitShadow({ ...DEFAULT_TUNABLES, maxFanout: 8 }, "blocked candidate")
  store.setOverride(override) // re-apply the manual override
  const blocked = store.promote()
  check("promotion is rejected under disableSelfTuning", blocked.promoted === false && /disabled by manual override/.test(blocked.reason), blocked.reason)
  check("active version stays learned v2", store.active()!.version === 2)

  // Clearing the override restores self-tuning.
  store.setOverride(undefined)
  check("override cleared", store.override() === undefined)
  store.submitShadow({ ...DEFAULT_TUNABLES, convergenceThreshold: 0.6 }, "after clearing")
  check("shadow submission works again", store.latestShadow()?.version === 4)

  // Req 22 hard-win applied to a TaskInput: forceAgents caps the swarm.
  const applied = applyManualOverrideToInput(
    { task: "run four branches", branches: 4, budget: { agents: 6 } as TaskInput["budget"] },
    { forceTopology: "FULL_SWARM", forceAgents: 1 },
  )
  const serial = applyManualOverrideToInput({ task: "x", branches: 4 }, { forceTopology: "SERIAL", forceAgents: 9 })
  check("SERIAL forces agent cap to 1", serial.input.budget!.agents === 1 && serial.applied.some((a) => /agent cap to 1/.test(a)))
  check("non-serial forced topology raises the cap just enough", applied.input.budget!.agents === 2, `agents=${applied.input.budget!.agents}`)
  check("forceAgents hard-wins over the input's 6", applied.input.budget!.agents !== 6 && /agents forced to 1/.test(applied.applied.join("; ")))
  const p = applyManualOverrideToInput({ task: "x", provider: "auto" }, { forceProvider: "opencode" })
  check("provider forced", p.input.provider === "opencode")
}

console.log(`\n[selftuning] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
