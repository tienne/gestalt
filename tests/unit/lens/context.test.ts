import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextCard, KnowledgeLink } from '../../../src/digest/lens-schema.js';
import { lensSourcePath } from '../../../src/digest/lens-source.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import {
  KNOWLEDGE_FILE,
  knowledgeContext,
  knowledgeFileSchema,
  type KnowledgeContext,
} from '../../../src/digest/lint-lens-context.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { reportKey } from '../../../src/digest/reports.js';
import { DigestStore } from '../../../src/digest/store.js';
import { writeJsonAtomic } from '../../../src/core/json-file.js';
import { attachContext } from '../../../src/lens/attach.js';
import { buildContextInput } from '../../../src/lens/context-input.js';
import {
  findKnowledge,
  knowledgeRoots,
  pickTerms,
  searchNotes,
} from '../../../src/lens/knowledge.js';
import { parseDigest } from '../../../src/digest/schema.js';
import { mergeReport } from '../../../src/digest/merge.js';
import { sampleDigest, sampleTranscript, SLUG as VIDEO_SLUG } from '../digest/fixture.js';
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

  /** 노트 파일과 knowledge.json까지 갖춘 저장소에 카드와 연결 카드를 단 리포트를 합쳐 둔다 */
  function withContext(): { root: string; store: DigestStore; note: string } {
    const root = tmp();
    const store = new DigestStore(root);
    store.saveTranscript(lensTranscript());
    writeJsonAtomic(lensSourcePath(store, LENS_SLUG), lensSource());
    const notes = join(root, 'notes');
    mkdirSync(notes, { recursive: true });
    const note = join(notes, 'flavor.md');
    writeFileSync(note, '# 노트\n\nFlavorGraph는 Recipe1M과 FlavorDB로 만든다.\n');
    writeJsonAtomic(join(store.dir(LENS_SLUG), KNOWLEDGE_FILE), {
      roots: [notes],
      terms: [],
      hits: [],
    });
    const r = lensReport();
    r.cards = [card()];
    r.links = [link({ path: note })];
    r.limits!.push({ text: '카드에서 온 줄', evidence: [], card: 'lineage' });
    expect(mergeReport(root, LENS_SLUG, r).saved).toBe(true);
    return { root, store, note };
  }

  it('cards만 붙이면 links가 그대로 남는다', () => {
    const { root, store } = withContext();
    const out = attachContext(root, LENS_SLUG, {
      cards: {
        cards: [card({ id: 'counter', kind: 'counter', title: '반론' })],
        limits: [{ text: '새 카드 줄', card: 'counter' }],
      },
    });
    expect(out.saved).toBe(true);
    const saved = store.loadDigest(LENS_SLUG)!.reports[0]!;
    expect(saved.cards!.map((c) => c.id)).toEqual(['counter']);
    expect(saved.limits!.map((l) => l.text)).toEqual([lensReport().limits![0]!.text, '새 카드 줄']);
    expect(saved.links!.map((l) => l.id)).toEqual(['kb-1']);
  });

  it('links만 붙이면 cards와 카드 한계 줄이 그대로 남는다', () => {
    const { root, store, note } = withContext();
    const out = attachContext(root, LENS_SLUG, {
      links: { links: [link({ id: 'kb-2', path: note })] },
    });
    expect(out.saved).toBe(true);
    const saved = store.loadDigest(LENS_SLUG)!.reports[0]!;
    expect(saved.links!.map((l) => l.id)).toEqual(['kb-2']);
    expect(saved.cards!.map((c) => c.id)).toEqual(['lineage']);
    expect(saved.limits!.some((l) => l.card === 'lineage')).toBe(true);
  });

  it('빈 객체는 그 필드를 비운다', () => {
    const { root, store } = withContext();
    expect(attachContext(root, LENS_SLUG, { links: {} }).saved).toBe(true);
    const saved = store.loadDigest(LENS_SLUG)!.reports[0]!;
    expect(saved.links ?? []).toEqual([]);
    expect(saved.cards!.map((c) => c.id)).toEqual(['lineage']);
  });

  it('cards와 links를 함께 붙인다', () => {
    const { root, store, note } = withContext();
    const out = attachContext(root, LENS_SLUG, {
      cards: {
        cards: [card({ id: 'counter', kind: 'counter', title: '반론' })],
        limits: [{ text: '새 카드 줄', card: 'counter' }],
      },
      links: { links: [link({ id: 'kb-3', path: note })] },
    });
    expect(out.saved).toBe(true);
    const saved = store.loadDigest(LENS_SLUG)!.reports[0]!;
    expect(saved.cards!.map((c) => c.id)).toEqual(['counter']);
    expect(saved.links!.map((l) => l.id)).toEqual(['kb-3']);
  });

  it('옛 한 파일 꼴(file)도 받는다', () => {
    const { root, store, note } = withContext();
    const file = { cards: [card()], links: [link({ id: 'kb-9', path: note })], limits: [] };
    expect(attachContext(root, LENS_SLUG, { file }).saved).toBe(true);
    expect(store.loadDigest(LENS_SLUG)!.reports[0]!.links!.map((l) => l.id)).toEqual(['kb-9']);
    expect(attachContext(root, LENS_SLUG, file).saved).toBe(true);
  });

  it('아무 파일도 없으면 거절한다', () => {
    expect(() => attachContext(tmp(), LENS_SLUG, { cards: undefined })).toThrow(/붙일 파일/);
  });

  it('카드 파일의 한계 줄에 card가 없으면 거절한다', () => {
    const root = tmp();
    expect(() => attachContext(root, LENS_SLUG, { limits: [{ text: 'x' }] })).toThrow(/card id/);
  });
});

describe('context-input', () => {
  const NOTE_PATH = '/Users/someone/private-notes/flavor.md';
  function setup() {
    const root = tmp();
    const store = new DigestStore(root);
    store.saveTranscript(lensTranscript());
    const r = lensReport();
    r.cards = [card()];
    r.links = [link({ path: NOTE_PATH })];
    // 노트 대조는 lint 단계라 저장소에 직접 써서 사본 동작만 본다
    writeJsonAtomic(store.digestPath(LENS_SLUG), lensDigest(r));
    return root;
  }

  it('links 키를 뺀 사본을 만들고 cards, limits, sections는 그대로 둔다', () => {
    const root = setup();
    const { report } = buildContextInput(root, LENS_SLUG);
    const orig = lensReport();
    expect('links' in report).toBe(false);
    expect(report.cards!.map((c) => c.id)).toEqual(['lineage']);
    expect(report.limits).toEqual(orig.limits);
    expect(report.sections).toEqual(orig.sections);
  });

  it('노트 경로 문자열이 출력 어디에도 없다', () => {
    const root = setup();
    const text = JSON.stringify(
      buildContextInput(root, LENS_SLUG, undefined, { withTranscript: true }),
    );
    expect(text).not.toContain('private-notes');
    expect(text).not.toContain(NOTE_PATH);
  });

  it('--report 키로 리포트를 고른다', () => {
    const root = setup();
    const digest = new DigestStore(root).loadDigest(LENS_SLUG)!;
    const key = reportKey(digest.reports[0]!.options);
    expect(buildContextInput(root, LENS_SLUG, key).report.options).toEqual(
      digest.reports[0]!.options,
    );
    expect(() => buildContextInput(root, LENS_SLUG, 'nope')).toThrow(/nope/);
  });

  it('withTranscript면 문단을 { i, text }만 담아 함께 준다', () => {
    const root = setup();
    expect(buildContextInput(root, LENS_SLUG).transcript).toBeUndefined();
    const { transcript } = buildContextInput(root, LENS_SLUG, undefined, { withTranscript: true });
    const segs = lensTranscript().segments;
    expect(transcript).toHaveLength(segs.length);
    expect(transcript![0]).toEqual({ i: segs[0]!.i, text: segs[0]!.text });
    expect(Object.keys(transcript![0]!).sort()).toEqual(['i', 'text']);
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
    const { hits } = searchNotes([notes], ['FlavorGraph', 'NMI']);
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
    const { roots, warnings } = knowledgeRoots(
      root,
      [join(root, 'kb')],
      join(root, 'no-user-lens.json'),
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]!.endsWith('/kb')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('gestalt.json이 레포 밖(절대 경로, ../, 밖을 가리키는 심링크)을 가리키면 빼고 경고한다', () => {
    const base = realpathSync(tmp());
    const repo = join(base, 'repo');
    const outside = join(base, 'private');
    mkdirSync(join(repo, 'kb'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(repo, 'escape'));
    writeFileSync(
      join(repo, 'gestalt.json'),
      JSON.stringify({ lens: { knowledgeSources: ['kb', outside, '../private', 'escape'] } }),
    );
    const { roots, warnings } = knowledgeRoots(repo, [], join(base, 'no-user-lens.json'));
    expect(roots).toEqual([join(repo, 'kb')]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/레포 밖/);
    // 부를 때 넘긴 폴더(--source)는 레포 밖이어도 받는다
    expect(knowledgeRoots(repo, [outside], join(base, 'no-user-lens.json')).roots).toEqual([
      join(repo, 'kb'),
      outside,
    ]);
  });

  it('연결 카드 대조는 노트 폴더 밖을 가리키는 심링크를 따라가지 않는다', () => {
    const root = realpathSync(tmp());
    const notes = join(root, 'notes');
    const secret = join(root, 'secret.md');
    mkdirSync(notes);
    writeFileSync(join(notes, 'ok.md'), 'FlavorGraph 메모\n');
    writeFileSync(secret, '비밀\n');
    symlinkSync(secret, join(notes, 'leak.md'));
    const store = new DigestStore(root);
    store.saveTranscript(lensTranscript());
    writeJsonAtomic(join(store.dir(LENS_SLUG), KNOWLEDGE_FILE), {
      roots: [notes],
      terms: [],
      hits: [],
    });
    const k = knowledgeContext(store, LENS_SLUG)!;
    expect(k.read(join(notes, 'ok.md'))).toBe('FlavorGraph 메모\n');
    expect(k.read(join(notes, 'leak.md'))).toBeNull();
    const r = lensReport();
    r.links = [link({ path: join(notes, 'leak.md'), quote: '비밀' })];
    expect(lint(r, k)).toContain('LINK_FILE_MISSING');
  });

  it('빌드 산출물 폴더는 건너뛰고 상한에 닿으면 잘렸다고 알린다', () => {
    const root = tmp();
    const notes = join(root, 'notes');
    for (const d of ['dist', 'build', 'vendor']) {
      mkdirSync(join(notes, d), { recursive: true });
      writeFileSync(join(notes, d, 'x.md'), 'FlavorGraph 빌드\n');
    }
    writeFileSync(join(notes, 'a.md'), 'FlavorGraph 1\nFlavorGraph 2\nFlavorGraph 3\n');
    writeFileSync(join(notes, 'b.md'), 'FlavorGraph 4\n');
    const all = searchNotes([notes], ['FlavorGraph']);
    expect(all.hits.map((h) => h.path).every((p) => !/dist|build|vendor/.test(p))).toBe(true);
    expect(all).toMatchObject({
      totalHits: 4,
      truncated: { files: false, bytes: false, hits: false, large: false },
    });

    const fewHits = searchNotes([notes], ['FlavorGraph'], { files: 10, totalBytes: 1e6, hits: 2 });
    expect(fewHits.hits).toHaveLength(2);
    expect(fewHits).toMatchObject({ totalHits: 4, truncated: { hits: true } });
    expect(
      searchNotes([notes], ['FlavorGraph'], { files: 1, totalBytes: 1e6, hits: 40 }).truncated
        .files,
    ).toBe(true);
    expect(
      searchNotes([notes], ['FlavorGraph'], { files: 10, totalBytes: 20, hits: 40 }).truncated
        .bytes,
    ).toBe(true);
  });

  it('1MB 넘는 노트는 읽지 않고 건너뛰었다고 알린다', () => {
    const root = tmp();
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'small.md'), 'FlavorGraph 작은 노트\n');
    writeFileSync(join(notes, 'big.md'), `FlavorGraph 큰 노트\n${'x'.repeat(1024 * 1024)}`);
    const found = searchNotes([notes], ['FlavorGraph']);
    expect(found.hits.map((h) => h.path)).toEqual([join(notes, 'small.md')]);
    expect(found.truncated.large).toBe(true);
  });

  it('합친 정규식으로 거른 뒤에도 말 경계를 그대로 지킨다', () => {
    const root = tmp();
    const notes = join(root, 'notes');
    mkdirSync(notes);
    writeFileSync(join(notes, 'a.md'), 'xNMI 붙은 말\nNMIx 붙은 말\nCSP 단독\n');
    writeFileSync(join(notes, 'b.md'), 'NMI2 숫자 붙음\n');
    const { hits } = searchNotes([notes], ['NMI', 'CSP']);
    expect(hits).toEqual([
      { path: join(notes, 'a.md'), line: 3, text: 'CSP 단독', terms: ['CSP'] },
    ]);
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
    expect(file.totalHits).toBe(file.hits.length);
    expect(file.truncated).toEqual({
      files: false,
      bytes: false,
      hits: false,
      terms: false,
      large: false,
    });
  });

  it('잘림 칸이 없는 옛 knowledge.json도 읽는다', () => {
    expect(knowledgeFileSchema.safeParse({ roots: [], terms: [], hits: [] }).success).toBe(true);
  });
});

describe('영상 맥락 카드와 상한', () => {
  const vcard = (i: number, over: Partial<ContextCard> = {}): ContextCard => ({
    id: `c${i}`,
    kind: 'counter',
    section: 's1',
    anchor: { key: 1, from: 1, to: 1 },
    title: `카드 ${i}`,
    points: [{ text: '다른 시각도 있다.', sources: ['src'] }],
    sources: [{ id: 'src', url: 'https://example.com/a', title: '자료' }],
    ...over,
  });
  const cards = (n: number) => Array.from({ length: n }, (_, i) => vcard(i));
  const videoCodes = (n: number) => {
    const d = sampleDigest();
    d.reports[0]!.cards = cards(n);
    return lintErrors(lintDigest(d, sampleTranscript())).map((i) => i.code);
  };

  it('렌즈 카드는 4장까지 통과하고 5장은 CARDS_OVER_LIMIT', () => {
    const ok = lensReport();
    ok.cards = cards(4);
    expect(lint(ok)).toEqual([]);
    const over = lensReport();
    over.cards = cards(5);
    expect(lint(over)).toContain('CARDS_OVER_LIMIT');
  });

  it('영상 카드는 8장까지 통과하고 CARDS_OVER_LIMIT도 없다', () => {
    expect(videoCodes(8)).toEqual([]);
  });

  it('영상 카드 9장은 스키마가 거절한다 (attachContext 포함)', () => {
    const d = sampleDigest();
    d.reports[0]!.cards = cards(9);
    expect(parseDigest(d).ok).toBe(false);
    const root = tmp();
    const store = new DigestStore(root);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(sampleDigest());
    expect(() =>
      attachContext(root, VIDEO_SLUG, { cards: { cards: cards(9), limits: [] } }),
    ).toThrow(/맥락 파일 형식 오류/);
    expect(attachContext(root, VIDEO_SLUG, { cards: { cards: cards(8), limits: [] } }).saved).toBe(
      true,
    );
  });

  const verdictCard = () =>
    vcard(1, {
      kind: 'background',
      points: [
        { text: '맞는 말', sources: ['src'], verdict: 'correct' },
        { text: '갈리는 말', sources: ['src'], verdict: 'depends' },
        { text: '틀린 말', sources: ['src'], verdict: 'incorrect' },
        { text: '못 가린 말', sources: ['src'], verdict: 'unverifiable' },
      ],
    });

  it('verdict 배지 네 종류와 background 라벨을 HTML에 그린다', () => {
    const r = lensReport();
    r.cards = [verdictCard()];
    const html = renderDigestHtml(lensDigest(r), lensTranscript(), { source: lensSource() }).html;
    for (const [v, label] of [
      ['correct', '맞음'],
      ['depends', '기준 따라 다름'],
      ['incorrect', '다름'],
      ['unverifiable', '확인 못함'],
    ]) {
      expect(html).toContain(`<span class="ctx-verdict ctx-verdict-${v}">${label}</span>`);
    }
    expect(html).toContain('알면 좋은 배경');
  });

  it('md에 verdict 라벨이 붙는다', () => {
    const r = lensReport();
    r.cards = [verdictCard()];
    const md = renderDigestMarkdown(lensDigest(r), lensTranscript(), { source: lensSource() });
    for (const label of ['[맞음]', '[기준 따라 다름]', '[다름]', '[확인 못함]']) {
      expect(md).toContain(label);
    }
  });

  it('영상 트랜스크립트로 렌더하면 영상용 머리말이 나온다', () => {
    const d = sampleDigest();
    d.reports[0]!.cards = [vcard(1)];
    const html = renderDigestHtml(d, sampleTranscript()).html;
    expect(html).toContain('영상에서 한 말을 바깥 자료로 확인한 카드예요');
    const lensHtml = renderDigestHtml(
      (() => {
        const r = lensReport();
        r.cards = [vcard(1)];
        return lensDigest(r);
      })(),
      lensTranscript(),
      { source: lensSource() },
    ).html;
    expect(lensHtml).not.toContain('영상에서 한 말을 바깥 자료로 확인한 카드예요');
  });

  it('영상 카드는 사실 확인과 기준과 해석이라는 이름을 쓴다', () => {
    const d = sampleDigest();
    d.reports[0]!.cards = [vcard(1, { kind: 'unverified' }), vcard(2, { kind: 'interpretation' })];
    const html = renderDigestHtml(d, sampleTranscript()).html;
    expect(html).toContain('<span class="ctx-kind">사실 확인</span>');
    expect(html).toContain('<span class="ctx-kind">기준과 해석</span>');
    const md = renderDigestMarkdown(d, sampleTranscript());
    expect(md).toContain('(사실 확인)');
    expect(md).toContain('(기준과 해석)');
    const r = lensReport();
    r.cards = [vcard(1, { kind: 'unverified' })];
    const lensHtml = renderDigestHtml(lensDigest(r), lensTranscript(), {
      source: lensSource(),
    }).html;
    expect(lensHtml).toContain('<span class="ctx-kind">검증 안 된 부분</span>');
  });
});
