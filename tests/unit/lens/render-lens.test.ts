import { describe, expect, it } from 'vitest';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';

const html = (report = lensReport(), kind: 'pdf' | 'web' = 'pdf') =>
  renderDigestHtml(lensDigest(report), lensTranscript(kind), { source: lensSource() }).html;

describe('읽기 렌즈 뷰어', () => {
  it('글 자료는 렌즈와 원문 시트 클래스를 붙이고 시트를 여는 버튼을 그린다', () => {
    const out = html();
    expect(out).toContain('<body class="is-diary is-lens is-doc">');
    expect(out).toContain('id="doc-open" class="doc-open" aria-controls="side"');
    expect(out).toContain('<aside class="side" id="side">');
    expect(out).toContain('class="doc-close"');
  });

  it('PDF는 플레이어 대신 쪽 그림 원문 창과 추출 텍스트를 둔다', () => {
    const out = html();
    expect(out).toContain('id="doc-pane"');
    expect(out).toContain('src="pages/p2.jpg"');
    expect(out).not.toContain('id="player"');
    expect(out).toContain('"videoId":null');
    // 문단 칩은 쪽 번호를 보이고 누르면 그 문단 번호를 연다
    expect(out).toMatch(/<button type="button" class="loc" data-unit="3">p\.2<\/button>/);
  });

  it('뷰어 데이터에 문단 사각형과 쪽 크기를 싣는다', () => {
    const out = html();
    const data = JSON.parse(
      /<script type="application\/json" id="digest-data">(.+?)<\/script>/s.exec(out)![1]!,
    );
    expect(data.doc).toBe(true);
    expect(data.kind).toBe('pdf');
    expect(data.units[3]).toEqual([[2, 70, 250, 290, 290]]);
    expect(data.pages[0]).toEqual({ n: 1, w: 595, h: 842 });
  });

  it('웹 글은 쪽 그림 없이 문단 목록만 두고 칩은 문단 번호다', () => {
    const out = html(lensReport(), 'web');
    expect(out).toContain('id="script-list"');
    expect(out).not.toContain('id="doc-pages"');
    expect(out).toMatch(/data-unit="3">¶4<\/button>/);
  });

  it('원문 표는 source.json 칸을 그대로 옮기고 원문 크롭을 접어 둔다', () => {
    const out = html();
    expect(out).toContain('id="src-table-4"');
    expect(out).toContain('<td data-cell="table-4:2:1">0.2862</td>');
    expect(out).toContain('src="tables/table-4.png"');
  });

  it('칸 경계를 못 믿을 표는 원문 크롭을 앞에 두고 옮긴 칸을 접는다', () => {
    const source = lensSource();
    source.tables[0]!.grid = 'loose';
    const out = renderDigestHtml(lensDigest(), lensTranscript(), { source }).html;
    expect(out).toContain('class="src-table is-loose"');
    expect(out).toMatch(/is-loose[^]*?<img class="src-crop"[^]*?<details>/);
  });

  it('원문 그림은 크롭과 쪽 썸네일을 나란히 두고 그림 자리를 칠한다', () => {
    const out = html();
    expect(out).toContain('src="figures/figure-1.png"');
    expect(out).toMatch(/class="page-thumb" data-unit="7"/);
    expect(out).toContain('class="thumb-hl"');
  });

  it('의심 표시는 불릿 바로 아래 펼쳐 두고 근거 칸 값을 보인다', () => {
    const out = html();
    expect(out).toContain('<li class="has-doubt">');
    expect(out).toContain('원문과 어긋남');
    expect(out).toMatch(/data-cell="table-4:2:1">표 4 3행 2열 <b>0\.2862<\/b>/);
  });

  it('한눈에 보기와 커버리지 배지, 검증 안 된 부분을 그린다', () => {
    const out = html();
    expect(out).toContain('한눈에 보기');
    expect(out).toMatch(/<dt>문제<\/dt>[^]*<dt>방법<\/dt>[^]*<dt>결과<\/dt>[^]*<dt>한계<\/dt>/);
    expect(out).toContain('원문 10문단 중 9문단을 다뤘고');
    expect(out).toContain('검증 안 된 부분');
    expect(out).toContain('class="sec-intro"');
  });

  it('원문 글자에 든 태그는 escape된다', () => {
    const t = lensTranscript();
    t.segments[1]!.text = '<script>alert(1)</script>';
    const out = renderDigestHtml(lensDigest(), t, { source: lensSource() }).html;
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('마크다운에 한눈에 보기 표와 원문 표, 의심, 한계를 싣고 출처는 문단과 쪽이다', () => {
    const md = renderDigestMarkdown(lensDigest(), lensTranscript(), { source: lensSource() });
    expect(md).toContain('| 결과 | NMI 0.3410 [¶4, p.2] |');
    expect(md).toContain('| Flavor Diffusion_CSP (50 nodes) | 0.2862 | 0.0152 |');
    expect(md).toContain('> **원문과 어긋남** 노드 50개에서는');
    expect(md).toContain('## 검증 안 된 부분');
    expect(md).toContain('(표 6 2행 3열: 0.0006)');
  });
});

describe('공유용 렌더(크롭 빼기)', () => {
  it('쪽 그림과 표, 그림 크롭을 싣지 않고 추출 텍스트 원문 창만 둔다', () => {
    const r = lensReport();
    const out = renderDigestHtml(lensDigest(r), lensTranscript(), {
      source: lensSource(),
      omitCrops: true,
    }).html;
    expect(out).not.toMatch(/src="(pages|tables|figures)\//);
    expect(out).not.toContain('id="doc-pages"');
    expect(out).toContain('id="script-list"');
    expect(out).toContain('공유용으로 원문에서 잘라낸 그림을 뺐어요');
    // 칸 글자는 원문 크롭이 아니라 옮긴 표라 그대로 남는다
    expect(out).toContain('<td data-cell="table-4:2:1">0.2862</td>');
    const md = renderDigestMarkdown(lensDigest(r), lensTranscript(), {
      source: lensSource(),
      omitCrops: true,
    });
    expect(md).not.toContain('figures/figure-1.png');
  });

  it('노트 연결 카드는 경로와 인용째 싣지 않는다', () => {
    const r = lensReport();
    r.links = [
      {
        id: 'kb-1',
        section: 's1',
        anchor: { key: 1, from: 1, to: 1 },
        title: '향미 노트의 FlavorGraph 항목',
        note: '노트에 적어 둔 그래프가 이 논문의 바탕이다.',
        path: '/Volumes/private/notes/flavor.md',
        line: 12,
        quote: '개인 메모에만 있는 인용 문장',
      },
    ];
    const opts = { source: lensSource() };
    // 공유용이 아니면 카드가 실린다
    const full = renderDigestHtml(lensDigest(r), lensTranscript(), opts).html;
    expect(full).toContain('개인 메모에만 있는 인용 문장');
    expect(full).toContain('/Volumes/private/notes/flavor.md');

    const out = renderDigestHtml(lensDigest(r), lensTranscript(), {
      ...opts,
      omitCrops: true,
    }).html;
    expect(out).not.toContain('개인 메모에만 있는 인용 문장');
    expect(out).not.toContain('/Volumes/private/notes');
    expect(out).not.toContain('내 지식과 잇기');

    const md = renderDigestMarkdown(lensDigest(r), lensTranscript(), { ...opts, omitCrops: true });
    expect(md).not.toContain('## 내 지식과 잇기');
    expect(md).not.toContain('개인 메모에만 있는 인용 문장');
    expect(md).not.toContain('/Volumes/private/notes');
  });
});
