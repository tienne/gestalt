import { describe, expect, it } from 'vitest';
import { renderResearchHtml, type LoadedImage } from '../../../src/research/render-html.js';
import { parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

function research(overrides: Parameters<typeof sampleResearch>[0] = {}): Research {
  const parsed = parseResearch(sampleResearch(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };
const withImage = (): LoadedImage | null => png;

describe('research HTML 렌더', () => {
  it('섹션 0부터 8까지와 제목을 그린다', () => {
    const r = renderResearchHtml(research(), { audience: 'private', loadImage: withImage });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const h of [
      '0. 전제',
      '1. 레퍼런스 선정',
      '2. 시안',
      '3. 비교표',
      '4. 와우 포인트와 페인 포인트',
      '5. 레퍼런스가 그렇게 한 이유',
      '6. 판단',
      '7. 검증 제안',
      '8. 열린 질문',
    ]) {
      expect(r.html).toContain(h);
    }
    expect(r.html).toContain('<title>');
    expect(r.html).toContain('prefers-color-scheme:dark');
  });

  it('시안이 없으면 비교표의 열이 레퍼런스 화면이라고 적고 보류에는 결정 조건을 붙인다', () => {
    const r = renderResearchHtml(research(), { audience: 'private', loadImage: withImage });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('시안 대신 레퍼런스 화면이다');
    expect(r.html).toContain('수량 한도 정책이 확정되면 결정');
    expect(r.html).not.toContain('뒤에 정함');
  });

  it('제외 판단은 제외 칩으로 그린다', () => {
    const input = sampleResearch();
    input.judgment!.push({
      area: '선물 분기',
      conclusion: '이번 과제 범위에서 뺀다',
      confidence: 'out',
      rationale: '구매 단계를 하나 늘린다',
    });
    const parsed = parseResearch(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = renderResearchHtml(parsed.value, { audience: 'private', loadImage: withImage });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain('<span class="chip">제외</span>');
  });

  it('사용자 글자를 이스케이프하고 스크립트를 넣지 않는다', () => {
    const r = renderResearchHtml(
      research({
        meta: {
          slug: 'demo',
          title: '<script>alert(1)</script>',
          task: 'a & b',
          kind: 'ux-research',
        },
      }),
      { audience: 'private', loadImage: withImage },
    );
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).not.toContain('<script');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('a &amp; b');
  });

  it('이미지는 base64로 한 파일에 넣는다', () => {
    const r = renderResearchHtml(research(), { audience: 'private', loadImage: withImage });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain(`data:image/png;base64,${png.data.toString('base64')}`);
  });

  it('공유용은 pii unchecked 캡처가 있으면 막고 캡처 id를 알려준다', () => {
    const base = research();
    const bad = {
      ...base,
      captures: base.captures.map((c) => ({ ...c, pii: 'unchecked' as const })),
    };
    const r = renderResearchHtml(bad, { audience: 'shared', loadImage: withImage });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('SHARE_BLOCKED');
    expect(r.captureIds).toEqual(bad.captures.map((c) => c.id));
    expect(renderResearchHtml(bad, { audience: 'private', loadImage: withImage }).ok).toBe(true);
  });

  it('공유용에는 로컬 경로와 계획 메모를 싣지 않는다', () => {
    const base = research();
    const withNote = { ...base, plan: { ...base.plan, note: '내부 메모 XYZ' } };
    const priv = renderResearchHtml(withNote, { audience: 'private', loadImage: withImage });
    const shared = renderResearchHtml(withNote, { audience: 'shared', loadImage: withImage });
    if (!priv.ok || !shared.ok) throw new Error('렌더 실패');
    const path = base.captures[0]!.path;
    expect(priv.html).toContain(path);
    expect(priv.html).toContain('내부 메모 XYZ');
    expect(shared.html).not.toContain(path);
    expect(shared.html).not.toContain('내부 메모 XYZ');
  });

  it('5MB를 넘는 이미지는 건너뛰고 경고한다', () => {
    const big: LoadedImage = { mime: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 1) };
    const r = renderResearchHtml(research(), { audience: 'private', loadImage: () => big });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.warnings.some((w) => w.includes('5MB'))).toBe(true);
    expect(r.html).not.toContain('data:image/png');
  });

  it('조합 확인 전에는 안내 문구를 붙인다', () => {
    const r = renderResearchHtml(research({ plan: {} }), {
      audience: 'private',
      loadImage: withImage,
    });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain('아직 확인받지 않았습니다');
  });
  it('구좌 격자에 정의, 패턴, 근거 표기, 못 본 칸의 이유를 그린다', () => {
    const base = sampleResearch();
    base.comparison![0]!.definition = '첫 화면에서 한눈에 보이는 상품 수';
    base.comparison![0]!.pattern = 'split';
    base.comparison![0]!.cells[0]!.captureIds = ['cap1'];
    base.captures![0]!.frameNo = '08';
    base.captures![0]!.caption = '1. 홈 — 순위 목록';
    const r = renderResearchHtml(research(base), { audience: 'private', loadImage: withImage });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain('첫 화면에서 한눈에 보이는 상품 수');
    expect(r.html).toContain('서비스별 분기');
    expect(r.html).toContain('(프레임 08)');
    expect(r.html).toContain('href="#cap-cap1"');
    expect(r.html).toContain('id="cap-cap1"');
    expect(r.html).toContain('1. 홈 — 순위 목록');
    expect(r.html).toContain('class="cell grey"');
    expect(r.html).toContain('구현 정보는 화면에 안 나온다');
  });

  it('발견은 구분, 구체값, 근거와 함께 그리고 시안 채택 표를 시안 섹션에 둔다', () => {
    const r = renderResearchHtml(research(), { audience: 'private', loadImage: withImage });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain('5개 상품을 비교하려면 5번 진입');
    expect(r.html).toContain('chip kind-pain');
    expect(r.html).toContain('시안이 가져온 것과 푼 것');
    expect(r.html).toContain('촘촘한 1열 행');
    const adoption = r.html.indexOf('시안이 가져온 것과 푼 것');
    expect(adoption).toBeGreaterThan(r.html.indexOf('<h2>2. 시안</h2>'));
    expect(adoption).toBeLessThan(r.html.indexOf('<h2>3. 비교표</h2>'));
  });

  it('열린 질문에 확인 주체를 붙이고 판단에 우선순위와 할 일을 붙인다', () => {
    const base = sampleResearch();
    base.judgment![0]!.rank = 1;
    base.judgment![0]!.todo = '카드 높이를 줄인 시안을 만든다';
    base.openQuestions!.items[0]!.ownerNote = '개발팀';
    const r = renderResearchHtml(research(base), { audience: 'private', loadImage: withImage });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain('데이터 확인 선행');
    expect(r.html).toContain('개발팀');
    expect(r.html).toContain('우선순위 1');
    expect(r.html).toContain('할 일: 카드 높이를 줄인 시안을 만든다');
  });

  it('격자 썸네일은 이미지당 1MB를 넘으면 링크만 남긴다', () => {
    const base = sampleResearch();
    base.comparison![0]!.cells[0]!.captureIds = ['cap1'];
    const mid: LoadedImage = { mime: 'image/png', data: Buffer.alloc(1024 * 1024 + 1) };
    const r = renderResearchHtml(research(base), { audience: 'private', loadImage: () => mid });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain('href="#cap-cap1"');
    expect(r.html.split('data:image/png').length - 1).toBe(1);
  });
});
