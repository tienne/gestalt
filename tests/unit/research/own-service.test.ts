import { describe, expect, it } from 'vitest';
import {
  buildSummaryTables,
  renderResearchHtml,
  type LoadedImage,
} from '../../../src/research/render-html.js';
import { lintResearch, parseResearch, type Research } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };
const FIGMA = 'https://www.figma.com/design/KEY/own?node-id=1-2';

type Input = ReturnType<typeof sampleResearch>;

function withOwn(edit: (input: Input) => void = () => {}): Research {
  const input = sampleResearch();
  input.productCandidates!.push({
    id: 'own',
    name: '우리 서비스',
    axis: 'own-service',
    reason: '조사하는 쪽',
    foundVia: [],
  });
  input.references!.push({
    id: 'rown',
    symbol: 'D',
    typeName: '우리 서비스 현재 화면',
    productIds: ['own'],
    reason: '비교 기준점',
  });
  input.captures!.push({
    id: 'cown',
    productId: 'own',
    path: 'captures/own-home.png',
    kind: 'figma',
    pii: 'none',
    figmaUrl: FIGMA,
  });
  input.wowPain!.findings!.push(
    {
      id: 'fw-own',
      referenceId: 'rown',
      kind: 'wow',
      viewpoint: 'user',
      text: '결제 버튼이 항상 하단에 붙어 있어요',
      basis: 'observation',
      evidence: [{ type: 'capture', captureId: 'cown' }],
    },
    {
      id: 'fp-own',
      referenceId: 'rown',
      kind: 'pain',
      viewpoint: 'user',
      text: '금액 선택지가 두 번 눌러야 보여요',
      basis: 'observation',
      evidence: [{ type: 'capture', captureId: 'cown' }],
    },
  );
  edit(input);
  const parsed = parseResearch(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe('우리 서비스 화면 입력', () => {
  it('우리 서비스 제품과 피그마 캡처를 스키마가 받는다', () => {
    const r = withOwn();
    expect(r.productCandidates.some((p) => p.axis === 'own-service')).toBe(true);
    expect(r.captures.find((c) => c.id === 'cown')?.figmaUrl).toBe(FIGMA);
  });

  it('figma.com이 아닌 링크는 거절한다', () => {
    const input = sampleResearch();
    input.captures![0]!.kind = 'figma';
    input.captures![0]!.figmaUrl = 'https://example.com/design';
    expect(parseResearch(input).ok).toBe(false);
  });

  it('우리 서비스의 와우와 페인은 가져올 것과 피할 것에 섞이지 않는다', () => {
    const tables = buildSummaryTables(withOwn());
    const heads = tables.map((t) => t.heading);
    expect(heads).toContain('지킬 우리 와우');
    expect(heads).toContain('고칠 우리 페인');
    const takeWow = tables.find((t) => t.heading === '가져올 와우')!;
    expect(takeWow.rows.flat().join(' ')).not.toContain('결제 버튼이 항상 하단');
    const fixPain = tables.find((t) => t.heading === '고칠 우리 페인')!;
    expect(fixPain.rows[0]![0]).toBe('D. 우리 서비스 현재 화면');
  });

  it('우리 서비스가 없으면 우리 표를 그리지 않는다', () => {
    const heads = buildSummaryTables(
      (() => {
        const parsed = parseResearch(sampleResearch());
        if (!parsed.ok) throw new Error(parsed.error.message);
        return parsed.value;
      })(),
    ).map((t) => t.heading);
    expect(heads.some((h) => h.includes('우리'))).toBe(false);
  });

  it('개인용 HTML에는 피그마 노드 링크가 붙고 공유용에는 안 붙는다', () => {
    const r = withOwn();
    const priv = renderResearchHtml(r, { audience: 'private', loadImage: () => png });
    if (!priv.ok) throw new Error('렌더 실패');
    expect(priv.html).toContain(FIGMA);
    expect(priv.html).toContain('피그마');
    const shared = renderResearchHtml(r, { audience: 'shared', loadImage: () => png });
    if (!shared.ok) throw new Error('렌더 실패');
    expect(shared.html).not.toContain(FIGMA);
  });

  it('캡처 종류와 제품 축이 어긋나거나 피그마 링크가 없으면 경고한다', () => {
    const noUrl = lintResearch(
      withOwn((input) => {
        delete input.captures!.find((c) => c.id === 'cown')!.figmaUrl;
      }),
    );
    expect(noUrl.some((w) => w.path.endsWith('figmaUrl'))).toBe(true);
    const mismatch = lintResearch(
      withOwn((input) => {
        input.captures!.find((c) => c.id === 'cown')!.kind = 'direct';
      }),
    );
    expect(mismatch.some((w) => w.message.includes('own-service 제품의 캡처'))).toBe(true);
    const wrongAxis = lintResearch(
      withOwn((input) => {
        input.captures![0]!.kind = 'own-app';
      }),
    );
    expect(wrongAxis.some((w) => w.message.includes('own-service 제품에만'))).toBe(true);
  });
});
