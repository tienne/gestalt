import { describe, it, expect } from 'vitest';
import { TextBasedSpecGenerator } from '../../../src/spec/text-based-spec-generator.js';
import type { ProjectMemory } from '../../../src/core/types.js';

/**
 * 메모리를 프롬프트에 싣는 자리.
 *
 * 여기서 만든 문자열은 그대로 LLM에 간다. 객체가 문자열 자리에 박히면 모델이 읽을 게
 * 없어지는데, 프롬프트는 아무도 안 읽어서 그 손실이 눈에 안 띈다.
 */

function memoryWith(partial: Partial<ProjectMemory>): ProjectMemory {
  return {
    version: '2',
    repoRoot: '/tmp/x',
    specHistory: [],
    architectureDecisions: [],
    executionHistory: [],
    ...partial,
  } as ProjectMemory;
}

describe('텍스트 기반 스펙 생성의 메모리 주입', () => {
  const generator = new TextBasedSpecGenerator();

  it('아키텍처 결정을 결정 내용과 근거로 펼친다', () => {
    const memory = memoryWith({
      architectureDecisions: [
        {
          decision: '이벤트 소싱으로 상태를 만든다',
          rationale: 'DB를 지워도 이벤트만 있으면 같은 결과가 나온다',
          specId: 'spec-1',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const { memoryContext } = generator.buildSpecContext('무언가 만든다', memory);

    expect(memoryContext).toContain('이벤트 소싱으로 상태를 만든다');
    expect(memoryContext).toContain('DB를 지워도 이벤트만 있으면 같은 결과가 나온다');
    // 객체를 그대로 박으면 여기가 [object Object]가 된다
    expect(memoryContext).not.toContain('[object Object]');
  });

  it('근거가 없으면 결정만 적는다', () => {
    const memory = memoryWith({
      architectureDecisions: [
        {
          decision: '패스스루 모드를 기본으로 둔다',
          rationale: '',
          specId: 'spec-2',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const { memoryContext } = generator.buildSpecContext('무언가 만든다', memory);

    expect(memoryContext).toContain('- 패스스루 모드를 기본으로 둔다');
    expect(memoryContext).not.toContain('()');
  });

  it('메모리가 비면 아무것도 안 싣는다', () => {
    const { memoryContext } = generator.buildSpecContext('무언가 만든다', memoryWith({}));

    expect(memoryContext).toBeUndefined();
  });
});
