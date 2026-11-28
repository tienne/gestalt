import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCss, renderTokenCss } from '../../../src/architecture/html-theme.js';
import { BUILTIN_PACKS, vocabularyOf } from '../../../src/architecture/packs/index.js';
import { BACKGROUND_IDS, chroma, resolveTokens } from './role-tokens.js';

const SRC = join(__dirname, '../../../src/architecture');
const LAYOUT = renderCss(vocabularyOf(BUILTIN_PACKS.map((p) => p.id)));
const DEFAULTS = BACKGROUND_IDS.map((b) => resolveTokens(b, 'orange-red'));

function ruleBody(selector: string): string {
  const at = LAYOUT.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`규칙 없음: ${selector}`);
  return LAYOUT.slice(at, LAYOUT.indexOf('}', at));
}

/** 소스 파일에서 var(token)을 쓰는 규칙의 선택자를 모은다 */
function selectorsUsing(src: string, token: string): string[] {
  const out: string[] = [];
  const needle = `var(${token})`;
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    const open = src.lastIndexOf('{', i);
    const from = Math.max(src.lastIndexOf('}', open), src.lastIndexOf('`', open));
    out.push(src.slice(from + 1, open).trim());
  }
  return out;
}

const CSS_SOURCES = ['html-theme.ts', 'delta-renderer.ts', 'live-client.ts'].map((f) =>
  readFileSync(join(SRC, f), 'utf8'),
);

describe('무채색 바탕', () => {
  const SURFACE_TOKENS = [
    '--bg',
    '--surface',
    '--surface-2',
    '--card',
    '--border',
    '--border-strong',
  ];

  it.each(SURFACE_TOKENS)('배경 여섯 개 모두 %s는 R=G=B 회색이다', (name) => {
    for (const t of DEFAULTS) expect(chroma(t.get(name)), t.id).toBe(0);
  });

  it('바탕과 면, 선은 Gestalt 색 역할을 읽는다', () => {
    const t = DEFAULTS[0]!;
    expect(t.raw('--bg')).toBe('var(--gestalt-color-background)');
    expect(t.raw('--surface')).toBe('var(--gestalt-color-surface)');
    expect(t.raw('--card')).toBe('var(--gestalt-color-surface)');
    expect(t.raw('--border')).toBe('var(--gestalt-color-border)');
  });
});

describe('글자 4단계', () => {
  const LEVELS = ['--text', '--text-2', '--text-3', '--text-4'];

  it('배경 여섯 개 모두 네 단계가 무채색이고 바탕에서 멀수록 앞 단계다', () => {
    for (const t of DEFAULTS) {
      const bg = t.get('--bg')[0];
      const dist = LEVELS.map((n) => {
        expect(chroma(t.get(n)), `${t.id} ${n}`).toBe(0);
        return Math.abs(t.get(n)[0] - bg);
      });
      expect(
        [...dist].sort((a, b) => b - a),
        t.id,
      ).toEqual(dist);
    }
  });

  it('본문과 보조 글자는 text와 text-muted 역할이다', () => {
    const t = DEFAULTS[0]!;
    expect(t.raw('--text')).toBe('var(--gestalt-color-text)');
    expect(t.raw('--text-3')).toBe('var(--gestalt-color-text-muted)');
  });

  it('--muted 토큰은 구조도 CSS 어디서도 읽지 않는다', () => {
    for (const src of CSS_SOURCES) expect(src).not.toContain('var(--muted)');
  });

  it('--text-4는 비활성 질문에만 쓴다', () => {
    const used = CSS_SOURCES.flatMap((src) => selectorsUsing(src, '--text-4'));
    expect(used.sort()).toEqual(['.q:disabled .q-subj']);
  });
});

describe('고른 강조색', () => {
  it('--accent는 강조 글자 역할이고 채움은 강조 채움 역할이다', () => {
    const t = DEFAULTS[0]!;
    expect(t.raw('--accent')).toBe('var(--gestalt-color-accent-text)');
    expect(t.raw('--accent-fill')).toBe('var(--gestalt-color-accent-fill)');
    expect(t.raw('--on-accent')).toBe('var(--gestalt-color-on-accent)');
  });

  it('카드 테두리 묶음은 무채색이고 이 단계 카드 테두리만 강조색이다', () => {
    for (const t of DEFAULTS) expect(chroma(t.get('--frame-line')), t.id).toBe(0);
    expect(ruleBody('.node.is-focus')).toContain('border-color: var(--accent)');
  });

  it('의미 색은 남는다', () => {
    for (const t of DEFAULTS)
      for (const name of ['--x-account', '--loads', '--warn'])
        expect(chroma(t.get(name)), `${t.id} ${name}`).toBeGreaterThan(60);
  });

  it('본문 안 링크는 색 대신 밑줄로 구분한다', () => {
    expect(ruleBody('a.loc')).toContain('text-decoration: underline');
  });
});

describe('회색 선, 고른 선만 강조', () => {
  it('기본 선은 무채색에 불투명도 .5 안팎이다', () => {
    for (const t of DEFAULTS) expect(chroma(t.get('--edge')), t.id).toBe(0);
    const alpha = Number(DEFAULTS[0]!.raw('--edge-alpha'));
    expect(alpha).toBeGreaterThanOrEqual(0.4);
    expect(alpha).toBeLessThanOrEqual(0.6);
  });

  it('기본 선 규칙은 --edge와 --edge-alpha를 읽는다', () => {
    const body = ruleBody('.link .edge');
    expect(body).toContain('stroke: var(--edge)');
    expect(body).toContain('stroke-opacity: var(--edge-alpha)');
  });

  it('로드 선은 기본에 회색으로 물리고 점 패턴은 남긴다', () => {
    const body = ruleBody('.link.e-loads .edge');
    expect(body).toContain('stroke: var(--edge)');
    expect(Number(/stroke-opacity: ([\d.]+)/.exec(body)?.[1])).toBeLessThanOrEqual(0.5);
    expect(LAYOUT).toContain(
      '.link.e-loads .edge:not([stroke-dasharray]) { stroke-dasharray: 1 6;',
    );
  });

  it('고르거나 올린 로드 선과 계정 넘는 선은 의미 색으로 뜨고 일반 강조보다 뒤에 온다', () => {
    const generic = LAYOUT.indexOf('\n.link.lit .edge, .link:hover .edge {');
    const loads = LAYOUT.indexOf(
      '\n.link.e-loads.lit .edge, .link.e-loads:hover .edge { stroke: var(--loads);',
    );
    const cross = LAYOUT.indexOf(
      '\n.link.x-account.lit .edge, .link.x-account:hover .edge { stroke: var(--x-account);',
    );
    expect(generic).toBeGreaterThan(0);
    expect(loads).toBeGreaterThan(generic);
    expect(cross).toBeGreaterThan(generic);
  });
});

describe('점 격자', () => {
  it('캔버스에 24px 간격 점 격자를 토큰 색으로 깐다', () => {
    expect(LAYOUT).toMatch(
      /\n\.stage \{ background-image: radial-gradient\(circle, var\(--grid-dot\) [^)]+\); background-size: 24px 24px; \}/,
    );
    for (const t of DEFAULTS) expect(chroma(t.get('--grid-dot')), t.id).toBeLessThanOrEqual(5);
  });

  it('인쇄에서는 격자를 끈다', () => {
    expect(LAYOUT).toContain('@media print { .stage { background-image: none; } }');
  });
});

describe('원 안 숫자', () => {
  it('덩어리 순서 숫자는 flex 가운데 정렬을 기본으로 두고 text-box를 아는 브라우저에서만 대문자 높이로 자른다', () => {
    const src = CSS_SOURCES[0]!;
    const at = src.indexOf('\n.ch-head .ord {');
    expect(at).toBeGreaterThan(0);
    const base = src.slice(at, src.indexOf('}', at));
    expect(base).toContain('display: inline-flex');
    expect(base).toContain('align-items: center');
    expect(base).not.toContain('text-box');
    const sup = src.indexOf('@supports (text-box: trim-both cap alphabetic) {', at);
    expect(sup).toBeGreaterThan(at);
    const trim = src.slice(sup, src.indexOf('}', sup));
    expect(trim).toContain('.ch-head .ord');
    expect(trim).toContain('text-box: trim-both cap alphabetic');
    expect(trim).toContain('padding: calc((22px - 1cap) / 2) 6px');
  });
});

describe('색 값은 html-theme.ts에만', () => {
  const others = readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts') && d.name !== 'html-theme.ts')
    .map((d) => d.name);

  it.each(others)('%s에 hex나 rgb 색 값이 없다', (name) => {
    const src = readFileSync(join(SRC, name), 'utf8');
    expect(src).not.toMatch(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|\brgba?\(|\bhsla?\(/i);
  });
});

describe('모션 줄이기', () => {
  // 테마를 바꾸면 선과 바탕 색 전환이 그림 전체에서 돈다. 시퀀스 뷰 전용 CSS에만 두면 다른 그림에서 빠진다
  it.each([
    ['구조도', LAYOUT],
    ['구조 변경 그림', renderTokenCss()],
  ])('%s CSS가 모든 요소의 전환을 끈다', (_, css) => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ transition: none !important; \}/,
    );
  });
});
