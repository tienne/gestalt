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

export class AmbiguityThresholdError extends GestaltError {
  constructor(score: number, threshold: number) {
    super(
      `Ambiguity score ${score.toFixed(2)} exceeds threshold ${threshold}. Continue the interview.`,
      'AMBIGUITY_THRESHOLD',
    );
    this.name = 'AmbiguityThresholdError';
  }
}

export class SeedGenerationError extends GestaltError {
  constructor(message: string) {
    super(message, 'SEED_GENERATION_ERROR');
    this.name = 'SeedGenerationError';
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
