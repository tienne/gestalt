import { describe, it, expect } from 'vitest';
import { changeRate } from '../../../src/humanize/change-rate.js';
import {
  countByRule,
  missingProtectedTokens,
  protectedTokens,
  reportRegisterStats,
  structureStats,
} from '../../../src/humanize/detectors.js';
import { decide, formatReport, prescan, runCheck } from '../../../src/humanize/check.js';

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

  it('보고서 어미는 인용문을 빼고 센다', () => {
    const stats = reportRegisterStats('지표는 증가했다.\n> "요청을 확인했습니다."');
    expect(stats).toEqual({ plainEndings: 1, formalEndings: 0 });
  });

  it('언어 태그가 붙은 펜스는 코드라서 건너뛴다', () => {
    const text = '```ts\nconst label = "기능·성능·안정성";\n```';
    expect(countByRule(text).get('C-12')).toBeUndefined();
  });

  it('태그 없는 펜스는 프롬프트 산문이라 검사한다', () => {
    const text = 'Agent {\n  prompt: "기능·성능·안정성을 본다"\n}';
    expect(countByRule(`\`\`\`\n${text}\n\`\`\``).get('C-12')).toBe(2);
  });

  it('인용줄은 마커만 떼고 산문으로 본다', () => {
    expect(countByRule('> 결론적으로 캐시 문제였어요.').get('D-1')).toBe(1);
  });

  it('인용줄 문두 접속사도 문장 첫머리로 센다', () => {
    expect(countByRule('> 따라서 이 모델은 공개 채널 말투를 재현한다.').get('H-1')).toBe(1);
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

  it('태그 없는 펜스는 윤문 대상이라 통째로 보호하지 않는다', () => {
    const before = '```\n프롬프트 본문입니다.\n```';
    expect(protectedTokens(before)).not.toContain(before);
    expect(missingProtectedTokens(before, '```\n프롬프트 본문이에요.\n```')).toEqual([]);
  });

  it('언어 태그가 붙은 펜스는 한 글자도 못 바꾼다', () => {
    const before = '```ts\nconst a = 1;\n```';
    expect(missingProtectedTokens(before, '```ts\nconst b = 1;\n```')).toContain(before);
  });
});

describe('structureStats', () => {
  it('문장·헤딩·불릿·링크를 센다', () => {
    const stats = structureStats(
      '# 제목\n\n첫 문장이다. 둘째 문장이다.\n\n- 항목\n[링크](http://a.b)',
    );
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

  it('보고서에서 평서체와 합니다체를 섞으면 경고한다', () => {
    const draft =
      '응답 시간은 4.2시간에서 9.1시간으로 증가했다. 다음 분기에는 대응 경로를 복구합니다.';
    const report = runCheck(draft, draft, { register: 'report' });
    const axis = report.axes.find((item) => item.axis === 'report-register');
    expect(axis?.verdict).toBe('warn');
    expect(axis?.evidence).toEqual(['평서체 1문장 / 합니다체 1문장']);
  });

  it('보고서 어미가 일관되면 통과한다', () => {
    const draft =
      '응답 시간은 4.2시간에서 9.1시간으로 증가했다. 다음 분기에는 대응 경로를 복구한다.';
    const report = runCheck(draft, draft, { register: 'report' });
    expect(report.axes.find((item) => item.axis === 'report-register')?.verdict).toBe('pass');
  });

  it('절반 넘게 갈아엎으면 채택 금지다', () => {
    const after = '전혀 다른 내용으로 통째 다시 썼습니다. 250 관련 이야기는 빼겠습니다.';
    const report = runCheck(before, after);
    expect(report.exitCode).toBe(2);
  });
});

describe('prescan', () => {
  it('S1이 없으면 윤문할 이유도 없다', () => {
    const clean = '배포는 내일이고 롤백 기준도 정했습니다. 응답은 250ms입니다.';
    const report = prescan(clean);
    expect(report.s1Total).toBe(0);
    expect(report.worthHumanizing).toBe(false);
  });

  it('원문 S1을 룰별로 세어 기준선을 만든다', () => {
    const draft = '이 변경에 대해 설명드리면 캐시가 판단되어진다는 문제가 있었습니다.';
    const report = prescan(draft);
    expect(report.worthHumanizing).toBe(true);
    expect(report.s1ByRule.get('A-1')).toBe(1);
    expect(report.s1ByRule.get('A-8')).toBe(1);
    expect(report.s1Total).toBe(2);
  });

  it('말투에 따라 기준선이 달라진다', () => {
    const draft = '이 작업을 통해 유지보수성을 손봤습니다.';
    expect(prescan(draft, { register: 'doc' }).s1ByRule.has('A-2')).toBe(false);
    expect(prescan(draft, { register: 'chat' }).s1ByRule.get('A-2')).toBe(1);
  });

  it('기준선을 넘기면 runCheck이 그 값을 쓴다', () => {
    const draft = '이 문제에 대해 검토했다.';
    // 원문에 A-1이 3건 있었다고 알려주면, 1건 남은 결과는 제거율 67%가 된다
    const report = runCheck(draft, draft, { prescanned: new Map([['A-1', 3]]) });
    expect(report.s1Before).toBe(3);
    expect(report.s1After).toBe(1);
    expect(report.s1Removal).toBeCloseTo(2 / 3);
  });
});

describe('runCheck — 과소윤문', () => {
  const before =
    '이 변경에 대해 설명드리면, 캐시가 그렇게 판단되어진다는 문제가 있었습니다. ' +
    '결론적으로 응답이 250ms까지 줄었습니다.';

  it('원문을 그대로 돌려주면 채택 금지다', () => {
    const report = runCheck(before, before);
    expect(report.verdict).toBe('abort');
    expect(report.exitCode).toBe(2);
    expect(report.s1Removal).toBe(0);
    expect(report.axes.find((a) => a.axis === 'residual-s1')?.verdict).toBe('abort');
  });

  it('절반도 못 줄이면 경고한다', () => {
    // D-1만 걷어내고 A-1과 A-8은 그대로 둔다 (3건 → 2건, 제거율 33%)
    const after =
      '이 변경에 대해 설명드리면, 캐시가 그렇게 판단되어진다는 문제가 있었습니다. ' +
      '응답이 250ms까지 줄었습니다.';
    const report = runCheck(before, after);
    expect(report.s1Removal).toBeCloseTo(1 / 3);
    const axis = report.axes.find((a) => a.axis === 'residual-s1');
    expect(axis?.verdict).toBe('warn');
    expect(axis?.detail).toContain('절반도 못 줄임');
  });

  it('전부 걷어내면 잔존 측면은 통과한다', () => {
    const after =
      '이 변경을 설명드리면 캐시 판정에 문제가 있었습니다. 응답이 250ms까지 줄었습니다.';
    const report = runCheck(before, after);
    expect(report.s1After).toBe(0);
    expect(report.s1Removal).toBe(1);
    expect(report.axes.find((a) => a.axis === 'residual-s1')?.verdict).toBe('pass');
  });
});

describe('runCheck — 유입', () => {
  const clean = '배포는 내일이고 롤백 기준도 정했습니다. 응답은 250ms입니다.';

  it('없던 S1을 심으면 채택 금지다', () => {
    const report = runCheck(clean, `${clean} 이 문제에 대해 더 봅니다.`);
    expect(report.verdict).toBe('abort');
    expect(report.axes.find((a) => a.axis === 'introduced')?.verdict).toBe('abort');
    expect(report.introduced.map((r) => r.ruleId)).toContain('A-1');
  });

  it('S1이 아닌 패턴 유입은 경고에서 멈춘다', () => {
    // G-2는 doc 기준 S1이 아니다
    const report = runCheck(clean, `${clean} 캐시 문제로 보인다.`);
    const axis = report.axes.find((a) => a.axis === 'introduced');
    expect(axis?.verdict).toBe('warn');
    expect(report.introduced.map((r) => r.ruleId)).toContain('G-2');
  });

  it('아무것도 안 심으면 통과한다', () => {
    const report = runCheck(clean, '배포는 내일입니다. 롤백 기준도 정했고 응답은 250ms입니다.');
    expect(report.axes.find((a) => a.axis === 'introduced')?.verdict).toBe('pass');
  });
});

describe('decide', () => {
  const before =
    '이 변경에 대해 설명드리면, 캐시가 그렇게 판단되어진다는 문제가 있었습니다. ' +
    '결론적으로 응답이 250ms까지 줄었습니다.';
  const good = '이 변경을 설명드리면 캐시 판정에 문제가 있었습니다. 응답이 250ms까지 줄었습니다.';

  it('통과하면 채택한다', () => {
    const clean = '배포는 내일입니다. 롤백 기준도 정했습니다.';
    expect(decide(runCheck(clean, clean)).action).toBe('accept');
  });

  it('경고면 채택하되 걸린 측면을 남긴다', () => {
    const report = runCheck(before, good);
    expect(report.verdict).toBe('warn');
    expect(decide(report).action).toBe('accept-with-warning');
  });

  it('첫 시도에서 막히면 다시 윤문시킨다', () => {
    const decision = decide(runCheck(before, before), 1);
    expect(decision.action).toBe('retry');
    expect(decision.message).toContain('--attempt 2');
  });

  it('재시도를 소진하면 원문으로 돌아간다', () => {
    const decision = decide(runCheck(before, before), 2);
    expect(decision.action).toBe('fallback');
    expect(decision.message).toContain('원문을 그대로 낸다');
  });

  it('리포트가 다음 행동을 함께 찍는다', () => {
    expect(formatReport(runCheck(before, before), 2)).toContain('[다음] fallback');
  });
});

describe('runCheck — 제거율 경계', () => {
  it('절반을 정확히 걷어내면 "절반도 못 줄임"이 아니다', () => {
    // S1 4건(A-1 2건 + D-1 2건) 중 D-1 2건만 제거 = 제거율 정확히 0.5
    const before =
      '이 문제에 대해 본다. 저 사안에 대해 본다. 결론적으로 캐시다. 결론적으로 끝이다.';
    const after = '이 문제에 대해 본다. 저 사안에 대해 본다. 캐시가 원인이다. 여기서 끝이다.';
    const report = runCheck(before, after);
    expect(report.s1Removal).toBe(0.5);
    const axis = report.axes.find((a) => a.axis === 'residual-s1');
    expect(axis?.verdict).toBe('warn');
    expect(axis?.detail).not.toContain('절반도 못 줄임');
  });
});

describe('runCheck — 탐지기 밖에서 고친 경우', () => {
  // B-3(안 굳어진 음차)은 탐지기가 없다. 그것만 고치면 제거율은 0으로 보인다
  const before = [
    '이 문제에 대해 정리한다.',
    '설정 파일이 소스 오브 트루스다.',
    '스키마도 소스 오브 트루스로 둔다.',
  ].join(' ');

  it('제거율이 0이어도 텍스트가 바뀌었으면 채택을 막지 않는다', () => {
    const after = [
      '이 문제에 대해 정리한다.',
      '설정 파일이 기준 문서다.',
      '스키마도 기준 문서로 둔다.',
    ].join(' ');
    const report = runCheck(before, after);
    expect(report.s1Removal).toBe(0);
    const axis = report.axes.find((a) => a.axis === 'residual-s1');
    expect(axis?.verdict).toBe('warn');
    expect(axis?.detail).toContain('탐지 가능한 룰은 안 줄었다');
    expect(decide(report).action).toBe('accept-with-warning');
  });

  it('제거율이 0이고 텍스트도 그대로면 채택 금지다', () => {
    const report = runCheck(before, before);
    expect(report.s1Removal).toBe(0);
    const axis = report.axes.find((a) => a.axis === 'residual-s1');
    expect(axis?.verdict).toBe('abort');
    expect(axis?.detail).toContain('한 건도 못 줄임');
  });
});

describe('신규 유입은 한 축만 판정한다', () => {
  const clean = '배포는 내일입니다. 롤백 기준도 정했습니다.';
  const seeded = `${clean} 이 문제에 대해 더 봅니다.`;

  it('잔존 축은 물러나고 유입 축이 막는다', () => {
    const report = runCheck(clean, seeded);
    // 두 축이 같은 사실을 각자 abort로 재면 한쪽이 회귀해도 다른 쪽이 가린다
    expect(report.axes.find((a) => a.axis === 'residual-s1')?.verdict).toBe('warn');
    expect(report.axes.find((a) => a.axis === 'introduced')?.verdict).toBe('abort');
    expect(report.verdict).toBe('abort');
  });
});

describe('decide — 재시도 예산', () => {
  const before = '이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.';

  it('호출자가 예산을 좁히면 첫 시도에서 바로 원문으로 간다', () => {
    const report = runCheck(before, before);
    expect(decide(report, 1, 1).action).toBe('fallback');
  });

  it('예산을 넓히면 재시도가 더 남는다', () => {
    const report = runCheck(before, before);
    expect(decide(report, 2, 3).action).toBe('retry');
    expect(decide(report, 3, 3).action).toBe('fallback');
  });
});
