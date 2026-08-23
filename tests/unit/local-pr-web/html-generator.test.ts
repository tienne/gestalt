import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  generatePrDetailHtml,
  generatePrListHtml,
  toEmbeddableJson,
} from '../../../src/local-pr-web/html-generator.js';
import type { PullRequest } from '../../../src/local-pr/types.js';

/**
 * html-generator는 순수 함수라 진짜 PR을 만들지 않고 팩토리로 값만 채운다.
 *
 * 주석이 단언한 이스케이프 보장마다 깨지면 실패하는 케이스를 함께 둔다 (CM-8) —
 * 코멘트 본문에 `<script>`가 들어오면 실행되지 않아야 한다는 것과, diff에
 * `</script>`가 섞여도 스크립트 태그를 조기 종료시키지 않는다는 것.
 */

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'abcd1234',
    title: '테스트 PR',
    body: '',
    author: 'claude-code:worker-1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    headRef: 'feat/x',
    baseRef: 'main',
    status: 'open',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    comments: [],
    reviews: [],
    rounds: [{ number: 1, openedAt: '2026-08-01T00:00:00.000Z', verdict: null, commentCount: 0 }],
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('& < > " \' 를 HTML 엔티티로 바꾼다', () => {
    expect(escapeHtml(`<script>alert('x')&"y"</script>`)).toBe(
      '&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;',
    );
  });

  it('특수문자가 없는 문자열은 그대로 둔다', () => {
    expect(escapeHtml('평범한 텍스트')).toBe('평범한 텍스트');
  });
});

describe('toEmbeddableJson', () => {
  it('</script> 시퀀스를 깨서 스크립트 태그를 조기 종료시키지 않는다', () => {
    const malicious = '</script><script>window.pwned = true;</script>';
    const embedded = toEmbeddableJson(malicious);

    // 이스케이프 안 된 </script>가 그대로 남아있으면 실제 HTML에서 태그를 끊는다
    expect(embedded).not.toContain('</script>');
    expect(embedded).not.toContain('<script>');

    // 유니코드 이스케이프로 안전하게 담겼는지 — 페이지에 꽂아도 원래 문자열로 되돌아온다
    const html = `<script>var x = ${embedded};</script>`;
    expect(html).not.toMatch(/<\/script><script>/);
  });

  it('일반 값은 JSON.stringify와 같은 결과를 낸다', () => {
    expect(toEmbeddableJson({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
  });
});

/**
 * 표의 미해결 칸만 뽑는다.
 *
 * `<td>1</td>`로 훑으면 라운드 칸에도 맞는다. 미해결 수가 틀려도 통과한다.
 * 작성자 칸 바로 앞이라는 자리로 겨냥한다.
 */
function unresolvedCell(html: string): string | null {
  return html.match(/<td>(\d+)<\/td>\s*<td class="meta">/)?.[1] ?? null;
}

describe('generatePrListHtml', () => {
  it('PR이 없으면 빈 상태 문구를 보여준다', () => {
    const html = generatePrListHtml([]);
    expect(html).toContain('PR이 없다');
  });

  it('제목과 상태, 라운드, 미해결 코멘트 수를 표에 담는다', () => {
    const pr = makePr({
      title: '두 번째 줄 추가',
      status: 'changes_requested',
      comments: [
        {
          id: 'c1',
          author: 'a',
          path: 'a.ts',
          line: 3,
          body: '왜 이렇게 했나요',
          threadId: 'c1',
          resolved: false,
          headSha: 'b'.repeat(40),
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const html = generatePrListHtml([pr]);
    expect(html).toContain('두 번째 줄 추가');
    expect(html).toContain('badge-changes_requested');
    expect(html).toContain('/prs/abcd1234');
    expect(unresolvedCell(html)).toBe('1');
  });

  it('답글이 달려도 미해결 수가 안 늘어난다', () => {
    const reply = (id: string) => ({
      id,
      author: 'codex:worker-1',
      path: 'a.ts',
      line: 3,
      body: '고쳤습니다',
      threadId: 'c1',
      resolved: false,
      headSha: 'b'.repeat(40),
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    // 지적 하나에 답글 둘. 코멘트를 세면 3이 나오고 CLI와 값이 갈린다
    const pr = makePr({ comments: [reply('c1'), reply('c2'), reply('c3')] });

    expect(unresolvedCell(generatePrListHtml([pr]))).toBe('1');
  });

  it('제목에 스크립트가 들어오면 이스케이프해 실행되지 않게 한다', () => {
    const pr = makePr({ title: `<script>alert(document.cookie)</script>` });
    const html = generatePrListHtml([pr]);
    expect(html).not.toContain('<script>alert(document.cookie)</script>');
    expect(html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  });
  it('레포가 여럿이면 옮겨 다니는 줄을 그린다', () => {
    const pr = makePr({});
    const repos = [
      { key: 'aaaaaaaa', name: 'gestalt', active: true, openCount: 2 },
      { key: 'bbbbbbbb', name: 'other', active: false, openCount: 0 },
    ];

    const html = generatePrListHtml([pr], repos);

    expect(html).toContain('href="/r/bbbbbbbb"');
    expect(html).toContain('<strong>gestalt <span class="meta">2</span></strong>');
    // PR 링크도 지금 레포 아래로 간다
    expect(html).toContain('href="/r/aaaaaaaa/prs/abcd1234"');
  });

  it('레포가 하나면 고를 게 없어 줄을 안 그린다', () => {
    const html = generatePrListHtml(
      [makePr({})],
      [{ key: 'aaaaaaaa', name: 'gestalt', active: true }],
    );

    expect(html).not.toContain('ul class="repos"');
  });
  it('레포마다 열린 PR 수를 함께 그린다', () => {
    const html = generatePrListHtml(
      [makePr({})],
      [
        { key: 'aaaaaaaa', name: 'gestalt', active: true, openCount: 2 },
        { key: 'bbbbbbbb', name: 'other', active: false, openCount: 5 },
      ],
    );

    // 어디에 일이 쌓였는지 목록을 하나씩 열어보지 않고도 보여야 한다
    expect(html).toMatch(/gestalt <span class="meta">2<\/span>/);
    expect(html).toMatch(/other <span class="meta">5<\/span>/);
  });
});

describe('generatePrDetailHtml', () => {
  it('코멘트 본문에 스크립트가 들어와도 이스케이프해 실행되지 않게 한다', () => {
    const pr = makePr({
      comments: [
        {
          id: 'c1',
          author: 'reviewer',
          path: 'src/x.ts',
          line: 10,
          body: `<img src=x onerror="alert(1)"><script>alert(2)</script>`,
          threadId: 'c1',
          resolved: false,
          headSha: 'b'.repeat(40),
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const html = generatePrDetailHtml(pr, '');

    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('PR 본문과 리뷰 요약도 이스케이프한다', () => {
    const pr = makePr({
      body: `본문에 <script>evil()</script> 섞임`,
      reviews: [
        {
          id: 'r1',
          reviewer: 'security-reviewer',
          verdict: 'request_changes',
          summary: `<b>위험함</b>`,
          round: 1,
          headSha: 'b'.repeat(40),
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const html = generatePrDetailHtml(pr, '');
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).not.toContain('<b>위험함</b>');
    expect(html).toContain('&lt;b&gt;위험함&lt;/b&gt;');
    expect(html).toContain('badge-request_changes');
  });

  it('diff에 </script>가 섞여도 스크립트 태그가 조기 종료되지 않는다', () => {
    const diff = 'diff --git a/x.ts b/x.ts\n+</script><script>window.pwned = true;</script>\n';
    const pr = makePr();

    const html = generatePrDetailHtml(pr, diff);
    expect(html).not.toMatch(/<\/script><script>window\.pwned/);
  });

  it('diff가 비어 있으면 변경 없음 처리를 diff2html에 맡기지 않고 안내한다', () => {
    const pr = makePr();
    const html = generatePrDetailHtml(pr, '');
    expect(html).toContain('변경 없음');
  });

  it('빈 코멘트/리뷰로도 에러 없이 완전한 HTML을 반환한다', () => {
    const pr = makePr();
    expect(() => generatePrDetailHtml(pr, 'diff --git a/x b/x\n')).not.toThrow();
    const html = generatePrDetailHtml(pr, 'diff --git a/x b/x\n');
    expect(html.trim().startsWith('<!DOCTYPE html>')).toBe(true);
  });
  it('상세 페이지가 어느 레포인지 알려준다', () => {
    const html = generatePrDetailHtml(makePr({}), 'diff --git a/x b/x', 'aaaaaaaa', 'api-server');

    // 레포가 여럿이면 PR 제목만 보고는 어디 것인지 모른다
    expect(html).toContain('api-server의 PR 목록');
    expect(html).toContain('href="/r/aaaaaaaa"');
  });
  it('CDN 자산의 버전을 고정하고 SRI를 붙인다', () => {
    const html = generatePrDetailHtml(makePr({}), 'diff --git a/x b/x');

    // 버전을 안 묶으면 CDN이 오염되는 순간 리뷰 중인 소스가 남의 코드 손에 들어간다
    expect(html).toMatch(/diff2html@\d+\.\d+\.\d+/);
    expect(html).not.toContain('npm/diff2html/bundles');
    expect((html.match(/integrity="sha384-/g) ?? []).length).toBe(3);
    expect(html).toContain('highlight.js@');
  });

  it('렌더러를 못 불러오면 원본 diff를 보여준다', () => {
    const html = generatePrDetailHtml(makePr({}), 'diff --git a/x b/x');

    // 오프라인이면 아무 말 없이 빈 상자가 남아 "변경 없음"과 구분이 안 된다
    expect(html).toContain("typeof Diff2HtmlUI === 'undefined'");
    expect(html).toContain('원본을 그대로 보여드려요');
  });

  it('큰 diff는 잘라내고 그 사실을 알린다', () => {
    const huge = `diff --git a/x b/x\n${'+line\n'.repeat(200_000)}`;

    const html = generatePrDetailHtml(makePr({}), huge);

    expect(html.length).toBeLessThan(huge.length);
    expect(html).toContain('var truncated = true');
  });

  it('접근성 뼈대를 갖춘다', () => {
    const html = generatePrListHtml(
      [makePr({})],
      [{ key: 'aaaaaaaa', name: 'gestalt', active: true, openCount: 1 }],
    );

    expect(html).toContain('<main>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('<caption class="sr-only">');
    expect(html).toContain('focus-visible');
  });

  it('배지 클래스는 아는 값에서만 고른다', () => {
    // escapeHtml은 공백을 안 건드려서 class 자리에 다른 클래스가 함께 들어갈 수 있다
    const pr = makePr({ status: 'open evil-class' as never });

    const html = generatePrListHtml([pr]);

    expect(html).not.toContain('badge-open evil-class');
    expect(html).toContain('class="badge badge-closed"');
  });
  it('라이브러리에 다크 스킴을 넘긴다', () => {
    const html = generatePrDetailHtml(makePr({}), 'diff --git a/x b/x', 'aaaaaaaa', 'r');

    // CSS 변수를 밖에서 덮는 방법은 안 통한다 — --d2h-bg-color를 읽는 셀렉터는 줄
    // 번호와 태그뿐이고 추가와 삭제 줄은 --d2h-ins-bg-color 쪽을 읽는다
    expect(html).toContain("colorScheme: 'dark'");
    // 밖에서 덮으려던 오버라이드 규칙이 남아 있으면 안 된다 (주석 속 언급은 제외)
    expect(html).not.toContain('.d2h-wrapper {');
  });

  it('잘린 diff에 붙는 안내가 폴백 경로에서도 나온다', () => {
    const huge = `diff --git a/x b/x\n${'+line\n'.repeat(200_000)}`;

    const html = generatePrDetailHtml(makePr({}), huge, 'aaaaaaaa', 'r');

    // 렌더러를 못 불러온 경로가 안내 앞에서 return하면, 오프라인에서 큰 PR을 열었을 때
    // 아무 표시 없이 중간에서 끊긴 원본을 본다
    expect(html).toContain('var truncated = true');
    // done()이 안내를 붙인다. 세 경로(변경 없음, 폴백, 정상)가 전부 done()으로 끝나므로
    // 여기 한 곳만 잡으면 폴백에서 안내가 빠지는 일이 안 생긴다
    expect(html).toMatch(/var done = function \(\) \{\s*addNote\(\);/);
  });

  it('한글 diff를 바이트로 재서 자른다', () => {
    // 문자 수는 상한 아래인데 바이트는 넘는 자리를 만든다. 한글은 문자당 3바이트라
    // 30만 자면 900KB다 — 문자로 재면 안 자르고 바이트로 재면 자른다
    const korean = `diff --git a/x b/x\n${'+한글줄\n'.repeat(60_000)}`;
    expect(korean.length).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(korean, 'utf-8')).toBeGreaterThan(512 * 1024);

    const html = generatePrDetailHtml(makePr({}), korean, 'aaaaaaaa', 'r');

    expect(html).toContain('var truncated = true');
  });

  it('자를 때 마지막 파일 경계에서 끊는다', () => {
    // 둘째 파일 헤더가 상한 안쪽에서 시작하고 그 본문이 상한을 넘도록 만든다.
    // 첫 파일만으로 이미 상한을 넘으면 경계를 잘라도 안 잘라도 결과가 같아서
    // 이 테스트가 아무것도 안 잡는다
    const filler = '+line\n'.repeat(50_000);
    const twoFiles = `diff --git a/a b/a\n${filler}diff --git a/b b/b\n${filler}`;
    expect(Buffer.byteLength(`diff --git a/a b/a\n${filler}`, 'utf-8')).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(twoFiles, 'utf-8')).toBeGreaterThan(512 * 1024);

    const html = generatePrDetailHtml(makePr({}), twoFiles, 'aaaaaaaa', 'r');

    // hunk 중간에서 끊으면 diff2html이 예외 없이 적게 그린다 — 리뷰어가 없는 변경을
    // 봤다고 판단하는 자리다
    const embedded = html.slice(html.indexOf('var diffString ='));
    expect(embedded).toContain('diff --git a/a b/a');
    expect(embedded).not.toContain('diff --git a/b b/b');
  });
});
