// ─── Gestalt Principles ─────────────────────────────────────────
export enum GestaltPrinciple {
  /** 폐쇄성: 불완전한 정보를 완성하려는 경향. 명시되지 않은 암묵적 요구사항을 찾아낸다. */
  CLOSURE = 'closure',
  /** 근접성: 가까이 있는 요소를 하나의 그룹으로 인식하는 경향. 관련된 요구사항끼리 자연스럽게 묶는다. */
  PROXIMITY = 'proximity',
  /** 유사성: 비슷한 요소를 같은 그룹으로 인식하는 경향. 요구사항 간 반복되는 패턴을 식별한다. */
  SIMILARITY = 'similarity',
  /** 전경 / 배경: 핵심(전경)과 부수적 요소(배경)를 분리하는 경향. MVP 범위와 선택사항을 구분한다. */
  FIGURE_GROUND = 'figure_ground',
  /** 연속성: 요소들이 일관된 방향으로 이어진다고 인식하는 경향. 요구사항 간 모순을 교차 검증한다. */
  CONTINUITY = 'continuity',
}

export interface ResolutionDimension {
  name: string;
  clarity: number; // 0.0-1.0
  weight: number;
  gestaltPrinciple: GestaltPrinciple;
}

export interface ResolutionScore {
  overall: number; // 0.0-1.0 (higher = clearer)
  dimensions: ResolutionDimension[];
  isReady: boolean; // overall >= RESOLUTION_THRESHOLD
}

export interface GestaltAnalysis {
  principle: GestaltPrinciple;
  finding: string;
  confidence: number;
}

// ─── Interview ──────────────────────────────────────────────────
export type InterviewStatus = 'in_progress' | 'completed' | 'aborted';
export type ProjectType = 'greenfield' | 'brownfield';

export interface InterviewRound {
  roundNumber: number;
  question: string;
  userResponse: string | null;
  gestaltFocus: GestaltPrinciple;
  timestamp: string;
}

export interface CompressedContext {
  summary: string;
  compressedAt: string;
  roundsCompressed: number;
}

export interface InterviewSession {
  sessionId: string;
  topic: string;
  status: InterviewStatus;
  projectType: ProjectType;
  rounds: InterviewRound[];
  resolutionScore: ResolutionScore | null;
  compressedContext?: CompressedContext;
  createdAt: string;
  updatedAt: string;
}

// ─── Spec ───────────────────────────────────────────────────────
export interface OntologyEntity {
  name: string;
  description: string;
  attributes: string[];
}

export interface OntologyRelation {
  from: string;
  to: string;
  type: string;
}

export interface OntologySchema {
  entities: OntologyEntity[];
  relations: OntologyRelation[];
}

export interface SpecMetadata {
  specId: string;
  interviewSessionId: string;
  resolutionScore: number;
  generatedAt: string;
}

export interface Spec {
  version: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  ontologySchema: OntologySchema;
  gestaltAnalysis: GestaltAnalysis[];
  metadata: SpecMetadata;
}

// ─── Skills ─────────────────────────────────────────────────────
export interface SkillFrontmatter {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  inputs: Record<string, SkillInput>;
  outputs: string[];
}

export interface SkillInput {
  type: string;
  required: boolean;
  description: string;
}

export interface SkillDefinition {
  frontmatter: SkillFrontmatter;
  body: string;
  filePath: string;
}

// ─── Execute ────────────────────────────────────────────────────
export type ExecuteStatus = 'planning' | 'plan_complete' | 'executing' | 'completed' | 'failed';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type ACClassification = 'figure' | 'ground';

export interface ClassifiedAC {
  acIndex: number;
  acText: string;
  classification: ACClassification;
  priority: TaskPriority;
  reasoning: string;
}

export interface AtomicTask {
  taskId: string;
  title: string;
  description: string;
  sourceAC: number[];
  isImplicit: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
  dependsOn: string[];
}

export interface TaskGroup {
  groupId: string;
  name: string;
  domain: string;
  taskIds: string[];
  reasoning: string;
}

export interface DAGValidation {
  isValid: boolean;
  hasCycles: boolean;
  cycleDetails?: string[];
  hasConflicts: boolean;
  conflictDetails?: string[];
  topologicalOrder: string[];
  criticalPath: string[];
}

export interface FigureGroundResult {
  principle: 'figure_ground';
  classifiedACs: ClassifiedAC[];
}

export interface ClosureResult {
  principle: 'closure';
  atomicTasks: AtomicTask[];
}

export interface ProximityResult {
  principle: 'proximity';
  taskGroups: TaskGroup[];
}

export interface ContinuityResult {
  principle: 'continuity';
  dagValidation: DAGValidation;
}

export type PlanningStepResult =
  | FigureGroundResult
  | ClosureResult
  | ProximityResult
  | ContinuityResult;

export interface ExecutionPlan {
  planId: string;
  specId: string;
  classifiedACs: ClassifiedAC[];
  atomicTasks: AtomicTask[];
  taskGroups: TaskGroup[];
  dagValidation: DAGValidation;
  parallelGroups: string[][];
  createdAt: string;
}

// ─── Execution Phase ────────────────────────────────────────────
export type TaskExecutionStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface TaskExecutionResult {
  taskId: string;
  status: TaskExecutionStatus;
  output: string;
  artifacts: string[];
}

// ─── Evaluate Phase ─────────────────────────────────────────────
export type EvaluateStage = 'structural' | 'contextual' | 'complete';

export interface StructuralCommand {
  name: string;
  command: string;
}

export interface StructuralCommandResult {
  name: string;
  command: string;
  exitCode: number;
  output: string;
}

export interface StructuralResult {
  commands: StructuralCommandResult[];
  allPassed: boolean;
}

export interface ACVerification {
  acIndex: number;
  satisfied: boolean;
  evidence: string;
  gaps: string[];
}

export interface EvaluationResult {
  verifications: ACVerification[];
  overallScore: number; // 0.0-1.0
  goalAlignment: number; // 0.0-1.0, Spec goal과의 정합성
  recommendations: string[];
}

// ─── Drift Detection ───────────────────────────────────────────
export interface DriftDimension {
  name: 'goal' | 'constraint' | 'ontology';
  score: number; // 0.0-1.0 (higher = more drift)
  detail: string;
}

export interface DriftScore {
  taskId: string;
  overall: number; // weighted sum of dimensions
  dimensions: DriftDimension[];
  thresholdExceeded: boolean;
}

export interface RetrospectiveResult {
  taskId: string;
  driftScore: DriftScore;
  causeAnalysis: string;
  correctionSuggestions: string[];
}

// ─── Evolution Loop ───────────────────────────────────────────
export type EvolveStage = 'fix' | 'patch' | 're_executing' | 'lateral';
export type TerminationReason = 'success' | 'stagnation' | 'oscillation' | 'hard_cap' | 'caller' | 'human_escalation';

export interface SpecPatch {
  acceptanceCriteria?: string[];
  constraints?: string[];
  ontologySchema?: {
    entities?: OntologyEntity[];
    relations?: OntologyRelation[];
  };
}

export interface SpecDelta {
  fieldsChanged: string[];
  similarity: number; // 0.0-1.0, Jaccard similarity between old and new Spec
  generation: number;
}

export interface FixTask {
  taskId: string;
  failedCommand: string;
  errorOutput: string;
  fixDescription: string;
  artifacts: string[];
}

export interface TerminationCondition {
  reason: TerminationReason;
  scoreHistory: number[];
  stagnationDetected: boolean;
  oscillationDetected: boolean;
  hardCapReached: boolean;
}

export interface EvolutionGeneration {
  generation: number;
  spec: Spec;
  evaluationScore: number;
  goalAlignment: number;
  delta: SpecDelta;
  terminationReason?: TerminationReason;
}

export interface ResumeContext {
  completedTaskIds: string[];
  nextTaskId: string | null;
  totalTasks: number;
  progressPercent: number;
}

export interface AuditResult {
  implementedACs: number[];
  partialACs: number[];
  missingACs: number[];
  gapAnalysis: string;
  auditedAt: string;
}

export interface SubTask {
  taskId: string;
  parentTaskId: string;
  title: string;
  description: string;
  inheritedContext: string;
  dependsOn: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: string;
}

export interface ExecuteSession {
  sessionId: string;
  specId: string;
  spec: Spec;
  status: ExecuteStatus;
  currentStep: number;
  planningSteps: PlanningStepResult[];
  executionPlan?: ExecutionPlan;
  taskResults: TaskExecutionResult[];
  completedTaskIds: string[];
  nextTaskId: string | null;
  subTasks: SubTask[];
  auditResult?: AuditResult;
  evaluateStage?: EvaluateStage;
  structuralResult?: StructuralResult;
  evaluationResult?: EvaluationResult;
  driftHistory: DriftScore[];
  // Evolution Loop
  evolutionHistory: EvolutionGeneration[];
  currentGeneration: number;
  evolveStage?: EvolveStage;
  terminationReason?: TerminationReason;
  // Lateral Thinking
  lateralTriedPersonas: string[];
  lateralAttempts: number;
  lateralCurrentPersona?: string;
  lateralCurrentPattern?: string;
  // Role Agent System
  roleMatches?: RoleMatch[];
  roleConsensus?: RoleConsensus;
  // Blast-radius based test filtering
  codeGraphRepoRoot?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent ──────────────────────────────────────────────────────
export type AgentTier = 'frugal' | 'standard' | 'frontier';
export type AgentPipeline = 'interview' | 'spec' | 'execute' | 'evaluate' | 'review';
export type LLMProvider = 'anthropic' | 'openai';

export interface AgentFrontmatter {
  name: string;
  model?: string;
  tier: AgentTier;
  pipeline: AgentPipeline;
  escalateTo?: string;
  description: string;
  role?: boolean;
  domain?: string[];
}

export interface AgentDefinition {
  frontmatter: AgentFrontmatter;
  systemPrompt: string;
  filePath: string;
}

// ─── Role Agent System ─────────────────────────────────────────
export interface RoleMatch {
  agentName: string;
  domain: string[];
  relevanceScore: number;
  reasoning: string;
}

export interface RolePerspective {
  agentName: string;
  perspective: string;
  confidence: number;
}

export interface RoleConsensus {
  consensus: string;
  conflictResolutions: string[];
  perspectives: RolePerspective[];
}

export interface RoleGuidance {
  agents: RolePerspective[];
  consensus: string;
  conflictResolutions: string[];
}

// ─── Code Review System ─────────────────────────────────────────
export type ReviewIssueSeverity = 'critical' | 'high' | 'warning';
export type ReviewSessionStatus = 'started' | 'reviewing' | 'consensus' | 'fixing' | 'passed' | 'failed_with_report';

export interface ReviewIssue {
  id: string;
  severity: ReviewIssueSeverity;
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion: string;
  reportedBy: string;
}

export interface ReviewResult {
  agentName: string;
  issues: ReviewIssue[];
  approved: boolean;
  summary: string;
}

export interface ReviewConsensusResult {
  mergedIssues: ReviewIssue[];
  approvedBy: string[];
  blockedBy: string[];
  summary: string;
  overallApproved: boolean;
}

export interface ReviewReport {
  markdown: string;
  generatedAt: string;
  attempt: number;
  passed: boolean;
}

export interface ReviewContext {
  changedFiles: string[];
  dependencyFiles: string[];
  spec: Spec;
  taskResults: TaskExecutionResult[];
}

export interface ReviewSession {
  sessionId: string;
  executeSessionId: string;
  status: ReviewSessionStatus;
  currentAttempt: number;
  maxAttempts: number;
  reviewContext?: ReviewContext;
  matchedAgents: string[];
  reviewResults: ReviewResult[];
  consensus?: ReviewConsensusResult;
  reports: ReviewReport[];
  createdAt: string;
  updatedAt: string;
}

// ─── Spec Templates ─────────────────────────────────────────────
export interface SpecTemplate {
  id: string;
  name: string;
  description: string;
  baseConstraints: string[];
  baseAcceptanceCriteria: string[];
  baseOntologyEntities: string[];
}

// ─── Project Memory ─────────────────────────────────────────────
export type TextInputSourceType = 'text' | 'jira' | 'github_issue';

export interface TextInputSource {
  type: TextInputSourceType;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SpecHistoryEntry {
  specId: string;
  goal: string;
  createdAt: string;
  interviewSessionId?: string;
  sourceType: TextInputSourceType | 'interview';
}

export interface MemoryExecutionRecord {
  executeSessionId: string;
  specId: string;
  completedTasks: string[];
  failedTasks: string[];
  resultSummary: string;
  completedAt: string;
}

export interface CompressedContextEntry {
  sessionId: string;
  summary: string;
  compressedAt: string;
}

export interface ProjectMemory {
  version: string;
  repoRoot: string;
  specHistory: SpecHistoryEntry[];
  executionHistory: MemoryExecutionRecord[];
  architectureDecisions: string[];
  compressedContexts?: CompressedContextEntry[];
  lastUpdated: string;
}

export interface UserProfile {
  userId?: string;
  preferredModel?: string;
  crossRepoPatterns: string[];
  personalPreferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── Events ─────────────────────────────────────────────────────
export interface DomainEvent<T = unknown> {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: T;
  timestamp: string;
  createdAt: string;
}

// ─── Recording ──────────────────────────────────────────────────

/** 단일 터미널 출력 프레임 — NDJSON으로 .frames 파일에 append */
export interface TerminalFrame {
  timestamp: number;    // Date.now() ms
  data: string;         // ANSI 포함 raw 출력 데이터
  cols: number;
  rows: number;
}

/** 하나의 연속 녹화 구간 (.frames 파일 1개에 대응) */
export interface RecordingSegment {
  sessionId: string;
  framesPath: string;   // .gestalt/recordings/{sessionId}.frames
  startedAt: number;    // timestamp ms
  endedAt?: number;
}

/** 활성 녹화 세션 상태 */
export interface RecordingSession {
  sessionId: string;
  segments: RecordingSegment[];
  isRecording: boolean;
  isResuming: boolean;
}

/** GIF 생성 결과 */
export interface GifOutput {
  filePath: string;
  sizeBytes: number;
  frameCount: number;
  durationMs: number;
}
