import { describe, expect, it } from 'vitest';
import { renderInline, renderMarkdown, safeHref } from '../../../src/conductor/results-markdown.js';

const LINK_ATTR = 'rel="noreferrer noopener" target="_blank"';

/** 태그로 살아남으면 안 되는 위험 요소 */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/\son\w+\s*=[^&]*>/i);
  expect(html).not.toMatch(/href="\s*javascript:/i);
}

describe('renderMarkdown 안전성', () => {
  it('<script>는 이스케이프된 글자가 된다', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expectInert(html);
  });

  it('<img onerror>와 원시 HTML 블록은 태그가 안 된다', () => {
    for (const src of [
      '<img src=x onerror=alert(1)>',
      '<div onclick="x()">hi</div>',
      '<iframe src="https://example.com"></iframe>',
      '<a href="javascript:alert(1)">x</a>',
      '문장 안의 <b onmouseover=1>굵게</b>',
    ]) {
      const html = renderMarkdown(src);
      expectInert(html);
      expect(html).toContain('&lt;');
      expect(html).not.toMatch(/<(img|div|iframe|b)\b/);
    }
  });

  it('javascript:, data:, vbscript: 링크는 링크가 안 되고 글자로 남는다(대소문자와 공백 변형 포함)', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>x</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example.com/x',
      '/relative/path',
    ]) {
      const html = renderMarkdown(`[x](${href})`);
      expect(html, href).not.toContain('<a ');
      expectInert(html);
    }
  });

  it('이미지 문법은 img가 아니라 링크 텍스트가 된다', () => {
    const html = renderMarkdown('![로고](https://example.com/a.png)');
    expect(html).toBe(`<p><a href="https://example.com/a.png" ${LINK_ATTR}>이미지: 로고</a></p>`);
    const bad = renderMarkdown('![x](data:image/svg+xml;base64,AAAA)');
    expect(bad).not.toContain('<a ');
    expect(bad).not.toContain('<img');
  });

  it('<javascript:…> 자동 링크 꼴도 글자', () => {
    const html = renderMarkdown('<javascript:alert(1)>');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;javascript');
  });

  it('http와 https 링크만 rel과 target을 달고 링크가 된다', () => {
    expect(renderMarkdown('[문서](https://example.com/a?x=1&y=2)')).toBe(
      `<p><a href="https://example.com/a?x=1&amp;y=2" ${LINK_ATTR}>문서</a></p>`,
    );
    expect(renderMarkdown('[문서](http://example.com/)')).toContain('href="http://example.com/"');
    expect(renderMarkdown('<https://example.com/x>')).toContain(`href="https://example.com/x"`);
    expect(renderMarkdown('맨 https://example.com/y 링크')).toContain(
      `<a href="https://example.com/y" ${LINK_ATTR}>`,
    );
  });

  it('링크 주소의 따옴표는 속성을 못 깨뜨린다', () => {
    const html = renderMarkdown('[x](https://example.com/"onmouseover="alert(1))');
    expectInert(html);
    expect(html).not.toMatch(/"\s*onmouseover=/);
  });

  it('코드 펜스 안의 태그는 이스케이프된다', () => {
    const html = renderMarkdown('```js\n</code></pre><script>x</script>\n```');
    expect(html).toBe(
      '<pre><code class="language-js">&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</code></pre>',
    );
  });

  it('펜스 언어 이름에 속성 탈출 문자가 있으면 클래스를 안 단다', () => {
    const html = renderMarkdown('```" onmouseover="x\ncode\n```');
    expectInert(html);
    expect(html).not.toContain('onmouseover');
  });

  it('인라인 코드와 표 셀, 제목, 인용 안의 HTML도 이스케이프된다', () => {
    for (const src of [
      '`<script>x</script>`',
      '| <script>x</script> | b |\n|---|---|\n| <img src=x onerror=1> | 2 |',
      '# <script>x</script>',
      '> <img src=x onerror=1>',
      '- <script>x</script>',
    ]) {
      expectInert(renderMarkdown(src));
    }
  });

  it('safeHref는 http와 https만 돌려준다', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('mailto:a@example.com')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });
});

describe('renderMarkdown 문법', () => {
  it('제목 h1~h6과 문단, 줄바꿈', () => {
    const html = renderMarkdown('# 하나\n## 둘\n###### 여섯\n\n첫 줄\n둘째 줄');
    expect(html).toContain('<h1>하나</h1>');
    expect(html).toContain('<h2>둘</h2>');
    expect(html).toContain('<h6>여섯</h6>');
    expect(html).toContain('<p>첫 줄<br>둘째 줄</p>');
  });

  it('굵게, 기울임, 취소선, 인라인 코드', () => {
    expect(renderInline('**굵게** *기울임* ~~삭제~~ `코드`')).toBe(
      '<strong>굵게</strong> <em>기울임</em> <del>삭제</del> <code>코드</code>',
    );
    expect(renderInline('`**안 바뀜**`')).toBe('<code>**안 바뀜**</code>');
  });

  it('순서와 비순서 목록, 중첩, 종류가 바뀌면 새 목록', () => {
    const html = renderMarkdown('- a\n  - b\n- c\n\n1. x\n2. y');
    expect(html).toBe(
      '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>\n<ol><li>x</li><li>y</li></ol>',
    );
  });

  it('GFM 표는 정렬을 고정 값 style로만 낸다', () => {
    const html = renderMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:center">b</th>');
    expect(html).toContain('<td style="text-align:right">3</td>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
  });

  it('인용은 중첩되고 수평선은 hr', () => {
    expect(renderMarkdown('> 인용\n> > 중첩')).toContain('<blockquote><p>중첩</p></blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('인용 중첩이 아주 깊어도 끝난다', () => {
    const html = renderMarkdown(`${'>'.repeat(500)} 깊다`);
    expect(html).toContain('깊다');
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(10);
  });

  it('코드 펜스는 줄바꿈을 보존하고 닫히지 않아도 끝까지를 코드로 본다', () => {
    expect(renderMarkdown('```\na\n  b\n```')).toBe('<pre><code>a\n  b</code></pre>');
    const open = renderMarkdown('```\n<b>끝까지');
    expect(open).toContain('&lt;b&gt;끝까지');
    expect(open).not.toContain('<b>');
  });

  it('빈 입력은 빈 문자열이고 CRLF도 같은 결과', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('# a\r\n\r\n문단')).toBe(renderMarkdown('# a\n\n문단'));
  });
});

describe('renderMarkdown 성능 회귀', () => {
  /** 제곱 폭주가 되돌아오면 이 시간을 크게 넘긴다. 정상은 수 ms */
  const BUDGET_MS = 1000;
  function time(src: string): number {
    const t = Date.now();
    renderMarkdown(src);
    return Date.now() - t;
  }

  it('[a]( 5만 번 반복', () => {
    expect(time('[a]('.repeat(50_000))).toBeLessThan(BUDGET_MS);
  });

  it('닫히지 않는 강조, 코드, 취소선 기호가 한 줄에 대량', () => {
    expect(time('**a '.repeat(30_000))).toBeLessThan(BUDGET_MS);
    expect(time('*a '.repeat(30_000))).toBeLessThan(BUDGET_MS);
    expect(time('`a '.repeat(30_000))).toBeLessThan(BUDGET_MS);
    expect(time('~~a '.repeat(30_000))).toBeLessThan(BUDGET_MS);
  });

  it('닫히지 않는 펜스와 긴 백틱 줄', () => {
    expect(time(`${'```\n'.repeat(1)}${'a\n'.repeat(100_000)}`)).toBeLessThan(BUDGET_MS);
    expect(time('`'.repeat(100_000))).toBeLessThan(BUDGET_MS);
    expect(time(`${'```'.repeat(20_000)}\nx`)).toBeLessThan(BUDGET_MS);
  });

  it('긴 표, 긴 목록, 긴 자동 링크 후보', () => {
    expect(time(`|a|b|\n|-|-|\n${'|1|2|\n'.repeat(20_000)}`)).toBeLessThan(BUDGET_MS);
    expect(time('- a\n'.repeat(50_000))).toBeLessThan(BUDGET_MS);
    expect(time('https://'.repeat(20_000))).toBeLessThan(BUDGET_MS);
    expect(time('<https://'.repeat(20_000))).toBeLessThan(BUDGET_MS);
    expect(time('![a]('.repeat(20_000))).toBeLessThan(BUDGET_MS);
  });

  it('1만 자를 넘는 줄은 강조를 건너뛰고 글자로 낸다', () => {
    const long = `**${'가'.repeat(10_050)}**`;
    const html = renderMarkdown(long);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('가가가');
    expect(renderMarkdown('**짧다**')).toContain('<strong>짧다</strong>');
  });
});
