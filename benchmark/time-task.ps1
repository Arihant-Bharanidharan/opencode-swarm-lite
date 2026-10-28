param(
  [Parameter(Mandatory=$true)][string]$Task,
  [Parameter(Mandatory=$true)][string]$TestFile,
  [string]$Arm = "serial",
  [string]$Lane = ""
)
# Timed single-task test run for the serial baseline.
# Appends one JSONL record to benchmark/logs/serial.jsonl.
$ErrorActionPreference = "Continue"
$repo = "C:\Users\B.Shanker\opencode-swarm-lite"
$logDir = Join-Path $repo "benchmark\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "serial.jsonl"

$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# Run the test; capture output. bun is a ps1 shim that writes to stderr on success too.
$outFile = Join-Path $env:TEMP "task-out-$Task.txt"
$raw = & bun test $TestFile 2>&1 | Out-String

$endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$durationMs = $endMs - $startMs

# Parse pass/fail from bun test summary lines like " 5 pass" / " 0 fail"
$passCount = 0; $failCount = 0
foreach ($line in ($raw -split "`n")) {
  if ($line -match '^\s*(\d+)\s+pass') { $passCount = [int]$Matches[1] }
  if ($line -match '^\s*(\d+)\s+fail') { $failCount = [int]$Matches[1] }
}
$status = if ($failCount -eq 0 -and $passCount -gt 0) { "PASS" } else { "FAIL" }

$rec = [ordered]@{
  task = $Task
  arm = $Arm
  status = $status
  passed = $passCount
  failed = $failCount
  start_ms = $startMs
  end_ms = $endMs
  duration_ms = $durationMs
}
if ($Lane) { $rec.lane = $Lane }
($rec | ConvertTo-Json -Compress) | Add-Content -Path $logFile -Encoding utf8

Write-Output "TASK=$Task STATUS=$status PASS=$passCount FAIL=$failCount START_MS=$startMs END_MS=$endMs DURATION_MS=$durationMs"
Write-Output "RAW_TAIL:"
Write-Output ($raw -split "`n" | Select-Object -Last 6)
