export class GestaltError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'GestaltError';
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
    super(`Session not found: ${sessionId}`);
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
      `Resolution score ${score.toFixed(2)} below threshold ${threshold}. Continue the interview.`,
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
  constructor(details: string) {
    super(`DAG contains cycles: ${details}`);
    this.name = 'DAGCycleError';
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
