import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findReport,
  isPreset,
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
import { DigestStore } from '../../../src/digest/store.js';
import { viewerLogic } from '../../../src/digest/viewer-js.js';
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

  it('구간은 초를 내려 붙이고 프롬프트는 해시 앞 8자만 붙인다', () => {
    const key = reportKey({
      length: 'default',
      difficulty: 'normal',
      lang: 'en',
      range: [30.7, 90.2],
      prompt: '실무 팁 위주로',
    });
    expect(key).toMatch(/^default-normal-en-r30-90-p[0-9a-f]{8}$/);
  });

  it('프롬프트가 다르면 키도 다르다', () => {
    const a = reportKey({ length: 'default', difficulty: 'normal', lang: 'ko', prompt: 'A' });
    const b = reportKey({ length: 'default', difficulty: 'normal', lang: 'ko', prompt: 'B' });
    expect(a).not.toBe(b);
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
    expect(store.loadDigest(SLUG)!.schemaVersion).toBe('1.1.0');
  });

  it('합친 결과에 lint 오류가 있으면 저장하지 않는다', () => {
    const { repo, store } = seeded();
    const bad = variant({ difficulty: 'easy' });
    bad.sections[0]!.cite = { key: 50, from: 50, to: 50 };
    const r = mergeReport(repo, SLUG, bad);
    expect(r.saved).toBe(false);
    expect(store.loadDigest(SLUG)!.reports).toHaveLength(1);
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

  it('툴바는 분량과 난이도 버튼을 두고 첫 리포트 조합을 눌린 상태로 둔다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toContain('class="report-bar"');
    expect(html).toMatch(/data-length="default"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-length="short"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/data-difficulty="easy"[^>]*aria-pressed="false"/);
    expect(html).toContain('id="report-missing"');
  });

  it('구간 리포트는 따로 고르는 목록에 들어가고 첫 리포트 말고는 숨긴다', () => {
    const { html } = renderDigestHtml(multi(), sampleTranscript());
    expect(html).toContain('id="report-select"');
    expect(html).toContain('00:30~01:00');
    expect(html).toMatch(/<div class="report" data-ri="0"(?![^>]*hidden)/);
    expect(html).toMatch(/<div class="report" data-ri="1"[^>]*hidden/);
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

  it('없는 조합이면 -1이고 생성 명령을 만든다', () => {
    expect(viewerLogic.pickReport(reports, 'long', 'easy')).toBe(-1);
    expect(viewerLogic.reportCommand('figma-x', 'long', 'easy')).toBe(
      '/gestalt:video-digest slug=figma-x length=long difficulty=easy',
    );
  });
});
