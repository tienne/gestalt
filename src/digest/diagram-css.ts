import { STEP_SEC } from './svg.js';

/**
 * Video Digest 도식의 정지 상태 CSS. 요약 뷰어와 시각화 문서 사이트가 같이 쓴다.
 * 문서 사이트는 예제 칸 밖으로 규칙이 새지 않게 scope를 붙여 부른다.
 * 채움 자리는 --accent-fill을 읽는다. 밝은 배경에서 글자용 강조색으로 채우면 그 위 글자 대비가 모자라서다.
 */
const RULES: ReadonlyArray<readonly [string, string]> = [
  ['.diagram', 'margin:8px 0'],
  [
    '.dg-scroll',
    'overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:8px',
  ],
  ['.dg-svg', 'display:block;max-width:none'],
  ['.dg-svg text', 'fill:var(--fg);font-size:13px;font-family:inherit'],
  ['.dg-svg rect', 'fill:var(--bg);stroke:var(--line)'],
  ['.dg-svg path,.dg-svg line', 'stroke:var(--muted);fill:none;stroke-width:1.2'],
  [
    '.dg-svg .mm-d0 rect,.dg-svg .dg-head rect',
    'fill:var(--accent-fill);stroke:var(--accent-fill)',
  ],
  [
    '.dg-svg .mm-d0 text,.dg-svg .dg-head text',
    'fill:var(--on-accent);font-size:14px;font-weight:600',
  ],
  [
    '.dg-svg .mm-d1 rect,.dg-flow rect,.dg-cycle rect,.dg-timeline rect',
    'stroke:var(--accent-fill)',
  ],
  ['.dg-svg rect.dg-cell', 'fill:var(--card);stroke:var(--line);stroke-dasharray:4 3'],
  ['.dg-svg .dg-dot', 'fill:var(--accent-fill);stroke:none'],
  ['.dg-svg .dg-when text', 'fill:var(--accent);font-weight:600'],
  ['.dg-svg .dg-axis text', 'fill:var(--muted)'],
  ['.dg-svg .dg-arrow', 'fill:var(--muted);stroke:none'],
  [
    '.dg-bar',
    'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:4px;font-size:.9em;color:var(--muted)',
  ],
  ['.dg-bar span', 'margin-right:auto'],
  ['.dg-outline', 'margin-top:4px;font-size:.92em'],
  ['.dg-outline summary', 'cursor:pointer;color:var(--muted)'],
  ['.dg-svg .dg-focus rect', 'fill:var(--hl);stroke:var(--accent-fill);stroke-width:2'],
  ['.dg-svg .dg-focus text', 'font-weight:600'],
  ['.dg-svg .dg-stat-value text', 'fill:var(--accent);font-size:40px;font-weight:700'],
  ['.dg-svg .dg-stat-label rect', 'fill:none;stroke:none'],
  ['.dg-svg .dg-spark circle', 'fill:var(--accent-fill);opacity:.45'],
  ['.dg-svg .dg-picked rect', 'fill:var(--hl);stroke:var(--accent-fill);stroke-width:3'],
  ['.dg-svg .dg-picked text', 'font-weight:600'],
  [
    '.dg-svg .dg-check',
    'stroke:var(--accent-fill);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;fill:none',
  ],
  ['.dg-svg .dg-dim', 'opacity:.5'],
];

export function diagramCss(scope = ''): string {
  const pre = (sel: string) =>
    sel
      .split(',')
      .map((x) => scope + x.trim())
      .join(',');
  return RULES.map(([sel, body]) => `${pre(sel)}{${body}}`).join('\n') + '\n';
}

const MOTION_CSS = `.armed{--dg-ease:cubic-bezier(.22,.8,.3,1)}
.armed>.conclusion,.armed .dg-step,.armed .dg-arrow,.armed .dg-dot,.armed .dg-cell,.armed .dg-spark,.armed .dg-when,.armed .dg-axis{opacity:0}
.armed .dg-svg path.dg-line{stroke-dasharray:1;stroke-dashoffset:1}
.armed .dg-svg .dg-picked rect{fill:var(--bg);stroke:var(--line);stroke-width:1}
.armed .dg-svg .dg-picked text{font-weight:400}
.armed .dg-svg .dg-check{opacity:0}
.armed .dg-svg .dg-dim{opacity:1}
.armed>.conclusion strong{background-size:0 42%}
.armed.play>.conclusion{animation:dg-up .5s var(--dg-ease) both}
.armed.play>.conclusion strong{animation:dg-hl .6s var(--dg-ease) .3s both}
.armed.play .dg-step{animation:dg-pop .4s var(--dg-ease) both;animation-delay:calc(var(--dg-base,0s) + var(--i,0) * var(--dg-step,${STEP_SEC}s));transform-box:fill-box;transform-origin:center}
.armed.play .dg-svg path.dg-line{animation:dg-draw .55s ease both;animation-delay:calc(var(--dg-base,0s) + var(--i,0) * var(--dg-step,${STEP_SEC}s))}
.armed.play .dg-arrow{animation:dg-fade .2s ease both;animation-delay:calc(var(--dg-base,0s) + var(--i,0) * var(--dg-step,${STEP_SEC}s) + .45s)}
.armed.play .dg-dot,.armed.play .dg-cell,.armed.play .dg-spark{animation:dg-fade .3s ease both;animation-delay:calc(var(--dg-base,0s) + var(--i,0) * var(--dg-step,${STEP_SEC}s))}
.armed.play .dg-when,.armed.play .dg-axis{animation:dg-fade .3s ease both;animation-delay:var(--dg-base,0s)}
.armed.play .dg-focus{animation:dg-ping .8s ease-in-out 3;animation-delay:calc(var(--dg-base,0s) + var(--i,0) * var(--dg-step,${STEP_SEC}s) + .4s);transform-box:fill-box;transform-origin:center}
.armed.play .dg-svg rect.dg-scan{animation:dg-scan 1s linear both;animation-delay:calc(var(--dg-base,0s) + var(--n,0) * var(--dg-step,${STEP_SEC}s) + .4s)}
.armed.play .dg-svg .dg-picked rect{animation:dg-pick .4s ease both;animation-delay:calc(var(--dg-base,0s) + var(--n,0) * var(--dg-step,${STEP_SEC}s) + 1.4s)}
.armed.play .dg-svg .dg-check{animation:dg-fade .3s ease both;animation-delay:calc(var(--dg-base,0s) + var(--n,0) * var(--dg-step,${STEP_SEC}s) + 1.4s)}
.armed.play .dg-svg .dg-dim{animation:dg-dim .4s ease both;animation-delay:calc(var(--dg-base,0s) + var(--n,0) * var(--dg-step,${STEP_SEC}s) + 1.4s)}
@keyframes dg-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes dg-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes dg-fade{from{opacity:0}to{opacity:1}}
@keyframes dg-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes dg-hl{from{background-size:0 42%}to{background-size:100% 42%}}
@keyframes dg-ping{0%,100%{transform:none}50%{transform:scale(1.08)}}
@keyframes dg-scan{0%{opacity:0;transform:translateX(0)}10%,90%{opacity:.7}100%{opacity:0;transform:translateX(var(--w,0px))}}
@keyframes dg-pick{from{fill:var(--bg);stroke:var(--line);stroke-width:1}to{fill:var(--hl);stroke:var(--accent-fill);stroke-width:3}}
@keyframes dg-dim{from{opacity:1}to{opacity:.5}}
@media (prefers-reduced-motion:reduce),print{.armed>.conclusion,.armed .dg-step,.armed .dg-arrow,.armed .dg-dot,.armed .dg-cell,.armed .dg-spark,.armed .dg-when,.armed .dg-axis,.armed .dg-focus{opacity:1!important;animation:none!important}.armed .dg-svg .dg-check{opacity:1!important;animation:none!important}.armed .dg-svg .dg-picked rect{fill:var(--hl);stroke:var(--accent-fill);stroke-width:3;animation:none!important}.armed .dg-svg .dg-picked text{font-weight:600}.armed .dg-svg .dg-dim{opacity:.5;animation:none!important}.armed .dg-svg rect.dg-scan{opacity:0;animation:none!important}.armed .dg-svg path.dg-line{stroke-dasharray:none;animation:none!important}.armed>.conclusion strong{background-size:100% 42%;animation:none!important}}`;

/**
 * 도식 진입 모션. 스크립트가 카드에 .armed를 붙이면 시작 상태로 숨기고 .play가 붙을 때 차례로 띄운다.
 * 문서 사이트도 다시 재생 버튼에서 같은 시간표를 쓰려고 scope를 붙여 부른다.
 */
export function diagramMotionCss(scope = ''): string {
  return scope ? MOTION_CSS.replace(/\.armed/g, `${scope}.armed`) : MOTION_CSS;
}
