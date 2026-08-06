import { describe, it, expect } from 'vitest';
import { changeRate } from '../../../src/humanize/change-rate.js';
import {
  countByRule,
  missingProtectedTokens,
  protectedTokens,
  structureStats,
} from '../../../src/humanize/detectors.js';
import { runCheck } from '../../../src/humanize/check.js';

describe('changeRate', () => {
  it('같은 글은 0이다', () => {
    const text = '배포 파이프라인을 손봤습니다. 캐시 무효화가 빠져 있었어요.';
    expect(changeRate(text, text)).toBe(0);
  });

  it('완전히 다른 글은 1에 가깝다', () => {
    expect(changeRate('사과 배 딸기 포도', '자동차 비행기 기차 배편')).toBeGreaterThan(0.7);
  });

  it('일부만 고치면 그만큼만 오른다', () => {
    const before = '이 기능은 캐시를 통해 성능을 개선할 수 있습니다. 배포는 내일 예정입니다.';
    const after = '이 기능은 캐시로 성능을 개선합니다. 배포는 내일 예정입니다.';
    const rate = changeRate(before, after);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.5);
  });

  it('마크업만 걷어낸 비교는 산문화로 부푼 변경률을 낮춘다', () => {
    const before = '- 캐시 무효화\n- 배포 순서\n- 롤백 기준';
    const after = '캐시 무효화와 배포 순서, 롤백 기준을 봤습니다.';
    expect(changeRate(before, after, { ignoreMarkup: true })).toBeLessThan(
      changeRate(before, after),
    );
  });

  it('빈 입력끼리는 0, 한쪽만 비면 1', () => {
    expect(changeRate('', '')).toBe(0);
    expect(changeRate('내용 있음', '')).toBe(1);
  });

  it('긴 글도 줄 단위로 떨어져 끝난다', () => {
    const before = Array.from({ length: 8000 }, (_, i) => `${i}번째 문장입니다.`).join(' ');
    const after = before.replace('0번째', '영번째');
    expect(changeRate(before, after)).toBeLessThan(0.01);
  });
});

describe('detectors', () => {
  it('번역투와 결산 피벗을 센다', () => {
    const counts = countByRule('이 문제에 대해 살펴봤습니다. 결론적으로 캐시가 원인입니다.');
    expect(counts.get('A-1')).toBe(1);
    expect(counts.get('D-1')).toBe(1);
  });

  it('이중 피동을 잡는다', () => {
    expect(countByRule('원인이 그렇게 판단되어진다.').get('A-8')).toBe(1);
  });

  it('연결어미 뒤 쉼표를 잡는다', () => {
    expect(countByRule('빌드를 돌리고, 배포를 했지만, 실패했어요.').get('C-11')).toBe(2);
  });

  it('가운뎃점 나열을 잡되 표 안은 건너뛴다', () => {
    expect(countByRule('기능·성능·안정성을 봤어요.').get('C-12')).toBe(2);
    expect(countByRule('| 기능·성능·안정성 | 확인 |').get('C-12')).toBeUndefined();
  });

  it('코드 스팬 안은 룰 적용 대상이 아니다', () => {
    expect(countByRule('`a·b` 형식입니다.').get('C-12')).toBeUndefined();
  });

  it('문두 접속사는 문장 첫머리에서만 센다', () => {
    const counts = countByRule('또한 캐시를 봤어요. 이건 또한 중요합니다.');
    expect(counts.get('H-1')).toBe(1);
  });
});

describe('protectedTokens', () => {
  it('수치·코드·URL·인용을 뽑는다', () => {
    const tokens = protectedTokens(
      '응답이 250ms까지 줄었고 `cacheKey`를 https://example.com 문서에서 확인했습니다.',
    );
    expect(tokens).toContain('250');
    expect(tokens).toContain('`cacheKey`');
    expect(tokens.some((t) => t.startsWith('https://'))).toBe(true);
  });

  it('사라진 보호 토큰을 집어낸다', () => {
    const before = '응답이 250ms까지 줄었습니다.';
    const after = '응답이 빨라졌습니다.';
    expect(missingProtectedTokens(before, after)).toContain('250');
  });

  it('그대로 살아있으면 유실이 없다', () => {
    const before = '응답이 250ms까지 줄었습니다.';
    const after = '응답 시간이 250ms로 내려갔어요.';
    expect(missingProtectedTokens(before, after)).toEqual([]);
  });
});

describe('structureStats', () => {
  it('문장·헤딩·불릿·링크를 센다', () => {
    const stats = structureStats('# 제목\n\n첫 문장이다. 둘째 문장이다.\n\n- 항목\n[링크](http://a.b)');
    expect(stats.headings).toBe(1);
    expect(stats.bullets).toBe(1);
    expect(stats.links).toBe(1);
    expect(stats.sentences).toBeGreaterThanOrEqual(2);
  });
});

describe('runCheck', () => {
  const before =
    '이 변경에 대해 설명드리면, 캐시가 그렇게 판단되어진다는 문제가 있었습니다. ' +
    '결론적으로 응답이 250ms까지 줄었습니다. 배포는 내일이고, 롤백 기준도 정했습니다.';

  it('제대로 윤문하면 통과한다', () => {
    const after =
      '이 변경을 설명드리면 캐시가 그렇게 판단된다는 문제가 있었습니다. ' +
      '응답이 250ms까지 줄었습니다. 배포는 내일이고 롤백 기준도 정했습니다.';
    const report = runCheck(before, after);
    expect(report.verdict).toBe('pass');
    expect(report.exitCode).toBe(0);
    expect(report.changeRate).toBeLessThan(0.3);
  });

  it('수치가 사라지면 채택 금지다', () => {
    const after = '이 변경을 설명드리면 캐시 판정에 문제가 있었습니다. 응답이 빨라졌습니다.';
    const report = runCheck(before, after);
    expect(report.verdict).toBe('abort');
    expect(report.exitCode).toBe(2);
    expect(report.axes.find((a) => a.axis === 'preservation')?.verdict).toBe('abort');
  });

  it('S1이 남으면 경고한다', () => {
    const after =
      '이 변경에 대해 설명드리면 캐시가 그렇게 판단된다는 문제가 있었습니다. ' +
      '응답이 250ms까지 줄었습니다. 배포는 내일이고 롤백 기준도 정했습니다.';
    const report = runCheck(before, after);
    expect(report.verdict).toBe('warn');
    expect(report.changeRate).toBeLessThan(0.3);
    expect(report.residualS1.map((r) => r.ruleId)).toContain('A-1');
  });

  it('없던 AI 티를 심으면 구조 측면에서 잡힌다', () => {
    const after =
      '이 변경을 설명드리면 캐시 판정에 문제가 있었습니다. ' +
      '응답이 250ms까지 줄었습니다. 배포는 내일이고 롤백 기준도 정했습니다. ' +
      '이는 기능·성능·안정성 모두에서 시사하는 바가 큽니다.';
    const report = runCheck(before, after);
    expect(report.introduced.map((r) => r.ruleId)).toContain('C-12');
    expect(report.verdict).not.toBe('pass');
  });

  it('말투에 따라 S1 대상이 달라진다', () => {
    const draft = '이 작업을 통해 유지보수성 개선 작업을 했습니다. 응답이 250ms까지 줄었습니다.';
    const doc = runCheck(draft, draft, { register: 'doc' });
    const chat = runCheck(draft, draft, { register: 'chat' });
    expect(doc.residualS1.map((r) => r.ruleId)).not.toContain('A-2');
    expect(chat.residualS1.map((r) => r.ruleId)).toContain('A-2');
  });

  it('절반 넘게 갈아엎으면 채택 금지다', () => {
    const after = '전혀 다른 내용으로 통째 다시 썼습니다. 250 관련 이야기는 빼겠습니다.';
    const report = runCheck(before, after);
    expect(report.exitCode).toBe(2);
  });
});
