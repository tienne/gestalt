import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import {
  HOIST,
  HOIST_MAX,
  PRESCRIPTION_ENOUGH,
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
  const cell = line.split('** → ')[1];
  if (cell === undefined) throw new Error(`처방 칸 구분자가 없다: ${line}`);
  return cell;
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

describe('prescriptionSentences', () => {
  it('영어 예시의 원문 쪽을 걷는다', () => {
    expect(prescriptionSentences('("root cause" → "원인")로 쓴다.')).toEqual(['("원인")로 쓴다.']);
  });

  it('문서 기준 빈도 조건을 걷는다', () => {
    expect(prescriptionSentences('3회 초과 시 쉼표로 푼다.')).toEqual(['쉼표로 푼다.']);
  });

  it('조건을 걷고 남은 앞 쉼표도 지운다', () => {
    expect(prescriptionSentences('반복분만, 쉼표로 푼다.')).toEqual(['쉼표로 푼다.']);
  });
});

describe('shortPrescription', () => {
  it(`첫 문장이 ${PRESCRIPTION_ENOUGH}자를 넘으면 거기서 멈춘다`, () => {
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

  it('문서 기준 근거 문장에서 멈춘다', () => {
    const { text, kept } = shortPrescription(['짧다.', '문서 산문에서는 세 번까지 봐준다.']);
    expect(text).toBe('짧다');
    expect(kept).toBe(1);
  });

  it('남은 자리보다 길면 안 담는다', () => {
    const { kept } = shortPrescription(['짧다.', `${'나'.repeat(PRESCRIPTION_MAX)}.`]);
    expect(kept).toBe(1);
  });

  it('빈 목록은 빈 결과다', () => {
    expect(shortPrescription([])).toEqual({ text: '', kept: 0 });
  });

  it('길이가 상한과 같으면 안 자르고 센 수도 그대로다', () => {
    const { text, kept } = shortPrescription([`${'가'.repeat(PRESCRIPTION_MAX)}.`]);
    expect(text).toHaveLength(PRESCRIPTION_MAX);
    expect(kept).toBe(1);
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
  // describe 본문에서 부르면 룰북이 어긋날 때 이 파일의 순수 함수 테스트까지 수집 단계에서 죽는다
  let rendered: string;
  beforeAll(() => {
    rendered = buildOutputStyle();
  });

  // HOIST 항목이 둘 이상 될 때를 위한 자리다. 지금은 아래 F-9 테스트에 포함된다
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

  it('F-9 줄이 실측 예산 안에 있다', () => {
    // PRESCRIPTION_MAX + HOIST_MAX + 2 는 clamp 가 무조건 보장해서 못 잡는다.
    // 지금 값(174자)에 여유만 둬야 룰북 문장이 길어질 때 실제로 걸린다
    expect(bannedLine(rendered, 'F-9').length).toBeLessThanOrEqual(180);
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

describe('verify의 HOIST 검사', () => {
  const restore = { ...HOIST };

  afterEach(() => {
    for (const key of Object.keys(HOIST)) delete HOIST[key];
    Object.assign(HOIST, restore);
  });

  it('룰북에 없는 ID를 가리키면 멈춘다', () => {
    HOIST['Z-9'] = '아무 조각';
    expect(buildOutputStyle).toThrow(/룰북에 없는 ID/);
  });

  it('금지 목록 밖의 룰에 올리면 멈춘다', () => {
    // C-5는 대화 어투와 충돌해 SPOTLIGHT에서 뺀 룰이다
    HOIST['C-5'] = '이모지';
    expect(buildOutputStyle).toThrow(/금지 목록에 없습니다/);
  });

  it('조각을 처방에서 못 찾으면 멈춘다', () => {
    HOIST['F-9'] = '룰북에 없는 조각';
    expect(buildOutputStyle).toThrow(/처방에서 못 찾습니다/);
  });

  it('조각이 여러 문장에 걸리면 멈춘다', () => {
    HOIST['F-9'] = '다';
    expect(buildOutputStyle).toThrow(/처방의 문장 \d+개에 걸립니다/);
  });

  it('올린 문장이 상한을 넘으면 멈춘다', () => {
    // F-10 아홉째 문장은 HOIST_MAX 를 넘는다
    HOIST['F-10'] = '탐지기는 "못 박" 어간과';
    expect(buildOutputStyle).toThrow(/HOIST_MAX/);
  });
});
