import { describe, it, expect } from 'vitest';
import { KOREAN_TONE_GUIDE, INTERVIEW_SYSTEM_PROMPT } from '../../../src/llm/prompts.js';
import {
  EXECUTE_SYSTEM_PROMPT,
  EXECUTE_EXECUTION_SYSTEM_PROMPT,
  EXECUTE_EVALUATION_SYSTEM_PROMPT,
  EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT,
  EVOLVE_CONTEXTUAL_SYSTEM_PROMPT,
} from '../../../src/execute/prompts.js';

describe('KOREAN_TONE_GUIDE', () => {
  it('src/llm/prompts.ts에서 export된 비어있지 않은 문자열', () => {
    expect(typeof KOREAN_TONE_GUIDE).toBe('string');
    expect(KOREAN_TONE_GUIDE.length).toBeGreaterThan(0);
  });

  it('리액션 추임새 금지 지시를 포함', () => {
    expect(KOREAN_TONE_GUIDE).toContain('리액션 추임새 금지');
    expect(KOREAN_TONE_GUIDE).toContain('물론이죠');
    expect(KOREAN_TONE_GUIDE).toContain('완벽합니다');
  });

  it('번역투 금지 지시를 포함', () => {
    expect(KOREAN_TONE_GUIDE).toContain('번역투 금지');
    expect(KOREAN_TONE_GUIDE).toContain('~를 통해');
    expect(KOREAN_TONE_GUIDE).toContain('~의 경우');
  });

  it('팀 동료 톤 지시를 포함', () => {
    expect(KOREAN_TONE_GUIDE).toContain('팀 동료 톤');
  });

  it('한국어 응답일 때만 적용된다고 조건을 명시', () => {
    expect(KOREAN_TONE_GUIDE).toContain('한국어');
    expect(KOREAN_TONE_GUIDE).toMatch(/한국어 응답|한국어로 답변/);
  });
});

describe('INTERVIEW_SYSTEM_PROMPT에 KOREAN_TONE_GUIDE 주입', () => {
  it('KOREAN_TONE_GUIDE 전문을 포함', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain(KOREAN_TONE_GUIDE);
  });

  it('가이드 토큰("Korean Tone Guidelines")을 포함', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('Korean Tone Guidelines');
  });

  it('기존 인터뷰 규칙(게슈탈트 원리)이 보존됨', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('Gestalt-trained requirements analyst');
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('Always respond in the user');
  });
});

describe('execute 5개 system 상수에 KOREAN_TONE_GUIDE 주입', () => {
  const cases: [string, string][] = [
    ['EXECUTE_SYSTEM_PROMPT', EXECUTE_SYSTEM_PROMPT],
    ['EXECUTE_EXECUTION_SYSTEM_PROMPT', EXECUTE_EXECUTION_SYSTEM_PROMPT],
    ['EXECUTE_EVALUATION_SYSTEM_PROMPT', EXECUTE_EVALUATION_SYSTEM_PROMPT],
    ['EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT', EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT],
    ['EVOLVE_CONTEXTUAL_SYSTEM_PROMPT', EVOLVE_CONTEXTUAL_SYSTEM_PROMPT],
  ];

  it.each(cases)('%s가 KOREAN_TONE_GUIDE 전문을 포함', (_name, prompt) => {
    expect(prompt).toContain(KOREAN_TONE_GUIDE);
  });

  it.each(cases)('%s가 가이드 토큰("Korean Tone Guidelines")을 포함', (_name, prompt) => {
    expect(prompt).toContain('Korean Tone Guidelines');
  });
});

describe('import 참조 동일성', () => {
  it('execute/prompts.ts와 llm/prompts.ts의 KOREAN_TONE_GUIDE가 동일 상수 참조 (SSOT)', () => {
    // 동일 문자열 전문이 양쪽 상수에 그대로 포함되는지로 SSOT를 검증
    expect(EXECUTE_SYSTEM_PROMPT).toContain(KOREAN_TONE_GUIDE);
    expect(INTERVIEW_SYSTEM_PROMPT).toContain(KOREAN_TONE_GUIDE);
  });
});

describe('회귀: JSON 응답 스키마 지시 보존', () => {
  it('INTERVIEW_SYSTEM_PROMPT의 게슈탈트 규칙이 깨지지 않음', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('Closure');
    expect(INTERVIEW_SYSTEM_PROMPT).toContain('Continuity');
  });

  it('EXECUTE_SYSTEM_PROMPT의 JSON object 지시가 보존됨', () => {
    expect(EXECUTE_SYSTEM_PROMPT).toContain('respond with ONLY a JSON object');
  });

  it('EXECUTE_EXECUTION_SYSTEM_PROMPT의 JSON object 지시가 보존됨', () => {
    expect(EXECUTE_EXECUTION_SYSTEM_PROMPT).toContain('Respond with ONLY a JSON object');
  });

  it('EXECUTE_EVALUATION_SYSTEM_PROMPT의 JSON object 지시가 보존됨', () => {
    expect(EXECUTE_EVALUATION_SYSTEM_PROMPT).toContain('Respond with ONLY a JSON object');
  });

  it('EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT의 JSON array 지시가 보존됨', () => {
    expect(EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT).toContain('Respond with ONLY a JSON array');
  });

  it('EVOLVE_CONTEXTUAL_SYSTEM_PROMPT의 JSON object 지시가 보존됨', () => {
    expect(EVOLVE_CONTEXTUAL_SYSTEM_PROMPT).toContain('Respond with ONLY a JSON object');
  });

  it('KOREAN_TONE_GUIDE는 JSON 스키마 지시 문자열을 포함하지 않음 (분리 보장)', () => {
    expect(KOREAN_TONE_GUIDE).not.toContain('JSON');
  });
});
