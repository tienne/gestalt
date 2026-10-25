import { describe, expect, it } from 'vitest';
import {
  applyProse,
  diffMarkers,
  extractMarkers,
  extractProse,
} from '../../../src/digest/prose.js';
import type { Digest } from '../../../src/digest/schema.js';
import { sampleDigest } from './fixture.js';

/** 그림 글자가 다 들어 있는 요약. 리포트 도식은 열 제목이 있는 비교로 바꾸고 장면과 확장을 붙인다 */
function labeledDigest(): Digest {
  const d = sampleDigest();
  const s2 = d.reports[0]!.sections[1]!;
  s2.diagram = {
    kind: 'compare',
    caption: '두 방식의 비교',
    columns: [
      { title: '예전 방식', items: [{ label: '손으로 3번 고치기' }] },
      { title: '새 방식', items: [{ label: '에이전트가 고치기' }] },
    ],
  };
  s2.subsections[0]!.shots = [
    { sec: 7, caption: '방향을 고르는 화면 슬라이드', cite: { key: 6, from: 6, to: 7 } },
  ];
  d.extensions = [
    {
      template: 'visual',
      title: '그림 해설',
      lang: 'ko',
      blocks: [
        {
          type: 'figure',
          title: '출시 흐름',
          diagram: { kind: 'flow', steps: [{ label: '공개' }, { label: 'AI 도입' }] },
          explanation: '공개 뒤 AI를 들였다.',
          cite: { key: 11, from: 10, to: 11 },
        },
        { type: 'mindmap', root: { label: 'Code Layers', children: [{ label: '탐색' }] } },
      ],
    },
  ];
  return d;
}

describe('extractProse', () => {
  it('제목은 빼고 도입, 결론, 불릿, 키워드 설명을 path와 hash로 뽑는다', () => {
    const items = extractProse(sampleDigest());
    const paths = items.map((i) => i.path);
    expect(paths).toContain('reports.0.lead.question');
    expect(paths).toContain('reports.0.sections.0.conclusion');
    expect(paths).toContain('reports.0.sections.0.subsections.0.bullets.0.text');
    expect(paths).toContain('reports.0.keywords.0.explanation');
    expect(items.some((i) => !i.kind && i.path.endsWith('.title'))).toBe(false);
    expect(items[0]!.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('그림 글자는 kind label로 따로 내고 같은 그림끼리 group을 맞춘다', () => {
    const labels = extractProse(labeledDigest()).filter((i) => i.kind === 'label');
    const dp = 'reports.0.sections.1.diagram';
    const shots = 'reports.0.sections.1.subsections.0.shots';
    expect(labels.map(({ path, group }) => ({ path, group }))).toEqual([
      { path: `${dp}.caption`, group: dp },
      { path: `${dp}.columns.0.title`, group: dp },
      { path: `${dp}.columns.0.items.0.label`, group: dp },
      { path: `${dp}.columns.1.title`, group: dp },
      { path: `${dp}.columns.1.items.0.label`, group: dp },
      { path: `${shots}.0.caption`, group: shots },
      {
        path: 'extensions.0.blocks.0.diagram.steps.0.label',
        group: 'extensions.0.blocks.0.diagram',
      },
      {
        path: 'extensions.0.blocks.0.diagram.steps.1.label',
        group: 'extensions.0.blocks.0.diagram',
      },
      { path: 'extensions.0.blocks.1.root.label', group: 'extensions.0.blocks.1' },
      { path: 'extensions.0.blocks.1.root.children.0.label', group: 'extensions.0.blocks.1' },
    ]);
  });

  it('figure 제목은 이름 칸이라 라벨로도 본문으로도 내지 않는다', () => {
    const paths = extractProse(labeledDigest()).map((i) => i.path);
    expect(paths).not.toContain('extensions.0.blocks.0.title');
    expect(paths).toContain('extensions.0.blocks.0.explanation');
  });
});

describe('extractMarkers', () => {
  it('키워드 id, 굵게, URL, 숫자를 센다. 키워드 id 속 숫자는 따로 세지 않는다', () => {
    expect(
      extractMarkers('{{kw:v2-api|API}}는 **3배** 빠르다 https://a.io/1 에서 12,000건'),
    ).toEqual(['키워드:v2-api', '굵게', '링크:https://a.io/1', '수치:3', '수치:12,000']);
  });

  it('키워드 표시 글자는 바뀌어도 되지만 id가 바뀌면 걸린다', () => {
    expect(diffMarkers('{{kw:a|코드 레이어}} 소개', '{{kw:a|레이어}}를 소개해요')).toBeNull();
    expect(diffMarkers('{{kw:a|코드}}', '{{kw:b|코드}}')).toEqual({
      missing: ['키워드:a'],
      added: ['키워드:b'],
    });
  });
});

describe('applyProse', () => {
  const pick = (path: string) => extractProse(sampleDigest()).find((i) => i.path === path)!;

  it('표식이 그대로면 같은 path에 넣고 원본은 건드리지 않는다', () => {
    const src = sampleDigest();
    const item = pick('reports.0.sections.0.conclusion');
    const r = applyProse(src, [
      { ...item, text: '{{kw:code-layers|코드 레이어}}로 캔버스에서 코드를 다룬다.' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.digest.reports[0]!.sections[0]!.conclusion).toBe(
      '{{kw:code-layers|코드 레이어}}로 캔버스에서 코드를 다룬다.',
    );
    expect(src.reports[0]!.sections[0]!.conclusion).toBe(item.text);
  });

  it('굵게가 빠지면 원문을 두고 MARKER_MISMATCH', () => {
    const item = pick('reports.0.sections.0.subsections.0.bullets.0.text');
    const r = applyProse(sampleDigest(), [{ ...item, text: '코드를 그대로 가져온다.' }]);
    expect(r.applied).toBe(0);
    expect(r.warnings).toEqual([
      { path: item.path, code: 'MARKER_MISMATCH', missing: ['굵게'], added: [] },
    ]);
  });

  it('hash가 다르면 STALE, 모르는 path와 빈 문장, 중복 path도 경고만 한다', () => {
    const a = pick('reports.0.lead.answer');
    const b = pick('reports.0.lead.takeaway');
    const r = applyProse(sampleDigest(), [
      { ...a, hash: '000000000000', text: '새 문장' },
      { path: 'reports.0.lead.nope', hash: a.hash, text: 'x' },
      { ...b, text: ' ' },
      { ...b, text: '두 번째' },
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['STALE', 'UNKNOWN_PATH', 'DUPLICATE_PATH']);
    expect(r.applied).toBe(0);
  });

  it('그대로 돌려준 항목은 unchanged로 센다', () => {
    const a = pick('reports.0.lead.answer');
    expect(applyProse(sampleDigest(), [a]).unchanged).toBe(1);
  });

  describe('그림 글자', () => {
    const label = (path: string) => extractProse(labeledDigest()).find((i) => i.path === path)!;
    const shot = 'reports.0.sections.1.subsections.0.shots.0.caption';

    it('원문보다 짧거나 같으면 넣는다', () => {
      const item = label(shot);
      const r = applyProse(labeledDigest(), [{ ...item, text: '방향 고르는 화면' }]);
      expect(r.applied).toBe(1);
      expect(r.digest.reports[0]!.sections[1]!.subsections[0]!.shots![0]!.caption).toBe(
        '방향 고르는 화면',
      );
    });

    it('원문보다 길어지면 원문을 두고 LABEL_TOO_LONG', () => {
      const item = label('reports.0.sections.1.diagram.columns.1.title');
      const r = applyProse(labeledDigest(), [{ ...item, text: '에이전트에게 맡기는 새 방식' }]);
      expect(r.applied).toBe(0);
      expect(r.warnings).toEqual([{ path: item.path, code: 'LABEL_TOO_LONG' }]);
    });

    it('숫자가 바뀌거나 굵게가 붙으면 MARKER_MISMATCH', () => {
      const num = label('reports.0.sections.1.diagram.columns.0.items.0.label');
      const r = applyProse(labeledDigest(), [{ ...num, text: '손으로 세 번' }]);
      expect(r.warnings).toEqual([
        { path: num.path, code: 'MARKER_MISMATCH', missing: ['수치:3'], added: [] },
      ]);
      const mm = label('extensions.0.blocks.1.root.children.0.label');
      expect(applyProse(labeledDigest(), [{ ...mm, text: '**탐색**' }]).warnings[0]!.code).toBe(
        'MARKER_MISMATCH',
      );
    });
  });
});
