import { CATALOG, CATEGORIES, type CatalogItem } from './catalog.js';
import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  COLOR_SYSTEM_VERSION,
  DEFAULT_THEME,
  DIFF_KINDS,
  SERIES_CUES,
  STATUS_CUES,
  resolveColorTheme,
} from './color.js';
import { CONTRAST_RULES, checkAllThemes, checkThemeContrast } from './contrast.js';
import { VISUAL_CSS, defaultThemeCss } from './css.js';
import { examplesFor, type Example } from './examples.js';
import { SCREENS, SURVEY, type ScreenEntry } from './inventory.js';
import { MOTIONS, MOTION_TOKENS } from './motion.js';
import { esc } from './render.js';
import { VISUAL_STEP_JS, WIDGET_RUNTIME_JS, themeRuntimeJs } from './runtime.js';
import { diagramCss, diagramMotionCss } from '../digest/diagram-css.js';
import { WIDGET_CSS } from '../digest/render-widgets.js';

/**
 * 컬러 시스템과 시각화 시스템 문서 사이트. 정적 HTML 한 장으로 뽑는다.
 * 호스팅과 기술 스택은 미정이라(Spec 제약) 외부 의존 없이 파일을 열기만 하면 보이게 했다.
 * 페이지는 전부 한 문서에 그려 두고 해시로 하나만 보인다. 스크립트가 꺼져 있으면 전부 이어서 보인다.
 */

const DOCS_STORAGE_KEY = 'gestalt-visual-docs-color';

/**
 * 문서 사이트 예제에는 제품의 확대, 다시 보기 버튼이 없다. 정지 규칙과 진입 모션은 제품 CSS를 같이 쓰고
 * 재생은 예제마다 붙인 모션 다시 보기 버튼이 맡는다.
 */
const DIGEST_DIAGRAM_STATIC_CSS = `${diagramCss('.vs-product ')}${diagramMotionCss('.vs-product ')}
.vs-product .zoom-btn,.vs-product .replay-btn{display:none}
.vs-product .dg-svg rect.dg-scan{fill:var(--accent-fill);stroke:none;opacity:0}
.vs-product .cite{color:var(--accent);text-decoration:none;font-size:12px}
.vs-product .loc{color:var(--muted);font-size:12px}
`;

const SITE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:var(--gestalt-color-background);color:var(--gestalt-color-text)}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
a{color:var(--gestalt-color-accent-text)}
.skip{position:absolute;left:-999px;top:0;padding:8px 12px;background:var(--gestalt-color-accent-fill);color:var(--gestalt-color-on-accent);z-index:10}
.skip:focus{left:8px}
:focus-visible{outline:2px solid var(--gestalt-color-focus);outline-offset:2px}
.layout{display:grid;grid-template-columns:272px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--gestalt-color-border);background:var(--gestalt-color-surface);padding:16px 12px}
.side h1{font-size:16px;margin:0 0 4px}
.side .ver{margin:0 0 12px;font-size:12px;color:var(--gestalt-color-text-muted)}
.side input[type=search]{width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--gestalt-color-border);background:var(--gestalt-color-background);color:var(--gestalt-color-text)}
.side nav h2{font-size:12px;margin:16px 4px 4px;color:var(--gestalt-color-text-muted);font-weight:600}
.side nav ul{list-style:none;margin:0;padding:0}
.side nav a{display:block;padding:4px 8px;border-radius:6px;text-decoration:none;color:var(--gestalt-color-text);font-size:14px}
.side nav a[aria-current="page"]{background:var(--gestalt-color-highlight);font-weight:700}
.side nav a:hover{background:var(--gestalt-color-highlight)}
.side nav .tag{font-size:10px;color:var(--gestalt-color-text-muted);margin-left:4px}
.menu-btn{display:none}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
main{padding:24px clamp(16px,4vw,48px) 80px;max-width:1080px;min-width:0}
.page{margin-bottom:56px}
.page>h2{font-size:26px;margin:0 0 4px}
.page h3{font-size:17px;margin:28px 0 8px}
.lede{color:var(--gestalt-color-text-muted);margin:0 0 16px}
.meta{display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0}
.meta dt{color:var(--gestalt-color-text-muted);font-size:13px}
.meta dd{margin:0}
.chips{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0}
.chips li,.chip{font-size:12px;padding:1px 8px;border:1px solid var(--gestalt-color-border);border-radius:999px;background:var(--gestalt-color-surface)}
.ex{border:1px solid var(--gestalt-color-border);border-radius:12px;padding:12px;margin:12px 0;background:var(--gestalt-color-surface)}
.ex>header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:8px}
.ex>header b{font-size:14px}
.ex .usage{font-size:13px;color:var(--gestalt-color-text-muted);margin:8px 0 0}
.ex .stage{background:var(--gestalt-color-background);border-radius:10px;padding:4px;overflow-x:auto}
.ex>header .ex-replay{margin-left:auto;min-height:32px;padding:4px 12px}
.ex-replay[hidden]{display:none}
.ex-msg{flex-basis:100%;font-size:12px;color:var(--gestalt-color-text-muted);min-height:0}
.ex-msg:empty{display:none}
.stage.vs-replay .vs-in{animation:vs-in var(--gestalt-motion-base,280ms) var(--gestalt-ease-enter,ease) both;animation-delay:calc(var(--i,0) * 70ms)}
.stage.vs-replay .vs-in-svg{animation:vs-in-svg var(--gestalt-motion-base,280ms) ease both;animation-delay:calc(var(--i,0) * 70ms)}
@keyframes vs-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes vs-in-svg{from{opacity:0}to{opacity:1}}
:root[data-gestalt-motion="reduce"] .stage.vs-replay :is(.vs-in,.vs-in-svg){animation:none}
@media (prefers-reduced-motion:reduce){:root:not([data-gestalt-motion="full"]) .stage.vs-replay :is(.vs-in,.vs-in-svg){animation:none}}
table.grid{border-collapse:collapse;width:100%;font-size:13px}
table.grid th,table.grid td{border:1px solid var(--gestalt-color-border);padding:6px 8px;text-align:left;vertical-align:top}
table.grid thead th{background:var(--gestalt-color-surface);position:sticky;top:0}
.tbl{overflow-x:auto;max-width:100%}
.sw{display:inline-block;width:14px;height:14px;border-radius:4px;border:1px solid var(--gestalt-color-border);vertical-align:-2px;margin-right:6px}
.picker{display:grid;gap:12px}
.picker fieldset{border:1px solid var(--gestalt-color-border);border-radius:10px;padding:10px 12px;margin:0}
.picker legend{font-weight:700;padding:0 4px}
.opts{display:flex;flex-wrap:wrap;gap:6px}
.opts label{display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 6px;border:1px solid var(--gestalt-color-border);border-radius:999px;cursor:pointer;font-size:13px;background:var(--gestalt-color-background)}
.opts input{position:absolute;opacity:0;width:1px;height:1px}
.opts input:checked+.sw{outline:2px solid var(--gestalt-color-text);outline-offset:1px}
.opts label:has(input:checked){border-color:var(--gestalt-color-accent-fill);font-weight:700}
.opts label:has(input:focus-visible){outline:2px solid var(--gestalt-color-focus);outline-offset:2px}
.now{font-size:14px;margin:8px 0}
.btn{font:inherit;padding:6px 12px;min-height:36px;border-radius:8px;border:1px solid var(--gestalt-color-border);background:var(--gestalt-color-background);color:var(--gestalt-color-text);cursor:pointer}
.ok{color:var(--gestalt-color-success-text)}.ng{color:var(--gestalt-color-danger-text)}
.status-planned{color:var(--gestalt-color-text-muted)}
.status-applied,.status-verified{color:var(--gestalt-color-success-text);font-weight:700}
.status-in-progress{color:var(--gestalt-color-warning-text)}
.motion-toggle{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
.note{border-left:4px solid var(--gestalt-color-info-fill);background:var(--gestalt-color-surface);padding:8px 12px;border-radius:0 8px 8px 0;font-size:14px}
html.js .page{display:none}
html.js .page.is-current{display:block}
html.js.searching .page{display:none}
@media (max-width:760px){
  .layout{grid-template-columns:1fr}
  .side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--gestalt-color-border)}
  html.js .side nav{display:none}
  html.js .side.open nav,html.js.searching .side nav{display:block}
  .menu-btn{display:inline-flex;margin-top:8px}
  .meta{grid-template-columns:1fr}
  main{padding-top:16px}
}
@media print{.side{display:none}.layout{display:block}html.js .page{display:block!important}}
`;

const categoryName = (id: string): string => CATEGORIES.find((c) => c.id === id)?.name ?? id;
const RENDERER_LABEL: Record<Example['renderer'], string> = {
  'visual-system': '공통 렌더러',
  'video-digest': 'Video Digest 제품 렌더러',
  lens: 'Lens 제품 렌더러',
};

function chips(list: readonly string[]): string {
  return list.length
    ? `<ul class="chips">${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '<span class="chip">없음</span>';
}

function exampleHtml(e: Example): string {
  const body = e.renderer === 'visual-system' ? e.html : `<div class="vs-product">${e.html}</div>`;
  return `<article class="ex"><header><b>${esc(e.title)}</b><span class="chip">${RENDERER_LABEL[e.renderer]}</span><span class="chip">Gestalt 예시</span><button type="button" class="btn ex-replay" data-ex-replay hidden>모션 다시 보기</button><span class="ex-msg" aria-live="polite"></span></header><div class="stage">${body}</div><p class="usage">${esc(e.usage)}</p></article>`;
}

function itemPage(c: CatalogItem, extra = ''): string {
  const exs = examplesFor(c.id);
  const origins = c.origins.length
    ? `<ul>${c.origins.map((o) => `<li>${esc(o.product)} <code>${esc(o.file)}</code>${o.name ? ` (${esc(o.name)})` : ''}</li>`).join('')}</ul>`
    : '<p>기존 제품에 같은 요소가 없어 공통 렌더러로 새로 만들었어요.</p>';
  return `<section class="page" id="${esc(c.id)}" data-search="${esc(`${c.id} ${c.name} ${c.purpose} ${categoryName(c.category)}`)}" aria-labelledby="h-${esc(c.id)}">
<h2 id="h-${esc(c.id)}">${esc(c.name)}</h2>
<p class="lede">${esc(categoryName(c.category))} · <code>${esc(c.id)}</code>${c.combo ? ' · 조합' : ''}</p>
<h3>목적</h3><p>${esc(c.purpose)}</p>
${extra}<h3>데이터와 표기</h3>
<dl class="meta"><dt>데이터 필드</dt><dd>${chips(c.data)}</dd><dt>표기 규칙</dt><dd>${c.notation.length ? `<ul>${c.notation.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '기본 규칙(단위와 출처 표시)만 따른다'}</dd><dt>색 역할</dt><dd>${chips(c.colorRoles)}</dd>${c.basedOn ? `<dt>기반 요소</dt><dd>${c.basedOn.map((b) => `<a href="#${esc(b)}">${esc(b)}</a>`).join(', ')}</dd>` : ''}</dl>
<h3>예제와 사용법</h3>${exs.length ? exs.map(exampleHtml).join('') : '<p class="ng">예제 없음</p>'}
<h3>상태와 조작</h3>
<dl class="meta"><dt>상태</dt><dd>${chips(c.states)}</dd><dt>조작</dt><dd>${chips(c.operations)}</dd><dt>모션</dt><dd>${c.motions.length ? c.motions.map((m) => `<a href="#${esc(m)}">${esc(m)}</a>`).join(', ') : '없음'}</dd></dl>
<h3>기존 제품 위치</h3>${origins}
</section>`;
}

type ThemeSummary = ReturnType<typeof checkAllThemes>;

function overviewPage(sum: ThemeSummary): string {
  const def = resolveColorTheme();
  return `<section class="page" id="overview" data-search="개요 시작 overview" aria-labelledby="h-overview">
<h2 id="h-overview">Gestalt 컬러 시스템과 시각화 시스템</h2>
<p class="lede">Gestalt 제품군이 함께 쓰는 색 역할, 시각화 요소, 모션 규칙을 한곳에서 봐요.</p>
<dl class="meta">
<dt>기본 테마</dt><dd><span class="sw" style="background:${def.colors.background}"></span>차콜 ${esc(def.colors.background!)} 배경, <span class="sw" style="background:${def.colors['accent-fill']}"></span>시안 ${esc(def.colors['accent-fill']!)} 강조</dd>
<dt>선택 범위</dt><dd>배경 ${BACKGROUND_PRESETS.length}개 × 강조색 ${ACCENT_PRESETS.length}개 = ${sum.themes}개 조합. 배경과 강조색은 따로 고른다</dd>
<dt>대비 검사</dt><dd>${sum.checks.toLocaleString('ko-KR')}건, 실패 ${sum.failures.length}건</dd>
<dt>시각화 카탈로그</dt><dd>${CATEGORIES.length}개 분류, ${CATALOG.length}개 항목 (조합 ${CATALOG.filter((c) => c.combo).length}개)</dd>
<dt>모션</dt><dd>${MOTIONS.length}개 규칙</dd>
<dt>적용 대상</dt><dd>${SCREENS.length}개 화면, 3차에 걸쳐 전환</dd>
</dl>
<h3>읽는 법</h3>
<p>왼쪽 목록에서 항목을 고르면 목적, 데이터와 표기, 예제, 상태와 조작, 출처가 차례로 나와요. 예제는 전부 실제 렌더러로 그린 결과이고 Video Digest 도식과 Lens 위젯은 제품 코드를 그대로 불러요.</p>
<p class="note">단계가 있는 그림은 이전과 다음 버튼, 또는 그림에 포커스를 두고 좌우 화살표로 넘겨요. 스크립트 없이 열면 마지막 단계가 보여요.</p>
</section>`;
}

function colorPage(sum: ThemeSummary): string {
  const def = resolveColorTheme();
  const bgOpts = BACKGROUND_PRESETS.map(
    (b) =>
      `<label><input type="radio" name="bg" value="${esc(b.id)}"${b.id === DEFAULT_THEME.background ? ' checked' : ''}><span class="sw" style="background:${b.color}"></span>${esc(b.name)}</label>`,
  ).join('');
  const acOpts = ACCENT_PRESETS.map(
    (a) =>
      `<label><input type="radio" name="ac" value="${esc(a.id)}"${a.id === DEFAULT_THEME.accent ? ' checked' : ''}><span class="sw" style="background:${a.dark}"></span>${esc(a.name)}</label>`,
  ).join('');
  const roles = Object.keys(def.colors);
  const perBg = BACKGROUND_PRESETS.map((b) => {
    const rows = ACCENT_PRESETS.map((a) =>
      checkThemeContrast(resolveColorTheme({ background: b.id, accent: a.id })),
    );
    const adjusted = rows.reduce((t, r) => t + r.adjusted, 0);
    const clean = rows.filter((r) => r.adjusted === 0).length;
    return `<tr><th scope="row"><span class="sw" style="background:${b.color}"></span>${esc(b.name)}</th><td>${rows.length}</td><td>${adjusted}</td><td>${clean}</td><td>${rows.reduce((t, r) => t + r.failures.length, 0)}</td></tr>`;
  }).join('');
  return `<section class="page" id="color" data-search="색 컬러 테마 배경 강조색 대비 color" aria-labelledby="h-color">
<h2 id="h-color">색상 실습</h2>
<p class="lede">배경과 강조색을 따로 골라 보세요. 선택은 이 문서 사이트에만 저장돼요.</p>
<div class="picker">
<fieldset><legend>배경 ${BACKGROUND_PRESETS.length}개</legend><div class="opts">${bgOpts}</div></fieldset>
<fieldset><legend>강조색 ${ACCENT_PRESETS.length}개</legend><div class="opts">${acOpts}</div></fieldset>
</div>
<p class="now" aria-live="polite" id="theme-now">현재 테마: ${esc(def.id)}</p>
<button type="button" class="btn" id="theme-reset">기본값(차콜, 시안)으로 되돌리기</button>
<h3>역할</h3>
<p>제품은 원색이 아니라 아래 역할 이름만 읽어요. CSS 변수는 <code>--gestalt-color-역할</code>이에요.</p>
<div class="tbl"><table class="grid" id="role-table"><thead><tr><th scope="col">역할</th><th scope="col">값</th></tr></thead><tbody>${roles
    .map(
      (r) =>
        `<tr><th scope="row"><code>${esc(r)}</code></th><td><span class="sw" style="background:var(--gestalt-color-${esc(r)})"></span><span data-role-value="${esc(r)}">${esc(def.colors[r]!)}</span></td></tr>`,
    )
    .join('')}</tbody></table></div>
<h3>보정 전후</h3>
<p>원색이 대비 기준에 못 미치면 배경 반대쪽으로 섞어 기준까지만 끌어올려요. 지금 고른 테마에서 보정이 들어간 역할이에요.</p>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">역할</th><th scope="col">원색</th><th scope="col">보정 결과</th><th scope="col">기준</th><th scope="col">대비 전 → 후</th></tr></thead><tbody id="adjust-body"></tbody></table></div>
<h3>대비 결과</h3>
<p>지금 고른 테마의 역할별 검사예요. 실패가 0이어야 제품에 써요.</p>
<p id="contrast-now"></p>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">역할</th><th scope="col">바탕</th><th scope="col">대비</th><th scope="col">기준</th><th scope="col">결과</th></tr></thead><tbody id="contrast-body"></tbody></table></div>
<h3>전체 ${sum.themes}개 테마</h3>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">배경</th><th scope="col">테마 수</th><th scope="col">보정 역할 수</th><th scope="col">보정 없는 테마</th><th scope="col">실패</th></tr></thead><tbody>${perBg}</tbody></table></div>
<h3>색만으로 구분하지 않기</h3>
<p>상태, 계열, 변경 종류는 색과 함께 기호나 선 모양을 붙여요.</p>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">구분</th><th scope="col">이름</th><th scope="col">색 아닌 단서</th></tr></thead><tbody>
${Object.entries(STATUS_CUES)
  .map(
    ([k, c]) =>
      `<tr><td>상태</td><td><span class="vs-badge vs-badge-${esc(k)}">${esc(c.symbol)} ${esc(c.label)}</span></td><td>기호 ${esc(c.symbol)}</td></tr>`,
  )
  .join('')}
${SERIES_CUES.map((s, i) => `<tr><td>계열</td><td><span class="sw" style="background:var(--gestalt-color-series-${i + 1})"></span>series-${i + 1}</td><td>${esc(s.label)}</td></tr>`).join('')}
${Object.entries(DIFF_KINDS)
  .map(
    ([k, d]) =>
      `<tr><td>변경</td><td class="vs-diff-${esc(k)}">${esc(d.symbol)} ${esc(d.label)}</td><td>기호 ${esc(d.symbol)}</td></tr>`,
  )
  .join('')}
</tbody></table></div>
</section>`;
}

function motionSpec(id: string): string {
  const m = MOTIONS.find((x) => x.id === id);
  if (!m) return '';
  return `<h3>모션 규칙</h3><dl class="meta"><dt>시작 조건</dt><dd>${esc(m.trigger)}</dd><dt>시작 상태</dt><dd>${esc(m.start)}</dd><dt>최종 상태</dt><dd>${esc(m.end)}</dd><dt>유지 요소</dt><dd>${chips(m.keep)}</dd><dt>움직이는 것</dt><dd>${chips(m.moving)}</dd><dt>모션 줄이기</dt><dd>${esc(m.reduced)}</dd><dt>반복과 되감기</dt><dd>${esc(m.replay)}</dd><dt>시간</dt><dd><code>${esc(m.timing.duration)}</code>, <code>${esc(m.timing.easing)}</code>${m.timing.stagger ? `, <code>${esc(m.timing.stagger)}</code>` : ''}</dd><dt>기존 자리</dt><dd>${chips(m.existing)}</dd></dl>`;
}

function motionPage(): string {
  return `<section class="page" id="motion" data-search="모션 움직임 줄이기 motion reduced" aria-labelledby="h-motion">
<h2 id="h-motion">모션 실습</h2>
<p class="lede">모든 모션은 최종 상태를 정지본으로 먼저 그리고, 시작 상태에서 그쪽으로 옮겨 가요. 움직임을 줄이면 전환 없이 단계만 바뀌어요.</p>
<div class="motion-toggle" role="group" aria-label="모션 설정"><span>모션:</span>
<button type="button" class="btn" data-motion="system" aria-pressed="true">시스템 설정 따르기</button>
<button type="button" class="btn" data-motion="reduce" aria-pressed="false">줄이기</button>
<button type="button" class="btn" data-motion="full" aria-pressed="false">켜기</button></div>
<p id="motion-now" aria-live="polite"></p>
<h3>토큰</h3>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">변수</th><th scope="col">값</th></tr></thead><tbody>${Object.entries(
    MOTION_TOKENS,
  )
    .map(
      ([k, val]) =>
        `<tr><th scope="row"><code>${esc(k)}</code></th><td><code>${esc(val)}</code></td></tr>`,
    )
    .join('')}</tbody></table></div>
<h3>규칙</h3><ul>${MOTIONS.map((m) => `<li><a href="#${esc(m.id)}">${esc(m.name)}</a> — ${esc(m.trigger)}</li>`).join('')}</ul>
<h3>예제로 확인하기</h3>
<p>아래 순차 공개 예제에서 모션을 줄이기로 바꾸고 다음을 눌러 보세요. 막대가 옮겨 가지 않고 바로 최종 자리에 나타나요.</p>
${examplesFor('motion-reveal').map(exampleHtml).join('')}
</section>`;
}

const STATUS_LABEL: Record<ScreenEntry['status'], string> = {
  planned: '예정',
  'in-progress': '진행 중',
  applied: '적용',
  verified: '검증 완료',
  'out-of-scope': '범위 밖',
};

function migrationPage(): string {
  const row = (s: ScreenEntry) =>
    `<tr><td>${s.phase}차</td><th scope="row">${esc(s.name)}</th><td>${s.files.map((f) => `<code>${esc(f)}</code>`).join('<br>')}</td><td>${esc(s.entry)}</td><td>${chips(s.visuals)}</td><td><ul>${s.baseline.preserve.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></td><td class="status-${s.status}">${STATUS_LABEL[s.status]}</td><td>${s.evidence.length ? `<ul>${s.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '-'}</td></tr>`;
  return `<section class="page" id="migration" data-search="이행 전환 화면 적용 migration" aria-labelledby="h-migration">
<h2 id="h-migration">제품 이행표</h2>
<p class="lede">화면마다 전환 차수, 생성 경로, 지켜야 할 값과 조작, 진행 상태를 적어요.</p>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">차수</th><th scope="col">화면</th><th scope="col">파일</th><th scope="col">생성 경로</th><th scope="col">시각화</th><th scope="col">보존</th><th scope="col">상태</th><th scope="col">증빙</th></tr></thead><tbody>${SCREENS.map(row).join('')}</tbody></table></div>
<h3>조사 항목</h3>
<div class="tbl"><table class="grid"><thead><tr><th scope="col">항목</th><th scope="col">범위</th><th scope="col">시각 요소</th><th scope="col">모션</th><th scope="col">후보</th></tr></thead><tbody>${SURVEY.map(
    (s) =>
      `<tr><th scope="row">${esc(s.name)}</th><td>${s.scope === 'gestalt' ? 'Gestalt' : '범위 밖(별도 Orca 플러그인)'}</td><td>${esc(s.visuals)}</td><td>${esc(s.motions)}</td><td>${esc(s.candidate)}</td></tr>`,
  ).join('')}</tbody></table></div>
</section>`;
}

function sidebar(): string {
  const groups = CATEGORIES.map((cat) => {
    const items = CATALOG.filter((c) => c.category === cat.id);
    return `<h2>${esc(cat.name)}</h2><ul>${items.map((c) => `<li><a href="#${esc(c.id)}">${esc(c.name)}${c.combo ? '<span class="tag">조합</span>' : ''}</a></li>`).join('')}</ul>`;
  }).join('');
  return `<aside class="side" id="side"><h1>Gestalt 시각 시스템</h1><p class="ver">컬러 시스템 ${esc(COLOR_SYSTEM_VERSION)}</p>
<label for="q" class="vs-muted" style="font-size:12px">항목 검색</label><input type="search" id="q" placeholder="이름, 목적, ID" autocomplete="off">
<button type="button" class="btn menu-btn" aria-expanded="false" aria-controls="side-nav">목록</button>
<p id="q-count" class="sr-only" role="status"></p>
<nav id="side-nav" aria-label="문서 목록"><h2>시작</h2><ul><li><a href="#overview">개요</a></li><li><a href="#color">색상 실습</a></li><li><a href="#motion">모션 실습</a></li><li><a href="#migration">제품 이행표</a></li></ul>${groups}</nav></aside>`;
}

/** 페이지 전환과 검색, 색 실습, 모션 토글. 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다 */
function siteJs(): string {
  return `(function(){
  var root = document.documentElement;
  root.classList.add('js');

  // 진입 모션은 제품에서 스크롤로 화면에 들어올 때 한 번만 돌아서 문서에서는 볼 틈이 없다. 예제마다 처음부터 다시 돌린다
  var ENTER_GAP = 70, ENTER_MS = 400, STEP_MS = 900;
  function enterTargets(stage){
    var out = [];
    stage.querySelectorAll('.vs-fig').forEach(function(fig){
      fig.querySelectorAll('.vs-title, .vs-body > :not(svg), .vs-body svg > :not(defs):not(title):not(desc), .vs-ctl, .vs-cap, .vs-src').forEach(function(el){
        // 단계로 공개할 요소는 단계 조작이 띄운다. 진입 애니메이션이 채운 불투명도가 숨김을 덮지 않게 뺀다
        if (!el.hasAttribute('data-at')) out.push(el);
      });
    });
    stage.querySelectorAll('.vs-product [data-widget] > *').forEach(function(el){ out.push(el); });
    return out;
  }
  function replay(art){
    var stage = art.querySelector('.stage');
    var msg = art.querySelector('.ex-msg');
    if (!stage) return;
    (art.vsTimers || []).forEach(clearTimeout);
    var timers = art.vsTimers = [];
    var figs = Array.prototype.slice.call(stage.querySelectorAll('[data-vs-steps]'));
    var dgs = Array.prototype.slice.call(stage.querySelectorAll('.vs-product figure.diagram'));
    if (window.gestaltVisual.reduced()) {
      figs.forEach(function(f){ window.gestaltVisual.setStep(f, Number(f.getAttribute('data-vs-steps'))); });
      if (msg) msg.textContent = '모션 줄이기 상태라 최종 상태로 바로 보여요. 모션 페이지에서 켜기를 고르면 재생돼요.';
      return;
    }
    var targets = enterTargets(stage);
    stage.classList.remove('vs-replay');
    dgs.forEach(function(d){ d.classList.add('armed'); d.classList.remove('play'); });
    targets.forEach(function(el, i){
      el.classList.add(el instanceof SVGElement ? 'vs-in-svg' : 'vs-in');
      el.style.setProperty('--i', String(i));
    });
    figs.forEach(function(f){ window.gestaltVisual.setStep(f, 1); });
    // 클래스를 뗀 상태를 한 번 그려야 같은 애니메이션이 처음부터 다시 돈다
    void stage.offsetWidth;
    stage.classList.add('vs-replay');
    dgs.forEach(function(d){ d.classList.add('play'); });
    if (msg) msg.textContent = '재생 중이에요';
    var entered = targets.length * ENTER_GAP + ENTER_MS;
    var most = 1;
    figs.forEach(function(f){ most = Math.max(most, Number(f.getAttribute('data-vs-steps')) || 1); });
    for (var k = 2; k <= most; k++) {
      (function(k){
        timers.push(setTimeout(function(){
          figs.forEach(function(f){ if (k <= (Number(f.getAttribute('data-vs-steps')) || 1)) window.gestaltVisual.setStep(f, k); });
        }, entered + (k - 2) * STEP_MS));
      })(k);
    }
    timers.push(setTimeout(function(){
      // 채움 상태가 남으면 단계 조작의 숨김을 덮어서 다 끝나면 진입 클래스를 걷는다
      stage.classList.remove('vs-replay');
      targets.forEach(function(el){ el.classList.remove('vs-in', 'vs-in-svg'); });
      if (msg) msg.textContent = '다 그렸어요';
    }, entered + Math.max(0, most - 1) * STEP_MS + (dgs.length ? 2600 : 0)));
  }
  document.querySelectorAll('[data-ex-replay]').forEach(function(b){
    b.hidden = false;
    b.addEventListener('click', function(){ replay(b.closest('.ex')); });
  });
  function dec(s){ try { return decodeURIComponent(s); } catch (e) { return ''; } }
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var links = Array.prototype.slice.call(document.querySelectorAll('#side-nav a'));
  function route(){
    var id = dec((location.hash || '#overview').slice(1)) || 'overview';
    var hit = document.getElementById(id);
    if (!hit || !hit.classList.contains('page')) { id = 'overview'; hit = document.getElementById(id); }
    pages.forEach(function(p){ p.classList.toggle('is-current', p === hit); });
    links.forEach(function(a){ if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.title = (hit.querySelector('h2') ? hit.querySelector('h2').textContent + ' — ' : '') + 'Gestalt 시각 시스템';
    if (window.gestaltVisual) window.gestaltVisual.init(hit);
    var side = document.getElementById('side');
    if (side) { side.classList.remove('open'); var mb = side.querySelector('.menu-btn'); if (mb) mb.setAttribute('aria-expanded', 'false'); }
  }
  window.addEventListener('hashchange', function(){ route(); var h = document.querySelector('.page.is-current h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); } });
  route();
  var q = document.getElementById('q');
  q.addEventListener('input', function(){
    var t = q.value.trim().toLowerCase();
    var shown = 0;
    links.forEach(function(a){
      var page = document.getElementById(dec(a.getAttribute('href').slice(1)));
      var text = (a.textContent + ' ' + (page ? page.getAttribute('data-search') || '' : '')).toLowerCase();
      a.parentNode.hidden = !!t && text.indexOf(t) < 0;
      if (!a.parentNode.hidden) shown++;
    });
    document.getElementById('q-count').textContent = t ? '결과 ' + shown + '개' : '';
    root.classList.toggle('searching', !!t);
    if (!t) route(); else pages.forEach(function(p){ p.classList.remove('is-current'); });
  });
  var mb = document.querySelector('.menu-btn');
  mb.addEventListener('click', function(){ var s = document.getElementById('side'); var open = !s.classList.contains('open'); s.classList.toggle('open', open); mb.setAttribute('aria-expanded', String(open)); });

  var rules = ${JSON.stringify(CONTRAST_RULES)};
  function fmt(n){ return (Math.round(n * 100) / 100).toFixed(2); }
  function paint(t){
    document.querySelectorAll('[data-role-value]').forEach(function(el){ el.textContent = t.colors[el.getAttribute('data-role-value')] || ''; });
    var adj = t.adjustments.filter(function(a){ return a.seed !== a.value; });
    document.getElementById('adjust-body').innerHTML = adj.length ? adj.map(function(a){
      return '<tr><th scope="row"><code>' + a.role + '</code></th><td><span class="sw" style="background:' + a.seed + '"></span>' + a.seed + '</td><td><span class="sw" style="background:' + a.value + '"></span>' + a.value + '</td><td>' + a.min + ':1</td><td>' + fmt(a.before) + ' → ' + fmt(a.after) + '</td></tr>';
    }).join('') : '<tr><td colspan="5">보정 없이 원색 그대로 써요.</td></tr>';
    var sys = window.gestaltTheme.system;
    var fails = 0, total = 0;
    var rows = [];
    rules.forEach(function(r){ r.on.forEach(function(on){
      var fg = t.colors[r.role], bg = t.colors[on];
      if (!fg || !bg) return;
      var c = sys.contrast(fg, bg); var ok = c >= r.min - 1e-9; total++; if (!ok) fails++;
      rows.push('<tr><th scope="row"><code>' + r.role + '</code></th><td><code>' + on + '</code></td><td>' + fmt(c) + ':1</td><td>' + r.min + ':1</td><td class="' + (ok ? 'ok' : 'ng') + '">' + (ok ? '✓ 통과' : '× 실패') + '</td></tr>');
    }); });
    document.getElementById('contrast-body').innerHTML = rows.join('');
    document.getElementById('contrast-now').textContent = total + '건 검사, 실패 ' + fails + '건';
    // 고를 때마다 읽어 주는 자리는 theme-now 하나로 둔다. 둘이 다 알리면 스크린 리더가 같은 변경을 두 번 읽는다
    document.getElementById('theme-now').textContent = '현재 테마: ' + t.id + (t.id === ${JSON.stringify(`${DEFAULT_THEME.background}/${DEFAULT_THEME.accent}`)} ? ' (기본값)' : '') + ', 실패 ' + fails + '건';
  }
  function sync(){
    var s = window.gestaltTheme.get();
    var t = window.gestaltTheme.resolve(s);
    document.querySelectorAll('input[name=bg]').forEach(function(i){ i.checked = i.value === t.background; });
    document.querySelectorAll('input[name=ac]').forEach(function(i){ i.checked = i.value === t.accent; });
    paint(t);
  }
  document.addEventListener('change', function(ev){
    var i = ev.target;
    if (i.name === 'bg') paint(window.gestaltTheme.set({ background: i.value }));
    if (i.name === 'ac') paint(window.gestaltTheme.set({ accent: i.value }));
  });
  document.getElementById('theme-reset').addEventListener('click', function(){ window.gestaltTheme.reset(); sync(); });
  sync();

  var MKEY = 'gestalt-visual-docs-motion';
  function setMotion(m){
    if (m === 'system') root.removeAttribute('data-gestalt-motion'); else root.setAttribute('data-gestalt-motion', m);
    try { localStorage.setItem(MKEY, m); } catch (e) {}
    document.querySelectorAll('[data-motion]').forEach(function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-motion') === m)); });
    document.getElementById('motion-now').textContent = window.gestaltVisual.reduced() ? '지금은 움직임을 줄인 상태예요. 단계는 전환 없이 바뀌어요.' : '지금은 전환 모션이 켜져 있어요.';
  }
  document.querySelectorAll('[data-motion]').forEach(function(b){ b.addEventListener('click', function(){ setMotion(b.getAttribute('data-motion')); }); });
  var saved = 'system'; try { saved = localStorage.getItem(MKEY) || 'system'; } catch (e) {}
  setMotion(saved);
})();`;
}

export interface DocsSite {
  html: string;
  /** 문서에 그려 넣은 카탈로그 ID. 검증이 렌더 누락을 찾는 데 쓴다 */
  renderedIds: string[];
}

export function buildDocsSite(): DocsSite {
  const sum = checkAllThemes();
  const pages = [
    overviewPage(sum),
    colorPage(sum),
    motionPage(),
    migrationPage(),
    ...CATALOG.map((c) => itemPage(c, motionSpec(c.id))),
  ];
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Gestalt 시각 시스템</title>
<style>${defaultThemeCss()}${SITE_CSS}${VISUAL_CSS}${DIGEST_DIAGRAM_STATIC_CSS}${WIDGET_CSS}</style>
<script>${themeRuntimeJs(DOCS_STORAGE_KEY)}</script>
</head>
<body>
<a class="skip" href="#main">본문으로 건너뛰기</a>
<div class="layout">${sidebar()}<main id="main" tabindex="-1">${pages.join('\n')}</main></div>
<script>${VISUAL_STEP_JS}</script>
<script>${WIDGET_RUNTIME_JS}</script>
<script>${siteJs()}</script>
</body>
</html>
`;
  const renderedIds = [...html.matchAll(/<section class="page" id="([^"]+)"/g)].map((m) => m[1]!);
  return { html, renderedIds };
}
