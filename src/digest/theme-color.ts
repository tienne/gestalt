import { createHash } from 'node:crypto';
import { COLOR_RESOLVER_JS } from '../visual-system/color-resolver-js.js';
import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  COLOR_CATALOG,
  colorCssText,
  resolveColorTheme,
} from '../visual-system/color.js';
import { DIGEST_VAR_BRIDGE } from '../visual-system/css.js';

/**
 * 영상 요약과 읽기 렌즈가 같이 쓰는 Gestalt 색 테마. 배경과 강조색을 따로 고르고 배경을 안 고르면(자동) OS 설정을 따른다.
 * 해석은 문서 사이트와 같은 COLOR_RESOLVER_JS 문자열이 한다.
 */

/** 고른 배경과 강조색을 JSON으로 담는 저장 키 */
export const DIGEST_COLOR_STORAGE_KEY = 'gestalt-digest-color';
/** 라이트, 다크 세 칸 선택기 시절 저장 키. 남아 있으면 배경 하나로 옮기고 지운다 */
export const LEGACY_THEME_STORAGE_KEY = 'gestalt-digest-theme';

/** 자동일 때 OS 밝기별 배경. 다이어리 종이 느낌을 살리려고 밝은 쪽은 흰색 대신 종이를 쓴다 */
export const DIGEST_AUTO_BACKGROUND = { light: 'paper', dark: 'charcoal' } as const;
export const DIGEST_DEFAULT_ACCENT = 'cyan';

const lightTheme = () =>
  resolveColorTheme({ background: DIGEST_AUTO_BACKGROUND.light, accent: DIGEST_DEFAULT_ACCENT });
const darkTheme = () =>
  resolveColorTheme({ background: DIGEST_AUTO_BACKGROUND.dark, accent: DIGEST_DEFAULT_ACCENT });

/**
 * 스크립트가 꺼진 정지 HTML에서도 읽히도록 자동 테마 두 벌을 CSS로 깐다. 부트 스크립트가 돌면 :root 인라인 변수가 이 값을 덮는다.
 * data-theme은 부트 스크립트가 해석 결과의 밝기로 붙여서 OS와 고른 배경의 밝기가 다를 때 미디어 규칙을 끈다.
 */
export function digestThemeCss(): string {
  return (
    `:root{color-scheme:light;${colorCssText(lightTheme())};${DIGEST_VAR_BRIDGE}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${colorCssText(darkTheme())}}}` +
    ':root[data-theme="dark"]{color-scheme:dark}'
  );
}

/** head에서 저장된 선택을 먼저 적용해 첫 화면이 깜빡이지 않게 한다. VIEWER_JS는 window.gestaltDigestTheme으로 이 상태를 바꾼다 */
export const THEME_BOOT_JS = `${COLOR_RESOLVER_JS}
(function(){
  var sys = gestaltColorSystem(${JSON.stringify(COLOR_CATALOG)});
  var KEY = '${DIGEST_COLOR_STORAGE_KEY}', OLD = '${LEGACY_THEME_STORAGE_KEY}';
  var AUTO_LIGHT = '${DIGEST_AUTO_BACKGROUND.light}', AUTO_DARK = '${DIGEST_AUTO_BACKGROUND.dark}', ACCENT = '${DIGEST_DEFAULT_ACCENT}';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function read(){
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && typeof s === 'object') return s;
      var o = localStorage.getItem(OLD);
      return o === 'light' ? { background: AUTO_LIGHT } : o === 'dark' ? { background: AUTO_DARK } : {};
    } catch (e) { return {}; }
  }
  function write(s){ try { localStorage.setItem(KEY, JSON.stringify(s)); localStorage.removeItem(OLD); } catch (e) {} }
  function apply(s){
    var bg = s.background || (mq && mq.matches ? AUTO_DARK : AUTO_LIGHT);
    var t = sys.resolve({ background: bg, accent: s.accent || ACCENT });
    sys.apply(root, t);
    root.setAttribute('data-theme', t.tone);
    root.setAttribute('data-gestalt-background', t.background);
    root.setAttribute('data-gestalt-accent', t.accent);
    root.setAttribute('data-gestalt-auto', s.background ? 'false' : 'true');
    return t;
  }
  function emit(t){ try { document.dispatchEvent(new CustomEvent('gestalt-theme', { detail: t })); } catch (e) {} }
  window.gestaltDigestTheme = {
    get: read,
    set: function(part){
      var s = read();
      for (var k in part) { if (Object.prototype.hasOwnProperty.call(part, k)) { if (part[k]) s[k] = part[k]; else delete s[k]; } }
      write(s);
      var t = apply(s);
      emit(t);
      return t;
    }
  };
  apply(read());
  if (mq) {
    var follow = function(){ var s = read(); if (!s.background) emit(apply(s)); };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }
})();`;

/** CSP script-src에 싣는 THEME_BOOT_JS 해시 */
export const THEME_BOOT_JS_SHA256 = createHash('sha256')
  .update(THEME_BOOT_JS, 'utf8')
  .digest('base64');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** themeSwitchHtml 선택기를 window.gestaltDigestTheme에 잇는다. 다른 곳에서 테마가 바뀌면 gestalt-theme 이벤트로 표시를 맞춘다 */
export const THEME_SWITCH_JS = `(function(){var api=window.gestaltDigestTheme;if(!api)return;var root=document.documentElement,auto=document.querySelector('[data-theme-set="auto"]'),bg=document.getElementById('theme-bg'),ac=document.getElementById('theme-accent');
function sync(){if(auto)auto.setAttribute('aria-pressed',api.get().background?'false':'true');if(bg)bg.value=root.getAttribute('data-gestalt-background')||'';if(ac)ac.value=root.getAttribute('data-gestalt-accent')||'';}
if(auto)auto.addEventListener('click',function(){api.set({background:null});});if(bg)bg.addEventListener('change',function(){api.set({background:bg.value});});if(ac)ac.addEventListener('change',function(){api.set({accent:ac.value});});
document.addEventListener('gestalt-theme',sync);sync();})();`;

/** 헤더의 테마 선택기. 자동 버튼과 배경, 강조색 고르기. 처음 선택값은 VIEWER_JS가 현재 상태로 맞춘다 */
export function themeSwitchHtml(): string {
  const bg = BACKGROUND_PRESETS.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join(
    '',
  );
  const ac = ACCENT_PRESETS.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  return (
    '<span class="theme-switch" role="group" aria-label="테마">' +
    '<button type="button" data-theme-set="auto" aria-pressed="true">자동</button>' +
    `<label>배경 <select id="theme-bg">${bg}</select></label>` +
    `<label>강조색 <select id="theme-accent">${ac}</select></label>` +
    '</span>'
  );
}
