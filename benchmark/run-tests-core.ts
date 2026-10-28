/**
 * Runs `bun test <file>` for one task file and forwards output.
 * Kept separate so run-tests.ts can capture the exit code + counts reliably.
 */
const file = process.argv[2];
const proc = Bun.spawnSync({
  cmd: [process.execPath, "test", file],
  stdout: "pipe",
  stderr: "pipe",
});
const out = proc.stdout.toString() + proc.stderr.toString();
process.stdout.write(out);
process.exit(proc.exitCode ?? 1);
