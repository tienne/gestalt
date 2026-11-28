import {
  THEME_BOOT_JS,
  THEME_SWITCH_JS,
  digestThemeCss,
  themeSwitchHtml,
} from '../digest/theme-color.js';

/** 테마 버튼을 누르면 펼쳐지는 선택기 팝업. CSP 때문에 head를 따로 짜는 화면도 같이 쓴다 */
export const THEME_POP_CSS = `
.theme-pop{position:relative;flex:none}
.theme-pop>summary{list-style:none;cursor:pointer;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);color:var(--fg);background:var(--card)}
.theme-pop>summary::-webkit-details-marker{display:none}
.theme-pop[open]>summary{background:var(--chip)}
.theme-pop .theme-switch{position:absolute;top:calc(100% + 6px);right:0;z-index:30;display:grid;gap:8px;width:220px;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.theme-pop .theme-switch label{display:grid;gap:4px;font-size:12px;color:var(--muted)}
.theme-pop .theme-switch select,.theme-pop .theme-switch button{font:inherit;font-size:13px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.theme-pop .theme-switch button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
`;

/** head에 넣는 공용 테마. 역할 변수와 선택기 스타일을 깔고 저장된 선택을 첫 화면 전에 적용한다 */
export const GRAPH_THEME_HEAD = `<style>${digestThemeCss()}${THEME_POP_CSS}</style>
  <script>${THEME_BOOT_JS}</script>`;

export function graphThemePicker(): string {
  return `<details class="theme-pop"><summary>테마</summary>${themeSwitchHtml()}</details>`;
}

// 캔버스로 그리는 차트는 CSS 변수를 못 읽어서 역할 값을 꺼내 주는 함수를 같이 싣는다
export const GRAPH_THEME_JS = `${THEME_SWITCH_JS}
window.gestaltRole = function (role, alpha) {
  var v = getComputedStyle(document.documentElement).getPropertyValue('--gestalt-color-' + role).trim();
  if (alpha == null || !/^#[0-9a-f]{6}$/i.test(v)) return v;
  return v + ('0' + Math.round(alpha * 255).toString(16)).slice(-2);
};`;
