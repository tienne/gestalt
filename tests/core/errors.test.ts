import { describe, it, expect } from 'vitest';
import {
  GestaltError,
  InterviewError,
  SessionNotFoundError,
  SessionAlreadyCompletedError,
  ResolutionThresholdError,
  SpecGenerationError,
  LLMError,
  SkillParseError,
  EventStoreError,
  ConfigError,
  ExecuteError,
  ExecuteSessionNotFoundError,
  InvalidPlanningStepError,
  DAGCycleError,
  TaskExecutionError,
  EvaluationError,
  AgentCreationError,
} from '../../src/core/errors.js';

// ─── GestaltError base class ────────────────────────────────────────────────

describe('GestaltError', () => {
  it('message, code를 정확히 설정한다', () => {
    const e = new GestaltError('테스트 에러', 'TEST_CODE');
    expect(e.message).toBe('테스트 에러');
    expect(e.code).toBe('TEST_CODE');
  });

  it('name이 GestaltError로 설정된다', () => {
    const e = new GestaltError('msg', 'CODE');
    expect(e.name).toBe('GestaltError');
  });

  it('Error를 상속한다', () => {
    const e = new GestaltError('msg', 'CODE');
    expect(e).toBeInstanceOf(Error);
  });

  it('instanceof GestaltError가 true다', () => {
    const e = new GestaltError('msg', 'CODE');
    expect(e).toBeInstanceOf(GestaltError);
  });

  it('recoveryHint가 제공되면 설정된다', () => {
    const e = new GestaltError('msg', 'CODE', '힌트를 확인하세요');
    expect(e.recoveryHint).toBe('힌트를 확인하세요');
  });

  it('recoveryHint가 없으면 undefined다', () => {
    const e = new GestaltError('msg', 'CODE');
    expect(e.recoveryHint).toBeUndefined();
  });
});

// ─── InterviewError ─────────────────────────────────────────────────────────

describe('InterviewError', () => {
  it('code가 INTERVIEW_ERROR로 설정된다', () => {
    const e = new InterviewError('인터뷰 오류');
    expect(e.code).toBe('INTERVIEW_ERROR');
  });

  it('name이 InterviewError로 설정된다', () => {
    const e = new InterviewError('인터뷰 오류');
    expect(e.name).toBe('InterviewError');
  });

  it('GestaltError를 상속한다', () => {
    const e = new InterviewError('msg');
    expect(e).toBeInstanceOf(GestaltError);
  });
});

// ─── SessionNotFoundError ───────────────────────────────────────────────────

describe('SessionNotFoundError', () => {
  it('sessionId를 메시지에 포함한다', () => {
    const e = new SessionNotFoundError('abc-123');
    expect(e.message).toContain('abc-123');
  });

  it('name이 SessionNotFoundError로 설정된다', () => {
    const e = new SessionNotFoundError('sid');
    expect(e.name).toBe('SessionNotFoundError');
  });

  it('InterviewError와 GestaltError를 상속한다', () => {
    const e = new SessionNotFoundError('sid');
    expect(e).toBeInstanceOf(InterviewError);
    expect(e).toBeInstanceOf(GestaltError);
  });
});

// ─── SessionAlreadyCompletedError ──────────────────────────────────────────

describe('SessionAlreadyCompletedError', () => {
  it('sessionId를 메시지에 포함한다', () => {
    const e = new SessionAlreadyCompletedError('session-99');
    expect(e.message).toContain('session-99');
  });

  it('name이 SessionAlreadyCompletedError로 설정된다', () => {
    const e = new SessionAlreadyCompletedError('sid');
    expect(e.name).toBe('SessionAlreadyCompletedError');
  });

  it('InterviewError를 상속한다', () => {
    const e = new SessionAlreadyCompletedError('sid');
    expect(e).toBeInstanceOf(InterviewError);
  });
});

// ─── ResolutionThresholdError ───────────────────────────────────────────────

describe('ResolutionThresholdError', () => {
  it('score와 threshold를 메시지에 포함한다', () => {
    const e = new ResolutionThresholdError(0.65, 0.8);
    expect(e.message).toContain('0.65');
    expect(e.message).toContain('0.8');
  });

  it('code가 RESOLUTION_THRESHOLD로 설정된다', () => {
    const e = new ResolutionThresholdError(0.5, 0.8);
    expect(e.code).toBe('RESOLUTION_THRESHOLD');
  });

  it('name이 ResolutionThresholdError로 설정된다', () => {
    const e = new ResolutionThresholdError(0.5, 0.8);
    expect(e.name).toBe('ResolutionThresholdError');
  });

  it('GestaltError를 상속한다', () => {
    const e = new ResolutionThresholdError(0.5, 0.8);
    expect(e).toBeInstanceOf(GestaltError);
  });
});

// ─── SpecGenerationError ────────────────────────────────────────────────────

describe('SpecGenerationError', () => {
  it('code가 SPEC_GENERATION_ERROR로 설정된다', () => {
    const e = new SpecGenerationError('스펙 생성 실패');
    expect(e.code).toBe('SPEC_GENERATION_ERROR');
  });

  it('name이 SpecGenerationError로 설정된다', () => {
    const e = new SpecGenerationError('msg');
    expect(e.name).toBe('SpecGenerationError');
  });
});

// ─── LLMError ──────────────────────────────────────────────────────────────

describe('LLMError', () => {
  it('code가 LLM_ERROR로 설정된다', () => {
    const e = new LLMError('LLM 호출 실패');
    expect(e.code).toBe('LLM_ERROR');
  });

  it('name이 LLMError로 설정된다', () => {
    const e = new LLMError('msg');
    expect(e.name).toBe('LLMError');
  });

  it('GestaltError를 상속한다', () => {
    const e = new LLMError('msg');
    expect(e).toBeInstanceOf(GestaltError);
  });
});

// ─── SkillParseError ────────────────────────────────────────────────────────

describe('SkillParseError', () => {
  it('code가 SKILL_PARSE_ERROR로 설정된다', () => {
    const e = new SkillParseError('파싱 실패');
    expect(e.code).toBe('SKILL_PARSE_ERROR');
  });

  it('name이 SkillParseError로 설정된다', () => {
    const e = new SkillParseError('msg');
    expect(e.name).toBe('SkillParseError');
  });
});

// ─── EventStoreError ────────────────────────────────────────────────────────

describe('EventStoreError', () => {
  it('code가 EVENT_STORE_ERROR로 설정된다', () => {
    const e = new EventStoreError('이벤트 저장 오류');
    expect(e.code).toBe('EVENT_STORE_ERROR');
  });

  it('name이 EventStoreError로 설정된다', () => {
    const e = new EventStoreError('msg');
    expect(e.name).toBe('EventStoreError');
  });
});

// ─── ConfigError ────────────────────────────────────────────────────────────

describe('ConfigError', () => {
  it('code가 CONFIG_ERROR로 설정된다', () => {
    const e = new ConfigError('설정 오류');
    expect(e.code).toBe('CONFIG_ERROR');
  });

  it('name이 ConfigError로 설정된다', () => {
    const e = new ConfigError('msg');
    expect(e.name).toBe('ConfigError');
  });
});

// ─── ExecuteError ───────────────────────────────────────────────────────────

describe('ExecuteError', () => {
  it('code가 EXECUTE_ERROR로 설정된다', () => {
    const e = new ExecuteError('실행 오류');
    expect(e.code).toBe('EXECUTE_ERROR');
  });

  it('name이 ExecuteError로 설정된다', () => {
    const e = new ExecuteError('msg');
    expect(e.name).toBe('ExecuteError');
  });

  it('GestaltError를 상속한다', () => {
    const e = new ExecuteError('msg');
    expect(e).toBeInstanceOf(GestaltError);
  });
});

// ─── ExecuteSessionNotFoundError ────────────────────────────────────────────

describe('ExecuteSessionNotFoundError', () => {
  it('sessionId를 메시지에 포함한다', () => {
    const e = new ExecuteSessionNotFoundError('exec-123');
    expect(e.message).toContain('exec-123');
  });

  it('name이 ExecuteSessionNotFoundError로 설정된다', () => {
    const e = new ExecuteSessionNotFoundError('sid');
    expect(e.name).toBe('ExecuteSessionNotFoundError');
  });

  it('ExecuteError를 상속한다', () => {
    const e = new ExecuteSessionNotFoundError('sid');
    expect(e).toBeInstanceOf(ExecuteError);
  });
});

// ─── InvalidPlanningStepError ───────────────────────────────────────────────

describe('InvalidPlanningStepError', () => {
  it('message를 정확히 설정한다', () => {
    const e = new InvalidPlanningStepError('잘못된 계획 단계');
    expect(e.message).toBe('잘못된 계획 단계');
  });

  it('name이 InvalidPlanningStepError로 설정된다', () => {
    const e = new InvalidPlanningStepError('msg');
    expect(e.name).toBe('InvalidPlanningStepError');
  });

  it('ExecuteError를 상속한다', () => {
    const e = new InvalidPlanningStepError('msg');
    expect(e).toBeInstanceOf(ExecuteError);
  });
});

// ─── DAGCycleError ──────────────────────────────────────────────────────────

describe('DAGCycleError', () => {
  it('cyclePath가 제공되면 경로를 메시지에 포함한다', () => {
    const e = new DAGCycleError('cycle', ['A', 'B', 'C']);
    expect(e.message).toContain('A');
    expect(e.message).toContain('B');
    expect(e.message).toContain('C');
  });

  it('cyclePath가 없으면 details를 메시지로 사용한다', () => {
    const e = new DAGCycleError('cycle details');
    expect(e.message).toContain('cycle details');
  });

  it('cyclePath 배열을 그대로 보존한다', () => {
    const path = ['task-1', 'task-2', 'task-3'];
    const e = new DAGCycleError('cycle', path);
    expect(e.cyclePath).toEqual(path);
  });

  it('cyclePath 없이 생성하면 빈 배열이다', () => {
    const e = new DAGCycleError('details');
    expect(e.cyclePath).toEqual([]);
  });

  it('name이 DAGCycleError로 설정된다', () => {
    const e = new DAGCycleError('details');
    expect(e.name).toBe('DAGCycleError');
  });

  it('ExecuteError를 상속한다', () => {
    const e = new DAGCycleError('details');
    expect(e).toBeInstanceOf(ExecuteError);
  });
});

// ─── TaskExecutionError ─────────────────────────────────────────────────────

describe('TaskExecutionError', () => {
  it('message를 정확히 설정한다', () => {
    const e = new TaskExecutionError('태스크 실행 실패');
    expect(e.message).toBe('태스크 실행 실패');
  });

  it('name이 TaskExecutionError로 설정된다', () => {
    const e = new TaskExecutionError('msg');
    expect(e.name).toBe('TaskExecutionError');
  });

  it('ExecuteError를 상속한다', () => {
    const e = new TaskExecutionError('msg');
    expect(e).toBeInstanceOf(ExecuteError);
  });
});

// ─── EvaluationError ───────────────────────────────────────────────────────

describe('EvaluationError', () => {
  it('message를 정확히 설정한다', () => {
    const e = new EvaluationError('평가 실패');
    expect(e.message).toBe('평가 실패');
  });

  it('name이 EvaluationError로 설정된다', () => {
    const e = new EvaluationError('msg');
    expect(e.name).toBe('EvaluationError');
  });

  it('ExecuteError를 상속한다', () => {
    const e = new EvaluationError('msg');
    expect(e).toBeInstanceOf(ExecuteError);
  });
});

// ─── AgentCreationError ─────────────────────────────────────────────────────

describe('AgentCreationError', () => {
  it('code가 AGENT_CREATION_ERROR로 설정된다', () => {
    const e = new AgentCreationError('에이전트 생성 실패');
    expect(e.code).toBe('AGENT_CREATION_ERROR');
  });

  it('name이 AgentCreationError로 설정된다', () => {
    const e = new AgentCreationError('msg');
    expect(e.name).toBe('AgentCreationError');
  });

  it('GestaltError를 상속하지만 ExecuteError는 아니다', () => {
    const e = new AgentCreationError('msg');
    expect(e).toBeInstanceOf(GestaltError);
    expect(e).not.toBeInstanceOf(ExecuteError);
  });
});

// ─── 공통 동작: instanceof 체인 ─────────────────────────────────────────────

describe('instanceof 체인 검증', () => {
  it('모든 하위 에러는 Error를 상속한다', () => {
    const errors = [
      new GestaltError('msg', 'CODE'),
      new InterviewError('msg'),
      new SessionNotFoundError('sid'),
      new LLMError('msg'),
      new ExecuteError('msg'),
      new DAGCycleError('details'),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('SessionNotFoundError는 InterviewError → GestaltError → Error 체인이다', () => {
    const e = new SessionNotFoundError('sid');
    expect(e).toBeInstanceOf(SessionNotFoundError);
    expect(e).toBeInstanceOf(InterviewError);
    expect(e).toBeInstanceOf(GestaltError);
    expect(e).toBeInstanceOf(Error);
  });

  it('DAGCycleError는 ExecuteError → GestaltError → Error 체인이다', () => {
    const e = new DAGCycleError('details');
    expect(e).toBeInstanceOf(DAGCycleError);
    expect(e).toBeInstanceOf(ExecuteError);
    expect(e).toBeInstanceOf(GestaltError);
    expect(e).toBeInstanceOf(Error);
  });
});
