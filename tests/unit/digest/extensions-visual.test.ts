import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchComments,
  lintDigest,
  lintErrors,
  mergeExtension,
  parseYtComments,
  readComments,
  compareSvg,
  cycleSvg,
  flowSvg,
  parseDigest,
  treeSvg,
  type Diagram,
  type Digest,
  type DigestIssue,
  type Extension,
} from '../../../src/digest/index.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown, renderExtensionMarkdown } from '../../../src/digest/render-md.js';
import { DigestStore } from '../../../src/digest/store.js';
import type { RunCommand } from '../../../src/digest/ytdlp.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const codes = (issues: DigestIssue[]) => issues.map((i) => i.code);
const withExt = (...extensions: Extension[]): Digest => ({ ...sampleDigest(), extensions });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(): string {
  const repo = resolve('.gestalt-test', `digest-vis-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  return repo;
}

const flashcards = (): Extension => ({
  template: 'flashcards',
  title: '플래시카드',
  lang: 'ko',
  blocks: [
    {
      type: 'flashcards',
      cards: [
        { front: 'Code Layers는?', back: '캔버스의 **코드**', cite: { key: 1, from: 1, to: 2 } },
        { front: '누가 만들었나?', back: 'Figma' },
      ],
    },
  ],
});

const quiz = (): Extension => ({
  template: 'quiz',
  title: '퀴즈',
  lang: 'ko',
  blocks: [
    {
      type: 'quiz',
      questions: [
        {
          question: '무엇을 하나?',
          choices: ['코드 실행', '이미지 편집'],
          answer: 0,
          explanation: '캔버스에서 코드를 돌린다.',
          cite: { key: 2, from: 2, to: 2 },
        },
      ],
    },
  ],
});

const mindmap = (): Extension => ({
  template: 'mindmap',
  title: '마인드맵',
  lang: 'ko',
  blocks: [
    {
      type: 'mindmap',
      root: {
        label: 'Code Layers',
        children: [
          { label: '탐색', cite: { key: 3, from: 3, to: 4 }, children: [{ label: 'A<b>' }] },
          { label: '공유' },
        ],
      },
    },
  ],
});

const commentsExt = (): Extension => ({
  template: 'comments',
  title: '댓글 반응',
  lang: 'ko',
  blocks: [
    {
      type: 'comments',
      total: 10,
      overview: '대체로 반긴다.',
      groups: [
        {
          title: '반가움',
          tone: 'positive',
          count: 6,
          summary: '기다렸다는 반응',
          examples: [{ id: 'c1', text: 'Finally *this* exists' }],
        },
        { title: '걱정', tone: 'negative', count: 4, summary: '성능 우려', examples: [] },
      ],
    },
  ],
});

describe('플래시카드, 퀴즈, 마인드맵 lint', () => {
  it('정상 블록은 오류 없이 통과한다', () => {
    const issues = lintDigest(withExt(flashcards(), quiz(), mindmap()), sampleTranscript());
    expect(lintErrors(issues)).toEqual([]);
  });

  it('퀴즈 정답 번호가 보기 밖이면 오류다', () => {
    const ext = quiz();
    const block = ext.blocks[0]!;
    if (block.type !== 'quiz') throw new Error('quiz 블록이어야 한다');
    block.questions[0]!.answer = 2;
    const issue = lintDigest(withExt(ext), sampleTranscript()).find(
      (i) => i.code === 'QUIZ_ANSWER_OUT_OF_RANGE',
    );
    expect(issue).toMatchObject({
      severity: 'error',
      path: 'extensions.0.blocks.0.questions.0.answer',
    });
  });

  it('마인드맵은 루트 아래 세 단을 넘기면 오류다', () => {
    const deep = { label: 'd4' };
    const ext = mindmap();
    const block = ext.blocks[0]!;
    if (block.type !== 'mindmap') throw new Error('mindmap 블록이어야 한다');
    block.root.children = [
      { label: 'd1', children: [{ label: 'd2', children: [{ label: 'd3', children: [deep] }] }] },
    ];
    const issue = lintDigest(withExt(ext), sampleTranscript()).find(
      (i) => i.code === 'MINDMAP_DEPTH',
    );
    expect(issue?.path).toBe(
      'extensions.0.blocks.0.root.children.0.children.0.children.0.children',
    );
  });

  it('마인드맵 노드가 60개를 넘으면 오류다', () => {
    const ext = mindmap();
    const block = ext.blocks[0]!;
    if (block.type !== 'mindmap') throw new Error('mindmap 블록이어야 한다');
    block.root.children = Array.from({ length: 6 }, (_, i) => ({
      label: `g${i}`,
      children: Array.from({ length: 10 }, (_, j) => ({ label: `n${i}-${j}` })),
    }));
    expect(codes(lintDigest(withExt(ext), sampleTranscript()))).toContain('MINDMAP_SIZE');
  });
});

describe('댓글 대조 lint', () => {
  const source = new Map([['c1', 'Finally *this* exists, so good']]);

  it('comments 옵션이 없으면 대조를 건너뛴다', () => {
    expect(lintErrors(lintDigest(withExt(commentsExt()), sampleTranscript()))).toEqual([]);
  });

  it('합계 초과는 comments 옵션이 없어도 경고한다', () => {
    const ext = commentsExt();
    const block = ext.blocks[0]!;
    if (block.type !== 'comments') throw new Error('comments 블록이어야 한다');
    block.total = 5;
    expect(codes(lintDigest(withExt(ext), sampleTranscript()))).toContain('COMMENT_COUNT_EXCEEDS');
  });

  it('comments.json이 없으면 오류다', () => {
    const issues = lintDigest(withExt(commentsExt()), sampleTranscript(), { comments: null });
    expect(issues.find((i) => i.code === 'COMMENTS_SOURCE_MISSING')).toMatchObject({
      severity: 'error',
      path: 'extensions.0.blocks.0',
    });
  });

  it('원문의 앞부분을 옮긴 예시는 통과한다', () => {
    const issues = lintDigest(withExt(commentsExt()), sampleTranscript(), { comments: source });
    expect(codes(issues).filter((c) => c.startsWith('COMMENT'))).toEqual([]);
  });

  it('없는 id는 오류고 다른 본문과 합계 초과는 경고다', () => {
    const ext = commentsExt();
    const block = ext.blocks[0]!;
    if (block.type !== 'comments') throw new Error('comments 블록이어야 한다');
    block.total = 5;
    block.groups[0]!.examples = [
      { id: 'c1', text: '드디어 나왔다' },
      { id: 'nope', text: 'x' },
    ];
    const issues = lintDigest(withExt(ext), sampleTranscript(), { comments: source });
    const byCode = (code: string) => issues.find((i) => i.code === code);
    expect(byCode('COMMENT_TEXT_MISMATCH')).toMatchObject({
      severity: 'warning',
      path: 'extensions.0.blocks.0.groups.0.examples.0.text',
    });
    expect(byCode('COMMENT_NOT_FOUND')).toMatchObject({
      severity: 'error',
      path: 'extensions.0.blocks.0.groups.0.examples.1.id',
    });
    expect(byCode('COMMENT_COUNT_EXCEEDS')?.severity).toBe('warning');
  });

  it('comments.json이 없으면 확장을 저장하지 않는다', () => {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(sampleDigest());
    const result = mergeExtension(repo, SLUG, commentsExt());
    expect(result.saved).toBe(false);
    expect(codes(result.issues)).toContain('COMMENTS_SOURCE_MISSING');
    expect(store.loadDigest(SLUG)!.extensions).toEqual([]);
  });

  const withExample = (id: string, text: string): Extension => {
    const ext = commentsExt();
    const block = ext.blocks[0]!;
    if (block.type !== 'comments') throw new Error('comments 블록이어야 한다');
    block.groups[0]!.examples = [{ id, text }];
    return ext;
  };

  const mergeWith = (ext: Extension, comments: Map<string, string>) => {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(sampleDigest());
    return mergeExtension(repo, SLUG, ext, { comments });
  };

  it('merge는 본문이 원문과 다른 예시를 저장하지 않는다', () => {
    const result = mergeWith(withExample('c1', '완전히 지어낸 칭찬 문장'), source);
    expect(result.saved).toBe(false);
    expect(result.issues.find((i) => i.code === 'COMMENT_TEXT_MISMATCH')?.severity).toBe('error');
  });

  it('이모지만 있는 예시를 다른 원문 id에 달면 불일치다', () => {
    const result = mergeWith(withExample('c1', '👍👍'), source);
    expect(codes(result.issues)).toContain('COMMENT_TEXT_MISMATCH');
  });

  it('원문과 똑같은 짧은 댓글과 이모지 댓글은 통과한다', () => {
    const short = new Map([
      ['c1', '최고'],
      ['c2', '🔥🔥'],
    ]);
    expect(mergeWith(withExample('c1', '최고'), short).saved).toBe(true);
    expect(mergeWith(withExample('c2', '🔥🔥'), short).saved).toBe(true);
  });
});

describe('parseYtComments', () => {
  const raw = {
    comment_count: 321,
    comments: [
      { id: 'a', text: ' low ', parent: 'root', like_count: 1, author: '홍길동', author_id: 'UC1' },
      { id: 'b', text: 'reply', parent: 'a', like_count: 99 },
      { id: 'c', text: 'top', parent: 'root', like_count: 50, is_pinned: true },
      { id: 'd', text: 'tie', parent: 'root', like_count: 1, author_is_uploader: true },
      { id: 'a', text: 'dup', parent: 'root', like_count: 100 },
      { id: 'bad id!', text: 'x', parent: 'root', like_count: 5 },
      { id: 'e', text: '   ', parent: 'root', like_count: 5 },
    ],
  };

  it('최상위 댓글만 좋아요 순으로 남기고 작성자 정보는 버린다', () => {
    const { comments, commentCount } = parseYtComments(raw, 10);
    expect(commentCount).toBe(321);
    expect(comments).toEqual([
      { id: 'c', text: 'top', likes: 50, pinned: true },
      { id: 'a', text: 'low', likes: 1 },
      { id: 'd', text: 'tie', likes: 1, byUploader: true },
    ]);
    expect(JSON.stringify(comments)).not.toMatch(/홍길동|UC1/);
  });

  it('max개로 자르고 긴 본문은 2000자로 줄인다', () => {
    const long = {
      comments: [{ id: 'x', text: 'a'.repeat(2500), parent: 'root' }, ...raw.comments],
    };
    const { comments, commentCount } = parseYtComments(long, 2);
    expect(comments).toHaveLength(2);
    expect(commentCount).toBeNull();
    expect(parseYtComments(long, 10).comments.find((c) => c.id === 'x')!.text).toHaveLength(2000);
  });
});

describe('fetchComments', () => {
  function seeded() {
    const repo = tmpRepo();
    new DigestStore(repo).saveTranscript(sampleTranscript());
    return repo;
  }

  it('답글 없이 인기순으로 받아 comments.json에 쓴다', async () => {
    const repo = seeded();
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const run: RunCommand = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return {
        stdout: JSON.stringify({
          comment_count: 2,
          comments: [{ id: 'k', text: 'hi', parent: 'root' }],
        }),
        stderr: '',
      };
    };
    const result = await fetchComments(SLUG, { repoRoot: repo, max: 50, run });
    expect(result).toMatchObject({ fetched: 1, commentCount: 2 });
    const args = calls[0]!.args;
    expect(args).toContain('--get-comments');
    expect(args).toContain('youtube:max_comments=50,50,0,0;comment_sort=top');
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=ukY9Dvwm7Gc');
    expect(calls[0]!.cwd.startsWith(repo)).toBe(false);
    expect(existsSync(calls[0]!.cwd)).toBe(false);
    const read = readComments(new DigestStore(repo), SLUG);
    expect(read.kind === 'ok' && read.value.comments).toEqual([{ id: 'k', text: 'hi', likes: 0 }]);
  });

  it('max가 범위를 벗어나면 부르지 않는다', async () => {
    const repo = seeded();
    const run: RunCommand = async () => {
      throw new Error('불리면 안 된다');
    };
    await expect(fetchComments(SLUG, { repoRoot: repo, max: 0, run })).rejects.toThrow(/--max/);
    await expect(fetchComments(SLUG, { repoRoot: repo, max: 1001, run })).rejects.toThrow(/--max/);
  });
});

describe('treeSvg', () => {
  it('라벨을 이스케이프하고 인용이 있는 노드에 data-sec을 단다', () => {
    const svg = treeSvg(
      { label: 'root', children: [{ label: '<script>', cite: { key: 2, from: 2, to: 2 } }] },
      { sec: (c) => c.key * 5 },
    );
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toMatch(
      /<g class="mm-node mm-d1 mm-cite" data-sec="10" role="link" tabindex="0" aria-label="[^"]*, 0분 10초로 이동">/,
    );
    expect(svg).toMatch(/^<svg [^>]*role="group"/);
    expect(svg).toMatch(/<g class="mm-node mm-d0">/);
  });

  it('누를 노드가 없으면 루트는 img로 남는다', () => {
    const svg = treeSvg({ label: '루트', children: [{ label: '가지' }] });
    expect(svg).toMatch(/^<svg [^>]*role="img"/);
    expect(svg).not.toContain('tabindex');
  });

  it('긴 라벨은 말줄임하고 전체는 title에 남긴다', () => {
    const label = '아주 긴 라벨입니다 '.repeat(10).trim();
    const svg = treeSvg({ label });
    expect(svg).toContain(`<title>${label}</title>`);
    expect(svg).toMatch(/…<\/text>/);
  });
});

describe('시각 블록 렌더', () => {
  const html = () =>
    renderDigestHtml(withExt(flashcards(), quiz(), mindmap(), commentsExt()), sampleTranscript())
      .html;

  it('카드, 퀴즈, 마인드맵, 댓글을 그린다', () => {
    const out = html();
    expect(out).toContain('<details class="card">');
    expect(out).toMatch(/<fieldset class="quiz-q" data-answer="0">/);
    expect(out).toMatch(/<input type="radio" name="[^"]+-b0-q0"/);
    expect(out).toMatch(
      /정답 확인<\/button><p class="quiz-result" role="status" aria-live="polite"><\/p><div class="quiz-exp" hidden>/,
    );
    expect(out).toContain('<figure class="diagram">');
    expect(out).toContain('data-zoom');
    expect(out).toContain('A&lt;b&gt;');
    expect(out).toContain('cm-positive');
    expect(out).toContain('분석한 댓글 10개');
  });

  it('퀴즈 radio name은 확장마다 갈린다', () => {
    const names = [...html().matchAll(/<input type="radio" name="([^"]+)"/g)].map((m) => m[1]!);
    const twice = renderDigestHtml(
      withExt(quiz(), { ...quiz(), lang: 'en' }),
      sampleTranscript(),
    ).html;
    const both = new Set(
      [...twice.matchAll(/<input type="radio" name="([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(both.size).toBe(2);
  });

  it('스크립트가 꺼져도 해설이 보이고 버튼은 숨는다', () => {
    expect(html()).toMatch(/<noscript><style>[^<]*\.quiz-exp\{display:block!important\}/);
  });

  it('마크다운은 카드, 문제, 목록, 인용으로 옮기고 댓글 원문의 마크다운 기호를 이스케이프한다', () => {
    const t = sampleTranscript();
    expect(renderExtensionMarkdown(flashcards(), t)).toMatch(/^- Q\. Code Layers는\?/m);
    expect(renderExtensionMarkdown(quiz(), t)).toMatch(/> 정답 \(1\)/);
    expect(renderExtensionMarkdown(mindmap(), t)).toMatch(/^ {2}- 탐색/m);
    expect(renderExtensionMarkdown(commentsExt(), t)).toContain('> Finally \\*this\\* exists');
  });
});

describe('대섹션 도식', () => {
  const withDiagram = (diagram: Diagram): Digest => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.diagram = diagram;
    return d;
  };
  const flow: Diagram = {
    kind: 'flow',
    caption: '작업 순서',
    steps: [
      { label: '탐색', cite: { key: 1, from: 1, to: 2 } },
      { label: '편집' },
      { label: '공유', cite: { key: 4, from: 4, to: 4 } },
    ],
  };

  it('네 종류가 스키마와 lint를 통과한다', () => {
    const kinds: Diagram[] = [
      flow,
      { kind: 'cycle', steps: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
      {
        kind: 'compare',
        columns: [
          { title: '전', items: [{ label: '느림' }] },
          { title: '후', items: [{ label: '빠름', cite: { key: 3, from: 3, to: 3 } }] },
        ],
      },
      { kind: 'tree', root: { label: '루트', children: [{ label: '가지' }] } },
    ];
    for (const diagram of kinds) {
      const digest = withDiagram(diagram);
      expect(parseDigest(JSON.parse(JSON.stringify(digest))).ok).toBe(true);
      expect(lintErrors(lintDigest(digest, sampleTranscript()))).toEqual([]);
    }
  });

  it('SVG 원문 같은 모르는 칸은 받지 않고 단계 수가 모자라면 거절한다', () => {
    const raw = JSON.parse(JSON.stringify(withDiagram(flow)));
    raw.reports[0].sections[0].diagram = { kind: 'svg', svg: '<svg onload="x"/>' };
    expect(parseDigest(raw).ok).toBe(false);
    raw.reports[0].sections[0].diagram = { kind: 'flow', steps: [{ label: 'a' }] };
    expect(parseDigest(raw).ok).toBe(false);
  });

  it('노드 출처가 대섹션 밖이면 오류다', () => {
    const d = withDiagram({
      kind: 'flow',
      steps: [{ label: 'a' }, { label: 'b', cite: { key: 7, from: 7, to: 7 } }],
    });
    const issue = lintDigest(d, sampleTranscript()).find(
      (i) => i.code === 'DIAGRAM_CITE_OUT_OF_SECTION',
    );
    expect(issue).toMatchObject({
      severity: 'error',
      path: 'reports.0.sections.0.diagram.steps.1.cite',
    });
    expect(issue?.message).toContain('대섹션');
  });

  it('라벨과 열 제목, 설명에 마커가 있으면 오류다', () => {
    const d = withDiagram({
      kind: 'compare',
      caption: '**비교**',
      columns: [
        { title: '{{kw:a|A}}', items: [{ label: 'x' }] },
        { title: '후', items: [{ label: '**y**' }] },
      ],
    });
    const paths = lintDigest(d, sampleTranscript())
      .filter((i) => i.code === 'TITLE_MARKER')
      .map((i) => i.path);
    expect(paths).toEqual([
      'reports.0.sections.0.diagram.caption',
      'reports.0.sections.0.diagram.columns.0.title',
      'reports.0.sections.0.diagram.columns.1.items.0.label',
    ]);
  });

  it('트리는 세 단과 30개 노드까지다', () => {
    const deep = withDiagram({
      kind: 'tree',
      root: {
        label: 'r',
        children: [
          {
            label: '1',
            children: [{ label: '2', children: [{ label: '3', children: [{ label: '4' }] }] }],
          },
        ],
      },
    });
    expect(codes(lintDigest(deep, sampleTranscript()))).toContain('DIAGRAM_DEPTH');
    const wide = withDiagram({
      kind: 'tree',
      root: {
        label: 'r',
        children: Array.from({ length: 3 }, (_, i) => ({
          label: `g${i}`,
          children: Array.from({ length: 10 }, (_, j) => ({ label: `n${j}` })),
        })),
      },
    });
    expect(codes(lintDigest(wide, sampleTranscript()))).toContain('DIAGRAM_SIZE');
  });

  it('HTML은 결론 다음에 그림과 목록을 싣고 노드에 data-sec을 단다', () => {
    const { html } = renderDigestHtml(withDiagram(flow), sampleTranscript());
    const sec = html.slice(html.indexOf('<section class="sec"'));
    expect(sec.indexOf('class="conclusion"')).toBeLessThan(sec.indexOf('<figure class="diagram">'));
    expect(sec.indexOf('<figure class="diagram">')).toBeLessThan(sec.indexOf('class="sub"'));
    expect(html).toContain('<svg class="dg-svg dg-flow"');
    expect(html).toMatch(/<g class="dg-node dg-cite" data-sec="5" role="link" tabindex="0"/);
    expect(html).toContain('<span>작업 순서</span>');
    expect(html).toMatch(
      /<details class="dg-outline"><summary>목록으로 보기<\/summary><ol><li>탐색/,
    );
  });

  it('도식이 없으면 그림을 싣지 않는다', () => {
    const d = sampleDigest();
    for (const s of d.reports[0]!.sections) delete s.diagram;
    const { html } = renderDigestHtml(d, sampleTranscript());
    expect(html).not.toContain('<figure class="diagram">');
  });

  it('마크다운은 번호 목록으로 옮긴다', () => {
    const md = renderDigestMarkdown(withDiagram(flow), sampleTranscript());
    expect(md).toContain('*흐름도: 작업 순서*');
    expect(md).toMatch(/^1\. 탐색 \[00:05\]/m);
    expect(md).toMatch(/^2\. 편집$/m);
  });

  it('마크다운 도식 라벨과 설명의 문법 글자를 무력화한다', () => {
    const injected: Diagram = {
      ...flow,
      caption: '[x](https://e.com)',
      steps: [{ label: '<b>탐색</b>' }, { label: '# 편집' }],
    };
    const md = renderDigestMarkdown(withDiagram(injected), sampleTranscript());
    expect(md).toContain('*흐름도: \\[x\\](https://e.com)*');
    expect(md).toMatch(/^1\. \\<b\\>탐색\\<\/b\\>$/m);
    expect(md).toMatch(/^2\. \\# 편집$/m);
  });
});

describe('도식 레이아웃', () => {
  const box = (svg: string) =>
    [...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(
      (m) => ({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! }),
    );
  const size = (svg: string) => {
    const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
    return { w: +m[1]!, h: +m[2]! };
  };
  const inView = (svg: string) => {
    const { w, h } = size(svg);
    return box(svg).every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h);
  };
  const steps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `단계 ${i + 1} 설명` }));

  it('흐름은 넷까지 가로, 다섯부터 세로로 놓는다', () => {
    const row = box(flowSvg(steps(4)));
    expect(new Set(row.map((b) => b.y)).size).toBe(1);
    const col = box(flowSvg(steps(5)));
    expect(new Set(col.map((b) => b.x)).size).toBe(1);
    expect(inView(flowSvg(steps(5)))).toBe(true);
  });

  it('순환은 상자가 겹치지 않고 그림 안에 들며 상자 사이 호가 보인다', () => {
    for (const n of [3, 5, 8]) {
      const svg = cycleSvg(steps(n));
      const rects = box(svg);
      expect(rects).toHaveLength(n);
      expect(inView(svg)).toBe(true);
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = rects[i]!;
          const b = rects[j]!;
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      expect(svg.match(/class="dg-arrow"/g)).toHaveLength(n);
      // 상자 사이 호가 짧으면 화살촉만 남는다. 아래쪽 두 상자 사이가 그렇게 묻힌 적이 있다
      const arcs = [...svg.matchAll(/<path d="(M[^"]+)"\/>/g)].map((m) =>
        [...m[1]!.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])]),
      );
      expect(arcs).toHaveLength(n);
      for (const pts of arcs) {
        let len = 0;
        for (let k = 1; k < pts.length; k++)
          len += Math.hypot(pts[k]![0]! - pts[k - 1]![0]!, pts[k]![1]! - pts[k - 1]![1]!);
        expect(len).toBeGreaterThanOrEqual(23);
      }
    }
  });

  it('비교는 열마다 머리 상자를 두고 라벨을 이스케이프한다', () => {
    const svg = compareSvg([
      { title: 'A&B', items: [{ label: '<x>' }] },
      { title: '후', items: [{ label: 'y' }, { label: 'z' }] },
    ]);
    expect(svg.match(/dg-head/g)).toHaveLength(2);
    expect(svg).toContain('A&amp;B');
    expect(svg).not.toContain('<x>');
    expect(inView(svg)).toBe(true);
  });
});
