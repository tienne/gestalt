import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextCard, KnowledgeLink } from '../../../src/digest/lens-schema.js';
import { lensSourcePath } from '../../../src/digest/lens-source.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import type { KnowledgeContext } from '../../../src/digest/lint-lens-context.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { DigestStore } from '../../../src/digest/store.js';
import { writeJsonAtomic } from '../../../src/core/json-file.js';
import { attachContext } from '../../../src/lens/attach.js';
import {
  findKnowledge,
  knowledgeRoots,
  pickTerms,
  searchNotes,
} from '../../../src/lens/knowledge.js';
import { mergeReport } from '../../../src/digest/merge.js';
import { LENS_SLUG, lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const r = resolve('.gestalt-test', `lens-context-${randomUUID()}`);
  mkdirSync(r, { recursive: true });
  dirs.push(r);
  return r;
}

const card = (over: Partial<ContextCard> = {}): ContextCard => ({
  id: 'lineage',
  kind: 'lineage',
  section: 's1',
  anchor: { key: 1, from: 1, to: 1 },
  title: 'FlavorGraph에서 이어진 연구',
  lineage: [{ year: '2021', title: 'FlavorGraph', role: 'foundation', took: 'CSP', source: 'fg' }],
  points: [{ text: 'CSP는 FlavorGraph에 이미 있던 기법이다.', sources: ['fg'] }],
  sources: [{ id: 'fg', url: 'https://doi.org/10.1038/s41598-020-79422-8', title: 'FlavorGraph' }],
  ...over,
});

const NOTE = '/notes/flavor.md';
const link = (over: Partial<KnowledgeLink> = {}): KnowledgeLink => ({
  id: 'kb-1',
  section: 's1',
  anchor: { key: 1, from: 1, to: 1 },
  title: '향미 노트',
  note: '노트의 FlavorGraph 항목과 이어진다.',
  path: NOTE,
  line: 3,
  quote: 'FlavorGraph는 Recipe1M과 FlavorDB로 만든다',
  ...over,
});

const knowledge: KnowledgeContext = {
  roots: ['/notes'],
  read: (p) => (p === NOTE ? '# 노트\n\nFlavorGraph는   Recipe1M과\nFlavorDB로 만든다.\n' : null),
};

const lint = (r = lensReport(), k: KnowledgeContext | null | undefined = knowledge) =>
  lintErrors(
    lintDigest(lensDigest(r), lensTranscript(), { source: lensSource(), knowledge: k }),
  ).map((i) => i.code);

describe('맥락 카드와 연결 카드 lint', () => {
  it('출처가 맞는 카드와 노트에 있는 인용은 통과한다', () => {
    const r = lensReport();
    r.cards = [card()];
    r.links = [link()];
    r.limits!.push({ text: '후속 검증을 찾지 못했다.', evidence: [], card: 'lineage' });
    expect(lint(r)).toEqual([]);
  });

  it('카드 줄의 출처 id가 sources에 없으면 막는다', () => {
    const r = lensReport();
    r.cards = [card({ points: [{ text: '근거 없는 말', sources: ['nope'] }] })];
    expect(lint(r)).toContain('CARD_SOURCE_UNKNOWN');
  });

  it('없는 대섹션이나 그 대섹션 밖 자리에 붙인 카드는 막는다', () => {
    const r = lensReport();
    r.cards = [card({ section: 's9' }), card({ id: 'c2', anchor: { key: 5, from: 5, to: 5 } })];
    const c = lint(r);
    expect(c).toContain('CARD_SECTION_UNKNOWN');
    expect(c).toContain('CARD_ANCHOR_OUT_OF_SECTION');
  });

  it('한계 줄이 없는 카드를 가리키면 LIMIT_CARD_UNKNOWN', () => {
    const r = lensReport();
    r.limits!.push({ text: '카드에서 온 줄', evidence: [], card: 'ghost' });
    expect(lint(r)).toContain('LIMIT_CARD_UNKNOWN');
  });

  it('카드 출처 주소는 http(s)만 받는다', () => {
    const r = lensReport();
    r.cards = [card({ sources: [{ id: 'fg', url: 'javascript:alert(1)', title: 'x' }] })];
    const d = lensDigest(r);
    expect(() => renderDigestHtml(d, lensTranscript())).not.toThrow();
    // 스키마가 먼저 막는다
    expect(mergeLike(r)).toMatch(/http\(s\)|Invalid url/);
  });

  it('노트에 없는 인용과 지식 소스 밖 경로를 막는다', () => {
    const r = lensReport();
    r.links = [link({ quote: '노트에 없는 문장입니다' }), link({ id: 'kb-2', path: '/etc/hosts' })];
    const c = lint(r);
    expect(c).toContain('LINK_QUOTE_NOT_FOUND');
    expect(c).toContain('LINK_OUTSIDE_SOURCES');
  });

  it('knowledge.json이 없으면 연결 카드를 받지 않고 렌더 때(undefined)는 대조를 건너뛴다', () => {
    const r = lensReport();
    r.links = [link()];
    expect(lint(r, null)).toContain('LINK_NO_KNOWLEDGE');
    expect(lint(r, undefined)).toEqual([]);
  });
});

function mergeLike(r: ReturnType<typeof lensReport>): string {
  const root = tmp();
  const store = new DigestStore(root);
  store.saveTranscript(lensTranscript());
  try {
    mergeReport(root, LENS_SLUG, r);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('카드 렌더', () => {
  it('카드는 그 대섹션 끝에 접어 두고 출처를 새 탭 링크로 단다', () => {
    const r = lensReport();
    r.cards = [card()];
    r.links = [link({ path: '/Users/someone/notes/flavor.md' })];
    r.limits!.push({ text: '카드 줄', evidence: [], card: 'lineage' });
    const html = renderDigestHtml(lensDigest(r), lensTranscript(), { source: lensSource() }).html;
    expect(html).toMatch(/<section class="sec" id="sec-s1">[^]*<aside class="ctx"[^]*<\/section>/);
    expect(html).toContain('<details class="ctx-card ctx-lineage" id="card-lineage">');
    expect(html).toContain(
      'href="https://doi.org/10.1038/s41598-020-79422-8" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).toContain('<td>토대</td>');
    expect(html).toContain('href="#card-lineage">맥락 카드</a>');
    expect(html).toContain('<code>~/notes/flavor.md:3</code>');
    const md = renderDigestMarkdown(lensDigest(r), lensTranscript(), { source: lensSource() });
    expect(md).toContain('### FlavorGraph에서 이어진 연구 (연구 계보)');
    expect(md).toContain('## 내 지식과 잇기');
  });
});

describe('lens attach', () => {
  it('카드를 리포트에 붙이고 카드에서 온 옛 한계 줄은 바꿔 끼운다', () => {
    const root = tmp();
    const store = new DigestStore(root);
    store.saveTranscript(lensTranscript());
    writeJsonAtomic(lensSourcePath(store, LENS_SLUG), lensSource());
    const r = lensReport();
    r.cards = [card()];
    r.limits!.push({ text: '옛 카드 줄', evidence: [], card: 'lineage' });
    expect(mergeReport(root, LENS_SLUG, r).saved).toBe(true);
    const out = attachContext(root, LENS_SLUG, {
      cards: [card({ id: 'counter', kind: 'counter', title: '반론' })],
      limits: [{ text: '새 카드 줄', card: 'counter' }],
    });
    expect(out.saved).toBe(true);
    const saved = store.loadDigest(LENS_SLUG)!.reports[0]!;
    expect(saved.cards!.map((c) => c.id)).toEqual(['counter']);
    expect(saved.limits!.map((l) => l.text)).toEqual([r.limits![0]!.text, '새 카드 줄']);
  });

  it('카드 파일의 한계 줄에 card가 없으면 거절한다', () => {
    const root = tmp();
    expect(() => attachContext(root, LENS_SLUG, { limits: [{ text: 'x' }] })).toThrow(/card id/);
  });
});

describe('내 지식 찾기', () => {
  it('두 번 넘게 나온 고유 이름과 약어만 찾을 말로 고른다', () => {
    const terms = pickTerms(['FlavorGraph uses NMI. FlavorGraph and NMI again. The model works.']);
    expect(terms).toEqual(expect.arrayContaining(['FlavorGraph', 'NMI']));
    expect(terms).not.toContain('The');
  });

  it('노트 폴더에서 이름이 겹치는 줄을 찾고 숨김 폴더와 다른 확장자는 건너뛴다', () => {
    const root = tmp();
    const notes = join(root, 'notes');
    mkdirSync(join(notes, '.secret'), { recursive: true });
    writeFileSync(join(notes, 'a.md'), 'intro\nFlavorGraph와 NMI 메모\n');
    writeFileSync(join(notes, '.secret', 'b.md'), 'FlavorGraph secret\n');
    writeFileSync(join(notes, 'c.json'), '{"FlavorGraph":1}');
    const hits = searchNotes([notes], ['FlavorGraph', 'NMI']);
    expect(hits).toEqual([
      {
        path: join(notes, 'a.md'),
        line: 2,
        text: 'FlavorGraph와 NMI 메모',
        terms: ['FlavorGraph', 'NMI'],
      },
    ]);
  });

  it('gestalt.json의 lens.knowledgeSources와 넘긴 폴더를 합치고 없는 폴더는 뺀다', () => {
    const root = tmp();
    mkdirSync(join(root, 'kb'));
    writeFileSync(
      join(root, 'gestalt.json'),
      JSON.stringify({ lens: { knowledgeSources: ['kb', 'missing'] } }),
    );
    const roots = knowledgeRoots(root, [join(root, 'kb')], join(root, 'no-user-lens.json'));
    expect(roots).toHaveLength(1);
    expect(roots[0]!.endsWith('/kb')).toBe(true);
  });

  it('findKnowledge가 knowledge.json을 쓴다', () => {
    const root = tmp();
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'n.md'), 'FlavorDiffusion 메모\n');
    const store = new DigestStore(root);
    store.saveTranscript(lensTranscript());
    const { file } = findKnowledge(LENS_SLUG, {
      repoRoot: root,
      sources: [notes],
      userFile: join(root, 'no-user-lens.json'),
    });
    expect(file.terms).toContain('FlavorDiffusion');
    expect(file.hits[0]?.line).toBe(1);
  });
});
