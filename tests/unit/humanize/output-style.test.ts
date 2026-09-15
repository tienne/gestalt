import { describe, it, expect } from 'vitest';
import {
  HOIST,
  HOIST_MAX,
  PRESCRIPTION_MAX,
  bannedPrescription,
  buildOutputStyle,
  hoistHits,
  prescriptionSentences,
  shortPrescription,
} from '../../../scripts/build-output-style.js';
import { parseRuleBook, type Rule } from '../../../src/humanize/rules.js';

/** 금지 목록에서 그 룰의 한 줄을 뽑는다 */
function bannedLine(rendered: string, id: string): string {
  const line = rendered.split('\n').find((row) => row.startsWith(`- **${id} `));
  if (!line) throw new Error(`금지 목록에 ${id} 줄이 없다`);
  return line;
}

function prescriptionCell(line: string): string {
  return line.split('** → ')[1] ?? '';
}

function fakeRule(id: string, prescription: string): Rule {
  return {
    id,
    category: 'F',
    categoryTitle: '테스트',
    pattern: '테스트 패턴',
    severity: 'S1',
    chatSeverity: 'S1',
    prescription,
  };
}

describe('shortPrescription', () => {
  it('첫 문장이 28자를 넘으면 거기서 멈춘다', () => {
    const sentences = prescriptionSentences(
      '이 첫 문장은 스물여덟 자를 넉넉히 넘기도록 길게 쓴다. 둘째 문장이다.',
    );
    expect(shortPrescription(sentences)).toEqual({
      text: '이 첫 문장은 스물여덟 자를 넉넉히 넘기도록 길게 쓴다',
      kept: 1,
    });
  });

  it('첫 문장이 짧으면 다음 문장까지 담는다', () => {
    const { text, kept } = shortPrescription(
      prescriptionSentences('짧다. 둘째 문장이다. 셋째 문장이다.'),
    );
    expect(text).toBe('짧다. 둘째 문장이다. 셋째 문장이다');
    expect(kept).toBe(3);
  });

  it('상한에 잘린 문장은 남은 것으로 안 센다', () => {
    const { text, kept } = shortPrescription([`${'가'.repeat(PRESCRIPTION_MAX + 10)}.`]);
    expect(text.endsWith('…')).toBe(true);
    expect(kept).toBe(0);
  });
});

describe('hoistHits', () => {
  it('조각이 걸리는 문장 자리를 전부 준다', () => {
    expect(hoistHits(['첫째다.', '둘째 조각이다.', '셋째 조각이다.'], '조각')).toEqual([1, 2]);
  });

  it('못 찾으면 빈 배열이다', () => {
    expect(hoistHits(['첫째다.'], '없는 말')).toEqual([]);
  });
});

describe('bannedPrescription', () => {
  const hoist = { 'F-9': '올릴 문장' };

  it('올린 문장이 앞 요약 밖이면 뒤에 잇는다', () => {
    const rule = fakeRule(
      'F-9',
      '이 첫 문장은 스물여덟 자를 넉넉히 넘기도록 길게 쓴다. 올릴 문장이다.',
    );
    expect(bannedPrescription(rule, hoist)).toBe(
      '이 첫 문장은 스물여덟 자를 넉넉히 넘기도록 길게 쓴다. 올릴 문장이다',
    );
  });

  it('올린 문장이 앞 요약에 이미 있으면 안 잇는다', () => {
    const rule = fakeRule(
      'F-9',
      '올릴 문장이라서 앞 요약이 이걸 그대로 담고도 남는 길이다. 둘째 문장이다.',
    );
    const out = bannedPrescription(rule, hoist);
    expect(out.match(/올릴 문장/g)).toHaveLength(1);
  });

  it('앞 요약이 잘렸으면 담은 걸로 안 보고 다시 잇는다', () => {
    // kept 가 아니라 taken 으로 재면 이 문장이 잘린 채 사라진다
    const long = `올릴 문장이지만 ${'가'.repeat(PRESCRIPTION_MAX)}.`;
    const out = bannedPrescription(fakeRule('F-9', long), hoist);
    expect(out).toContain('…');
    expect(out.match(/올릴 문장/g)).toHaveLength(2);
  });

  it('올린 문장은 HOIST_MAX에서 자른다', () => {
    const rule = fakeRule('F-9', `짧다. 올릴 문장인데 ${'나'.repeat(HOIST_MAX + 20)}.`);
    const lifted = bannedPrescription(rule, hoist).split('. ').at(-1)!;
    expect(lifted.length).toBeLessThanOrEqual(HOIST_MAX);
  });

  it('HOIST에 없는 룰은 앞 요약에서 끝난다', () => {
    const rule = fakeRule(
      'Z-1',
      '이 첫 문장은 스물여덟 자를 넉넉히 넘기도록 길게 쓴다. 둘째 문장이다.',
    );
    expect(bannedPrescription(rule, hoist)).toBe(
      '이 첫 문장은 스물여덟 자를 넉넉히 넘기도록 길게 쓴다',
    );
  });
});

describe('buildOutputStyle', () => {
  const rendered = buildOutputStyle();

  it('HOIST에 올린 룰마다 그 조각이 금지 목록에 실린다', () => {
    const entries = Object.entries(HOIST);
    expect(entries.length).toBeGreaterThan(0);

    for (const [id, needle] of entries) {
      expect(bannedLine(rendered, id), `${id} 줄에 HOIST 조각이 없다`).toContain(needle);
    }
  });

  it('F-9는 root 기준을 꼬리까지 싣는다', () => {
    // 이 줄이 빨개지면 룰북 문장이 바뀐 것이다. HOIST 조각과 이 기대값을 같이 맞춘다
    expect(bannedLine(rendered, 'F-9')).toContain(
      '"뿌리"는 root 한 단어가 그 대상 이름인 자리에서만 쓴다 — root cause처럼 수식하는 자리는 대상이다',
    );
  });

  it('올린 룰의 처방 칸도 두 상한 안에 있다', () => {
    for (const id of Object.keys(HOIST)) {
      const cell = prescriptionCell(bannedLine(rendered, id));
      expect(cell.length, `${id} 처방 칸`).toBeLessThanOrEqual(PRESCRIPTION_MAX + HOIST_MAX + 2);
    }
  });

  it('안 올린 룰의 처방 칸은 요약 상한에서 끝난다', () => {
    const book = parseRuleBook();
    let checked = 0;

    for (const line of rendered.split('\n')) {
      const id = line.match(/^- \*\*([A-J]-\d{1,2}) /)?.[1];
      if (!id || Object.hasOwn(HOIST, id) || !book.rules.get(id)) continue;
      expect(prescriptionCell(line).length, `${id} 처방 칸이 상한을 넘었다`).toBeLessThanOrEqual(
        PRESCRIPTION_MAX,
      );
      checked += 1;
    }

    expect(checked).toBeGreaterThan(20);
  });

  it('룰북 표에는 생성기용 마크업이 없다', () => {
    // 룰북은 플러그인으로 배포되고 에이전트 여럿이 원문을 그대로 읽는다.
    // 실을 문장을 고르는 일은 HOIST가 맡고 룰북은 산문만 갖는다
    const book = parseRuleBook();
    for (const rule of book.rules.values()) {
      expect(rule.prescription, `${rule.id} 처방`).not.toContain('<!--');
      expect(rule.pattern, `${rule.id} 패턴`).not.toContain('<!--');
    }
  });
});
