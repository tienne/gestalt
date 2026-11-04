import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtime = readFileSync('plugin/skills/_shared/host-runtime.md', 'utf8');
const doubt = readFileSync('plugin/skills/doubt/SKILL.md', 'utf8');
const review = readFileSync('plugin/skills/review/SKILL.md', 'utf8');

// 호출부 구역별로 검사한다. 다른 구역에 같은 규칙이 있어도 누락을 가리지 못한다.
function between(text: string, start: string, end: string): string {
  expect(text).toContain(start);
  expect(text).toContain(end);
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
}

const contexts = [
  ['runtime 독립 판정 정책', between(runtime, '### 독립 판정 컨텍스트', '## Claude Code')],
  [
    'doubt 반박 리뷰어',
    between(doubt, '## 3단계: 반박 리뷰어를 띄운다', '## 4단계: 결과를 분류한다'),
  ],
  ['review 정합 심급', between(review, '### 3.5단계:', '### 3.7단계:')],
  ['review 제안 검증', between(review, '#### 검증 위임', '#### 결과 반영')],
] as const;

describe('Codex 독립 판정 컨텍스트 계약', () => {
  it.each(contexts)('%s는 모델 상속과 이력 비상속을 구분한다', (_, section) => {
    expect(section).toContain('모델 재지정 여부와 무관하게');
    expect(section).toContain('지원');
    expect(section).toContain('fork_turns: "none"');
    expect(section).toContain('inherit');
    expect(section).toMatch(/모델 인자.*생략|인자를 생략/);
    expect(section).toContain('산출물, 계약, 필수 절대 경로만');
    expect(section).toMatch(/작성자 추론.*부모 이력.*넘기지/);
    expect(section).toContain('미실행');
    expect(section).toContain('자기 검토를 독립 승인으로 보고하지');
  });

  it('일반 위임 조건이 독립 판정의 격리 조건을 제한하지 않는다', () => {
    const delegation = between(runtime, '`spawn_agent`,', '스폰 도구가 명시한 모델');
    expect(delegation).toContain('일반 위임');
    expect(delegation).toContain('독립 판정은 모델 선택과 무관하게');
    expect(delegation).not.toContain('명시해야 할 때만');
    expect(runtime).toContain('동등한 새 컨텍스트 격리가 보장되는');
  });

  it('정합 심급은 리뷰어 이슈를 배제하고 제안 검증은 초안을 받는다', () => {
    expect(contexts[2][1]).toContain('`issues`를 입력으로 받지 않습니다');
    expect(contexts[2][1]).toContain('Pass를 승인으로 게시하지');
    expect(contexts[3][1]).toContain('이슈 초안은 검토 대상 산출물');
    expect(contexts[3][1]).toContain('초안을 유지');
  });
});
