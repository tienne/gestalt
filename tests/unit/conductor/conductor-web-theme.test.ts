import { describe, expect, it } from 'vitest';
import { renderBrowsePage } from '../../../src/conductor-web/html.js';
import { THEME_BOOT_JS, THEME_SWITCH_JS } from '../../../src/digest/theme-color.js';
import { ORDER_STATUS_ROLE } from '../../../src/visual-system/status.js';

const NONCE = 'test-nonce';
const html = renderBrowsePage(NONCE, '/state');
const pageCss = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
// 공용 테마 CSS 뒤에 붙는 결과 웹 고유 규칙만 본다
const ownCss = pageCss.slice(pageCss.indexOf('* { box-sizing'));
const ownRoot = /\/\*[^*]*\*\/\s*:root \{[^}]*\}/.exec(pageCss)![0];

describe('컨덕터 결과 웹 테마', () => {
  it('스크립트는 전부 nonce를 달고 테마 부트가 본문보다 먼저 돈다', () => {
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((m) => m[1])).toEqual(Array(3).fill(` nonce="${NONCE}"`));
    expect(scripts[0]![2]).toBe(THEME_BOOT_JS);
    expect(scripts[2]![2]).toBe(THEME_SWITCH_JS);
    expect(html.indexOf(THEME_BOOT_JS)).toBeLessThan(html.indexOf('<body>'));
  });

  it('머리줄에 테마 선택기가 있다', () => {
    expect(html).toMatch(/<header class="top">[\s\S]*<details class="theme-pop">[\s\S]*<\/header>/);
  });

  it('결과 웹 고유 규칙에는 원색이 없고 역할 변수만 쓴다', () => {
    expect(ownRoot + ownCss).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    expect(ownRoot).not.toMatch(/--(?:bg|fg|muted|line|hl):/);
  });

  it('상태 배지는 바탕을 채우지 않고 주문 상태 표의 역할 글자색과 테두리로 구분한다', () => {
    const rules = [...ownCss.matchAll(/(\.badge[^{]*)\{([^}]*)\}/g)];
    expect(rules.length).toBe(5);
    for (const [, , body] of rules) expect(body).not.toMatch(/background/);
    for (const [status, role] of Object.entries(ORDER_STATUS_ROLE)) {
      const rule = rules.find(([, sel]) =>
        sel!.split(',').some((x) => x.trim() === `.badge.${status}`),
      );
      if (role === 'neutral') expect(rule, status).toBeUndefined();
      else expect(rule?.[2], status).toContain(`color:var(--gestalt-color-${role}-text)`);
    }
  });

  it('선택한 주문과 초점 보고는 바탕 대신 강조선으로 보인다', () => {
    expect(ownRoot).toContain('--mark:inset 3px 0 0 var(--accent)');
    expect(ownCss).toContain('.orders li a.sel { background:var(--bg); box-shadow:var(--mark); }');
    expect(ownCss).toContain(
      '.timeline > li.focus { background:var(--card); box-shadow:var(--mark); }',
    );
  });

  it('보고 요약 안의 목록에는 타임라인 점을 찍지 않는다', () => {
    expect(ownCss).not.toMatch(/\.timeline li[ :.{]/);
    expect(ownCss).toContain('.timeline > li::before');
  });

  it('좁은 화면에서는 목록과 본문을 위아래로 쌓는다', () => {
    expect(ownCss).toMatch(
      /@media \(max-width: 640px\) \{[\s\S]*\.layout \{ flex-direction:column; height:auto; \}/,
    );
  });

  it('고친 파일 목록과 도는 중 표시에 역할 클래스를 단다', () => {
    expect(html).toContain(
      "listBlock('고친 파일 (' + s.changedFiles.length + ')', s.changedFiles, 'files')",
    );
    expect(html).toContain("el('p', 'muted small live', '도는 중이라 '");
    expect(ownCss).toContain(
      '.work-lists .files li::marker { color:var(--gestalt-color-diff-changed-text); }',
    );
  });
});
