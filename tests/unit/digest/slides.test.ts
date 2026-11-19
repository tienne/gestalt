import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { mergeExtension, mergeReport } from '../../../src/digest/merge.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { renderToFiles } from '../../../src/digest/render.js';
import { readSlideContext } from '../../../src/digest/slides.js';
import { DigestStore } from '../../../src/digest/store.js';
import type { RunCommand } from '../../../src/digest/ytdlp.js';
import { ingestDigestSlides } from '../../../src/lens/digest-slides.js';
import { sampleDigest, sampleTranscript } from './fixture.js';
import { lensSource, lensTranscript } from '../lens/fixture.js';

const id = 'slides-1234567890abcdef12345678';
const videoCite = { key: 1, from: 1, to: 1 };
const pdfCite = { key: 1, from: 1, to: 1, source: id };
const deck = () => {
  const transcript = lensTranscript();
  transcript.segments[1]!.text = 'Slide target: 1.2 percent.';
  transcript.segments[1]!.page = 2;
  return { transcript, source: lensSource() };
};

const addComparison = () => {
  const digest = sampleDigest();
  const sub = digest.reports[0]!.sections[0]!.subsections[0]!;
  sub.bullets[0]!.comparison = {
    note: '발표 중 목표를 정정했다.',
    video: { cite: videoCite, quote: 'Sentence number 1.' },
    slides: { cite: pdfCite, quote: 'Slide target: 1.2 percent.' },
  };
  digest.reports[0]!.sections[0]!.subsections[1]!.bullets[0]!.cite = pdfCite;
  return digest;
};

const extension = (text: string, cite = pdfCite) => ({
  template: 'quotes',
  title: '인용',
  lang: 'ko',
  blocks: [{ type: 'quote', text, cite }],
});

const roots: string[] = [];
function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'gestalt-slides-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('발표 영상과 슬라이드 PDF', () => {
  it('번호가 같아도 각 자료에서 인용을 검증하고 한 리포트의 양쪽 출처를 그린다', async () => {
    const root = createRepo();
    const store = new DigestStore(root);
    const video = sampleTranscript();
    store.saveTranscript(video);
    const pdf = deck();
    const dir = join(store.dir(video.slug), id);
    mkdirSync(dir);
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify(pdf.transcript));
    writeFileSync(join(dir, 'source.json'), JSON.stringify(pdf.source));

    const report = addComparison().reports[0]!;
    expect(mergeReport(root, video.slug, report).saved).toBe(true);
    expect(mergeExtension(root, video.slug, extension('Slide target: 1.2 percent.')).saved).toBe(
      true,
    );
    const wrong = mergeExtension(root, video.slug, extension('Sentence number 1.'));
    expect(wrong.saved).toBe(false);
    expect(wrong.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'QUOTE_NOT_IN_SOURCE' })]),
    );
    expect(mergeExtension(root, video.slug, extension('Slide target: 12 percent.')).saved).toBe(
      false,
    );

    const r = renderToFiles(video.slug, { repoRoot: root });
    const html = readFileSync(r.htmlPath, 'utf8');
    const note = /<div class="slide-comparison"[\s\S]*?<\/div>/.exec(html)?.[0];
    expect(note).toContain('data-sec="5"');
    expect(note).toContain('data-key="1"');
    expect(note).toContain(`data-slide-source="${id}" data-slide-key="1"`);
    expect(note).toContain('Sentence number 1.');
    expect(note).toContain('Slide target: 1.2 percent.');
    expect(html).toContain(`${id}/pages/p2.jpg`);
    const md = readFileSync(r.mdPath, 'utf8');
    expect(md).toContain('영상과 슬라이드의 차이');
    expect(md).toContain('슬라이드 p.2, 문단 2');
  });

  it('슬라이드가 없거나 범위를 벗어나면 막고 기존 영상과 Lens 출처는 그대로 검증한다', () => {
    const video = sampleTranscript();
    const digest = addComparison();
    expect(lintErrors(lintDigest(digest, video))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SLIDE_SOURCE_NOT_FOUND' })]),
    );
    const first = digest.reports[0]!.sections[0]!;
    first.cite = pdfCite;
    first.subsections[1]!.bullets[0]!.cite = { source: id, key: 10, from: 10, to: 10 };
    const slides = new Map([[id, deck()]]);
    const issues = lintErrors(lintDigest(digest, video, { slides }));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SLIDE_CITE_NOT_ALLOWED',
          path: 'reports.0.sections.0.cite',
        }),
        expect.objectContaining({
          code: 'CITE_OUT_OF_RANGE',
          path: 'reports.0.sections.0.subsections.1.bullets.0.cite',
        }),
      ]),
    );
    expect(lintErrors(lintDigest(sampleDigest(), video))).toEqual([]);
    const oneSided = addComparison();
    oneSided.reports[0]!.sections[0]!.subsections[0]!.bullets[0]!.comparison!.slides.cite =
      videoCite;
    expect(lintErrors(lintDigest(oneSided, video, { slides }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'COMPARISON_SOURCES' })]),
    );
  });

  it('OCR 슬라이드의 출처 칩과 마크다운을 해당 원문 쪽에 연결한다', () => {
    const video = sampleTranscript();
    const pdf = deck();
    pdf.source.pages[1]!.textMethod = 'ocr';
    pdf.source.pages[2]!.textMethod = 'unread';
    const slides = new Map([[id, pdf]]);
    const digest = addComparison();
    expect(lintErrors(lintDigest(digest, video, { slides }))).toEqual([]);
    const { html } = renderDigestHtml(digest, video, { slides });
    expect(html).toContain('슬라이드 p.2 (OCR)');
    expect(html).toContain('글자를 읽지 못한 PDF 쪽: 3');
    const md = renderDigestMarkdown(digest, video, { slides });
    expect(md).toContain('슬라이드 p.2 (OCR), 문단 2');
    expect(md).toContain('.pdf#page=2');
  });

  it('재수집해도 이전 출처를 보존하고 PDF 수집 실패 후 영상만 렌더할 수 있다', async () => {
    const root = createRepo();
    const store = new DigestStore(root);
    const t = sampleTranscript();
    store.saveTranscript(t);
    const pdf = join(root, 'slides.pdf');
    writeFileSync(pdf, '%PDF-1.7\nsample');
    const run: RunCommand = async () => ({
      stdout: JSON.stringify({
        title: 'Slides',
        pageCount: 1,
        pages: [],
        units: [{ i: 0, page: 1, role: 'para', text: 'Target 12%.', rects: [] }],
        tables: [],
        figures: [],
      }),
      stderr: '',
    });
    const opts = { repoRoot: root, run };
    const first = await ingestDigestSlides(pdf, t.slug, opts);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw Error(first.error);
    expect(await ingestDigestSlides(pdf, t.slug, opts)).toEqual(first);
    writeFileSync(pdf, '%PDF-1.7\nrevised');
    const second = await ingestDigestSlides(pdf, t.slug, opts);
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw Error(second.error);
    expect(second.source).not.toBe(first.source);
    const failed = await ingestDigestSlides(join(root, 'missing.pdf'), t.slug, opts);
    expect(failed.status).toBe('failed');
    const context = readSlideContext(store, t.slug);
    expect([...context.slides.keys()]).toEqual(
      expect.arrayContaining([first.source, second.source]),
    );
    expect(context.slidesFailed).toBe(true);
    store.saveDigest(sampleDigest());
    const r = renderToFiles(t.slug, { repoRoot: root });
    expect(readFileSync(r.htmlPath, 'utf8')).toContain('슬라이드 PDF를 수집하지 못했어요.');
    expect(readFileSync(r.htmlPath, 'utf8')).not.toContain('class="slide-cite"');
  });
});
