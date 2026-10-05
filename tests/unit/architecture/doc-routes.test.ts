import { describe, expect, it } from 'vitest';
import { analyzeDocRoutes, docResolver } from '../../../src/architecture/doc-routes.js';
import { buildKnowledgeIr, scanMarkdown } from '../../../src/architecture/doc-scan.js';

const doc = (path: string, text: string) => scanMarkdown('acme-kb', path, text);

const SCAN = {
  skipped: [],
  docs: [
    doc(
      'README.md',
      [
        '# 안내',
        '',
        '| 질문 | 문서 |',
        '|---|---|',
        '| 주문, 결제 | [주문](domains/orders/INDEX.md) |',
        '| 환불 | [환불](domains/refund.md) |',
        '| 정산 | [정산](domains/settle.md) |',
      ].join('\n'),
    ),
    doc(
      'domains/orders/INDEX.md',
      ['# 주문', '', '자세한 건 `domains/orders/flow.md`와 `references/rules.md`를 봐요.'].join(
        '\n',
      ),
    ),
    doc('domains/orders/flow.md', '# 흐름'),
    doc('domains/orders/references/rules.md', '# 규칙'),
    doc('domains/refund.md', '# 환불\n\n| 파일 | 설명 |\n|---|---|\n| 01-intro.md | 시작 |'),
    doc('domains/refund/01-intro.md', '# 시작'),
    doc(
      'skills/billing/SKILL.md',
      '# 정산 스킬\n\n| 질문 | 문서 |\n|---|---|\n| 결제 | [결제](./pay.md) |',
    ),
    doc('skills/billing/pay.md', '# 결제'),
    doc('archive/old.md', '# 옛 문서'),
  ],
};

describe('질문 길', () => {
  it('링크, 백틱 경로, 표 안 파일 이름을 따라 진입 문서에서 닿는 문서를 센다', () => {
    const r = analyzeDocRoutes(SCAN);
    expect(r.entries).toEqual(['acme-kb/README.md', 'acme-kb/skills/billing/SKILL.md']);
    expect(r.orphans).toEqual(['acme-kb/archive/old.md']);
    expect(r.reachable).toBe(8);
  });

  it('없는 문서로 가는 안내와 같은 말이 다른 문서로 가는 자리를 잡는다', () => {
    const r = analyzeDocRoutes(SCAN);
    expect(r.deadRoutes).toEqual([
      { from: 'acme-kb/README.md', keywords: ['정산'], targetPath: 'domains/settle.md' },
    ]);
    expect(r.conflicts).toEqual([
      {
        keyword: '결제',
        targets: ['acme-kb/domains/orders/INDEX.md', 'acme-kb/skills/billing/pay.md'],
      },
    ]);
  });

  it('진입 문서가 없으면 고립으로 몰지 않는다', () => {
    const r = analyzeDocRoutes({ skipped: [], docs: [doc('a/b.md', '# b')] });
    expect(r.orphans).toEqual([]);
  });

  it('지식 지도 초안의 문서 노드에 고립과 찾는 말을 싣는다', () => {
    const ir = buildKnowledgeIr([{ repoId: 'acme-kb', path: '/x' }], SCAN, '2026-10-05T00:00:00Z');
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    expect(byId.get('doc:acme-kb/archive/old.md')?.doc?.orphan).toBe(true);
    expect(byId.get('doc:acme-kb/domains/orders/INDEX.md')?.doc).toMatchObject({
      keywords: ['주문', '결제'],
    });
    expect(byId.get('doc:acme-kb/README.md')?.doc?.orphan).toBeUndefined();
  });
});

describe('문서 경로 풀기', () => {
  it('옆 스킬이나 레포 루트 기준으로 적은 경로를 위 폴더로 올라가며 푼다', () => {
    const scan = {
      skipped: [],
      docs: [
        doc(
          'skills/ads/INDEX.md',
          '| 질문 | 문서 |\n|---|---|\n| 지도 광고 | `search/references/ads.md` |',
        ),
        doc('skills/search/references/ads.md', '# 광고'),
        doc('skills/data/references/a.md', '`references/b.md`와 `$REPO_ROOT/README.md`'),
        doc('skills/data/references/b.md', '# b'),
        doc('README.md', '# 안내'),
      ],
    };
    const resolve = docResolver(scan);
    const [ads, , a] = scan.docs;
    expect(resolve(ads!, 'search/references/ads.md')).toBe(
      'acme-kb/skills/search/references/ads.md',
    );
    expect(resolve(a!, 'references/b.md')).toBe('acme-kb/skills/data/references/b.md');
    expect(resolve(a!, '$REPO_ROOT/README.md')).toBe('acme-kb/README.md');
    expect(analyzeDocRoutes(scan).deadRoutes).toEqual([]);
    const ir = buildKnowledgeIr([{ repoId: 'acme-kb', path: '/x' }], scan, '2026-10-05T00:00:00Z');
    expect(ir.nodes.find((n) => n.id === 'doc:acme-kb/skills/ads/INDEX.md')?.doc?.routes).toEqual([
      {
        keywords: ['지도 광고'],
        targetPath: 'skills/search/references/ads.md',
        target: 'doc:acme-kb/skills/search/references/ads.md',
      },
    ]);
  });
});
