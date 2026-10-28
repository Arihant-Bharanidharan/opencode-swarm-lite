param(
  [Parameter(Mandatory=$true)][string]$Type,
  [string]$Arm = "",
  [string]$Lane = "",
  [string]$Task = "",
  [string]$Detail = ""
)
# Harness event log for benchmark arms. Types follow the runtime vocabulary
# (src/runtime/telemetry.ts RuntimeEventType) where applicable; SKIP_VERIFY
# and COMPLETE are harness-only labels (not in the runtime enum).
# Appends one JSONL record to benchmark/logs/events.jsonl.
$repo = "C:\Users\B.Shanker\opencode-swarm-lite"
$logDir = Join-Path $repo "benchmark\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "events.jsonl"

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$rec = [ordered]@{
  ts = $ts
  type = $Type
  runId = "run_mvmmyollkinq7p"
}
if ($Arm)   { $rec.arm = $Arm }
if ($Lane)  { $rec.lane = $Lane }
if ($Task)  { $rec.task = $Task }
if ($Detail) { $rec.detail = $Detail }
($rec | ConvertTo-Json -Compress) | Add-Content -Path $logFile -Encoding utf8

Write-Output "EVENT type=$Type ts=$ts"
