/**
 * Small shared utilities for the adaptive runtime.
 * Copyright (c) 2026 Arihant Bharanidhran <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */
import fs from "node:fs"
import path from "node:path"

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

/** Nearest-rank percentile. p in [0,1]. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const rank = clamp(Math.ceil(p * sorted.length), 1, sorted.length)
  return sorted[rank - 1]!
}

export const median = (xs: readonly number[]): number => percentile(xs, 0.5)

export const round = (n: number, digits = 1): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export const uid = (prefix: string): string => {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${t}${r}`
}

export function safeReadJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

export function safeWriteJson(file: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // Telemetry/state must never take down a lane.
  }
}

/**
 * Append one JSONL line durably. Returns false on write failure so callers
 * (telemetry) can count lost events instead of silently swallowing them.
 */
export function safeAppendLine(file: string, line: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`)
    return true
  } catch {
    return false
  }
}

export function readJsonLines<T>(file: string, limit = 5000): T[] {
  try {
    if (!fs.existsSync(file)) return []
    const text = fs.readFileSync(file, "utf8")
    const lines = text.split(/\r?\n/).filter(Boolean)
    const out: T[] = []
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // skip malformed line
      }
    }
    return out
  } catch {
    return []
  }
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#._-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
}
