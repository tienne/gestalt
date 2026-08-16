/**
 * 프롬프트에 실리는 명령 출력이 어느 쪽에서 잘리는지 검증한다.
 *
 * 실패 상세는 출력 끝에 나온다. 앞에서 자르면 수정 모델이 실패 이유를 못 본 채
 * 고칠 것을 지어내고, 사용자는 evolve 루프가 왜 헛도는지 알 수 없다.
 */
import { describe, it, expect } from 'vitest';
import { buildStructuralFixPrompt } from '../../../src/execute/prompts.js';
import type {
  Spec,
  StructuralCommandResult,
  TaskExecutionResult,
} from '../../../src/core/types.js';

const spec: Spec = {
  specId: 'spec-1',
  goal: '테스트 목표',
  constraints: [],
  acceptanceCriteria: ['AC1'],
  ontologySchema: { entities: [], relations: [] },
  gestaltAnalysis: [],
  createdAt: new Date().toISOString(),
} as unknown as Spec;

/** 앞은 진행 로그로 채우고 진짜 실패 이유는 끝에 둔다 — 실제 테스트 출력의 모양 */
function noisyOutput(): string {
  return `${'진행 로그 줄\n'.repeat(400)}FAIL src/auth.ts:42 expected 200 but got 401`;
}

function failedCommand(output: string): StructuralCommandResult {
  return { name: 'test', command: 'pnpm test', exitCode: 1, output };
}

describe('구조 검증 실패 출력의 절단 방향', () => {
  it('실패 이유가 출력 끝에 있어도 프롬프트에 실린다', () => {
    const prompt = buildStructuralFixPrompt(spec, [failedCommand(noisyOutput())], []);

    expect(prompt).toContain('FAIL src/auth.ts:42 expected 200 but got 401');
  });

  it('잘렸으면 잘렸다고 적는다 — 표시가 없으면 거기서 끝난 줄 안다', () => {
    const prompt = buildStructuralFixPrompt(spec, [failedCommand(noisyOutput())], []);

    expect(prompt).toMatch(/앞 \d+자 생략/);
  });

  it('상한보다 짧은 출력은 손대지 않는다', () => {
    const short = 'FAIL: 한 줄짜리 실패';
    const prompt = buildStructuralFixPrompt(spec, [failedCommand(short)], []);

    expect(prompt).toContain(short);
    expect(prompt).not.toMatch(/자 생략/);
  });

  it('실패한 태스크 출력도 뒤에서 자른다', () => {
    const taskResult = {
      taskId: 'task-0',
      status: 'failed',
      output: noisyOutput(),
    } as unknown as TaskExecutionResult;

    const prompt = buildStructuralFixPrompt(spec, [], [taskResult]);

    expect(prompt).toContain('expected 200 but got 401');
  });
});
