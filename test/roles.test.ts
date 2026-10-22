/**
 * v1.4.0 tests: the extensible role registry - parse rules, resolution
 * (add / modify / broaden, extends chains, cycles, last-wins), rendering of
 * the Specialist roles section, the /swarm-roles listing, and skillContent
 * integration (including 6-arg backward compatibility).
 */
import { readFileSync } from "node:fs"
import {
  BUILTIN_ROLES,
  ROLE_BRIEFS,
  parseRoles,
  registrySummary,
  resolveRoleBrief,
  rolesSection,
  skillContent,
} from "../src/index.js"

let pass = 0
let fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`[PASS] ${name}`) } else { fail++; console.log(`[FAIL] ${name}`) } // prettier-ignore
}

const MEM = "/mem/swarm-memory.md"
const RELAY = "/mem/swarm-relay.md"
const ROLES = "/mem/swarm-roles.md"

// ---- 1. parseRoles: block recognition ----
const p1 = parseRoles("### role: security-auditor\n- extends: verifier\n- One-line purpose.\n- Terse rule two.")
check("parse: role block kind + name", p1.length === 1 && p1[0].kind === "role" && p1[0].name === "security-auditor")
check("parse: extends captured", p1[0].extends === "verifier")
check("parse: multi-line body kept", p1[0].body.includes("One-line purpose.") && p1[0].body.includes("Terse rule two."))
check("parse: extends line not part of body", !p1[0].body.includes("extends:"))

const p2 = parseRoles("### extend: builder\n- Extra builder rule.")
check("parse: extend block kind", p2.length === 1 && p2[0].kind === "extend" && p2[0].extends === undefined)
check("parse: extends only meaningful on role blocks", p2[0].body.includes("Extra builder rule."))

const p3 = parseRoles("### ROLE: My-Rule\n- body")
check("parse: heading case-insensitive, slug lowercased", p3.length === 1 && p3[0].kind === "role" && p3[0].name === "my-rule")

const p4 = parseRoles("### role: bad_slug\n- body")
check("parse: invalid slug ignored entirely", p4.length === 0)

const p5 = parseRoles("### role: keeper\n- keep body\n### Notes\n- stray line")
check("parse: any other heading ends the block", p5.length === 1 && p5[0].body === "- keep body")

const p6 = parseRoles("### role: ghost\n\n### role: real\n- body")
check("parse: empty-body block dropped", p6.length === 1 && p6[0].name === "real")

const p7 = parseRoles("### role: crlf\r\n- body\r\n")
check("parse: CRLF tolerated", p7.length === 1 && p7[0].body === "- body")

const p8 = parseRoles("### role: dup\n- first\n### role: dup\n- second")
check("parse: duplicate slugs kept in file order", p8.length === 2 && p8[0].body === "- first" && p8[1].body === "- second")

const p9 = parseRoles("free prose before any heading\n### role: after\n- body")
check("parse: prose before first heading ignored", p9.length === 1 && p9[0].name === "after")

const p10 = parseRoles("### role: x\n- extends: a\n- extends: b\n- body")
check("parse: second extends line falls into body", p10.length === 1 && p10[0].extends === "a" && p10[0].body.includes("extends: b"))

const p11 = parseRoles("### role: ticks\n- extends: `verifier`\n- body")
check("parse: backticked extends value accepted", p11.length === 1 && p11[0].extends === "verifier")

// ---- 2. resolveRoleBrief: base resolution ----
check("resolve: built-in resolves to its brief", resolveRoleBrief("verifier", []) === ROLE_BRIEFS["verifier"])
check("resolve: input trimmed + lowercased", resolveRoleBrief("  VERIFIER ", []) === ROLE_BRIEFS["verifier"])
check("resolve: unknown slug -> null", resolveRoleBrief("nope", []) === null)

const solo = parseRoles("### role: data-migrator\n- Own brief line.")
check("resolve: custom standalone -> its body", resolveRoleBrief("data-migrator", solo) === "- Own brief line.")

const aud = parseRoles("### role: security-auditor\n- extends: verifier\n- Audit for vulns.")
const audBrief = resolveRoleBrief("security-auditor", aud) ?? ""
check("resolve: extends inherits the base brief", audBrief.includes(ROLE_BRIEFS["verifier"]))
check("resolve: extends keeps its own body", audBrief.includes("Audit for vulns."))

const ub = parseRoles("### role: solo\n- extends: ghost-base\n- solo body")
check("resolve: unknown extends base -> stands on its own body", resolveRoleBrief("solo", ub) === "- solo body")

// ---- 3. resolution: modify, broaden, precedence ----
const mod = parseRoles("### role: verifier\n- Modified verifier brief.")
const modBrief = resolveRoleBrief("verifier", mod) ?? ""
check("resolve: role block on a built-in slug REPLACES it (modify)", modBrief === "- Modified verifier brief.")
check("resolve: replacement drops the original built-in text", !modBrief.includes("You are a verifier lane in a lightweight swarm."))
check("resolve: other built-ins unaffected by one modification", resolveRoleBrief("architect", mod) === ROLE_BRIEFS["architect"])

const acc = parseRoles("### extend: verifier\n- first add\n### extend: verifier\n- second add")
const accBrief = resolveRoleBrief("verifier", acc) ?? ""
check("resolve: broadening appends to the base", accBrief.startsWith(ROLE_BRIEFS["verifier"]))
check("resolve: multiple extend blocks accumulate", accBrief.includes("first add") && accBrief.includes("second add"))
check("resolve: accumulation follows file order", accBrief.indexOf("first add") < accBrief.indexOf("second add"))
check("resolve: broadening carries the preamble", accBrief.includes("**Broadened for this installation (added by the orchestrator):**"))

const dup = parseRoles("### role: x\n- first body\n### role: x\n- second body")
check("resolve: last block wins (re-appending rewrites)", resolveRoleBrief("x", dup) === "- second body")

const prop = parseRoles(
  "### role: auditor\n- extends: verifier\n- auditor body\n### extend: verifier\n- shared broadening",
)
check("resolve: broadened base propagates to roles extending it", (resolveRoleBrief("auditor", prop) ?? "").includes("shared broadening"))
check("resolve: broadened base applies to the base itself", (resolveRoleBrief("verifier", prop) ?? "").includes("shared broadening"))

const cyc = parseRoles("### role: alpha\n- extends: beta\n- alpha body\n### role: beta\n- extends: alpha\n- beta body")
const cycBrief = resolveRoleBrief("alpha", cyc)
check("resolve: extends cycle terminates with the own body", cycBrief !== null && cycBrief.includes("alpha body") && cycBrief.includes("beta body"))

check("resolve: extend block alone never invents a role", resolveRoleBrief("phantom", parseRoles("### extend: phantom\n- add")) === null)

const selfBroaden = parseRoles("### role: data-migrator\n- Own body\n### extend: data-migrator\n- Broadened for customs too")
check("resolve: registry roles can be broadened as well", (resolveRoleBrief("data-migrator", selfBroaden) ?? "").includes("Broadened for customs too"))

// ---- 4. rolesSection: rendering ----
const none = rolesSection([], ROLES)
check("render: all 7 built-in headings exact", BUILTIN_ROLES.every((r) => none.includes(`### ${r.title} lane\n`)))
check("render: no custom heading when the registry is empty", !none.includes("(custom)"))
check("render: no modified marker when nothing is modified", !none.includes("(modified)"))

const blocks = parseRoles(
  "### role: security-auditor\n- extends: verifier\n- Audit for vulns.\n\n### extend: builder\n- Extra builder rule.",
)
const sec = rolesSection(blocks, ROLES)
check("render: custom role heading (custom)", sec.includes("### Security auditor lane (custom)"))
check("render: custom brief rendered", sec.includes("Audit for vulns."))
check("render: broadened built-in marked via preamble", sec.includes("**Broadened for this installation"))
check("render: registry file path shown", sec.includes(ROLES))
check("render: role block format example", sec.includes("### role: security-auditor"))
check("render: extend block format example", sec.includes("### extend: builder"))
check("render: doctrine-not-replaced rule documented", sec.includes("never replaces the doctrine"))
check("render: one-role-per-lane rule documented", sec.includes("ONE role per lane still applies"))
check("render: append-only discipline documented", sec.includes("append-only markdown"))
check("render: immediate effect + hot refresh documented", sec.includes("re-renders automatically"))

const secMod = rolesSection(mod, ROLES)
check("render: modified built-in heading marked", secMod.includes("### Verifier lane (modified)"))
check("render: modified brief replaces the built-in text", secMod.includes("- Modified verifier brief.") && !secMod.includes("You are a verifier lane in a lightweight swarm."))
check("render: unmodified built-ins keep plain headings", secMod.includes("### Architect lane\n"))

// ---- 5. registrySummary (/swarm-roles listing) ----
const sum0 = registrySummary([])
check("summary: lists every built-in once", sum0.split("\n").length === BUILTIN_ROLES.length && sum0.includes("- verifier (built-in)"))

const mixed = parseRoles(
  "### role: security-auditor\n- extends: verifier\n- Audit.\n\n### role: verifier\n- Modified.\n\n### extend: builder\n- Extra.",
)
const sum1 = registrySummary(mixed)
check("summary: custom role flagged with its base", sum1.includes("- security-auditor (custom, extends verifier)"))
check("summary: modified built-in flagged", sum1.includes("- verifier (built-in, modified)"))
check("summary: broadened built-in flagged with count", sum1.includes("- builder (built-in, broadened x1)"))
check("summary: untouched built-ins keep plain flag", sum1.includes("- architect (built-in)"))

// ---- 6. skillContent integration + backward compatibility ----
const def = skillContent("adaptive", MEM, 8, true, 1, RELAY) // legacy 6-arg call
check("skill: 6-arg legacy call still renders", def.includes("# Swarm (lightweight)"))
check("skill: registry section present by default", def.includes("### Role registry - add, modify, or broaden roles yourself"))
check("skill: default roles path derived from memory dir", def.includes("swarm-roles.md"))
check("skill: workflow step 1 is memory + registry", def.includes("1. **Memory + registry**"))
check("skill: built-in roster still complete", BUILTIN_ROLES.every((r) => def.includes(`### ${r.title} lane`)))

const full = skillContent("adaptive", MEM, 8, true, 1, RELAY, blocks, ROLES)
check("skill: custom role lane appears", full.includes("### Security auditor lane (custom)"))
check("skill: workflow references the registry path", full.includes(`\`${ROLES}\``))
check("skill: dispatch step references registry roles", full.includes(`a registry role from \`${ROLES}\``))
check("skill: broadened built-in text lands in the skill", full.includes("Extra builder rule."))
check("skill: attribution carries v1.4.0", full.includes("opencode-swarm-lite v1.4.0"))

const manual = skillContent("manual", MEM, 5, false, 0, RELAY, blocks, ROLES)
check("skill: manual mode renders the registry too", manual.includes("### Security auditor lane (custom)"))
check("skill: manual mode keeps the registry contract", manual.includes("### Role registry - add, modify, or broaden roles yourself"))

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
check("package.json bumped to 1.4.0", pkg.version === "1.4.0")

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
