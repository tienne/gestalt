export class GestaltError extends Error {
  public readonly recoveryHint?: string;

  constructor(
    message: string,
    public readonly code: string,
    recoveryHint?: string,
  ) {
    super(message);
    this.name = 'GestaltError';
    if (recoveryHint !== undefined) {
      this.recoveryHint = recoveryHint;
    }
  }
}

export class InterviewError extends GestaltError {
  constructor(message: string) {
    super(message, 'INTERVIEW_ERROR');
    this.name = 'InterviewError';
  }
}

export class SessionNotFoundError extends InterviewError {
  constructor(sessionId: string) {
    super(
      `세션을 찾을 수 없습니다 (${sessionId}). ges_interview action=start로 새 세션을 시작하세요.`,
    );
    this.name = 'SessionNotFoundError';
  }
}

export class SessionAlreadyCompletedError extends InterviewError {
  constructor(sessionId: string) {
    super(`Session already completed: ${sessionId}`);
    this.name = 'SessionAlreadyCompletedError';
  }
}

export class ResolutionThresholdError extends GestaltError {
  constructor(score: number, threshold: number) {
    super(
      `해상도 점수(${score.toFixed(2)})가 임계값(${threshold}) 미만입니다. 인터뷰를 계속 진행하거나 force=true로 강제 생성하세요.`,
      'RESOLUTION_THRESHOLD',
    );
    this.name = 'ResolutionThresholdError';
  }
}

export class SpecGenerationError extends GestaltError {
  constructor(message: string) {
    super(message, 'SPEC_GENERATION_ERROR');
    this.name = 'SpecGenerationError';
  }
}

export class LLMError extends GestaltError {
  constructor(message: string) {
    super(message, 'LLM_ERROR');
    this.name = 'LLMError';
  }
}

export class SkillParseError extends GestaltError {
  constructor(message: string) {
    super(message, 'SKILL_PARSE_ERROR');
    this.name = 'SkillParseError';
  }
}

export class EventStoreError extends GestaltError {
  constructor(message: string) {
    super(message, 'EVENT_STORE_ERROR');
    this.name = 'EventStoreError';
  }
}

export class ConfigError extends GestaltError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class ExecuteError extends GestaltError {
  constructor(message: string) {
    super(message, 'EXECUTE_ERROR');
    this.name = 'ExecuteError';
  }
}

export class ExecuteSessionNotFoundError extends ExecuteError {
  constructor(sessionId: string) {
    super(`Execute session not found: ${sessionId}`);
    this.name = 'ExecuteSessionNotFoundError';
  }
}

export class InvalidPlanningStepError extends ExecuteError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanningStepError';
  }
}

export class DAGCycleError extends ExecuteError {
  public readonly cyclePath: string[];

  constructor(details: string, cyclePath: string[] = []) {
    const pathInfo =
      cyclePath.length > 0
        ? `DAG 순환이 감지되었습니다: ${cyclePath.join(' → ')}. 태스크 의존관계를 확인하세요.`
        : `DAG contains cycles: ${details}`;
    super(pathInfo);
    this.name = 'DAGCycleError';
    this.cyclePath = cyclePath;
  }
}

export class TaskExecutionError extends ExecuteError {
  constructor(message: string) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}

export class EvaluationError extends ExecuteError {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

export class AgentCreationError extends GestaltError {
  constructor(message: string) {
    super(message, 'AGENT_CREATION_ERROR');
    this.name = 'AgentCreationError';
  }
}
