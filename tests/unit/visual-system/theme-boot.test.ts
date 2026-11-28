import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DIGEST_COLOR_STORAGE_KEY, THEME_BOOT_JS } from '../../../src/digest/theme-color.js';
import { DEFAULT_THEME } from '../../../src/visual-system/color.js';
import { themeRuntimeJs } from '../../../src/visual-system/runtime.js';
import {
  PRESENTATION_STORAGE_KEY,
  PRESENTATION_THEMES,
  presentationThemeBlock,
} from '../../../src/visual-system/presentation.js';

function fakeBrowser(stored: Record<string, string>, search = '') {
  const attrs: Record<string, string> = {};
  const store = new Map(Object.entries(stored));
  const root = {
    style: { setProperty() {} },
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    getAttribute: (k: string) => attrs[k] ?? null,
  };
  const window: Record<string, unknown> = {};
  const ctx = {
    window,
    document: { documentElement: root, dispatchEvent() {}, addEventListener() {} },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location: { pathname: '/deck.html', search },
    CustomEvent: class {},
  };
  return { ctx, attrs, store, window };
}

describe('테마 부트 스크립트의 저장값 복구', () => {
  it('영상 요약 부트는 카탈로그에 없는 id를 지우고 기본 테마를 적용한다', () => {
    const b = fakeBrowser({
      [DIGEST_COLOR_STORAGE_KEY]: JSON.stringify({ background: 'no-such-bg', accent: 'nope' }),
    });
    expect(() => runInNewContext(THEME_BOOT_JS, b.ctx)).not.toThrow();
    expect(b.attrs['data-gestalt-accent']).toBe('cyan');
    expect(JSON.parse(b.store.get(DIGEST_COLOR_STORAGE_KEY)!)).toEqual({});
  });

  it('공용 런타임은 카탈로그에 없는 id를 지우고 문서 기본값을 적용한다', () => {
    const b = fakeBrowser({ 'gestalt-color': JSON.stringify({ accent: 'removed-accent' }) });
    expect(() => runInNewContext(themeRuntimeJs(), b.ctx)).not.toThrow();
    expect(b.attrs['data-gestalt-accent']).toBe(DEFAULT_THEME.accent);
    expect(JSON.parse(b.store.get('gestalt-color')!)).toEqual({});
  });

  it('공용 런타임의 set은 적용이 실패하면 저장하지 않는다', () => {
    const b = fakeBrowser({});
    runInNewContext(themeRuntimeJs(), b.ctx);
    const api = b.window.gestaltTheme as { set: (p: object) => unknown };
    expect(() => api.set({ background: 'no-such-bg' })).toThrow(/Unknown Gestalt background/);
    expect(b.store.has('gestalt-color')).toBe(false);
  });

  it('장표는 주소에 카탈로그에 없는 id가 오면 저장하지 않고 있는 id만 저장한다', () => {
    const block = presentationThemeBlock(PRESENTATION_THEMES[0]!);
    const script = block.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const key = `${PRESENTATION_STORAGE_KEY}:/deck.html`;

    const bad = fakeBrowser({}, '?accent=no-such');
    runInNewContext(script, bad.ctx);
    expect(bad.store.has(key)).toBe(false);
    expect(bad.attrs['data-gestalt-accent']).not.toBe('no-such');

    const good = fakeBrowser({}, '?accent=cyan');
    runInNewContext(script, good.ctx);
    expect(JSON.parse(good.store.get(key)!)).toMatchObject({ accent: 'cyan' });
  });
});
