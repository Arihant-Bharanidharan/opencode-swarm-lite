param(
  [Parameter(Mandatory=$true)][string]$Task,
  [Parameter(Mandatory=$true)][ValidateSet("start","end")][string]$Phase,
  [string]$Arm = "serial",
  [string]$Lane = ""
)
# Per-task boundary marks (epoch ms) for benchmark timing.
# Appends one JSONL record to benchmark/logs/marks.jsonl.
$repo = "C:\Users\B.Shanker\opencode-swarm-lite"
$logDir = Join-Path $repo "benchmark\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "marks.jsonl"

$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$rec = [ordered]@{
  task = $Task
  phase = $Phase
  ts = $ts
  arm = $Arm
}
if ($Lane) { $rec.lane = $Lane }
($rec | ConvertTo-Json -Compress) | Add-Content -Path $logFile -Encoding utf8

Write-Output "MARK task=$Task phase=$Phase ts=$ts arm=$Arm"
