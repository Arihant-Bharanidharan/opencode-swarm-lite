/**
 * Shared types for the adaptive swarm runtime.
 * Copyright (c) 2026 Arihant Bharanidharan <arihantbharani@outlook.com>
 * SPDX-License-Identifier: MIT
 */

export type Topology =
  | "SERIAL"
  | "SMALL_SWARM"
  | "FULL_SWARM"
  | "SPECULATIVE_SWARM"
  | "PIPELINE"
  | "BATCHED_WORKER"

export type Category =
  | "microtask"
  | "research"
  | "coding"
  | "analysis"
  | "verification"
  | "mixed"
  | "ops"

export type VerificationLevel = 0 | 1 | 2 | 3 | 4

export type ObservationStatus = "ok" | "error" | "timeout" | "interrupted" | "429"

export type ProviderState = "closed" | "open" | "half_open"

export interface MicroTask {
  id: string
  seconds: number
  category?: Category
  files?: string[]
  role?: string
}

export interface DagNode {
  id: string
  seconds: number
  role?: string
  category?: Category
}

export interface TaskInput {
  task: string
  category?: Category
  /** Number of genuinely independent branches. Defaults to 1: never fan out by default. */
  branches?: number
  /** Expected wall-clock seconds per branch, including that lane's own tool work. */
  branchSeconds?: number
  /** 0..1, how independent the branches are. 1 = no dependencies. */
  independence?: number
  /** 0..1, how much the branches re-read/re-derive the same context. */
  sharedContext?: number
  /** 0..1, how unclear the solution path is. */
  ambiguity?: number
  /** 0..1, blast radius if wrong. */
  risk?: number
  /** 0..1, how much a separate verification pass is worth. */
  verificationValue?: number
  /** 0..1, weight on quality vs speed when choosing a topology. */
  qualityWeight?: number
  contextTokens?: number
  outputTokens?: number
  role?: string
  model?: string
  provider?: string
  /** True when a compatible idle lane can be reused. */
  warm?: boolean
  /** Attach this versioned context capsule to every lane in the run. */
  capsule?: string
  capsuleVersion?: number
  /** Independent microtasks that can be grouped into batched workers. */
  tasks?: MicroTask[]
  /** Explicit dependency graph; presence implies PIPELINE. */
  nodes?: DagNode[]
  edges?: Array<[string, string]>
  criticalPathSeconds?: number
  dependencies?: boolean
  verificationLevel?: VerificationLevel
  budget?: Partial<Budget>
  /** Signals for the adaptive verification policy. */
  deterministicTests?: boolean
  testStrength?: number
  disagreement?: number
  confidence?: number
  files?: string[]
  /** v3: execution objective; alters fan-out, verification and routing bias. */
  sla?: SlaMode
  /** v3: hard wall-clock target; the scheduler must report honest infeasibility. */
  deadlineSeconds?: number
  /** v3: requested quality tier; raises the verification floor. */
  qualityLevel?: QualityLevel
  /** v3: calibrated confidence the integrated result must reach. */
  targetConfidence?: number
  /** v3: opt-in chaos injection for tests/benchmarks; never the default. */
  chaosMode?: boolean
}

export interface Budget {
  requests: number
  tokens: number
  agents: number
  wallClockSeconds: number
  verificationSeconds: number
  reserve: number
}

export interface VerificationPlan {
  level: VerificationLevel
  steps: string[]
  estimatedCost: number
  expectedGain: number
  skipReason?: string
  escalateIf?: string[]
  judgeAllowed: boolean
}

export interface PlanEstimates {
  /** Predicted time if one agent does everything sequentially. */
  serial: number
  /** Best predicted non-serial candidate (even when SERIAL is recommended). */
  swarm: number
  /** Predicted time of the recommended topology. */
  chosen: number
  /** serial / chosen. 1 when SERIAL is recommended. */
  speedup: number
  /** serial / best swarm candidate. */
  swarmSpeedup: number
  parallelEfficiency: number
  startupCost: number
  verificationGain: number
  integrationCost: number
  planningCost: number
  criticalPath: number
  agents: number
  waves: number
  requests: number
  tokens: number
  confidence: number
  netSecondsSaved: number
}

export interface BatchPlan {
  index: number
  taskIds: string[]
  seconds: number
  role?: string
}

export interface ScheduleNodeResult {
  id: string
  earliestStart: number
  earliestFinish: number
  latestStart: number
  latestFinish: number
  slack: number
  critical: boolean
  lane?: number
}

export interface ScheduleResult {
  order: string[]
  waves: string[][]
  criticalPath: string[]
  makespan: number
  serialTime: number
  concurrency: number
  utilization: number
  nodes: ScheduleNodeResult[]
  cycle?: string[]
}

/**
 * The nine predictor fields, snake_case, published on every plan.
 * Derived from the live plan by `planPredictors` (see predictor.ts); the
 * internal scheduler fields are camelCase, this is the stable contract.
 */
export interface PlanPredictors {
  /** Predicted wall clock if one agent does everything sequentially (seconds). */
  estimated_serial_time: number
  /** Predicted wall clock of the best non-serial candidate (seconds). */
  estimated_swarm_time: number
  /** serial / chosen, divided by agents. 1 when SERIAL is recommended. */
  estimated_parallel_efficiency: number
  /** Startup (cold or warm, per the routing decision) for the chosen plan (seconds). */
  estimated_startup_cost: number
  /** Expected correctness gain from the chosen verification ladder. */
  estimated_verification_gain: number
  /** SERIAL | SMALL_SWARM | FULL_SWARM | SPECULATIVE_SWARM | PIPELINE | BATCHED_WORKER. */
  recommended_topology: string
  /** Recommended lane count for the chosen topology. */
  recommended_agent_count: number
  /** Recommended provider/model per lane. */
  recommended_models: string[]
  /** Scheduler confidence in the chosen plan, 0.2..0.95. */
  confidence: number
}

export interface Plan {
  runId: string
  createdAt: number
  task: TaskInput
  topology: Topology
  agents: number
  waves: number
  batches: BatchPlan[]
  models: string[]
  verification: VerificationPlan
  estimates: PlanEstimates
  /** Snake_case predictor contract published by this plan (see predictor.ts). */
  predictors: PlanPredictors
  budget: Budget
  reasons: string[]
  warnings: string[]
  schedule?: ScheduleResult
  alternatives: Array<{ topology: Topology; agents: number; seconds: number; reason: string }>
}

export interface Observation {
  ts: number
  runId?: string
  laneId?: string
  provider: string
  model: string
  role: string
  category: Category
  warm: boolean
  startupSeconds: number
  workSeconds: number
  totalSeconds: number
  tokensIn?: number
  tokensOut?: number
  /** Seconds from dispatch to first streamed token, when observed. */
  firstTokenSeconds?: number
  /** Cumulative time spent inside tool calls, when observed. */
  toolSeconds?: number
  /** Provider completion/usage-report latency, separate from lane wall-clock. */
  completionSeconds?: number
  toolCalls?: number
  requests?: number
  retryCount?: number
  failureKind?: string
  branch?: string
  judgeSeconds?: number
  integrationSeconds?: number
  status: ObservationStatus
  source?: string
}

export interface ModelProfile {
  id: string
  provider: string
  quotaGroup: string
  quality: number
  speed: number
  contextLimit: number
  costTier: 0 | 1 | 2 | 3
  strengths: string[]
}

export interface RouteRequest {
  role: string
  category: Category
  contextTokens?: number
  qualityWeight?: number
  warm?: boolean
  exclude?: string[]
}

export interface RouteChoice {
  model: ModelProfile
  score: number
  reasons: string[]
}

export interface RouteDecision {
  choices: RouteChoice[]
  blocked: string[]
  health: Record<string, ProviderState>
}

export interface LaneRecord {
  sessionID: string
  role: string
  model: string
  category: Category
  provider: string
  capsule?: string
  capsuleVersion?: number
  status: "idle" | "busy" | "invalid"
  createdAt: number
  lastUsedAt: number
  expiresAt: number
  uses: number
  maxUses: number
  lastRunId?: string
  reason?: string
}

export interface Finding {
  id: string
  text: string
  confidence?: number
  evidence?: string[]
  source?: string
  branch?: string
}

export interface FindingCluster {
  id: string
  representative: Finding
  members: Finding[]
  evidence: number
  confidence: number
  consensus: boolean
  dissent: boolean
  redundantIds: string[]
}

export interface ConvergenceResult {
  clusters: FindingCluster[]
  keep: string[]
  redundant: string[]
  dissent: string[]
  shouldStop: boolean
  reason: string
  confidence: number
}

export interface CapsuleFact {
  id: string
  key: string
  text: string
  status: "verified" | "hypothesis" | "stale"
  evidence: string[]
  source: string
  addedAt: number
  verifiedAt?: number
}

export interface CapsuleFile {
  path: string
  hash?: string
  note?: string
}

export interface Capsule {
  name: string
  version: number
  revision: number
  createdAt: number
  updatedAt: number
  scope: string
  architecture: string[]
  facts: CapsuleFact[]
  files: CapsuleFile[]
  invariants: string[]
  blockers: string[]
  commands: Array<{ cmd: string; verified: boolean; note?: string }>
  failedApproaches: string[]
  provenance: string[]
}

export interface VerificationInput {
  level?: VerificationLevel
  risk?: number
  disagreement?: number
  confidence?: number
  deterministicTests?: boolean
  testStrength?: number
  impact?: number
  trivial?: boolean
  judgeAvailable?: boolean
  judgeCostSeconds?: number
  workSeconds?: number
  budgetSeconds?: number
}

export interface EffortReport {
  runId: string
  predictedSeconds: number
  actualSeconds: number
  serialSeconds?: number
  speedup?: number
  predictedErrorPct?: number
  workers: number
  usefulWorkers: number
  wastedWorkers: number
  requests: number
  tokensIn: number
  tokensOut: number
  quality?: number
  qualityGain?: number
  verificationSeconds?: number
  startupSeconds?: number
  score: number
  grade: "A" | "B" | "C" | "D" | "F"
  reasons: string[]
}

// ============================================================
// v3: self-improving runtime contracts
// Every store persists a versioned wrapper; unknown versions are
// ignored gracefully (fresh start), never a crash (Req 49).
// Learning records carry NO raw task text and no secrets (Req 48).
// ============================================================

export type SlaMode =
  | "FASTEST"
  | "CHEAPEST"
  | "HIGHEST_QUALITY"
  | "BALANCED"
  | "LOWEST_PROVIDER_RISK"

export type QualityLevel = "standard" | "high" | "maximum"

export type AnytimeStage = "PRELIMINARY" | "VERIFIED" | "FINAL"

export type FailureClass =
  | "logic_failure"
  | "tool_failure"
  | "merge_conflict"
  | "context_failure"
  | "provider_timeout"
  | "rate_limit"
  | "test_flake"
  | "dependency_issue"

/** The 11 skill categories tracked by trust profiles (Req 5). */
export type SkillCategory =
  | "coding"
  | "debugging"
  | "repo_navigation"
  | "math"
  | "planning"
  | "review"
  | "testing"
  | "summarization"
  | "architecture"
  | "classification"
  | "research"

export type EvidenceKind =
  | "deterministic_test"
  | "command_output"
  | "file_line"
  | "derived"
  | "none"

// --- Counterfactuals and regret (Req 1, 2) ---

export interface CounterfactualRecord {
  /** OBSERVED = this ran and was measured. ESTIMATED_COUNTERFACTUAL = inferred, never benchmark evidence. */
  label: "OBSERVED" | "ESTIMATED_COUNTERFACTUAL"
  topology: Topology
  agents: number
  modelMix?: string[]
  verificationLevel?: VerificationLevel
  /** Seconds; for OBSERVED this is the measured wall clock. */
  estimatedRuntime: number
  estimatedQuality?: number
  estimatedCost?: number
  estimatedRisk?: number
  /** 0..1 confidence in the estimate; OBSERVED rows carry 1. */
  confidence: number
  reason: string
}

export interface RegretReport {
  actualCostSeconds: number
  bestAlternative: CounterfactualRecord
  totalRegret: number
  latencyRegret: number
  requestRegret: number
  verificationRegret: number
  providerRegret: number
  agentCountRegret: number
  qualityRegret?: number
  reasons: string[]
}

// --- Branch ROI and dynamic priority (Req 3, 4) ---

export interface BranchRoiInput {
  branchId: string
  /** 0..1 relative value of the remaining unknowns this branch could resolve. */
  expectedInformationGain: number
  /** 0..1 value of finishing this branch at all. */
  expectedCompletionValue: number
  /** 0..1 value of this branch's contribution to verification. */
  expectedVerificationValue: number
  expectedRemainingTime: number
  expectedRequests: number
  providerRisk: number
  branchConfidence: number
  /** 0..1; 1 = unique evidence no other branch covers. */
  branchNovelty: number
  onCriticalPath?: boolean
}

export interface BranchRoi extends BranchRoiInput {
  roi: number
  reason: string
}

export type PriorityActionKind = "PRIORITY_UP" | "PRIORITY_DOWN" | "CANCEL" | "KEEP"

export interface PriorityAction {
  branchId: string
  action: PriorityActionKind
  reason: string
}

// --- Trust profiles (Req 5-8) ---

export interface TrustObservation {
  ts: number
  model: string
  provider?: string
  skillCategory: SkillCategory
  success: boolean
  firstAttemptPass?: boolean
  verificationFailed?: boolean
  hallucinationDetected?: boolean
  toolSuccessRate?: number
  judgeAgreement?: number
  regression?: boolean
  latencySeconds?: number
  tokens?: number
  requests?: number
  reportedConfidence?: number
}

export interface TrustSnapshot {
  model: string
  skillCategory: SkillCategory
  /** Raw observation count in the window. */
  n: number
  /** Decay-weighted effective sample size. */
  nEffective: number
  successRate: number
  firstAttemptPassRate: number
  verificationFailureRate: number
  hallucinationRate: number
  toolSuccessRate: number
  judgeAgreement: number
  regressionRate: number
  avgLatency: number
  avgTokens: number
  avgRequests: number
  /** Decayed, prior-blended, movement-clamped score 0..1. */
  effectiveScore: number
  lastTs: number
}

export interface CalibrationBucket {
  lo: number
  hi: number
  n: number
  meanReported: number
  observedAccuracy: number
  calibrationError: number
}

export interface CalibrationReport {
  buckets: CalibrationBucket[]
  mae: number
  /** mean(observed - reported); positive = workers under-report confidence. */
  bias: number
}

export interface EvidenceWeightInput {
  reportedConfidence: number
  evidenceKinds: EvidenceKind[]
  model: string
  skillCategory?: SkillCategory
}

export interface EvidenceWeightResult {
  rawConfidence: number
  evidenceStrength: number
  historicalReliability: number
  calibratedConfidence: number
  reasons: string[]
}

// --- Diversity-aware consensus (Req 9, 10) ---

export interface CorrelationSignals {
  sharedContextCapsule?: boolean
  sameModel?: boolean
  sameSourceFiles?: boolean
  sameInitialHypothesis?: boolean
  sameUpstreamParent?: boolean
  copiedEvidence?: boolean
  model?: string
  capsule?: string
  sourceFiles?: string[]
  parent?: string
  hypothesis?: string
}

export type CorrelatedFinding = Finding & { correlation?: CorrelationSignals }

export interface DiversityCluster {
  id: string
  representative: string
  members: string[]
  /** Effective independent confirmations; 3 correlated lanes << 3. */
  independentCount: number
  consensusScore: number
  correlatedPairs: Array<[string, string, string[]]>
  consensus: "strong" | "moderate" | "weak"
}

export interface MinorityVerdict {
  findingId: string
  verdict: "redundant_dissent" | "high_value_contradiction"
  reason: string
  preserved: boolean
}

export interface DiversityConsensusResult {
  clusters: DiversityCluster[]
  minority: MinorityVerdict[]
  reasons: string[]
}

// --- Checkpoints, snapshots, selective rollback (Req 11-14) ---

export type CheckpointMilestone =
  | "root_cause_identified"
  | "patch_drafted"
  | "build_complete"
  | "tests_partial"
  | "verification_pending"
  | "complete"

export interface BranchCheckpoint {
  id: string
  runId?: string
  branchId: string
  task?: string
  role?: string
  model?: string
  provider?: string
  capsule?: { name: string; version: number }
  filesInspected: string[]
  hypothesis?: string
  evidence: string[]
  commandsRun: Array<{ cmd: string; ok: boolean }>
  pendingActions: string[]
  /** file -> content as of this milestone (the branch's own edits only). */
  patchState: Record<string, string>
  verificationState: { stage: CheckpointMilestone; testsPassed: number; testsTotal: number }
  /** Completed work this checkpoint preserves; drives resume-vs-restart. */
  workSecondsCompleted: number
  milestone: CheckpointMilestone
  createdAt: number
}

export type ResumeFailureKind =
  | "provider_timeout"
  | "429"
  | "connection_loss"
  | "worker_crash"
  | "model_failure"
  | "unknown"

export interface ResumeDecision {
  branchId: string
  action: "resume" | "restart"
  fromStep?: string
  checkpoint?: BranchCheckpoint
  savedWorkSeconds: number
  reason: string
}

export interface BranchSnapshot {
  id: string
  branchId: string
  runId?: string
  /** Per-file before/after content for this branch's edits only. */
  files: Array<{ path: string; before: string; after: string }>
  createdAt: number
  provenance: string[]
}

// --- Integration planning (Req 15-17) ---

export interface BranchChange {
  branchId: string
  filesChanged: string[]
  symbolsChanged: string[]
  testFiles?: string[]
  /** Symbols this branch consumes but does not define. */
  dependsOnSymbols?: string[]
}

export type ConflictKind = "TEXTUAL" | "SEMANTIC" | "SAFE"

export interface IntegrationConflict {
  kind: ConflictKind
  branches: [string, string]
  files: string[]
  symbols: string[]
  autoResolvable: boolean
  requiresReview: boolean
  reason: string
}

export interface IntegrationPlan {
  order: string[]
  independentBranches: string[]
  conflicts: IntegrationConflict[]
  semanticConflicts: number
  reasons: string[]
}

// --- Bounded self-tuning, shadow policy, overrides (Req 18-22, 50) ---

export interface TunableParameters {
  initialFanout: number
  maxFanout: number
  warmLanePoolSize: number
  microtaskBatchThreshold: number
  verificationThreshold: number
  convergenceThreshold: number
  hedgeDelaySeconds: number
  branchRoiKillThreshold: number
  confidenceEscalationThreshold: number
  providerWeights: Record<string, number>
}

export interface PolicyVersion {
  version: number
  parameters: TunableParameters
  createdAt: number
  promotedAt?: number
  promotionReason?: string
  rollbackReason?: string
  shadowStats?: { n: number; activeMae?: number; shadowMae?: number }
  status: "active" | "rolled_back" | "shadow"
}

export interface SelfTuneProposal {
  parameter: keyof TunableParameters
  from: number
  to: number
  n: number
  /** Fraction of window observations supporting the direction. */
  directionalConsistency: number
  ciLow: number
  ciHigh: number
  reason: string
  accepted: boolean
}

export interface PromotionGate {
  eligible: boolean
  reasons: string[]
  nRuns: number
  improvementPct?: number
}

export interface ManualOverride {
  forceTopology?: Topology
  forceAgents?: number
  forceProvider?: string
  disableLearning?: boolean
  disableCheckpoints?: boolean
  disableCounterfactuals?: boolean
  disableTrustHistory?: boolean
  disableSelfTuning?: boolean
  reason?: string
}

// --- SLA modes, deadline honesty, anytime stages (Req 23-26) ---

export interface SlaProfile {
  mode: SlaMode
  fanoutFactor: number
  qualityWeight: number
  /** -1..1; negative biases toward cheaper verification. */
  verificationBias: number
  costSensitivity: number
  providerSpread: number
  hedgeDelayFactor: number
  reasons: string[]
}

export interface DeadlineCheck {
  plausible: boolean
  deadlineSeconds: number
  estimatedFastestSeconds: number
  slackSeconds: number
  reason: string
}

export type DeadlineAction =
  | "prioritize_critical_path"
  | "reduce_low_value_branches"
  | "increase_parallelism"
  | "reserve_verification"
  | "skip_optional_work"

export interface DeadlinePressure {
  /** 0..1. */
  pressure: number
  actions: DeadlineAction[]
  reason: string
}

export interface AnytimeResult {
  stage: AnytimeStage
  label: string
  safeToExpose: boolean
  reason: string
}

// --- Straggler prediction and hedged execution (Req 27, 28) ---

export interface StragglerInput {
  branchId: string
  elapsedSeconds: number
  expectedSeconds: number
  providerLatencyP90Seconds?: number
  /** Seconds since the last observable progress event. */
  lastProgressSeconds?: number
  progressEvents?: number
  toolActivity?: number
}

export type StragglerAction = "continue" | "checkpoint" | "split" | "hedge" | "replace" | "cancel"

export interface StragglerAssessment {
  branchId: string
  stragglerRisk: number
  action: StragglerAction
  reason: string
}

export interface HedgeDecision {
  hedge: boolean
  reason: string
  expectedCostSeconds: number
  expectedBenefitSeconds: number
}

// --- Opt-in chaos and recovery assertions (Req 29, 30) ---

export type ChaosKind =
  | "429"
  | "timeout"
  | "ECONNRESET"
  | "slow_provider"
  | "malformed_response"
  | "worker_crash"
  | "late_notification"
  | "duplicate_completion"
  | "lost_log_event"
  | "partial_tool_failure"

export interface ChaosInjection {
  kind: ChaosKind
  target?: string
  delaySeconds?: number
  note?: string
}

export interface RecoveryAssertions {
  duplicateCommits: string[]
  lostProvenance: string[]
  excessiveRetries: Array<{ branchId: string; retries: number }>
  workspaceCorruption: string[]
  orphanWorkers: string[]
  incorrectPass: string[]
  clean: boolean
}

// --- Dashboards and grades (Req 41-45) ---

export interface CalibrationDashboard {
  serialTimeMae: number
  serialTimeMape: number
  serialTimeBias: number
  swarmTimeMae: number
  swarmTimeMape: number
  swarmTimeBias: number
  speedupMae: number
  confidenceCalibration: CalibrationReport
  agentCountRegretP50: number
  verificationRegretP50: number
  n: number
}

export interface SchedulerDashboard {
  runs: number
  serialDecisions: number
  swarmDecisions: number
  /** Fraction of runs where the chosen topology was best in hindsight. */
  correctStrategyRate: number
  averageSpeedup: number
  medianSpeedup: number
  p95Speedup: number
  averageWastedBranches: number
  warmLaneHitRate: number
  verificationSkipRate: number
  providerRecoveries: number
}

export interface WasteBreakdown {
  duplicateWorkSeconds: number
  cancelledWorkSeconds: number
  failedWorkSeconds: number
  unusedSpeculativeSeconds: number
  excessVerificationSeconds: number
  providerRetryWasteSeconds: number
  contextReloadWasteSeconds: number
  totalWasteSeconds: number
}

export interface MultiDimensionGrade {
  correctness: number
  speed: number
  predictionAccuracy: number
  workerEfficiency: number
  providerEfficiency: number
  verificationEfficiency: number
  recoveryQuality: number
  waste: number
  composite: number
  grade: "A" | "B" | "C" | "D" | "F"
  raw: Record<string, unknown>
  reasons: string[]
}

// --- Failure-class forecast, info-gain, critical path, opportunity cost (Req 34-37) ---

export type FailureClassRisk = Record<FailureClass, number>

export interface InformationGainOption {
  id: string
  costSeconds: number
  /** Hypothesis ids this experiment can separate. */
  distinguishes: string[]
  discriminationPower: number
}

export interface InformationGainChoice {
  chosen: string | null
  expectedReduction: number
  reason: string
}

export interface CriticalPathNode {
  id: string
  remainingTime: number
  downstreamBlockedWork: number
  slack: number
  critical: boolean
}

export interface CriticalPathReport {
  criticalPath: string[]
  estimatedCriticalPathTime: number
  nodes: CriticalPathNode[]
}

export interface OpportunityCost {
  seconds: number
  reason: string
}

// --- Run history and task-shape baselines (Req 40, 48, 49) ---

export type TaskShape =
  | "microtask"
  | "small_serial"
  | "batched_microtasks"
  | "medium_branch"
  | "large_parallel"
  | "ambiguous_debug"
  | "high_verification"
  | "tool_heavy"
  | "code_write"
  | "research"

export interface CompletedRun {
  ts: number
  runId: string
  shape: TaskShape
  category: Category
  topology: Topology
  agents: number
  predictedSerialSeconds: number
  predictedChosenSeconds: number
  actualSeconds: number
  quality?: number
  requests?: number
  workers?: number
  usefulWorkers?: number
  wastedWorkers?: number
  verificationSeconds?: number
  verificationLevel?: VerificationLevel
  providerFailures?: number
  status: ObservationStatus
  provider: string
  model: string
  sla?: SlaMode
  hedgeUsed?: boolean
  checkpointResumed?: boolean
  chaos?: boolean
}

export interface ShapeBaseline {
  shape: TaskShape
  n: number
  p50Seconds: number
  p90Seconds: number
  successRate: number
}

export interface RunActuals {
  runId: string
  actualSeconds: number
  requests?: number
  verificationSeconds?: number
  verificationLevel?: VerificationLevel
  quality?: number
  targetQuality?: number
  agents?: number
  workers?: number
  usefulWorkers?: number
  wastedWorkers?: number
  provider?: string
  model?: string
  status?: ObservationStatus
  hedgeUsed?: boolean
  checkpointResumed?: boolean
  chaos?: boolean
  duplicateWorkSeconds?: number
  cancelledWorkSeconds?: number
  failedWorkSeconds?: number
  unusedSpeculativeSeconds?: number
  excessVerificationSeconds?: number
  providerRetryWasteSeconds?: number
  contextReloadWasteSeconds?: number
}

// --- Provider portfolio and reliability (Batch 6) ---

export interface ProviderReliability {
  provider: string
  state: ProviderState
  failures: number
  opens: number
  cooldownRemaining: number
  lastKind?: string
  lastFailureAt?: number
  lastSuccessAt?: number
  /** Failures per observation (0..1), blended with a prior from the learned cost model. */
  failureRate: number
  /** 429 rate per observation (0..1). */
  rate429: number
  /** Times the circuit recovered from open/half_open back to closed. */
  recoveryCount: number
  /** Composite reliability 0..1 (higher = more reliable). */
  reliabilityScore: number
}

export interface PortfolioReport {
  providers: ProviderReliability[]
  totalProviders: number
  openCount: number
  halfOpenCount: number
  closedCount: number
  aggregateFailureRate: number
  aggregateRate429: number
  /** Provider with the highest reliabilityScore (null when no providers). */
  mostReliable: string | null
  /** Provider with the lowest reliabilityScore (null when no providers). */
  leastRisky: string | null
  grade: "A" | "B" | "C" | "D" | "F"
}

// --- Explainability (Req 51) ---

export interface DecisionRecord {
  ts: number
  runId?: string
  decision: string
  kind: string
  reasons: string[]
  data?: Record<string, unknown>
}
