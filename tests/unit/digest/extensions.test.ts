import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extensionKey,
  lintDigest,
  lintErrors,
  mergeExtension,
  type Digest,
  type DigestIssue,
  type Extension,
} from '../../../src/digest/index.js';
import type { Block } from '../../../src/digest/blocks.js';
import { blockFields } from '../../../src/digest/lint-extension.js';
import { blockMarkdown } from '../../../src/digest/render-blocks.js';
import { renderDigestFiles } from '../../../src/cli/commands/digest.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderExtensionMarkdown } from '../../../src/digest/render-md.js';
import { exportMarkdown } from '../../../src/digest/render.js';
import { DigestStore } from '../../../src/digest/store.js';
import {
  findBuiltinTemplatesDir,
  loadTemplates,
  parseTemplate,
  templateMap,
} from '../../../src/digest/templates.js';
import { viewerLogic } from '../../../src/digest/viewer-logic.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const codes = (issues: DigestIssue[]) => issues.map((i) => i.code);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(): string {
  const repo = resolve('.gestalt-test', `digest-ext-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  return repo;
}

function sampleExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    template: 'background',
    title: '관련 배경지식',
    lang: 'ko',
    blocks: [
      { type: 'heading', text: 'Code Layers' },
      { type: 'text', text: '캔버스 위에서 **코드를** 돌린다.', cite: { key: 1, from: 1, to: 2 } },
      {
        type: 'list',
        title: '더 볼 거리',
        items: [{ text: 'React', children: [{ text: 'JSX', cite: { key: 3, from: 3, to: 3 } }] }],
      },
    ],
    ...overrides,
  };
}

const withExt = (...extensions: Extension[]): Digest => ({ ...sampleDigest(), extensions });

const TEMPLATE = `---
id: background
title: 관련 배경지식
description: 배경을 풀어 준다
blocks: [heading, text, list, text]
---

배경지식을 정리한다.
`;

describe('parseTemplate', () => {
  it('frontmatter와 본문을 읽고 블록 중복을 걷어낸다', () => {
    const t = parseTemplate(TEMPLATE, 'builtin', '/x/background.md');
    expect(t).toMatchObject({
      id: 'background',
      blocks: ['heading', 'text', 'list'],
      needs: [],
      order: 100,
      prompt: '배경지식을 정리한다.',
    });
  });

  it('js frontmatter는 코드로 돌리지 않고 거절한다', () => {
    const js = '---js\n{ id: "x", title: (globalThis.__ran = 1) }\n---\n본문';
    expect(() => parseTemplate(js, 'user', '/x/x.md')).toThrow(/js frontmatter/);
    expect((globalThis as Record<string, unknown>).__ran).toBeUndefined();
  });

  it('본문이 비면 거절한다', () => {
    expect(() => parseTemplate(TEMPLATE.replace('배경지식을 정리한다.', ''), 'user', 'p')).toThrow(
      /본문/,
    );
  });

  it('모르는 블록 타입과 잘못된 id를 거절한다', () => {
    expect(() => parseTemplate(TEMPLATE.replace('list, text', 'svg'), 'user', 'p')).toThrow(
      /blocks/,
    );
    expect(() =>
      parseTemplate(TEMPLATE.replace('id: background', 'id: ../x'), 'user', 'p'),
    ).toThrow(/id/);
  });

  it('64KB를 넘으면 거절한다', () => {
    expect(() => parseTemplate(TEMPLATE + 'a'.repeat(65 * 1024), 'user', 'p')).toThrow(/64KB/);
  });
});

describe('loadTemplates', () => {
  function writeTemplate(dir: string, name: string, content: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  it('심링크와 64KB를 넘는 파일은 읽지 않고 경고한다', () => {
    const repo = tmpRepo();
    const dir = new DigestStore(repo).templatesDir();
    const outside = join(repo, 'outside.md');
    writeFileSync(outside, TEMPLATE);
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'background.md'));
    writeTemplate(dir, 'big.md', TEMPLATE + 'a'.repeat(65 * 1024));
    const { templates, warnings } = loadTemplates(null, repo);
    expect(templates).toEqual([]);
    expect(warnings.join('\n')).toMatch(/심링크라 건너뛰었다/);
    expect(warnings.join('\n')).toMatch(/64KB를 넘어 건너뛰었다/);
  });

  it('같은 id면 사용자 템플릿이 기본 템플릿을 대신하고 경고를 남긴다', () => {
    const repo = tmpRepo();
    const builtin = join(repo, 'builtin');
    writeTemplate(builtin, 'background.md', TEMPLATE);
    writeTemplate(
      new DigestStore(repo).templatesDir(),
      'background.md',
      TEMPLATE.replace('배경지식을 정리한다.', '내 방식으로 정리한다.'),
    );
    const { templates, warnings } = loadTemplates(builtin, repo);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      source: 'user',
      prompt: '내 방식으로 정리한다.',
      overridesBuiltin: true,
    });
    expect(warnings.join('\n')).toMatch(/기본 템플릿 background를 대신한다/);
  });

  it('파일 이름과 id가 다르거나 깨진 파일은 건너뛰고 나머지는 읽는다', () => {
    const repo = tmpRepo();
    const builtin = join(repo, 'builtin');
    writeTemplate(builtin, 'background.md', TEMPLATE);
    writeTemplate(builtin, 'other.md', TEMPLATE);
    writeTemplate(builtin, 'broken.md', '---\nid: broken\n---\n');
    const { templates, warnings } = loadTemplates(builtin, repo);
    expect(templates.map((t) => t.id)).toEqual(['background']);
    expect(warnings).toHaveLength(2);
  });

  it('order 순으로 정렬한다', () => {
    const repo = tmpRepo();
    const builtin = join(repo, 'builtin');
    writeTemplate(builtin, 'background.md', TEMPLATE.replace('blocks:', 'order: 50\nblocks:'));
    writeTemplate(
      builtin,
      'alpha.md',
      TEMPLATE.replace('id: background', 'id: alpha').replace('blocks:', 'order: 60\nblocks:'),
    );
    expect(loadTemplates(builtin, repo).templates.map((t) => t.id)).toEqual([
      'background',
      'alpha',
    ]);
  });

  it('skillsDir에 video-digest가 없으면 패키지에 실린 기본 템플릿으로 내려간다', () => {
    const dir = findBuiltinTemplatesDir(join(tmpRepo(), 'plugin', 'skills'));
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, 'background.md'))).toBe(true);
  });
});

describe('확장 리포트 lint', () => {
  const lint = (d: Digest, templates?: Parameters<typeof templateMap>[0]) =>
    lintDigest(d, sampleTranscript(), templates ? { templates: templateMap(templates) } : {});

  it('유효한 확장은 오류가 없다', () => {
    expect(lintErrors(lint(withExt(sampleExtension())))).toEqual([]);
  });

  it('키워드 마커는 어느 칸이든 오류다', () => {
    const ext = sampleExtension({
      blocks: [{ type: 'text', text: '{{kw:code-layers|코드 레이어}}를 쓴다.' }],
    });
    expect(codes(lint(withExt(ext)))).toContain('EXTENSION_KEYWORD');
  });

  it('제목 칸의 굵게는 오류다', () => {
    const ext = sampleExtension({ blocks: [{ type: 'heading', text: '**굵은** 제목' }] });
    const issues = lint(withExt(ext));
    expect(codes(issues)).toContain('TITLE_MARKER');
    expect(issues.find((i) => i.code === 'TITLE_MARKER')!.path).toBe('extensions.0.blocks.0.text');
  });

  it('없는 문장과 범위 밖 key를 짚는다', () => {
    const ext = sampleExtension({
      blocks: [
        { type: 'text', text: '끝.', cite: { key: 12, from: 12, to: 12 } },
        { type: 'text', text: '앞.', cite: { key: 5, from: 1, to: 2 } },
      ],
    });
    expect(codes(lint(withExt(ext)))).toEqual(
      expect.arrayContaining(['CITE_OUT_OF_RANGE', 'KEY_OUT_OF_RANGE']),
    );
  });

  it('목록 3단은 오류다', () => {
    const ext = sampleExtension({
      blocks: [
        {
          type: 'list',
          items: [{ text: '1', children: [{ text: '2', children: [{ text: '3' }] }] }],
        },
      ],
    });
    const issue = lint(withExt(ext)).find((i) => i.code === 'LIST_DEPTH');
    expect(issue?.path).toBe('extensions.0.blocks.0.items.0.children.0.children');
  });

  it('템플릿과 언어가 같은 확장이 둘이면 오류다', () => {
    expect(codes(lint(withExt(sampleExtension(), sampleExtension())))).toContain(
      'DUPLICATE_EXTENSION',
    );
    expect(lintErrors(lint(withExt(sampleExtension(), sampleExtension({ lang: 'en' }))))).toEqual(
      [],
    );
  });

  it('템플릿 목록을 주면 모르는 템플릿과 템플릿 밖 블록을 경고한다', () => {
    const t = parseTemplate(TEMPLATE.replace('heading, text, list, text', 'text'), 'builtin', 'p');
    const issues = lint(withExt(sampleExtension(), sampleExtension({ template: 'nope' })), [t]);
    expect(lintErrors(issues)).toEqual([]);
    expect(codes(issues)).toEqual(
      expect.arrayContaining(['BLOCK_NOT_IN_TEMPLATE', 'UNKNOWN_TEMPLATE']),
    );
  });
});

describe('mergeExtension', () => {
  function seeded() {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(sampleDigest());
    return { repo, store };
  }

  it('digest.json이 없으면 합치지 않는다', () => {
    const repo = tmpRepo();
    new DigestStore(repo).saveTranscript(sampleTranscript());
    expect(() => mergeExtension(repo, SLUG, sampleExtension())).toThrow(/digest.json이 없어요/);
  });

  it('새 확장은 뒤에 붙이고 같은 키는 바꿔 끼운다', () => {
    const { repo, store } = seeded();
    const first = mergeExtension(repo, SLUG, sampleExtension());
    expect(first).toMatchObject({ key: 'background.ko', index: 0, replaced: false, saved: true });
    const second = mergeExtension(repo, SLUG, sampleExtension({ title: '배경' }));
    expect(second).toMatchObject({ index: 0, replaced: true, saved: true });
    const saved = store.loadDigest(SLUG)!;
    expect(saved.extensions.map((x) => x.title)).toEqual(['배경']);
    expect(saved.reports).toHaveLength(1);
  });

  it('lint 오류가 나면 저장하지 않는다', () => {
    const { repo, store } = seeded();
    const bad = sampleExtension({ blocks: [{ type: 'text', text: '{{kw:a|b}}' }] });
    expect(mergeExtension(repo, SLUG, bad).saved).toBe(false);
    expect(store.loadDigest(SLUG)!.extensions).toEqual([]);
  });

  it('형식이 틀리면 경로와 함께 거절한다', () => {
    const { repo } = seeded();
    expect(() => mergeExtension(repo, SLUG, { template: 'x', title: 't', blocks: [] })).toThrow(
      /확장 리포트 형식 오류: blocks/,
    );
  });
});

describe('확장 탭 렌더', () => {
  const templates = [
    { id: 'background', title: '관련 배경지식', description: '배경' },
    { id: 'quiz', title: '퀴즈', description: '<문제>' },
  ];

  it('확장도 템플릿도 없으면 탭 없이 예전 출력 그대로다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('id="panel-summary"');
    expect(html).not.toContain('id="more-menu"');
  });

  it('확장이 있으면 요약 탭과 확장 탭, 숨긴 패널을 그린다', () => {
    const { html } = renderDigestHtml(withExt(sampleExtension()), sampleTranscript());
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="tab-panel-summary"');
    expect(html).toContain('id="tab-ext-background.ko"');
    expect(html).toMatch(
      /<section class="ext" id="ext-background\.ko" role="tabpanel"[^>]* hidden>/,
    );
    expect(html).toMatch(/<section class="ext" id="ext-background\.ko"[^>]* tabindex="0" hidden>/);
    expect(html).toContain(
      '<div id="panel-summary" role="tabpanel" aria-labelledby="tab-panel-summary" tabindex="0">',
    );
    expect(html).toContain('<strong>코드를</strong>');
    expect(html).toContain('<noscript><style>.ext{display:block!important}');
  });

  it('이미 만든 템플릿은 메뉴에서 빼고 설명은 이스케이프한다', () => {
    const { html } = renderDigestHtml(withExt(sampleExtension()), sampleTranscript(), {
      templates,
    });
    expect(html).not.toContain('data-template="background"');
    expect(html).toContain('data-template="quiz"');
    expect(html).toContain('&lt;문제&gt;');
  });

  it('메뉴에 띄울 템플릿만 있어도 탭 줄을 둔다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript(), { templates });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="more-btn"');
  });

  it('확장 마크다운은 머리말 다음에 블록을 옮긴다', () => {
    const md = renderExtensionMarkdown(sampleExtension(), sampleTranscript());
    expect(md).toContain('> 리포트: 관련 배경지식');
    expect(md).toContain('## Code Layers');
    expect(md).toContain('**더 볼 거리**');
    expect(md).toMatch(/\n {2}- JSX/);
  });

  it('확장 마크다운의 리포트 제목도 링크와 HTML 문법 글자를 무력화한다', () => {
    const ext = { ...sampleExtension(), title: '[x](https://e.com) <b>' };
    const md = renderExtensionMarkdown(ext, sampleTranscript());
    expect(md).toContain(String.raw`> 리포트: \[x\](https://e.com) \<b\>`);
  });
});

describe('serve 렌더', () => {
  it('serve가 쓰는 렌더도 템플릿을 넘겨 더 만들기 메뉴를 그린다', () => {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(sampleDigest());
    const { htmlPath } = renderDigestFiles(SLUG, { repoRoot: repo, json: true });
    expect(readFileSync(htmlPath, 'utf-8')).toContain('id="more-btn"');
  });
});

describe('확장 내보내기', () => {
  it('--report에 확장 키를 주면 그 확장만 내보낸다', () => {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(withExt(sampleExtension()));
    const key = extensionKey(sampleExtension());
    const { mdPath } = exportMarkdown(SLUG, { repoRoot: repo, report: key });
    expect(mdPath.endsWith(`digest.${key}.md`)).toBe(true);
    expect(readFileSync(mdPath, 'utf-8')).toContain('> 리포트: 관련 배경지식');
  });

  it('없는 키면 확장 키까지 목록에 보여 준다', () => {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(withExt(sampleExtension()));
    expect(() => exportMarkdown(SLUG, { repoRoot: repo, report: 'nope' })).toThrow(
      /background\.ko/,
    );
  });
});

describe('뷰어 로직', () => {
  it('templateCommand는 템플릿과 언어를 붙인 명령을 만든다', () => {
    expect(viewerLogic.templateCommand('abc', 'quiz', 'en')).toBe(
      '/gestalt:video-digest slug=abc templates=quiz reportLang=en',
    );
    expect(viewerLogic.templateCommand('abc', 'quiz')).toBe(
      '/gestalt:video-digest slug=abc templates=quiz',
    );
  });

  it('tabStep은 양 끝에서 돌고 다른 키는 -1이다', () => {
    expect(viewerLogic.tabStep(2, 3, 'ArrowRight')).toBe(0);
    expect(viewerLogic.tabStep(0, 3, 'ArrowLeft')).toBe(2);
    expect(viewerLogic.tabStep(1, 3, 'Home')).toBe(0);
    expect(viewerLogic.tabStep(1, 3, 'End')).toBe(2);
    expect(viewerLogic.tabStep(1, 3, 'Enter')).toBe(-1);
  });
});

describe('텍스트 블록 (quote, timestamps, actions, qa)', () => {
  const textExt = (): Extension =>
    sampleExtension({
      template: 'meeting',
      title: '회의록',
      blocks: [
        {
          type: 'quote',
          text: 'sentence number 3 sentence number 4',
          translation: '3번 **문장**',
          speaker: '진행자',
          note: '핵심',
          cite: { key: 3, from: 3, to: 4 },
        },
        {
          type: 'timestamps',
          items: [
            { title: '도입', summary: '시작', cite: { key: 0, from: 0, to: 2 } },
            { title: '본론', cite: { key: 6, from: 3, to: 11 } },
          ],
        },
        {
          type: 'actions',
          items: [
            { task: '문서 정리', owner: '민수', due: '금요일', cite: { key: 5, from: 5, to: 5 } },
            { task: '공유' },
          ],
        },
        {
          type: 'qa',
          items: [{ question: '왜요?', answer: '빨라서요.', cite: { key: 7, from: 7, to: 8 } }],
        },
      ],
    });

  it('네 블록이 스키마와 lint를 통과한다', () => {
    const issues = lintDigest(withExt(textExt()), sampleTranscript());
    expect(lintErrors(issues)).toEqual([]);
    expect(codes(issues)).not.toContain('QUOTE_NOT_IN_SOURCE');
  });

  it('인용문이 출처 대사에 그대로 없으면 경고한다', () => {
    const ext = textExt();
    const quote = ext.blocks[0]!;
    if (quote.type !== 'quote') throw new Error('quote 블록이어야 한다');
    quote.text = 'Sentence number 9.';
    const issue = lintDigest(withExt(ext), sampleTranscript()).find(
      (i) => i.code === 'QUOTE_NOT_IN_SOURCE',
    );
    expect(issue).toMatchObject({ severity: 'warning', path: 'extensions.0.blocks.0.text' });
  });

  it('인용 원문과 담당자 칸은 굵게를 받지 않는다', () => {
    const ext = textExt();
    const [quote, , actions] = ext.blocks;
    if (quote?.type !== 'quote' || actions?.type !== 'actions') throw new Error('블록 순서');
    quote.text = '**sentence number 3**';
    actions.items[0]!.owner = '**민수**';
    const issues = lintDigest(withExt(ext), sampleTranscript());
    expect(issues.filter((i) => i.code === 'VERBATIM_MARKER').map((i) => i.path)).toEqual([
      'extensions.0.blocks.0.text',
    ]);
    expect(issues.find((i) => i.code === 'TITLE_MARKER')?.path).toBe(
      'extensions.0.blocks.2.items.0.owner',
    );
  });

  it('HTML은 인용, 목차 시각 링크, 할 일, 문답을 그린다', () => {
    const { html } = renderDigestHtml(withExt(textExt()), sampleTranscript());
    expect(html).toContain('<figure class="quote"><blockquote>sentence number 3 sentence number 4');
    expect(html).toContain('<p class="quote-tr">3번 <strong>문장</strong></p>');
    expect(html).toMatch(/<ol class="ext-toc"><li><a class="ts" href="[^"]*t=0s"[^>]*data-sec="0"/);
    expect(html).toContain('data-sec="30"');
    expect(html).toContain('<span>담당 민수</span><span>기한 금요일</span>');
    expect(html).toContain('<dl class="qa"><dt>왜요?</dt><dd>빨라서요.');
  });

  it('마크다운은 인용문, 시각 목차, 체크박스, 문답으로 옮긴다', () => {
    const md = renderExtensionMarkdown(textExt(), sampleTranscript());
    expect(md).toMatch(/^> sentence number 3 sentence number 4 \[\[4\]\]/m);
    expect(md).toContain('> — 진행자, 핵심');
    expect(md).toMatch(/^- \[00:30\]\(https:[^)]*t=30s\) \*\*본론\*\*$/m);
    expect(md).toContain('- [ ] 문서 정리 (담당 민수, 기한 금요일)');
    expect(md).toContain('- [ ] 공유\n');
    expect(md).toContain('**Q. 왜요?**');
  });

  it('마크다운 인용에 개행이 섞여도 줄마다 인용으로 남고 문법 글자는 무력화한다', () => {
    const ext = textExt();
    const [quote, timestamps] = ext.blocks;
    if (quote?.type !== 'quote') throw new Error('quote 블록이어야 한다');
    quote.text = 'sentence number 3\n![x](https://example.com/p.png) &lt;b&gt;';
    const heading = { type: 'heading' as const, text: '제목\n- 목록으로 새는 줄' };
    ext.blocks.unshift(heading);
    if (timestamps?.type === 'timestamps') timestamps.items[0]!.title = '본론\n# 끼어든 제목';
    const md = renderExtensionMarkdown(ext, sampleTranscript());
    expect(md).toContain(
      '> sentence number 3\n> !\\[x\\](https://example.com/p.png) \\&lt;b\\&gt; [[4]]',
    );
    expect(md).toContain('## 제목 - 목록으로 새는 줄');
    expect(md).not.toMatch(/^# 끼어든 제목/m);
  });

  describe('마크다운 한 줄 칸도 링크와 HTML 문법 글자를 무력화한다', () => {
    const raw = String.raw`a\b [x](https://e.com) <b>`;
    const escaped = String.raw`a\\b \[x\](https://e.com) \<b\>`;
    const cite = { key: 1, from: 1, to: 1 };
    const cases: [string, Block, string][] = [
      ['heading', { type: 'heading', text: raw }, `## ${escaped}`],
      ['list.title', { type: 'list', title: raw, items: [{ text: '항목' }] }, `**${escaped}**`],
      ['quote.speaker', { type: 'quote', text: '원문', speaker: raw, cite }, `— ${escaped}`],
      ['timestamps.title', { type: 'timestamps', items: [{ title: raw, cite }] }, `**${escaped}**`],
      [
        'actions.owner',
        { type: 'actions', items: [{ task: '할 일', owner: raw }] },
        `담당 ${escaped}`,
      ],
      ['actions.due', { type: 'actions', items: [{ task: '할 일', due: raw }] }, `기한 ${escaped}`],
      [
        'comments 묶음 title',
        {
          type: 'comments',
          total: 1,
          overview: '개요',
          groups: [{ title: raw, tone: 'neutral', count: 1, summary: '요약', examples: [] }],
        },
        `**${escaped}**`,
      ],
      ['mindmap 라벨', { type: 'mindmap', root: { label: raw } }, `- ${escaped}`],
    ];

    it.each(cases)('%s', (_name, block, expected) => {
      const md = blockMarkdown(block, { cite: () => '', time: () => '' }).join('\n');
      expect(md).toContain(expected);
      expect(md).not.toMatch(/(^|[^\\])\]\(https:\/\/e\.com\)/m);
    });
  });

  describe('마크다운 글자 칸은 blockFields가 내놓는 경로마다 role대로 이스케이프된다', () => {
    const cite = { key: 1, from: 1, to: 1 };
    const blocks: Block[] = [
      { type: 'heading', text: 'p' },
      { type: 'text', text: 'p', cite },
      { type: 'list', title: 'p', items: [{ text: 'p', children: [{ text: 'p' }] }] },
      { type: 'quote', text: 'p', speaker: 'p', note: 'p', translation: 'p', cite },
      { type: 'timestamps', items: [{ title: 'p', summary: 'p', cite }] },
      { type: 'actions', items: [{ task: 'p', owner: 'p', due: 'p', cite }] },
      { type: 'qa', items: [{ question: 'p', answer: 'p', cite }] },
      { type: 'flashcards', cards: [{ front: 'p', back: 'p', cite }] },
      {
        type: 'quiz',
        questions: [{ question: 'p', choices: ['p', 'p'], answer: 0, explanation: 'p', cite }],
      },
      { type: 'mindmap', root: { label: 'p', children: [{ label: 'p' }] } },
      {
        type: 'comments',
        total: 1,
        overview: 'p',
        groups: [
          {
            title: 'p',
            tone: 'neutral',
            count: 1,
            summary: 'p',
            examples: [{ id: 'c1', text: 'p' }],
          },
        ],
      },
    ];
    const probe =
      '1. 첫째\n---\n- 가짜 [x](https://e.com) <img> **a_b** 1~2개\n    - 들여쓴 줄\r+ 홑 줄바꿈\n**줄\n넘김**';
    const tail = String.raw`\[x\](https://e.com) \<img\>`;
    const rest = String.raw`1\~2개 - 들여쓴 줄 + 홑 줄바꿈 \*\*줄 넘김\*\*`;
    const expected = {
      title: String.raw`1\. 첫째 --- - 가짜 ${tail} \*\*a\_b\*\* ${rest}`,
      body: String.raw`1\. 첫째 --- - 가짜 ${tail} **a\_b** ${rest}`,
      verbatim: [
        String.raw`> 1\. 첫째`,
        String.raw`> \---`,
        String.raw`> \- 가짜 ${tail} \*\*a\_b\*\* 1\~2개`,
        String.raw`> \- 들여쓴 줄`,
        String.raw`> \+ 홑 줄바꿈`,
        String.raw`> \*\*줄`,
        String.raw`> 넘김\*\*`,
      ].join('\n'),
    };
    const cases = blocks.flatMap((block) =>
      blockFields(block, 'b').texts.map((t) => [t.path, t.role, block] as const),
    );
    const render = (block: Block, path: string, value: string) => {
      const target = structuredClone(block) as Record<string, unknown>;
      const keys = path.split('.').slice(1);
      const parent = keys
        .slice(0, -1)
        .reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, target);
      parent[keys.at(-1)!] = value;
      return blockMarkdown(target as Block, { cite: () => '', time: () => '' }).join('\n');
    };

    it.each(cases)('%s (%s)', (path, role, block) => {
      const md = render(block, path, probe);
      expect(md).toContain(expected[role]);
      expect(md).not.toContain('**줄 넘김**');
      expect(md).not.toMatch(/(^|[^\\])\]\(https:\/\/e\.com\)/m);
      expect(md).not.toMatch(/^[\s>]*(?:[-*]\s+)?(?:---|- 가짜|1\. 첫째|- 들여쓴|\+ 홑|\*\*줄)/m);
    });

    // 세 번째 칸은 문법이 아닌 머리를 지나치게 이스케이프했을 때 나오는 꼴이다
    const heads = [
      ['- 가짜', String.raw`\- 가짜`, null],
      ['+ 가짜', String.raw`\+ 가짜`, null],
      ['1. 가짜', String.raw`1\. 가짜`, null],
      ['1) 가짜', String.raw`1\) 가짜`, null],
      ['-', String.raw`\-`, null],
      ['---', String.raw`\---`, null],
      ['===  ', String.raw`\===`, null],
      ['3.5배', '3.5배', String.raw`3\.5배`],
      ['-5도', '-5도', String.raw`\-5도`],
      ['2026.10.25', '2026.10.25', String.raw`2026\.10.25`],
    ] as const;

    it.each(cases.flatMap((c) => heads.map((h) => [...c, ...h] as const)))(
      '%s (%s) 줄 머리 %#',
      (path, role, block, head, out, overEscaped) => {
        // 인용 원문은 윗줄이 있어야 `===`와 `-`가 제목 밑줄이 되므로 앞줄을 둔다
        const md = render(block, path, role === 'verbatim' ? `앞줄\n${head}` : head);
        expect(md).toContain(role === 'verbatim' ? `\n> ${out}` : out);
        if (overEscaped) expect(md).not.toContain(overEscaped);
      },
    );
  });

  it('인용 원문의 범위 표기 물결이 취소선으로 바뀌지 않는다', () => {
    const ctx = { cite: () => '', time: () => '' };
    const quote: Block = { type: 'quote', text: '1~2개와 3~4개', cite: { key: 1, from: 1, to: 1 } };
    expect(blockMarkdown(quote, ctx).join('\n')).toContain(String.raw`> 1\~2개와 3\~4개`);
  });
});

describe('기본 템플릿', () => {
  it('패키지에 실린 템플릿이 전부 경고 없이 읽힌다', () => {
    const { templates, warnings } = loadTemplates(findBuiltinTemplatesDir(), tmpRepo());
    expect(warnings).toEqual([]);
    expect(templates.length).toBeGreaterThanOrEqual(8);
    expect(new Set(templates.map((t) => t.order)).size).toBe(templates.length);
  });
});
