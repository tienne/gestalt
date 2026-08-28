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
  label: string; // Korean display name, e.g. "목표 명확성"
  improvementHint: string; // Dimension-specific hint for improving the score
}

export interface ResolutionScore {
  overall: number; // 0.0-1.0 (higher = clearer)
  dimensions: ResolutionDimension[];
  isReady: boolean; // overall >= RESOLUTION_THRESHOLD
  contradictions?: string[]; // Detected contradictions during interview
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
  contradictions?: string[]; // 이 라운드 응답 채점 시 감지된 모순
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
  resolutionScore: number | null;
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

export type TaskModel = 'haiku' | 'sonnet' | 'opus';

export interface AtomicTask {
  taskId: string;
  title: string;
  description: string;
  sourceAC: number[];
  isImplicit: boolean;
  estimatedComplexity: 'low' | 'medium' | 'high';
  dependsOn: string[];
  /**
   * Optional model hint for Passthrough execution. When set, Claude Code is
   * advised to spawn a sub-agent with this model via the Agent tool. Auto-assigned
   * at plan completion based on task complexity and intent.
   */
  model?: TaskModel;
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
  status: 'OK' | 'WARNING' | 'CRITICAL';
  threshold: number;
  hint: string;
}

export interface RetrospectiveResult {
  taskId: string;
  driftScore: DriftScore;
  causeAnalysis: string;
  correctionSuggestions: string[];
}

// ─── Evolution Loop ───────────────────────────────────────────
export type EvolveStage = 'fix' | 'patch' | 're_executing' | 'lateral';
export type TerminationReason =
  | 'success'
  | 'stagnation'
  | 'oscillation'
  | 'hard_cap'
  | 'caller'
  | 'human_escalation';

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
  /** 지금 동시에 착수 가능한 태스크 집합. nextTaskId는 이 배열의 첫 원소와 항상 일치한다. */
  nextTaskIds: string[];
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
  /** 지금 동시에 착수 가능한 태스크 집합. nextTaskId는 nextTaskIds[0]에서 파생된다. */
  nextTaskIds: string[];
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
export type AgentPipeline = 'interview' | 'spec' | 'execute' | 'evaluate' | 'review' | 'persona';
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
export type ReviewSessionStatus =
  | 'started'
  | 'reviewing'
  | 'consensus'
  | 'fixing'
  | 'passed'
  | 'escalated'
  | 'failed_with_report';

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

/** 정합 심급이 판단하는 세 축. goal=목표 정합, consistency=일관성, drift=이탈. */
export type ContinuityAxis = 'goal' | 'consistency' | 'drift';

export interface ContinuityDriftFinding {
  axis: ContinuityAxis;
  file?: string;
  message: string;
}

/**
 * 정합 심급(continuity-judge)의 판정.
 * 결함 심급이 국소 결함을 검출하는 것과 독립적으로, 변경 전체가 목표를
 * 향하는지·일관된지·drift가 없는지를 종합 판단한다.
 * coherent=false면 결함이 없어도 리뷰를 Block한다.
 * escalate=true면 라인 수정(review_fix) 대상이 아니라 스펙·설계 재검토 신호다.
 */
export interface ContinuityVerdict {
  coherent: boolean;
  driftFindings: ContinuityDriftFinding[];
  escalate: boolean;
  summary: string;
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
  spec?: Spec;
  taskResults?: TaskExecutionResult[];
}

/**
 * review_publish가 PR에 무엇까지 썼는지 남기는 자국.
 *
 * PR은 이벤트 소싱이라 한 번 쓴 코멘트를 지울 수 없다. 그래서 같은 합의를 두 번
 * 옮기면 코멘트가 복제되고 되돌릴 방법이 없다. publish는 코멘트 N건을 쓰고 마지막에
 * 판정 하나를 쓰는 다중 쓰기라 원자적으로 만들 수 없다. 대신 어디까지 썼는지를 여기
 * 남겨서, 다시 부르면 그 다음부터 잇는다.
 *
 * 자국은 리뷰 세션과 수명이 같다(메모리). publish는 세션의 합의가 있어야 도는 액션이라
 * 세션이 사라지면 publish도 못 돈다. 방어 범위와 액션의 범위가 같다.
 */
export interface ReviewPublishState {
  prId: string;
  /** publish를 시작할 때의 PR head. head가 옮겨가면 새 라운드라 처음부터 다시 쓴다. */
  headSha: string;
  /**
   * 옮긴 합의의 지문.
   *
   * 자국을 버리는 기준은 `review_consensus`를 다시 불렀는지가 아니라 옮길 내용이
   * 바뀌었는지다. 호출을 기준으로 삼으면 같은 합의를 다시 제출한 것만으로 자국이
   * 날아가 코멘트가 복제된다. 호스트가 재시도하는 단위가 publish 한 호출이라는
   * 보장이 없다. 리뷰 스킬처럼 consensus와 publish를 잇달아 부르는 흐름이 그 자리를
   * 밟는다.
   */
  issuesKey: string;
  /** 이 head에서 PR에 이미 쓴 의견 수. 합의 목록의 앞에서부터 이만큼이다. */
  postedCount: number;
  /** 판정까지 써서 한 바퀴가 끝났는지 */
  completed: boolean;
  /** 끝난 바퀴가 남긴 판정. completed일 때만 뜻이 있다. */
  verdict: 'approve' | 'request_changes';
  /** 판정을 남긴 리뷰어 */
  reviewer: string;
}

export interface ReviewSession {
  sessionId: string;
  executeSessionId: string;
  status: ReviewSessionStatus;
  currentAttempt: number;
  maxAttempts: number;
  reviewContext?: ReviewContext;
  /** 이슈 라인의 코드 스니펫을 읽을 기준 경로. 없으면 cwd로 폴백한다. */
  repoRoot?: string;
  /** 이 리뷰가 로컬 PR에서 시작했으면 그 PR id. 합의 결과를 되돌려 쓸 자리다. */
  prId?: string;
  /** review_publish가 PR에 쓴 진행 상태. 재실행 방어와 중단 재개의 근거다. */
  publishState?: ReviewPublishState;
  matchedAgents: string[];
  reviewResults: ReviewResult[];
  consensus?: ReviewConsensusResult;
  continuityVerdict?: ContinuityVerdict;
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

export interface ArchitectureDecision {
  decision: string;
  rationale: string;
  outcome?: string;
  specId: string;
  timestamp: string;
}

export interface ProjectMemory {
  version: string;
  repoRoot: string;
  specHistory: SpecHistoryEntry[];
  executionHistory: MemoryExecutionRecord[];
  architectureDecisions: ArchitectureDecision[];
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

// ─── Shared Response Helpers ────────────────────────────────────
export interface NextActionGuide {
  nextAction: string;
  nextActionParams?: Record<string, unknown>;
  hint: string;
}

export interface ProgressInfo {
  completed: number;
  total: number;
  percent: number;
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
