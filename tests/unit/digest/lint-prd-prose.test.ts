import { describe, expect, it } from 'vitest';
import { lintPrdProse, PROSE_SAMPLE_LIMIT } from '../../../src/digest/lint-prd-prose.js';
import { sourceFromText } from '../../../src/digest/prd-source.js';
import { sampleV2 } from './prd-fixture.js';

function fixture() {
  const { view, source } = sampleV2();
  const req = view.sections[0]!.blocks[1]!;
  const risk = view.sections[0]!.blocks[3]!;
  if (req.kind !== 'requirement' || risk.kind !== 'risk') throw new Error('fixture');
  return { view, source, req, risk };
}

describe('lintPrdProse', () => {
  it('행위자와 경계, 대응을 검사하며 진단은 전부 info다', () => {
    const { view, source, req, risk } = fixture();
    req.detail = ['선택한 책을 신청한다.'];
    delete req.boundary;
    delete risk.response;
    const prose = lintPrdProse(view, source);
    for (const code of ['REQ_NO_SUBJECT', 'REQ_NO_BOUNDARY', 'RISK_NO_RESPONSE']) {
      expect(prose).toContainEqual(expect.objectContaining({ code, severity: 'info' }));
    }
    expect(prose.every((g) => g.severity === 'info')).toBe(true);
  });

  it.each(['사용자는', '사용자가', '관리자는', '관리자가', '회원은', '운영자는'])(
    '%s 행위자와 title 다음 문장을 인식한다',
    (subject) => {
      const { view, source, req } = fixture();
      req.detail = [`${subject} 대여할 책을 선택한다.`];
      expect(
        lintPrdProse(view, source)
          .find((g) => g.code === 'REQ_NO_SUBJECT')
          ?.samples.some((s) => s.blockId === req.id),
      ).toBeFalsy();
      delete req.detail;
      req.title = `대여 신청. ${subject} 책을 선택한다.`;
      expect(
        lintPrdProse(view, source)
          .find((g) => g.code === 'REQ_NO_SUBJECT')
          ?.samples.some((s) => s.blockId === req.id),
      ).toBeFalsy();
    },
  );

  it('acceptance와 data, risk의 가능 표현만 짚고 result와 permission은 제외한다', () => {
    const { view, source, req, risk } = fixture();
    req.acceptance![0]!.text = '목록에 등록될 수 있다.';
    req.slots!.data!.text = '번호가 누락될 수 있다.';
    risk.text = '신청이 실패할 수 있다.';
    const group = lintPrdProse(view, source).find((g) => g.code === 'MODAL_AMBIGUOUS');
    expect(group?.count).toBe(3);
    expect(group?.samples.map((s) => s.field)).toEqual([
      'acceptance.0.text',
      'slots.data.text',
      'text',
    ]);
  });

  it('원문 전체에서 긴 문장과 humanize 규칙을 찾아 원문 문장과 규칙 id를 싣는다', () => {
    const { view } = fixture();
    const sentence =
      '회원은 도서를 고르고, 대여 · 반납 · 예약 내용을 보면서 다음에 읽을 책과 받을 장소와 신청한 순서와 지금 처리하는 상태와 남은 신청 횟수까지 함께 살펴본다.';
    const source = sourceFromText(
      'docs/rental/PRD.md',
      `# 대여\n${sentence}\n${'짧다. '.repeat(30)}\n\`\`\`ts\n${'코드'.repeat(50)}\n\`\`\``,
    );
    const prose = lintPrdProse(view, source);
    expect(prose.find((g) => g.code === 'SENTENCE_LONG')).toMatchObject({
      count: 1,
      samples: [{ sentence, line: 2 }],
    });
    expect(prose.find((g) => g.code === 'PROSE_AI_TELL')?.samples).toContainEqual(
      expect.objectContaining({ sentence, ruleId: expect.any(String) }),
    );
  });

  it('반복 진단은 코드별 전체 건수와 앞 예시 세 개만 싣고 원문은 유지한다', () => {
    const { view, source, req } = fixture();
    for (let k = 0; k < 10; k++)
      view.sections[0]!.blocks.push({
        ...req,
        id: `req${k}`,
        detail: ['책 고르기'],
        boundary: undefined,
      });
    const before = JSON.stringify(view);
    const prose = lintPrdProse(view, source);
    expect(prose.find((g) => g.code === 'REQ_NO_BOUNDARY')).toMatchObject({
      count: 11,
      samples: expect.any(Array),
    });
    expect(prose.find((g) => g.code === 'REQ_NO_BOUNDARY')?.samples).toHaveLength(
      PROSE_SAMPLE_LIMIT,
    );
    expect(JSON.stringify(view)).toBe(before);
  });
});
