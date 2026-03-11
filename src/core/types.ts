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

export interface AmbiguityDimension {
  name: string;
  clarity: number; // 0.0-1.0
  weight: number;
  gestaltPrinciple: GestaltPrinciple;
}

export interface AmbiguityScore {
  overall: number; // 0.0-1.0 (lower = clearer)
  dimensions: AmbiguityDimension[];
  isReady: boolean; // overall <= AMBIGUITY_THRESHOLD
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

export interface InterviewSession {
  sessionId: string;
  topic: string;
  status: InterviewStatus;
  projectType: ProjectType;
  rounds: InterviewRound[];
  ambiguityScore: AmbiguityScore | null;
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
  ambiguityScore: number;
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
export type EvolveStage = 'fix' | 'patch' | 're_executing';
export type TerminationReason = 'success' | 'stagnation' | 'oscillation' | 'hard_cap' | 'caller';

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

export interface ExecuteSession {
  sessionId: string;
  specId: string;
  spec: Spec;
  status: ExecuteStatus;
  currentStep: number;
  planningSteps: PlanningStepResult[];
  executionPlan?: ExecutionPlan;
  taskResults: TaskExecutionResult[];
  evaluateStage?: EvaluateStage;
  structuralResult?: StructuralResult;
  evaluationResult?: EvaluationResult;
  driftHistory: DriftScore[];
  // Evolution Loop
  evolutionHistory: EvolutionGeneration[];
  currentGeneration: number;
  evolveStage?: EvolveStage;
  terminationReason?: TerminationReason;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent ──────────────────────────────────────────────────────
export type AgentTier = 'frugal' | 'standard' | 'frontier';
export type AgentPipeline = 'interview' | 'spec' | 'execute' | 'evaluate';
export type LLMProvider = 'anthropic' | 'openai';

export interface AgentFrontmatter {
  name: string;
  model?: string;
  tier: AgentTier;
  pipeline: AgentPipeline;
  escalateTo?: string;
  description: string;
}

export interface AgentDefinition {
  frontmatter: AgentFrontmatter;
  systemPrompt: string;
  filePath: string;
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
