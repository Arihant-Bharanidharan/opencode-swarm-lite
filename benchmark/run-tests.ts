/**
 * Deterministic benchmark test runner.
 *
 * Usage:
 *   bun benchmark/run-tests.ts --serial   # Phase 1 serial baseline
 *   bun benchmark/run-tests.ts --swarm    # Phase 3-4 swarm arm
 *
 * Writes one JSON line per task to benchmark/logs/results.jsonl and a final
 * summary line with wall-clock ms. Exit code 0 only if every task passes.
 */
import { readdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const logFile = fileURLToPath(new URL("./logs/results.jsonl", import.meta.url));
const modeFromArg = process.argv.slice(2).find((a) => a.startsWith("--")) ?? "--serial";
const mode = modeFromArg.replace(/^--/, "");

const testDir = fileURLToPath(new URL("./tests/", import.meta.url));
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).sort();
if (files.length !== 8) {
  console.error(`expected 8 test files, found ${files.length}`);
  process.exit(2);
}

interface TaskResult {
  mode: string;
  task: string;
  pass: boolean;
  totalMs: number;
  testCount: number;
  passCount: number;
  failCount: number;
  tail: string;
}

function runOne(task: string): TaskResult {
  const testPath = join(testDir, task);
  const started = Date.now();
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "benchmark/run-tests-core.ts", testPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const totalMs = Date.now() - started;
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const text = stdout + stderr;
  const counts = /(\d+)\s+pass\n\s+(\d+)\s+fail/.exec(text);
  const ranLine = /Ran (\d+) tests/.exec(text);
  const pass = proc.exitCode === 0 && !!counts;
  // capture the last meaningful failure lines as evidence tail
  const lines = text
    .split(/\r?\n/)
    .filter((l) => /\(fail\)|error:/.test(l))
    .slice(-14);
  return {
    mode,
    task,
    pass,
    totalMs,
    testCount: Number(ranLine?.[1] ?? 0),
    passCount: Number(counts?.[1] ?? 0),
    failCount: Number(counts?.[2] ?? 0),
    tail: lines.join(" | ") || text.slice(-400),
  };
}

const results: TaskResult[] = [];
for (const f of files) {
  const started = Date.now();
  const r = runOne(f);
  results.push(r);
  appendFileSync(
    logFile,
    JSON.stringify({ ...r, wallMs: Date.now() - started }) + "\n",
  );
}

const summary = {
  mode,
  summary: true,
  tasks: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  wallMs: results.reduce((a, r) => a + r.totalMs, 0),
  finishedAt: new Date().toISOString(),
};
appendFileSync(logFile, JSON.stringify(summary) + "\n");
console.log(JSON.stringify(summary));
process.exit(summary.failed === 0 ? 0 : 1);
