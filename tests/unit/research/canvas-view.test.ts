import { describe, expect, it } from 'vitest';
import { boardMarkup, CANVAS_JS } from '../../../src/research/canvas-view.js';
import { renderResearchHtml, type LoadedImage } from '../../../src/research/render-html.js';
import { parseResearch } from '../../../src/research/schema.js';
import { sampleResearch } from './fixture.js';

const png: LoadedImage = { mime: 'image/png', data: Buffer.from('fake-png-bytes') };

describe('캔버스 보기', () => {
  it('h2마다 보드를 끊고 첫 h2 앞은 제목 보드로 묶는다', () => {
    const html = boardMarkup(
      ['<h1>t</h1>', '<h2>0. 전제</h2>', '<p>a</p>', '<h2>1. 레퍼런스</h2>'],
      '제목',
    );
    expect(html).toBe(
      [
        '<section class="board" data-title="제목">',
        '<h1>t</h1>',
        '</section>',
        '<section class="board" data-title="0. 전제">',
        '<h2>0. 전제</h2>',
        '<p>a</p>',
        '</section>',
        '<section class="board" data-title="1. 레퍼런스">',
        '<h2>1. 레퍼런스</h2>',
        '</section>',
      ].join('\n'),
    );
  });

  it('렌더 결과의 섹션마다 보드가 있고 이스케이프한 제목을 data-title에 쓴다', () => {
    const parsed = parseResearch(
      sampleResearch({
        meta: { slug: 'demo', title: '"따옴표" <b>', task: 't', kind: 'ux-research' },
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const r = renderResearchHtml(parsed.value, { audience: 'private', loadImage: () => png });
    if (!r.ok) throw new Error('렌더 실패');
    expect(r.html).toContain('data-title="&quot;따옴표&quot; &lt;b&gt;"');
    expect(r.html).toContain('<section class="board" data-title="0. 전제">');
    expect(r.html).toContain('<section class="board" data-title="8. 열린 질문">');
  });

  it('스크립트 본문이 script 태그를 닫지 않는다', () => {
    expect(CANVAS_JS).not.toContain('</script');
  });
});
