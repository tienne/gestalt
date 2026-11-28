import { colorCssText, resolveColorTheme } from './color.js';
import { MOTION_TOKENS } from './motion.js';

/**
 * 공통 시각화 CSS. 색은 `--gestalt-color-*`만 읽는다. 기본 테마 값을 :root에 깔아 두어서
 * 스크립트가 돌지 않는 정지 HTML도 차콜과 시안으로 읽힌다.
 */

const v = (role: string) => `var(--gestalt-color-${role})`;

export const MOTION_CSS_VARS = Object.entries(MOTION_TOKENS)
  .map(([k, val]) => `${k}:${val}`)
  .join(';');

export function defaultThemeCss(selector = ':root'): string {
  return `${selector}{${colorCssText(resolveColorTheme())};${MOTION_CSS_VARS}}`;
}

/**
 * Digest와 Lens가 원래 쓰던 변수(--bg, --fg, --accent …)를 Gestalt 역할에 잇는다. 제품 CSS를 다시 쓰지 않고
 * 변수 이름만 이어서 기존 규칙과 SVG 클래스가 그대로 동작한다.
 */
export const DIGEST_VAR_BRIDGE = [
  `--bg:${v('background')}`,
  `--fg:${v('text')}`,
  `--muted:${v('text-muted')}`,
  `--line:${v('border')}`,
  `--card:${v('surface')}`,
  `--accent:${v('accent-text')}`,
  `--accent-fill:${v('accent-fill')}`,
  `--on-accent:${v('on-accent')}`,
  `--warn:${v('warning-text')}`,
  `--chip:${v('surface')}`,
  `--hl:${v('highlight')}`,
].join(';');

export const VISUAL_CSS = `
.vs-fig{margin:0;padding:16px;border:1px solid ${v('border')};border-radius:12px;background:${v('background')};color:${v('text')};font:14px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif;display:flex;flex-direction:column;gap:10px;min-width:0}
.vs-fig:focus-visible,.vs-fig [tabindex]:focus-visible,.vs-fig button:focus-visible,.vs-fig a:focus-visible{outline:2px solid ${v('focus')};outline-offset:2px}
.vs-title{font-weight:700}
.vs-body{min-width:0;overflow-x:auto}
.vs-cap,.vs-src,.vs-axis{margin:0;font-size:12px;color:${v('text-muted')}}
.vs-src a{color:${v('accent-text')}}
.vs-muted{color:${v('text-muted')}}
.vs-h{margin:0 0 8px;font-size:15px}
.vs-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vs-ctl button,.vs-live-ctl button{font:inherit;color:${v('text')};background:${v('surface')};border:1px solid ${v('border')};border-radius:8px;padding:6px 12px;min-height:36px;cursor:pointer}
.vs-ctl button[aria-disabled="true"]{opacity:.45;cursor:default}
.vs-pos{font-size:13px;color:${v('text-muted')};font-variant-numeric:tabular-nums}
[data-at],[data-focus-at],.vs-strike{transition:opacity var(--gestalt-motion-base,280ms) var(--gestalt-ease-enter,ease),transform var(--gestalt-motion-base,280ms) var(--gestalt-ease-enter,ease),background-color var(--gestalt-motion-fast,160ms) ease,fill var(--gestalt-motion-fast,160ms) ease}
.vs-off{opacity:.1;transform:translateY(4px)}
svg .vs-off{transform:none}
.vs-stat{display:flex;flex-direction:column;gap:4px}
.vs-stat-v{font-size:40px;line-height:1.1;color:${v('accent-text')};font-variant-numeric:tabular-nums}
.vs-stat-v small,.vs-big small,.sl-num small{font-size:.45em;margin-left:4px;color:${v('text')}}
.vs-big b{font-size:64px;line-height:1;color:${v('accent-text')}}
.vs-big p{margin:6px 0 0}
.vs-bars{display:flex;flex-direction:column;gap:6px}
.vs-bar-row{display:grid;grid-template-columns:minmax(64px,auto) 1fr auto;gap:8px;align-items:center}
.vs-bar-l{font-size:13px}
.vs-bar-t{height:14px;background:${v('surface')};border-radius:4px;overflow:hidden}
.vs-bar{display:block;height:100%;background:${v('text-muted')};border-radius:4px}
.vs-bar-row.is-focus .vs-bar,.vs-bar-row.vs-focus .vs-bar{background:${v('accent-fill')}}
.vs-bar-row.is-focus .vs-bar-l,.vs-bar-row.vs-focus .vs-bar-l{font-weight:700}
.vs-bar-v{font-size:13px;font-variant-numeric:tabular-nums;min-width:3em;text-align:right}
.vs-cols{display:flex;align-items:flex-end;gap:14px;height:calc(var(--vs-h) + 48px)}
.vs-col{display:flex;flex-direction:column;align-items:center;gap:4px;flex:1}
.vs-col-bar{width:100%;max-width:48px;background:${v('series-2')};border-radius:4px 4px 0 0}
.vs-col-bar.is-last{background:${v('accent-fill')}}
.vs-svg{display:block;width:100%;height:auto;max-width:640px}
.vs-svg text{fill:${v('text')};font-size:12px;font-family:inherit}
.vs-svg .vs-tick{fill:${v('text-muted')};font-size:11px}
.vs-svg .vs-grid{stroke:${v('border')}}
${[1, 2, 3, 4, 5, 6].map((n) => `.vs-s${n}{--vs-c:${v(`series-${n}`)}}`).join('')}
.vs-svg polyline{stroke:var(--vs-c);stroke-width:2.5}
.vs-svg g[class^="vs-s"]>circle,.vs-svg g[class^="vs-s"]>rect,.vs-svg g[class^="vs-s"]>path{fill:var(--vs-c);stroke:var(--vs-c)}
.vs-svg .vs-stroke-only{fill:none!important;stroke-width:2}
.vs-svg .vs-ring{fill:${v('background')}!important;stroke-width:2}
.vs-svg .vs-end{font-weight:600}
.vs-band rect{fill:${v('highlight')};opacity:0}
.vs-band text{fill:${v('text-muted')};opacity:0}
.vs-band.vs-focus rect,.vs-band.vs-focus text{opacity:1}
[data-vs]:not([data-vs-current]) .vs-band:last-of-type rect{opacity:1}
.vs-legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px}
.vs-legend li{display:flex;align-items:center;gap:6px}
.vs-legend svg line{stroke:var(--vs-c);stroke-width:2.5}
.vs-key{width:12px;height:12px;border-radius:3px;background:var(--vs-c)}
.vs-donut{position:relative;width:180px;height:180px}
.vs-donut svg{width:180px;height:180px}
.vs-donut-track{fill:none;stroke:${v('surface')};stroke-width:22}
.vs-donut-arc{fill:none;stroke:${v('accent-fill')};stroke-width:22;transition:stroke-dasharray var(--gestalt-motion-slow,800ms) var(--gestalt-ease-move,ease)}
.vs-donut-c{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:2px}
.vs-donut-c b{font-size:32px;font-variant-numeric:tabular-nums}
.vs-donut-l{margin:0}
.vs-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.vs-card{border:1px solid ${v('border')};border-radius:10px;padding:12px;background:${v('surface')}}
.vs-card.is-accent{border-color:${v('accent-fill')};box-shadow:inset 4px 0 0 ${v('accent-fill')}}
.vs-card h4{margin:0 0 6px}
.vs-card dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:0;font-size:13px}
.vs-card dt{color:${v('text-muted')}}.vs-card dd{margin:0}
.vs-dots{display:grid;grid-template-columns:repeat(10,16px);gap:4px}
.vs-dot{width:16px;height:16px;border-radius:50%;border:1.5px solid ${v('text-muted')}}
.vs-dot.is-on{background:${v('accent-fill')};border-color:${v('accent-fill')}}
.vs-dot.vs-off{opacity:1;transform:none;background:transparent;border-color:${v('text-muted')}}
.vs-dots-l{margin:0}
.vs-layers{display:flex;flex-direction:column;gap:4px}
.vs-layer{display:flex;justify-content:space-between;gap:10px;padding:8px 12px;border:1px solid ${v('border')};border-radius:8px;background:${v('surface')}}
.vs-layer.vs-focus{background:${v('highlight')};border-color:${v('accent-fill')};font-weight:700}
.vs-layer.vs-focus::before{content:"현재";font-size:11px;color:${v('on-accent')};background:${v('accent-fill')};padding:0 6px;border-radius:4px;margin-right:auto;order:-1}
.vs-scale{display:grid;grid-template-columns:1fr 1fr;gap:12px;position:relative;padding-top:18px}
.vs-beam{position:absolute;top:6px;left:10%;right:10%;height:4px;background:${v('text-muted')};transform:rotate(var(--vs-tilt));border-radius:2px}
.vs-pan{border:1px solid ${v('border')};border-radius:10px;padding:10px;background:${v('surface')}}
.vs-pan h4{margin:0 0 6px}.vs-pan ul{margin:0;padding-left:18px}
.vs-pan-l{border-top:4px solid ${v('accent-fill')}}.vs-pan-r{border-top:4px solid ${v('series-2')}}
.vs-verdict{margin:0;font-weight:700;color:${v('accent-text')}}
.vs-edge line{stroke:${v('text-muted')};stroke-width:1.5}
.vs-edge text{fill:${v('text-muted')};font-size:11px}
.vs-arrowhead{fill:${v('text-muted')}}
.vs-node rect{fill:${v('surface')};stroke:var(--vs-c);stroke-width:2}
.vs-node.vs-focus rect,.vs-node.is-focus rect{fill:${v('highlight')};stroke-width:3}
.vs-node.is-human rect{stroke-dasharray:4 3;stroke:${v('warning-fill')}}
.vs-node:focus{outline:none}.vs-node:focus-visible rect{stroke:${v('focus')};stroke-width:3}
.vs-log{list-style:none;margin:0;padding:0;max-height:220px;overflow:auto;border:1px solid ${v('border')};border-radius:8px}
.vs-ev{display:grid;grid-template-columns:auto auto auto 1fr;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid ${v('border')};font-size:13px}
.vs-ev time{font-variant-numeric:tabular-nums;color:${v('text-muted')}}
.vs-ev.is-new{animation:vs-new var(--gestalt-motion-slow,800ms) ease}
@keyframes vs-new{from{background:${v('highlight')}}to{background:transparent}}
.vs-src-badge{font-size:11px;padding:0 6px;border:1px solid ${v('border')};border-radius:4px}
.vs-live-ctl{display:flex;gap:8px;align-items:center}
.vs-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
${['success', 'warning', 'danger', 'info'].map((k) => `.vs-badge-${k}{color:${v(`${k}-text`)}}.vs-${k}-text{color:${v(`${k}-text`)}}`).join('')}
.vs-badges{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.vs-table{border-collapse:collapse;font-size:13px;width:100%}
.vs-table th,.vs-table td{border:1px solid ${v('border')};padding:6px 8px;text-align:left}
.vs-table thead th{background:${v('surface')}}
.vs-table td.vs-off{opacity:.15;transform:none}
.vs-dur{display:flex;border-radius:6px;overflow:hidden;min-height:34px}
.vs-seg{display:flex;align-items:center;gap:4px;padding:4px 8px;font-size:12px;color:${v('background')};background:var(--vs-c);white-space:nowrap;overflow:hidden}
.vs-seg+.vs-seg{border-left:2px solid ${v('background')}}
.vs-prose{margin:0}
.vs-cite{font-size:12px;padding:0 6px;border-radius:4px;background:${v('surface')};color:${v('accent-text')};text-decoration:none;border:1px solid ${v('border')}}
.vs-quote{margin:0;padding:12px 16px;border-left:4px solid ${v('accent-fill')};background:${v('surface')};border-radius:0 8px 8px 0}
.vs-quote p{margin:0;font-size:16px}.vs-quote footer{margin-top:6px;font-size:12px;color:${v('text-muted')}}
.vs-lines{list-style:none;margin:0;padding:0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.vs-lines li{padding:2px 8px;border-radius:4px}
.vs-lines li.vs-focus,.vs-lines li.is-target{background:${v('highlight')};color:${v('text')}}
.vs-ln{display:inline-block;width:2em;color:${v('text-muted')};user-select:none}
.vs-diff{list-style:none;margin:0;padding:0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.vs-diff li{padding:2px 8px}
.vs-diff-sym{display:inline-block;width:1.4em;font-weight:700}
${['added', 'removed', 'changed'].map((d) => `.vs-diff-${d}{background:${v(`diff-${d}-bg`)}}.vs-diff-${d} .vs-diff-sym{color:${v(`diff-${d}-text`)}}`).join('')}
.vs-formula{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.vs-term{display:flex;flex-direction:column;padding:8px 12px;border:1px solid ${v('border')};border-radius:8px;background:${v('surface')}}
.vs-term b{font-size:24px;font-variant-numeric:tabular-nums}
.vs-term small{color:${v('text-muted')}}
.vs-term.is-result{border-color:${v('accent-fill')}}.vs-term.is-result b{color:${v('accent-text')}}
.vs-op{font-size:22px;color:${v('text-muted')}}
.vs-wave{fill:${v('text-muted')}}
.vs-wave.vs-focus{fill:${v('accent-fill')}}
.vs-script li{opacity:.6}.vs-script li.vs-focus{opacity:1}
.vs-chapters{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.vs-chapters li{border:1px solid ${v('border')};border-radius:8px;padding:10px;background:${v('surface')};display:flex;flex-direction:column}
.vs-chapters li b{color:${v('text-muted')}}
.vs-chapters li.vs-focus{background:${v('accent-fill')};color:${v('on-accent')};border-color:${v('accent-fill')}}
.vs-chapters li.vs-focus b{color:${v('on-accent')}}
.vs-capture{display:grid;gap:10px}
.vs-shot{border:1px solid ${v('border')};border-radius:8px;padding:6px;background:${v('surface')}}
.vs-zoom{font:18px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 14px;border:2px solid ${v('accent-fill')};border-radius:8px;background:${v('highlight')}}
.vs-judge{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.vs-judge li{border:1px solid ${v('border')};border-radius:8px;padding:8px 12px;background:${v('surface')}}
.vs-judge small{color:${v('text-muted')}}.vs-judge p{margin:2px 0 0}
.vs-strike.is-struck{text-decoration:line-through;text-decoration-color:${v('diff-removed-text')};text-decoration-thickness:2px;color:${v('text-muted')}}
.vs-judge-rev{border-color:${v('accent-fill')}!important}.vs-judge-rev p{color:${v('accent-text')};font-weight:700}
.vs-slots{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.vs-slots li{border:1px dashed ${v('border')};border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:4px}
.vs-slots b{color:${v('accent-text')}}
.vs-slide{position:relative;aspect-ratio:16/9;width:100%;max-width:640px;background:${v('background')};color:${v('text')};border:1px solid ${v('border')};border-radius:10px;padding:6% 7%;display:flex;flex-direction:column;justify-content:center;gap:10px;overflow:hidden}
.vs-slide.is-inverse{background:${v('accent-fill')};color:${v('on-accent')};border-color:${v('accent-fill')}}
.vs-slide.is-inverse .sl-sub,.vs-slide.is-inverse footer{color:${v('on-accent')};opacity:.85}
.vs-slide footer{position:absolute;left:7%;right:7%;bottom:4%;display:flex;justify-content:space-between;font-size:11px;color:${v('text-muted')}}
.sl-kicker{margin:0;color:${v('accent-text')};font-weight:700;font-size:13px}
.sl-hero{margin:0;font-size:clamp(20px,4vw,34px);line-height:1.2}
.sl-h{margin:0;font-size:clamp(16px,2.6vw,22px)}
.sl-sub,.sl-meta{margin:0;color:${v('text-muted')}}
.sl-chap-n{font-size:clamp(40px,8vw,72px);line-height:1}
.sl-num{font-size:clamp(48px,10vw,88px);line-height:1;color:${v('accent-text')}}
.sl-2col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.sl-2col section{border:1px solid ${v('border')};border-radius:8px;padding:8px 12px}
.sl-2col section.is-accent{border-color:${v('accent-fill')};box-shadow:inset 0 4px 0 ${v('accent-fill')}}
.sl-2col h4{margin:0 0 4px}.sl-2col ul{margin:0;padding-left:18px}
.sl-quote{margin:0;font-size:clamp(18px,3.4vw,28px);border-left:6px solid ${v('accent-fill')};padding-left:14px}
.sl-list,.sl-proc{margin:0;padding-left:20px;display:grid;gap:6px;font-size:clamp(14px,2vw,18px)}
.sl-proc{list-style:none;padding:0;grid-auto-flow:column;grid-auto-columns:1fr}
.sl-proc li{border-top:4px solid ${v('accent-fill')};padding-top:6px;display:flex;flex-direction:column}
.sl-proc b{color:${v('accent-text')}}
.sl-img{flex:1;border:1px dashed ${v('border')};border-radius:8px;display:flex;align-items:center;justify-content:center;color:${v('text-muted')};min-height:80px}
.sl-qa{margin:0;display:grid;gap:4px}.sl-qa dt{font-weight:700}.sl-qa dd{margin:0 0 6px;color:${v('text-muted')}}
.vs-product{${DIGEST_VAR_BRIDGE};color:${v('text')}}
@media (prefers-reduced-motion:reduce){:root:not([data-gestalt-motion="full"]) :is([data-at],[data-focus-at],.vs-strike,.vs-donut-arc){transition:none!important}:root:not([data-gestalt-motion="full"]) .vs-ev.is-new{animation:none}}
:root[data-gestalt-motion="reduce"] [data-at],:root[data-gestalt-motion="reduce"] [data-focus-at],:root[data-gestalt-motion="reduce"] .vs-donut-arc{transition:none!important}
:root[data-gestalt-motion="reduce"] .vs-ev.is-new{animation:none}
@media print{.vs-ctl,.vs-live-ctl{display:none}.vs-off{opacity:1!important;transform:none!important}}
@media (max-width:520px){.vs-fig{padding:12px}.sl-2col{grid-template-columns:1fr}.sl-proc{grid-auto-flow:row}.vs-bar-row{grid-template-columns:1fr auto}.vs-bar-t{grid-column:1/-1;grid-row:2}.vs-ev{grid-template-columns:auto 1fr}.vs-dots{grid-template-columns:repeat(10,12px)}.vs-dot{width:12px;height:12px}}
`;
