/**
 * Explainability: every significant scheduler decision records its reasons.
 * Req 51: tools surface "DECISION: ... reason: ..." blocks, never bare
 * verdicts — a decision without reasons is a bug.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import type { DecisionRecord } from "./types.js"

/** Render one decision record as the stable "DECISION/reason" text block. */
export function renderDecision(r: DecisionRecord): string {
  const where = r.runId ? ` run=${r.runId}` : ""
  const lines = [`DECISION: ${r.decision} (kind=${r.kind}${where})`, "reason:"]
  const reasons = r.reasons.length > 0 ? r.reasons : ["no reasons recorded"]
  for (const reason of reasons) lines.push(`- ${reason}`)
  return lines.join("\n")
}

/** In-memory decision log with a bounded window; optionally mirrored to JSONL. */
export class DecisionLog {
  private readonly entries: DecisionRecord[] = []
  private readonly max: number
  private readonly sink: ((line: string) => void) | null

  constructor(max = 200, sink: ((line: string) => void) | null = null) {
    this.max = max
    this.sink = sink
  }

  record(entry: DecisionRecord): void {
    this.entries.push(entry)
    if (this.entries.length > this.max) this.entries.shift()
    if (this.sink) {
      try {
        this.sink(JSON.stringify(entry))
      } catch {
        // Persistence must never break the decision path.
      }
    }
  }

  all(): readonly DecisionRecord[] {
    return this.entries
  }

  forRun(runId: string): DecisionRecord[] {
    return this.entries.filter((e) => e.runId === runId)
  }

  /** Rendered blocks, newest last; optionally filtered by decision name. */
  explain(decision?: string): string[] {
    const rows = decision ? this.entries.filter((e) => e.decision === decision) : this.entries
    return rows.map(renderDecision)
  }

  clear(): void {
    this.entries.length = 0
  }
}
