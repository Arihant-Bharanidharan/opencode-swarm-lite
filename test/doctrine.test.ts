/**
 * v1.3.0 tests: lane doctrine, relay comms, refine loop, adaptive lane rubric,
 * specialist roles, and skillContent rendering for both modes.
 */
import {
  DOCTRINE,
  LANE_RUBRIC,
  laneHint,
  relaySection,
  refineSection,
  skillContent,
} from "../src/index.js"

let pass = 0
let fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`[PASS] ${name}`) } else { fail++; console.log(`[FAIL] ${name}`) } // prettier-ignore
}

// ---- 1. Doctrine: all 7 rules present and substantive ----
const doctrineRules = [
  ["evidence over assertion", /1\. \*\*Evidence over assertion\./],
  ["scope fence", /2\. \*\*Scope fence\./],
  ["read before write", /3\. \*\*Read before write\./],
  ["one truth per fact", /4\. \*\*One truth per fact\./],
  ["fail loudly early", /5\. \*\*Fail loudly, early\./],
  ["deterministic finish", /6\. \*\*Deterministic finish\./],
  ["no self-promotion", /7\. \*\*No self-promotion\./],
] as const
for (const [label, re] of doctrineRules) check(`doctrine rule present: ${label}`, re.test(DOCTRINE))
check("doctrine explicitly not permission rails", /working rules, not permissions/.test(DOCTRINE))
check("doctrine mandates structured finish (STATUS/FINDINGS/HANDOFFS)", /STATUS \(done \| partial \| blocked\), FINDINGS .*HANDOFFS/.test(DOCTRINE)) // prettier-ignore
check("doctrine routes out-of-scope work to the relay", /append it to the relay/.test(DOCTRINE))

// ---- 2. Relay: path interpolation + protocol invariants ----
const relay = relaySection("/tmp/my-relay.md")
check("relay renders the configured path", relay.includes("/tmp/my-relay.md"))
check("relay states it is the only lane channel", /ONLY channel between lanes/.test(relay))
check("relay requires append-only discipline", /Append, never edit/.test(relay))
check("relay defines handoff protocol", /HANDOFF -> lane-ID/.test(relay))
check("relay requires read-before-write", /Read first, write second/.test(relay))
check("relay sets size discipline", /≤15 lines/.test(relay))

// ---- 3. Refine loop: 0 disables, 1..3 render, wording scales ----
const off = refineSection(0)
check("refine passes=0 disables the loop", /0 \(disabled\)/.test(off) && /no critique iteration/.test(off))
check("refine passes=0 has no iteration steps", !/Re-verify/.test(off))
const one = refineSection(1)
check("refine passes=1 renders singular wording", /up to 1 pass —/.test(one) && !/1 passes/.test(one))
const two = refineSection(2)
check("refine passes=2 renders plural wording", /up to 2 passes —/.test(two))
check("refine loop has draft step", /\*\*Draft\*\*/.test(two))
check("refine loop has verifier critique step", /\*\*Critique\*\*/.test(two) && /verifier lane/.test(two))
check("refine loop has fix step", /\*\*Fix\*\*/.test(two))
check("refine loop has re-verify step", /\*\*Re-verify\*\*/.test(two))
check("refine loop stops early on convergence", /stop EARLY the moment a critique finds zero/.test(two))
const three = refineSection(3)
check("refine passes=3 renders (setup clamps to this max)", /up to 3 passes —/.test(three))

// ---- 4. Adaptive lane rubric: varies with work, no fixed default ----
check("rubric covers 1-lane case", /- 1 lane:/.test(LANE_RUBRIC))
check("rubric covers 2-3 lane case", /- 2-3 lanes:/.test(LANE_RUBRIC))
check("rubric covers 4-6 lane case", /- 4-6 lanes:/.test(LANE_RUBRIC))
check("rubric covers 7+ lane case", /- 7\+ lanes:/.test(LANE_RUBRIC))
check("rubric forbids fixed defaults", /never from a fixed default/.test(LANE_RUBRIC))
check("rubric ties count to workstreams not numbers", /split by workstream, never by number/.test(LANE_RUBRIC))

// ---- 5. laneHint: hint scales with prompt length (anti-hardcode proof) ----
const tiny = laneHint("Fix the typo.")
const mid = laneHint(
  "Audit the repository for bugs, performance issues, and documentation inconsistencies across the parser, CLI, tests, and benchmarks, then propose fixes for each area.",
)
const huge = laneHint(Array(400).fill("word").join(" "))
const wTiny = Number(/~(\d+) words/.exec(tiny)?.[1])
const wMid = Number(/~(\d+) words/.exec(mid)?.[1])
const hTiny = Number(/about (\d+) independent/.exec(tiny)?.[1])
const hMid = Number(/about (\d+) independent/.exec(mid)?.[1])
const hHuge = Number(/about (\d+) independent/.exec(huge)?.[1])
check("laneHint reports word count (tiny)", wTiny === 3)
check("laneHint reports word count (mid)", wMid > 20)
check("tiny prompt hints fewer lanes than mid prompt", hTiny < hMid)
check("tiny prompt hints the 1-lane floor", hTiny === 1)
check("laneHint caps the hint at 6 lanes", hHuge === 6)
check("laneHint says hint is an input, not a mandate", /not a mandate/.test(tiny))
check("laneHint output differs across task lengths", tiny !== mid)

// ---- 6. skillContent — ADAPTIVE mode renders everything v1.3.0 promises ----
const adaptive = skillContent("adaptive", "/mem/swarm-memory.md", 8, true, 1, "/mem/swarm-relay.md")
check("adaptive: mode header rendered", /## Mode: ADAPTIVE/.test(adaptive))
check("adaptive: anti-default guarantee present", /Never say "I'll use the default N lanes"\./.test(adaptive))
check("adaptive: no-default statement present", /There is no default count - there is only the work\./.test(adaptive))
check("adaptive: lane rubric embedded", adaptive.includes("Derive the lane count from the WORKSTREAMS"))
check("adaptive: doctrine section embedded", /## Lane doctrine/.test(adaptive))
check("adaptive: doctrine rendered verbatim", adaptive.includes(DOCTRINE.slice(0, 80)))
check("adaptive: relay section embeds relay path", adaptive.includes("/mem/swarm-relay.md"))
check("adaptive: workflow has relay step", /4\. \*\*Relay\*\*/.test(adaptive))
check("adaptive: workflow invokes the refine loop", /6\. \*\*Verify adaptively\*\*.*refine loop/.test(adaptive))
check("adaptive: refine section shows configured passes", /up to 1 pass —/.test(adaptive))
check(
  "adaptive: specialist roster complete (architect/builder/verifier/coder/researcher/reviewer/multimodal)",
  [/### Architect lane/, /### Builder lane/, /### Verifier lane/, /### Coder lane/, /### Researcher lane/, /### Reviewer lane/, /### Multimodal analyst lane/].every(
    (re) => re.test(adaptive),
  ),
)
check("adaptive: memory path embedded", adaptive.includes("/mem/swarm-memory.md"))
check("adaptive: wave size embedded", /Wave size = ~8 lanes/.test(adaptive))
check("adaptive: rate-limit ON text", /token-bucket limited \(burst 8\)/.test(adaptive))
check("adaptive: attribution (copyright) attached", adaptive.includes("(c) 2026 Arihant Bharanidharan"))

// ---- 7. skillContent — MANUAL mode keeps user-decides + still gets doctrine ----
const manual = skillContent("manual", "/mem/swarm-memory.md", 8, false, 0, "/mem/swarm-relay.md")
check("manual: mode header rendered", /## Mode: MANUAL/.test(manual))
check("manual: user decides shape", /you decide\.|the user does\./i.test(manual))
check("manual: adaptive rubric NOT in manual mode", !adaptive.includes("## Mode: MANUAL") && !manual.includes("I'll use the default N lanes")) // prettier-ignore
check("manual: doctrine still enforced", /## Lane doctrine/.test(manual))
check("manual: relay still present", manual.includes("/mem/swarm-relay.md"))
check("manual: refine passes=0 disables loop in skill", /Refine passes: 0 \(disabled\)/.test(manual))
check("manual: rate-limit OFF text", /rate limiting is OFF/.test(manual))

// ---- 8. Signature/regression guards ----
check("skillContent is exported", typeof skillContent === "function")
check("laneHint is exported", typeof laneHint === "function")
check("relaySection is exported", typeof relaySection === "function")
check("refineSection is exported", typeof refineSection === "function")

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
