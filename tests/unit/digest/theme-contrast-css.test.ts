import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderPrdHtml } from '../../../src/digest/render-prd.js';
import { renderResearchHtml } from '../../../src/research/render-html.js';
import { parseResearch } from '../../../src/research/schema.js';
import { lensDigest, lensSource, lensTranscript } from '../lens/fixture.js';
import { sampleDigest, sampleTranscript } from './fixture.js';
import { sampleV2 } from './prd-fixture.js';
import { sampleResearch } from '../research/fixture.js';

function prdHtml(): string {
  const { view, source } = sampleV2();
  return renderPrdHtml(view, {
    sourceSha256: source.sha256,
    coverage: lintPrdView(view, source).coverage,
  });
}

function researchHtml(): string {
  const parsed = parseResearch(sampleResearch());
  if (!parsed.ok) throw new Error(parsed.error.message);
  const r = renderResearchHtml(parsed.value, { audience: 'private', loadImage: () => null });
  if (!r.ok) throw new Error(r.message);
  return r.html;
}

function cssRules(html: string): string[] {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join('');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => `${m[1]!.trim()}{${m[2]!}}`);
}

// Gestalt 색 역할은 강조 글자를 background와 surface 위에서만 4.5:1로 맞춘다.
// --chip(다이어리에선 글자색을 섞은 표면)과 --hl 위에 강조 글자를 올리면 테마에 따라 기준 밑으로 떨어진다.
const UNSAFE = /background:var\(--(?:chip|hl)\)/;
const ACCENT_TEXT = /(?:^|[;{])color:var\(--accent\)/;

describe('테마 바탕과 강조 글자 짝', () => {
  const pages = {
    digest: renderDigestHtml(sampleDigest(), sampleTranscript()).html,
    lens: renderDigestHtml(lensDigest(), lensTranscript(), { source: lensSource() }).html,
    prd: prdHtml(),
    research: researchHtml(),
  };

  for (const [name, html] of Object.entries(pages)) {
    it(`${name}: --chip이나 --hl 바탕 규칙에 강조 글자색을 같이 두지 않는다`, () => {
      const rules = cssRules(html);
      // 바탕과 글자색이 다른 규칙에 나뉘어 있어도 잡으려고 선택자의 마지막 요소끼리 맞춰 본다
      const last = (r: string) =>
        r
          .slice(0, r.indexOf('{'))
          .split(',')
          .map((s) => s.trim().split(/\s+/).pop()!);
      const accentTargets = new Set(rules.filter((r) => ACCENT_TEXT.test(r)).flatMap(last));
      const bad = rules.filter(
        (r) =>
          UNSAFE.test(r) &&
          (ACCENT_TEXT.test(r) ||
            (!/(?:^|[;{])color:/.test(r) && last(r).some((s) => accentTargets.has(s)))),
      );
      expect(bad).toEqual([]);
    });
  }

  it('재생 중인 스크립트 줄의 시간 링크는 본문 글자색을 쓴다', () => {
    expect(pages.digest).toContain('#script-list li.is-playing .ts{color:var(--fg)}');
  });
});
