// ─── Gestalt Principles ─────────────────────────────────────────
export enum GestaltPrinciple {
  CLOSURE = 'closure',
  PROXIMITY = 'proximity',
  SIMILARITY = 'similarity',
  FIGURE_GROUND = 'figure_ground',
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

// ─── Seed ───────────────────────────────────────────────────────
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

export interface SeedMetadata {
  seedId: string;
  interviewSessionId: string;
  ambiguityScore: number;
  generatedAt: string;
}

export interface Seed {
  version: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  ontologySchema: OntologySchema;
  gestaltAnalysis: GestaltAnalysis[];
  metadata: SeedMetadata;
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
