/**
 * Versioned context capsules: verified facts, hypotheses and stale notes with
 * provenance. Capsules are explicit handoffs, not shared mutable memory.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import type { Capsule, CapsuleFact } from "./types.js"
import { round, safeReadJson, safeWriteJson, tokenize } from "./util.js"

export type CapsuleInput = {
  name: string
  scope?: string
  architecture?: string[]
  invariants?: string[]
  blockers?: string[]
  commands?: Array<{ cmd: string; verified?: boolean; note?: string }>
  failedApproaches?: string[]
  files?: Array<{ path: string; hash?: string; note?: string }>
  facts?: Array<{
    id?: string
    key?: string
    text: string
    status?: "verified" | "hypothesis" | "stale"
    evidence?: string[]
    source?: string
    verifiedAt?: number
  }>
  provenance?: string[]
}

export interface CapsuleSummary {
  name: string
  version: number
  revision: number
  scope: string
  facts: number
  verified: number
  hypotheses: number
  stale: number
  updatedAt: number
  digest: string
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "capsule"

const factKey = (s: string): string => tokenize(s).slice(0, 10).sort().join("-")

const uniq = (xs: readonly string[]): string[] => [...new Set(xs.map((s) => s.trim()).filter(Boolean))]

export class CapsuleStore {
  private readonly dir: string | null
  private readonly now: () => number

  constructor(dir: string | null, opts: { now?: () => number } = {}) {
    this.dir = dir
    this.now = opts.now ?? (() => Date.now())
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        // ignore
      }
    }
  }

  private file(name: string): string | null {
    if (!this.dir) return null
    return path.join(this.dir, `${slug(name)}.json`)
  }

  load(name: string): Capsule | undefined {
    const f = this.file(name)
    if (!f) return undefined
    const c = safeReadJson<Capsule | null>(f, null)
    if (!c || typeof c !== "object" || !Array.isArray(c.facts)) return undefined
    return c
  }

  list(): CapsuleSummary[] {
    if (!this.dir) return []
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => safeReadJson<Capsule | null>(path.join(this.dir!, f), null))
        .filter((c): c is Capsule => !!c && Array.isArray(c.facts))
        .map((c) => this.summarize(c))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  private summarize(c: Capsule): CapsuleSummary {
    return {
      name: c.name,
      version: c.version,
      revision: c.revision,
      scope: c.scope,
      facts: c.facts.length,
      verified: c.facts.filter((f) => f.status === "verified").length,
      hypotheses: c.facts.filter((f) => f.status === "hypothesis").length,
      stale: c.facts.filter((f) => f.status === "stale").length,
      updatedAt: c.updatedAt,
      digest: this.digest(c),
    }
  }

  create(input: CapsuleInput): Capsule {
    const existing = this.load(input.name)
    if (existing) return this.merge(input.name, input)
    const now = this.now()
    const capsule: Capsule = {
      name: input.name,
      version: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      scope: input.scope ?? "project",
      architecture: uniq(input.architecture ?? []),
      facts: this.toFacts(input, now, 0),
      files: (input.files ?? []).map((f) => ({ ...f })),
      invariants: uniq(input.invariants ?? []),
      blockers: uniq(input.blockers ?? []),
      commands: (input.commands ?? []).map((c) => ({ cmd: c.cmd, verified: c.verified ?? false, note: c.note })),
      failedApproaches: uniq(input.failedApproaches ?? []),
      provenance: uniq([
        ...(input.provenance ?? []),
        `created by runtime at ${new Date(now).toISOString()}`,
      ]),
    }
    this.save(capsule)
    return capsule
  }

  private toFacts(input: CapsuleInput, now: number, start: number): CapsuleFact[] {
    return (input.facts ?? [])
      .filter((f) => f && typeof f.text === "string" && f.text.trim().length > 0)
      .map((f, i) => {
        const text = f.text.trim()
        return {
          id: f.id ?? `f${start + i + 1}`,
          key: f.key ?? factKey(text),
          text,
          status: f.status ?? "hypothesis",
          evidence: uniq(f.evidence ?? []),
          source: f.source ?? "runtime",
          addedAt: now,
          verifiedAt: f.status === "verified" ? f.verifiedAt ?? now : f.verifiedAt,
        }
      })
  }

  save(c: Capsule): void {
    const f = this.file(c.name)
    if (!f) return
    safeWriteJson(f, c)
  }

  merge(name: string, input: Partial<CapsuleInput> & { note?: string }): Capsule {
    const c = this.load(name)
    if (!c) return this.create({ ...(input as CapsuleInput), name })
    const now = this.now()
    const nextId = c.facts.length + 1
    const added = this.toFacts(input as CapsuleInput, now, nextId)
    for (const fact of added) {
      const sameText = c.facts.find(
        (f) => f.text.trim().toLowerCase() === fact.text.trim().toLowerCase() && f.status === fact.status,
      )
      if (sameText) continue
      const sameKey = c.facts.find((f) => f.key === fact.key && f.status !== "stale")
      if (sameKey && sameKey.text.trim().toLowerCase() !== fact.text.trim().toLowerCase()) {
        fact.key = `${fact.key}#conflict${c.facts.length + 1}`
        fact.status = "hypothesis"
        fact.evidence = uniq([...fact.evidence, `conflicts with ${sameKey.id}: ${sameKey.text}`])
        c.provenance.push(`conflict on ${sameKey.key}: kept both as hypotheses`)
      }
      c.facts.push(fact)
    }
    c.architecture = uniq([...c.architecture, ...(input.architecture ?? [])])
    c.invariants = uniq([...c.invariants, ...(input.invariants ?? [])])
    c.blockers = uniq([...c.blockers, ...(input.blockers ?? [])])
    c.failedApproaches = uniq([...c.failedApproaches, ...(input.failedApproaches ?? [])])
    for (const f of input.files ?? []) {
      const found = c.files.find((x) => x.path === f.path)
      if (found) {
        if (f.hash) found.hash = f.hash
        if (f.note) found.note = f.note
      } else c.files.push({ ...f })
    }
    for (const cmd of input.commands ?? []) {
      const found = c.commands.find((x) => x.cmd === cmd.cmd)
      if (found) {
        found.verified = cmd.verified ?? found.verified
        if (cmd.note) found.note = cmd.note
      } else c.commands.push({ cmd: cmd.cmd, verified: cmd.verified ?? false, note: cmd.note })
    }
    c.provenance = uniq([
      ...c.provenance,
      ...(input.provenance ?? []),
      ...(input.note ? [input.note] : []),
      `merged at ${new Date(now).toISOString()}`,
    ])
    c.revision++
    c.updatedAt = now
    this.save(c)
    return c
  }

  bumpVersion(name: string, note?: string): Capsule | undefined {
    const c = this.load(name)
    if (!c) return undefined
    c.version++
    c.revision++
    c.updatedAt = this.now()
    c.provenance = uniq([...c.provenance, note ?? `version bumped at ${new Date(c.updatedAt).toISOString()}`])
    this.save(c)
    return c
  }

  refresh(
    name: string,
    opts: { fileHashes?: Record<string, string>; reverifyKeys?: string[]; note?: string } = {},
  ): { capsule: Capsule; stale: string[]; refreshed: string[] } | undefined {
    const c = this.load(name)
    if (!c) return undefined
    const now = this.now()
    const stale: string[] = []
    const refreshed: string[] = []
    for (const f of c.files) {
      if (!opts.fileHashes || opts.fileHashes[f.path] === undefined) continue
      const hash = opts.fileHashes[f.path]
      if (f.hash && hash && f.hash !== hash) {
        for (const fact of c.facts) {
          if (fact.status !== "stale" && fact.evidence.some((e) => e.includes(f.path) || e === f.path)) {
            fact.status = "stale"
            stale.push(fact.id)
            c.provenance.push(`stale ${fact.id}: ${f.path} changed`)
          }
        }
        f.hash = hash
      } else if (!f.hash && hash) {
        f.hash = hash
      }
    }
    for (const key of opts.reverifyKeys ?? []) {
      for (const fact of c.facts) {
        if (fact.key === key || fact.id === key) {
          fact.status = "verified"
          fact.verifiedAt = now
          refreshed.push(fact.id)
        }
      }
    }
    c.revision++
    c.updatedAt = now
    c.provenance = uniq([
      ...c.provenance,
      opts.note ?? `refreshed at ${new Date(now).toISOString()} (${stale.length} stale, ${refreshed.length} reverified)`,
    ])
    this.save(c)
    return { capsule: c, stale, refreshed }
  }

  invalidate(name: string, opts: { keys?: string[]; pattern?: string; reason?: string } = {}): Capsule | undefined {
    const c = this.load(name)
    if (!c) return undefined
    const now = this.now()
    let n = 0
    for (const f of c.facts) {
      const hit =
        (opts.keys ?? []).some((k) => k === f.id || k === f.key) ||
        (opts.pattern ? new RegExp(opts.pattern, "i").test(`${f.key} ${f.text}`) : false)
      if (hit && f.status !== "stale") {
        f.status = "stale"
        n++
      }
    }
    c.revision++
    c.updatedAt = now
    c.provenance = uniq([
      ...c.provenance,
      opts.reason ?? `invalidated ${n} fact(s) at ${new Date(now).toISOString()}`,
    ])
    this.save(c)
    return c
  }

  digest(c: Capsule): string {
    return crypto
      .createHash("sha1")
      .update(`${c.name}:${c.version}:${c.revision}:${c.facts.map((f) => `${f.id}:${f.status}:${f.text}`).join("|")}`)
      .digest("hex")
      .slice(0, 12)
  }

  render(name: string, maxChars = 6000): string | undefined {
    const c = this.load(name)
    if (!c) return undefined
    return this.renderCapsule(c, maxChars)
  }

  renderCapsule(c: Capsule, maxChars = 6000): string {
    const lines: string[] = []
    lines.push(`## Capsule: ${c.name} (v${c.version}, rev ${c.revision}, scope ${c.scope})`)
    lines.push(`digest ${this.digest(c)} | updated ${new Date(c.updatedAt).toISOString()}`)
    if (c.architecture.length) {
      lines.push("", "### Architecture")
      for (const a of c.architecture) lines.push(`- ${a}`)
    }
    if (c.facts.length) {
      lines.push("", "### Facts (verified > hypothesis > stale)")
      const order = { verified: 0, hypothesis: 1, stale: 2 } as const
      const sorted = [...c.facts].sort((a, b) => order[a.status] - order[b.status])
      for (const f of sorted) {
        const ev = f.evidence.length ? ` - evidence: ${f.evidence.join("; ")}` : ""
        const src = f.source ? ` [source: ${f.source}]` : ""
        lines.push(`- [${f.status}] ${f.text}${ev}${src}`)
      }
    }
    if (c.files.length) {
      lines.push("", "### Files")
      for (const f of c.files) lines.push(`- ${f.path}${f.hash ? ` @ ${f.hash.slice(0, 10)}` : ""}${f.note ? ` - ${f.note}` : ""}`)
    }
    if (c.invariants.length) {
      lines.push("", "### Invariants")
      for (const i of c.invariants) lines.push(`- ${i}`)
    }
    if (c.blockers.length) {
      lines.push("", "### Blockers")
      for (const b of c.blockers) lines.push(`- ${b}`)
    }
    if (c.commands.length) {
      lines.push("", "### Commands")
      for (const cmd of c.commands) lines.push(`- [${cmd.verified ? "verified" : "unverified"}] \`${cmd.cmd}\`${cmd.note ? ` - ${cmd.note}` : ""}`)
    }
    if (c.failedApproaches.length) {
      lines.push("", "### Failed approaches (do not repeat)")
      for (const f of c.failedApproaches) lines.push(`- ${f}`)
    }
    if (c.provenance.length) {
      lines.push("", "### Provenance")
      for (const p of c.provenance.slice(-12)) lines.push(`- ${p}`)
    }
    let text = lines.join("\n")
    if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 40))}\n... (truncated)`
    return text
  }

  attach(
    name: string,
    opts: { role?: string; maxChars?: number } = {},
  ): { text: string; version: number; digest: string; verified: number; hypotheses: number; stale: number } | undefined {
    const c = this.load(name)
    if (!c) return undefined
    return {
      text: this.renderCapsule(c, opts.maxChars ?? 6000),
      version: c.version,
      digest: this.digest(c),
      verified: c.facts.filter((f) => f.status === "verified").length,
      hypotheses: c.facts.filter((f) => f.status === "hypothesis").length,
      stale: c.facts.filter((f) => f.status === "stale").length,
    }
  }

  summaryLine(name: string): string | undefined {
    const c = this.load(name)
    if (!c) return undefined
    return `${name} v${c.version} rev${c.revision}: ${c.facts.length} facts (${c.facts.filter((f) => f.status === "verified").length} verified, ${c.facts.filter((f) => f.status === "stale").length} stale)`
  }

  stats(): { capsules: number; verified: number; hypotheses: number; stale: number; newest?: number } {
    const list = this.list()
    return {
      capsules: list.length,
      verified: list.reduce((n, c) => n + c.verified, 0),
      hypotheses: list.reduce((n, c) => n + c.hypotheses, 0),
      stale: list.reduce((n, c) => n + c.stale, 0),
      newest: list.length ? Math.max(...list.map((c) => c.updatedAt)) : undefined,
    }
  }

  ageSeconds(name: string): number {
    const c = this.load(name)
    return c ? round((this.now() - c.updatedAt) / 1000) : 0
  }
}
