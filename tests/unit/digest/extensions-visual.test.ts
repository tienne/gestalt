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
  treeSvg,
  type Digest,
  type DigestIssue,
  type Extension,
} from '../../../src/digest/index.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderExtensionMarkdown } from '../../../src/digest/render-md.js';
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

  it('없는 id는 오류, 다른 본문은 경고, 합계 초과도 경고다', () => {
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
    expect(svg).toMatch(/<g class="mm-node mm-d1 mm-cite" data-sec="10">/);
    expect(svg).toMatch(/<g class="mm-node mm-d0">/);
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
