// ReferenceCandidate
export const REFERENCE_CANDIDATE_KINDS = [
  'selfContamination',
  'copyDrift',
  'forwardRef',
  'backwardRef',
  'knowledgeDoc',
  'ruleIdListGap',
  'ruleOverlap',
] as const;

export type ReferenceCandidateKind = (typeof REFERENCE_CANDIDATE_KINDS)[number];

export interface ReferenceCandidate {
  kind: ReferenceCandidateKind;
  sourceFile: string;
  sourceLine: number;
  targetRepo: string;
  targetPath: string;
  /** 대상 파일에서 걸린 줄. 파일 단위로만 짝을 짓는 후보는 없다 */
  targetLine?: number;
  matchedText: string;
  contextLines: string[];
  needsLlmJudgment: boolean;
}

// Identifier
export const IDENTIFIER_KINDS = [
  'path',
  'heading',
  'ruleId',
  'skillName',
  'agentName',
  'uniqueFileName',
  'pluginName',
  'packageName',
  'mcpToolName',
  'responseField',
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export const CHANGE_TYPES = ['removed', 'renamed', 'modified'] as const;

export type ChangeType = (typeof CHANGE_TYPES)[number];

export const EXTRACTED_BY_TYPES = ['pattern', 'llm'] as const;

export type ExtractedByType = (typeof EXTRACTED_BY_TYPES)[number];

export interface Identifier {
  kind: IdentifierKind;
  value: string;
  changeType: ChangeType;
  extractedBy: ExtractedByType;
}

// Placeholder
export const RESOLUTION_STATUSES = ['single', 'multiple', 'none'] as const;

export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export interface Placeholder {
  token: string;
  definingFile: string;
  resolvedRepo?: string;
  resolutionStatus: ResolutionStatus;
}

// RelatedRepo
export const DISCOVERED_BY_TYPES = ['forwardMention', 'backwardSearch', 'config'] as const;

export type DiscoveredByType = (typeof DISCOVERED_BY_TYPES)[number];

export interface RelatedRepo {
  owner: string;
  name: string;
  discoveredBy: DiscoveredByType;
  defaultBranch: string;
  lastDetectedAt: Date | null;
}

// DetectionCache
export interface DetectionCache {
  relatedRepos: RelatedRepo[];
  identifiers: Identifier[];
  harnessDocsHash: string;
  expiresAt: Date;
}

// SearchBackend
export const SEARCH_BACKEND_KINDS = ['githubSearch', 'localClone'] as const;

export type SearchBackendKind = (typeof SEARCH_BACKEND_KINDS)[number];

export interface SearchBackend {
  kind: SearchBackendKind;
  capabilities: Record<string, unknown>;
  rateLimitState?: Record<string, unknown>;
}

// RelatedPR
export const PR_STATES = ['open', 'merged', 'closed'] as const;

export type PrState = (typeof PR_STATES)[number];

export const FOUND_BY_TYPES = [
  'bodyLink',
  'ticketKey',
  'touchesTarget',
  'sameAuthorNearby',
] as const;

export type FoundByType = (typeof FOUND_BY_TYPES)[number];

/**
 * inDefaultBranch: 확정할 근거는 없지만 이미 그 레포 기본 브랜치에 머지됐다.
 * 세 상태 판정의 main 쪽에 벌써 들어 있어 묻지 않고 판정 근거로 따로 쓰지도 않는다
 */
export const CONFIRMATION_TYPES = [
  'confirmed',
  'needsShipConfirm',
  'needsAuthorAnswer',
  'inDefaultBranch',
] as const;

export type ConfirmationType = (typeof CONFIRMATION_TYPES)[number];

/** 답이나 확인을 기다리는 후보인가. 이 후보가 있으면 approve를 확정하지 못한다 */
export function isAwaitingConfirmation(confirmation: ConfirmationType): boolean {
  return confirmation === 'needsShipConfirm' || confirmation === 'needsAuthorAnswer';
}

export interface RelatedPR {
  repo: string;
  number: number;
  headSha: string;
  state: PrState;
  mergedBranch?: string;
  foundBy: FoundByType;
  confirmation: ConfirmationType;
}

// ThreeStateVerdict
export const SINGLE_STATE_VALUES = ['ok', 'broken'] as const;

export type SingleStateValue = (typeof SINGLE_STATE_VALUES)[number];

export const VERDICT_TYPES = ['notDefect_mergeOrder', 'defect', 'relatedRemovesUsed'] as const;

export type VerdictType = (typeof VERDICT_TYPES)[number];

export interface ThreeStateVerdict {
  identifier: Identifier;
  onMain: SingleStateValue;
  onRelatedHead: SingleStateValue;
  afterBothMerged: SingleStateValue;
  verdict: VerdictType;
  notifyRepos: string[];
}

// ReviewRound
export const USER_CHOICE_TYPES = ['proceedWithoutRefs', 'wait'] as const;

export type UserChoiceType = (typeof USER_CHOICE_TYPES)[number];

export const POSTED_EVENT_TYPES = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const;

export type PostedEventType = (typeof POSTED_EVENT_TYPES)[number];

export interface ReviewRound {
  roundNumber: number;
  lookupBlocked: boolean;
  noGitHubRemote: boolean;
  relatedPrUnconfirmed: boolean;
  referenceCheckSkipped: boolean;
  userChoice?: UserChoiceType;
  explicitApproveInstruction?: boolean;
  postedEvent?: PostedEventType;
}

// ApproveGate
export const EXPLICIT_INSTRUCTION_SCOPES = ['precondition', 'thisRound', 'none'] as const;

export type ExplicitInstructionScope = (typeof EXPLICIT_INSTRUCTION_SCOPES)[number];

export const GATE_DECISIONS = ['allow', 'block'] as const;

export type GateDecision = (typeof GATE_DECISIONS)[number];

export interface ApproveGate {
  blockingIssuesThisRound: string[];
  blockingIssuesPriorRounds: string[];
  explicitInstructionScope?: ExplicitInstructionScope;
  decision: GateDecision;
  reason: string;
}

// FollowUpMarker
export interface FollowUpMarker {
  originRepo: string;
  originPrNumber: number;
  threadId: string;
  targetRepo: string;
  plannedWork: string;
  fulfilledByPr?: string;
}

// HarnessReviewer
export interface HarnessReviewer {
  judgmentCriteria: Record<string, unknown>;
  alwaysIncludedWhen: Record<string, unknown>;
  tier: string;
}

// FakeRepoFixture
export const FAKE_REPO_SCENARIOS = [
  'placeholderPerFile',
  'fileNameOnlyRef',
  'receiveOnlyRepo',
  'knowledgeDocMention',
  'commonPathCollision',
  'noRemote',
] as const;

export type FakeRepoScenario = (typeof FAKE_REPO_SCENARIOS)[number];

export interface FakeRepoFixture {
  scenario: FakeRepoScenario;
  path: string;
}

// ReplayReport
export const PR_SET_TYPES = ['fixFollowed', 'noFixFollowed'] as const;

export type PrSetType = (typeof PR_SET_TYPES)[number];

export const USER_LABEL_TYPES = ['correct', 'incorrect'] as const;

export type UserLabelType = (typeof USER_LABEL_TYPES)[number];

export interface ReplayReport {
  prSet: PrSetType;
  version: string;
  runCount: number;
  commentCountOnCleanPrs: number;
  detected: number;
  missed: number;
  userLabels?: UserLabelType;
  backendUsed: string;
}
