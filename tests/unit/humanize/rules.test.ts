import { describe, it, expect } from 'vitest';
import { expandIdRanges, parseRuleBook, ruleLabel, s1Ids } from '../../../src/humanize/rules.js';

describe('expandIdRanges', () => {
  it('범위 표기를 개별 ID로 편다', () => {
    expect(expandIdRanges('D-1~D-6 확인').sort()).toEqual([
      'D-1',
      'D-2',
      'D-3',
      'D-4',
      'D-5',
      'D-6',
    ]);
  });

  it('뒤쪽 접두어를 생략한 범위도 편다', () => {
    expect(expandIdRanges('A-1~3').sort()).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('범위와 단독 ID가 섞여도 중복 없이 모은다', () => {
    expect(expandIdRanges('D-1~D-3, A-7, D-2').sort()).toEqual(['A-7', 'D-1', 'D-2', 'D-3']);
  });

  it('룰 ID가 없으면 빈 배열', () => {
    expect(expandIdRanges('아무 ID도 없는 문장')).toEqual([]);
  });
});

describe('parseRuleBook', () => {
  const book = parseRuleBook();

  it('룰북에서 표를 읽어낸다', () => {
    expect(book.rules.size).toBeGreaterThan(40);
  });

  it('카테고리와 처방을 함께 담는다', () => {
    const rule = book.rules.get('C-11');
    expect(rule?.category).toBe('C');
    expect(rule?.severity).toBe('S1');
    expect(rule?.prescription).toContain('쉼표');
  });

  it('말투별 심각도가 다른 룰은 두 값을 따로 갖는다', () => {
    const rule = book.rules.get('F-6');
    expect(rule?.severity).toBe('S2');
    expect(rule?.chatSeverity).toBe('S1');
  });

  it('실측으로 강등한 A-2는 문서 S2 · 대화 S1이다', () => {
    const rule = book.rules.get('A-2');
    expect(rule?.severity).toBe('S2');
    expect(rule?.chatSeverity).toBe('S1');
  });

  it('실측으로 승격한 C-8은 문서에서도 S1이다', () => {
    expect(book.rules.get('C-8')?.severity).toBe('S1');
  });

  it('자체검증 목록을 문서분과 대화분으로 나눠 읽는다', () => {
    expect(book.selfCheckS1).toContain('C-11');
    expect(book.selfCheckChatS1).toContain('F-6');
    expect(book.selfCheckS1).not.toContain('F-6');
  });
});

describe('s1Ids', () => {
  const book = parseRuleBook();

  it('대화 기준 S1은 문서 기준을 포함한다', () => {
    const doc = new Set(s1Ids(book, 'doc'));
    const chat = s1Ids(book, 'chat');
    for (const id of doc) expect(chat).toContain(id);
  });

  it('대화에서만 격상되는 룰은 문서 목록에 없다', () => {
    expect(s1Ids(book, 'doc')).not.toContain('I-5');
    expect(s1Ids(book, 'chat')).toContain('I-5');
  });
});

describe('ruleLabel', () => {
  const book = parseRuleBook();

  it('ID 뒤에 룰 이름을 붙인다', () => {
    expect(ruleLabel(book, 'C-11')).toBe('C-11 연결어미 뒤 쉼표');
    expect(ruleLabel(book, 'D-3')).toBe('D-3 "본질적으로/핵심적으로"');
  });

  it('대시 뒤 부연을 걷어낸다', () => {
    expect(ruleLabel(book, 'F-6')).toBe('F-6 복합명사 압축');
  });

  it('긴 괄호는 예시라 끊고, 짧은 괄호는 이름의 일부라 남긴다', () => {
    expect(ruleLabel(book, 'D-4')).toBe('D-4 hype 어휘');
    expect(ruleLabel(book, 'C-12')).toBe('C-12 가운뎃점(·) 나열 남발');
    expect(ruleLabel(book, 'A-1')).toBe('A-1 "~에 대해(서)"');
  });

  it('중첩 괄호가 있어도 꼬리가 남지 않는다', () => {
    expect(ruleLabel(book, 'B-1')).toBe('B-1 한글 + 괄호 영어 매번');
  });

  it('앞에 이름이 있으면 긴 인용은 예시로 보고 뺀다', () => {
    expect(ruleLabel(book, 'D-1')).toBe('D-1 결산 피벗 표현');
    expect(ruleLabel(book, 'H-1')).toBe('H-1 문두 접속사');
  });

  it('짧은 인용은 그 자체가 이름이라 남긴다', () => {
    expect(ruleLabel(book, 'A-8')).toBe('A-8 이중 피동 "~되어진다"');
  });

  it('빈도 조건은 이름이 아니다', () => {
    expect(ruleLabel(book, 'A-2')).toBe('A-2 "~를 통해/통하여"');
    expect(ruleLabel(book, 'J-2')).toBe('J-2 따옴표 강조');
  });

  it('모든 룰 이름이 한 줄에 들어간다', () => {
    for (const id of book.rules.keys()) {
      expect(ruleLabel(book, id).length).toBeLessThanOrEqual(32);
    }
  });

  it('룰북에 없는 ID는 ID 그대로 돌려준다', () => {
    expect(ruleLabel(book, 'Z-99')).toBe('Z-99');
  });
});
