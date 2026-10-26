import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findReport,
  initialReportIndex,
  isPreset,
  pairIndex,
  lintDigest,
  lintErrors,
  mergeReport,
  rangeSpan,
  reportKey,
  reportLabel,
  upsertReport,
  type DigestIssue,
  type Report,
} from '../../../src/digest/index.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { exportMarkdown } from '../../../src/digest/render.js';
import { DIGEST_SCHEMA_VERSION, reportOptionsSchema } from '../../../src/digest/schema.js';
import { DigestStore } from '../../../src/digest/store.js';
import { VIEWER_JS } from '../../../src/digest/viewer-js.js';
import { viewerLogic } from '../../../src/digest/viewer-logic.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const codes = (issues: DigestIssue[]) => issues.map((i) => i.code);

function variant(options: Partial<Report['options']>): Report {
  const base = structuredClone(sampleDigest().reports[0]!);
  return { ...base, options: { ...base.options, ...options } };
}

/** 30초부터 끝까지, 두 번째 대섹션만 덮는 구간 리포트 */
function rangeReport(): Report {
  const base = structuredClone(sampleDigest().reports[0]!);
  return {
    ...base,
    options: { ...base.options, range: [30, 60] },
    sections: [base.sections[1]!],
    keywords: [],
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seeded() {
  const repo = resolve('.gestalt-test', `digest-reports-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  const store = new DigestStore(repo);
  store.saveTranscript(sampleTranscript());
  store.saveDigest(sampleDigest());
  return { repo, store };
}

describe('reportKey', () => {
  it('분량, 난이도, 언어로 키를 만든다', () => {
    expect(reportKey({ length: 'short', difficulty: 'easy', lang: 'ko' })).toBe('short-easy-ko');
  });

  it('구간은 초를 붙이고 프롬프트는 해시 앞 8자만 붙인다', () => {
    const key = reportKey({
      length: 'default',
      difficulty: 'normal',
      lang: 'en',
      range: [30, 90],
      prompt: '실무 팁 위주로',
    });
    expect(key).toMatch(/^default-normal-en-r30-90-p[0-9a-f]{8}$/);
  });

  it('프롬프트가 다르면 키도 다르다', () => {
    const a = reportKey({ length: 'default', difficulty: 'normal', lang: 'ko', prompt: 'A' });
    const b = reportKey({ length: 'default', difficulty: 'normal', lang: 'ko', prompt: 'B' });
    expect(a).not.toBe(b);
  });

  it('키 경계를 흐리는 언어 태그와 소수 구간은 스키마가 거절한다', () => {
    const prompt = 'x';
    const hash = reportKey({ length: 'short', difficulty: 'normal', lang: 'en', prompt });
    const fakeLang = `en-${hash.split('-').at(-1)!}`;
    expect(reportOptionsSchema.safeParse({ lang: fakeLang }).success).toBe(false);
    expect(reportOptionsSchema.safeParse({ lang: 'en-r30-40' }).success).toBe(false);
    expect(reportOptionsSchema.safeParse({ lang: 'en-R30-40' }).success).toBe(false);
    expect(reportOptionsSchema.safeParse({ lang: 'pt-BR' }).success).toBe(true);
    expect(reportOptionsSchema.safeParse({ range: [90.2, 100] }).success).toBe(false);
  });

  it('p나 r로 시작하는 지역 하위 태그는 받는다', () => {
    for (const lang of ['es-PA', 'es-PE', 'fr-PF', 'en-r30']) {
      expect(reportOptionsSchema.safeParse({ lang }).success).toBe(true);
    }
  });
});

describe('rangeSpan', () => {
  it('시작 시각이 [시작, 끝)에 드는 문장 번호를 준다', () => {
    expect(rangeSpan([30, 60], sampleTranscript().segments)).toEqual({ from: 6, to: 11 });
    expect(rangeSpan([10, 20], sampleTranscript().segments)).toEqual({ from: 2, to: 3 });
  });

  it('드는 문장이 없으면 null', () => {
    expect(rangeSpan([61, 90], sampleTranscript().segments)).toBeNull();
  });
});

describe('isPreset과 reportLabel', () => {
  const base = { length: 'default', difficulty: 'normal', lang: 'ko' } as const;

  it('구간이나 프롬프트가 있거나 언어가 다르면 툴바 리포트가 아니다', () => {
    expect(isPreset({ ...base, length: 'short' }, base)).toBe(true);
    expect(isPreset({ ...base, range: [0, 10] }, base)).toBe(false);
    expect(isPreset({ ...base, prompt: 'x' }, base)).toBe(false);
    expect(isPreset({ ...base, lang: 'en' }, base)).toBe(false);
  });

  it('라벨에 분량과 난이도, 구간, 언어, 요청 여부를 적는다', () => {
    expect(reportLabel({ ...base, range: [180, 300], prompt: 'x' })).toBe(
      '기본, 보통 / 03:00~05:00 / ko / 요청 반영',
    );
  });
});

describe('upsertReport와 findReport', () => {
  it('같은 키면 그 자리에 바꿔 끼우고 다르면 뒤에 붙인다', () => {
    const d = sampleDigest();
    const short = variant({ length: 'short' });
    const added = upsertReport(d, short);
    expect(added.replaced).toBe(false);
    expect(added.digest.reports).toHaveLength(2);

    const again = variant({ length: 'short' });
    again.lead.answer = '바뀐 답.';
    const replaced = upsertReport(added.digest, again);
    expect(replaced.replaced).toBe(true);
    expect(replaced.digest.reports).toHaveLength(2);
    expect(findReport(replaced.digest, 'short-normal-ko')!.lead.answer).toBe('바뀐 답.');
    expect(d.reports).toHaveLength(1);
  });
});

describe('lintDigest 리포트 여럿', () => {
  it('키가 겹치는 리포트는 오류', () => {
    const d = sampleDigest();
    d.reports.push(structuredClone(d.reports[0]!));
    const issues = lintErrors(lintDigest(d, sampleTranscript()));
    expect(codes(issues)).toEqual(['DUPLICATE_REPORT']);
    expect(issues[0]!.path).toBe('reports.1.options');
  });

  it('구간 리포트는 그 구간만 덮으면 통과한다', () => {
    const d = sampleDigest();
    d.reports.push(rangeReport());
    expect(lintErrors(lintDigest(d, sampleTranscript()))).toEqual([]);
  });

  it('구간 밖을 인용한 대섹션은 오류', () => {
    const d = sampleDigest();
    const r = rangeReport();
    r.options.range = [40, 60];
    d.reports.push(r);
    const issues = lintErrors(lintDigest(d, sampleTranscript()));
    expect(codes(issues)).toContain('OUT_OF_REPORT_RANGE');
    expect(issues.find((i) => i.code === 'OUT_OF_REPORT_RANGE')!.path).toBe(
      'reports.1.sections.0.cite',
    );
  });

  it('구간에 든 문장이 없으면 오류', () => {
    const d = sampleDigest();
    const r = rangeReport();
    r.options.range = [100, 200];
    d.reports.push(r);
    expect(codes(lintErrors(lintDigest(d, sampleTranscript())))).toContain('RANGE_EMPTY');
  });

  it('짧게는 대섹션마다 소섹션 1~2개를 받는다', () => {
    const d = sampleDigest();
    const short = variant({ length: 'short' });
    for (const s of short.sections) s.subsections = [s.subsections[0]!];
    for (const s of short.sections) s.subsections[0]!.cite = { ...s.cite };
    d.reports.push(short);
    const issues = lintDigest(d, sampleTranscript()).filter((i) => i.path.startsWith('reports.1'));
    expect(codes(issues)).not.toContain('SUBSECTION_COUNT');
  });
});

describe('mergeReport', () => {
  it('새 리포트를 붙여 저장하고 키를 알려준다', () => {
    const { repo, store } = seeded();
    const r = mergeReport(repo, SLUG, variant({ difficulty: 'easy' }));
    expect(r).toMatchObject({ key: 'default-easy-ko', index: 1, replaced: false, saved: true });
    expect(store.loadDigest(SLUG)!.reports.map((x) => reportKey(x.options))).toEqual([
      'default-normal-ko',
      'default-easy-ko',
    ]);
    expect(store.loadDigest(SLUG)!.schemaVersion).toBe(DIGEST_SCHEMA_VERSION);
  });

  it('합친 결과에 lint 오류가 있으면 저장하지 않는다', () => {
    const { repo, store } = seeded();
    const bad = variant({ difficulty: 'easy' });
    bad.sections[0]!.cite = { key: 50, from: 50, to: 50 };
    const r = mergeReport(repo, SLUG, bad);
    expect(r.saved).toBe(false);
    expect(store.loadDigest(SLUG)!.reports).toHaveLength(1);
  });

  it('같은 키면 그 자리에 바꿔 끼우고 순서를 유지한다', () => {
    const { repo, store } = seeded();
    mergeReport(repo, SLUG, variant({ difficulty: 'easy' }));
    const next = variant({});
    next.lead.takeaway = '바꾼 결론';
    const r = mergeReport(repo, SLUG, next);
    expect(r).toMatchObject({ key: 'default-normal-ko', index: 0, replaced: true, saved: true });
    const reports = store.loadDigest(SLUG)!.reports;
    expect(reports.map((x) => reportKey(x.options))).toEqual([
      'default-normal-ko',
      'default-easy-ko',
    ]);
    expect(reports[0]!.lead.takeaway).toBe('바꾼 결론');
  });

  it('1.0.0 digest.json을 읽어 1.1.0 reports로 저장한다', () => {
    const { repo, store } = seeded();
    const { reports, ...rest } = sampleDigest();
    writeFileSync(
      store.digestPath(SLUG),
      JSON.stringify({ ...rest, schemaVersion: '1.0.0', report: reports[0] }),
    );
    const r = mergeReport(repo, SLUG, variant({ length: 'short' }));
    expect(r).toMatchObject({ index: 1, saved: true });
    const saved = JSON.parse(readFileSync(store.digestPath(SLUG), 'utf-8'));
    expect(saved.schemaVersion).toBe(DIGEST_SCHEMA_VERSION);
    expect(saved.report).toBeUndefined();
    expect(saved.reports).toHaveLength(2);
  });

  it('기존 리포트에 lint 오류가 있으면 새 리포트가 멀쩡해도 저장하지 않는다', () => {
    const { repo, store } = seeded();
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.cite = { key: 50, from: 50, to: 50 };
    writeFileSync(store.digestPath(SLUG), JSON.stringify(d));
    const before = readFileSync(store.digestPath(SLUG), 'utf-8');
    const r = mergeReport(repo, SLUG, variant({ difficulty: 'easy' }));
    expect(r.saved).toBe(false);
    expect(r.issues.some((i) => i.path.startsWith('reports.0'))).toBe(true);
    expect(readFileSync(store.digestPath(SLUG), 'utf-8')).toBe(before);
  });

  it('digest.json이 깨졌으면 덮어쓰지 않고 던진다', () => {
    const { repo, store } = seeded();
    writeFileSync(store.digestPath(SLUG), '{ not json');
    expect(() => mergeReport(repo, SLUG, variant({}))).toThrow();
    expect(readFileSync(store.digestPath(SLUG), 'utf-8')).toBe('{ not json');
    writeFileSync(store.digestPath(SLUG), JSON.stringify({ slug: SLUG, reports: [] }));
    expect(() => mergeReport(repo, SLUG, variant({}))).toThrow();
  });

  it('digest.json이 없으면 그 리포트 한 벌로 만든다', () => {
    const { repo, store } = seeded();
    rmSync(store.digestPath(SLUG));
    const r = mergeReport(repo, SLUG, variant({}));
    expect(r.saved).toBe(true);
    expect(store.loadDigest(SLUG)!.reports).toHaveLength(1);
  });

  it('리포트 형식이 틀리면 던진다', () => {
    const { repo } = seeded();
    expect(() => mergeReport(repo, SLUG, { lead: {} })).toThrow('리포트 형식 오류');
  });
});

describe('리포트 여럿 렌더', () => {
  function multi() {
    const d = sampleDigest();
    d.reports.push(variant({ length: 'short' }), rangeReport());
    return d;
  }

  it('툴바는 쉽게 보기 토글 하나만 두고 분량과 난이도 버튼은 그리지 않는다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toContain('class="report-bar"');
    expect(html).toMatch(/id="easy-toggle"[^>]*aria-pressed="false"[^>]*>쉽게 보기</);
    expect(html).not.toContain('data-length=');
    expect(html).not.toContain('data-difficulty=');
    expect(html).not.toContain('난이도');
    expect(html).toContain('id="report-missing"');
    expect(html).toContain(
      '<p id="report-status" class="sr-only" role="status" aria-live="polite"></p>',
    );
    expect(html).not.toMatch(/id="report-missing"[^>]*role="status"/);
  });

  it('리포트마다 쉽게 보기 짝과 구간을 뷰어 데이터로 싣는다', () => {
    const d = multi();
    d.reports.push({ ...rangeReport(), options: { ...rangeReport().options, difficulty: 'easy' } });
    const { html } = renderDigestHtml(d, sampleTranscript());
    const data = JSON.parse(
      html.match(/<script type="application\/json" id="digest-data">([^<]*)</)![1]!,
    ) as {
      reports: { pair: number; range: [number, number] | null; prompted: boolean }[];
    };
    expect(data.reports.map((r) => r.pair)).toEqual([-1, -1, 3, 2]);
    expect(data.reports[2]!.range).toEqual([30, 60]);
    expect(data.reports.every((r) => r.prompted === false)).toBe(true);
  });

  it('처음 보이는 리포트가 쉬운 리포트면 토글이 눌린 상태다', () => {
    const d = sampleDigest();
    d.reports[0] = variant({ length: 'long', difficulty: 'easy' });
    const { html } = renderDigestHtml(d, sampleTranscript());
    expect(html).toMatch(/id="easy-toggle"[^>]*aria-pressed="true"/);
  });

  it('구간 리포트는 따로 고르는 목록에 들어가고 첫 리포트 말고는 숨긴다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toContain('id="report-select"');
    expect(html).toContain('00:30~01:00');
    expect(html).toMatch(/<div class="report" data-ri="0"(?![^>]*hidden)/);
    expect(html).toMatch(/<div class="report" data-ri="1"[^>]*hidden/);
  });

  it('숨긴 리포트의 미니맵은 display:flex에 가리지 않고 숨는다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toMatch(/<nav class="minimap"[^>]*data-ri="1"[^>]*hidden/);
    expect(html).toContain('.minimap[hidden]{display:none}');
  });

  it('리포트 여럿이 같은 프레임을 다시 실어도 인라인 합계는 15MB를 안 넘는다', () => {
    const { html, warnings } = renderDigestHtml(multi(), sampleTranscript(), {
      inlineFrames: true,
      loadFrame: () => Buffer.alloc(3 * 1024 * 1024),
    });
    const uris = html.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g) ?? [];
    const bytes = uris.reduce((n, u) => n + Buffer.from(u.split(',')[1]!, 'base64').length, 0);
    expect(bytes).toBeLessThanOrEqual(15 * 1024 * 1024);
    expect(warnings.some((w) => w.includes('합계가 15MB'))).toBe(true);
  });

  it('지금 보는 리포트의 언어를 뷰어 데이터에 싣는다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toMatch(/"lang":"ko"/);
  });

  it('두 번째 리포트부터 섹션 id에 접두를 붙여 첫 리포트 앵커와 안 겹친다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toContain('id="sec-s1"');
    expect(html).toContain('id="sec-r1~s1"');
    expect(html).toContain('id="sec-r2~s2"');
  });

  it('구간 없는 리포트 하나면 목록을 안 만든다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).not.toContain('id="report-select"');
  });

  it('마크다운은 리포트가 여럿이면 어느 리포트인지 머리에 적는다', () => {
    const d = multi();
    const md = renderDigestMarkdown(d, sampleTranscript(), { report: d.reports[2]! });
    expect(md).toContain('> 리포트: 기본, 보통 / 00:30~01:00 / ko');
  });

  it('export --report는 첫 리포트가 아니면 digest.<키>.md에 쓴다', () => {
    const { repo, store } = seeded();
    store.saveDigest(multi());
    const r = exportMarkdown(SLUG, { repoRoot: repo, report: 'short-normal-ko' });
    expect(r.mdPath).toBe(join(store.dir(SLUG), 'digest.short-normal-ko.md'));
    expect(existsSync(r.mdPath)).toBe(true);
    expect(readFileSync(r.mdPath, 'utf-8')).toContain('> 리포트: 짧게, 보통 / ko');
    expect(() => exportMarkdown(SLUG, { repoRoot: repo, report: 'long-easy-ko' })).toThrow(
      '리포트 long-easy-ko가 없어요',
    );
  });
});

describe('viewerLogic 리포트 전환', () => {
  const reports = [
    { preset: true, length: 'default', difficulty: 'normal' },
    { preset: false, length: 'short', difficulty: 'normal' },
    { preset: true, length: 'short', difficulty: 'normal' },
  ];

  it('툴바 조합에 맞는 첫 프리셋 리포트를 고른다', () => {
    expect(viewerLogic.pickReport(reports, 'short', 'normal')).toBe(2);
    expect(viewerLogic.pickReport(reports, 'default', 'normal')).toBe(0);
  });

  it('없는 조합이면 -1이고 생성 명령에는 분량을 싣지 않는다', () => {
    expect(viewerLogic.pickReport(reports, 'long', 'easy')).toBe(-1);
    expect(viewerLogic.reportCommand('figma-x', 'easy')).toBe(
      '/gestalt:video-digest slug=figma-x difficulty=easy',
    );
  });

  it('구간 리포트면 생성 명령에 구간을 초 단위로 싣는다', () => {
    expect(viewerLogic.reportCommand('figma-x', 'easy', 'ko', [30, 60.4])).toBe(
      '/gestalt:video-digest slug=figma-x difficulty=easy range=30-61 reportLang=ko',
    );
  });

  it('지금 보는 리포트의 언어를 생성 명령에 싣는다', () => {
    expect(viewerLogic.reportCommand('figma-x', 'normal', 'en')).toBe(
      '/gestalt:video-digest slug=figma-x difficulty=normal reportLang=en',
    );
  });
});

describe('pairIndex', () => {
  it('난이도만 반대인 리포트를 짝으로 찾는다', () => {
    const reports = [variant({}), variant({ difficulty: 'easy' }), variant({ lang: 'en' })];
    expect(pairIndex(reports, 0)).toBe(1);
    expect(pairIndex(reports, 1)).toBe(0);
    expect(pairIndex(reports, 2)).toBe(-1);
  });

  it('구간이나 요청이 다르면 짝이 아니다', () => {
    const easyRange = {
      ...rangeReport(),
      options: { ...rangeReport().options, difficulty: 'easy' as const },
    };
    const prompted = variant({ difficulty: 'easy', prompt: '디자인 얘기만' });
    expect(pairIndex([variant({}), easyRange, prompted], 0)).toBe(-1);
    expect(pairIndex([rangeReport(), variant({ difficulty: 'easy' }), easyRange], 0)).toBe(2);
  });

  it('없는 자리면 -1이다', () => {
    expect(pairIndex([], 0)).toBe(-1);
  });
});

describe('initialReportIndex', () => {
  it('long+normal이 있으면 그 자리를 돌려준다', () => {
    const reports = [variant({}), variant({ length: 'long' })];
    expect(initialReportIndex(reports)).toBe(1);
  });

  it('long+normal이 없으면 첫 리포트', () => {
    expect(initialReportIndex([variant({}), variant({ length: 'short' })])).toBe(0);
    expect(initialReportIndex([variant({}), variant({ length: 'long', difficulty: 'easy' })])).toBe(
      0,
    );
  });

  it('언어가 다르거나 range, prompt가 붙은 long+normal은 무시한다', () => {
    const reports = [
      variant({}),
      variant({ length: 'long', lang: 'en' }),
      variant({ length: 'long', range: [30, 60] }),
      variant({ length: 'long', prompt: 'x' }),
    ];
    expect(initialReportIndex(reports)).toBe(0);
  });

  it('빈 배열이면 0', () => {
    expect(initialReportIndex([])).toBe(0);
  });

  it('첫 리포트가 long+normal이면 0', () => {
    expect(initialReportIndex([variant({ length: 'long' }), variant({ length: 'long' })])).toBe(0);
  });
});

describe('초기 리포트 렌더', () => {
  const withLong = () => {
    const d = sampleDigest();
    d.reports.push(variant({ length: 'long' }));
    return d;
  };
  const dataOf = (html: string) =>
    JSON.parse(
      /<script type="application\/json" id="digest-data">([\s\S]*?)<\/script>/.exec(html)![1]!,
    );

  it('long+normal이 뒤에 있으면 그 리포트와 미니맵만 보이고 쉽게 보기는 꺼져 있다', () => {
    const { html } = renderDigestHtml(withLong(), sampleTranscript());
    expect(html).toMatch(/<div class="report" data-ri="1"(?![^>]*hidden)/);
    expect(html).toMatch(/<div class="report" data-ri="0"[^>]*hidden/);
    expect(html).toMatch(/<nav class="minimap"[^>]*data-ri="1"(?![^>]*hidden)/);
    expect(html).toMatch(/<nav class="minimap"[^>]*data-ri="0"[^>]*hidden/);
    expect(html).toMatch(/id="easy-toggle"[^>]*aria-pressed="false"/);
    expect(dataOf(html).initial).toBe(1);
  });

  it('long+normal이 없으면 data.initial은 0이고 첫 리포트가 보인다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(dataOf(html).initial).toBe(0);
    expect(html).toMatch(/<div class="report" data-ri="0"(?![^>]*hidden)/);
  });

  it('옛 짧게와 기본 리포트는 다른 리포트 목록으로 간다', () => {
    const d = withLong();
    d.reports.push(variant({ length: 'short' }));
    const { html } = renderDigestHtml(d, sampleTranscript());
    const select = /<select id="report-select">([\s\S]*?)<\/select>/.exec(html)![1]!;
    expect(select).toContain('짧게, 보통');
    expect(select).toContain('기본, 보통');
  });

  it('길게 리포트만 있으면 다른 리포트 목록을 그리지 않는다', () => {
    const d = sampleDigest();
    d.reports[0] = variant({ length: 'long' });
    d.reports.push(variant({ length: 'long', difficulty: 'easy' }));
    const { html } = renderDigestHtml(d, sampleTranscript());
    expect(html).not.toContain('id="report-select"');
  });

  it('다른 리포트 select는 초기 리포트 option에 selected를 단다', () => {
    const d = withLong();
    d.reports.push(rangeReport());
    const { html } = renderDigestHtml(d, sampleTranscript());
    expect(html).toMatch(/<option value="1"[^>]*selected/);
    expect(html).not.toMatch(/<option value="0"[^>]*selected/);
  });

  it('뷰어 스크립트가 data.initial을 읽는다', () => {
    expect(VIEWER_JS).toContain('data.initial');
  });
});
