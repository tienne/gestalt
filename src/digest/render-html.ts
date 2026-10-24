import { CAPTION_LABEL, formatTime, stripNumbering, watchUrlAt } from './format.js';
import { frameFileName } from './frames.js';
import { renderDigestMarkdown } from './render-md.js';
import { DIFFICULTY_LABEL, isPreset, LENGTH_LABEL, reportKey, reportLabel } from './reports.js';
import { VIEWER_JS } from './viewer-js.js';
import {
  boldPattern,
  keywordPattern,
  REPORT_DIFFICULTIES,
  REPORT_LENGTHS,
  type Bullet,
  type Cite,
  type Digest,
  type Report,
  type Segment,
  type Transcript,
  youtubeWatchUrl,
} from './schema.js';

export interface RenderHtmlOptions {
  /** 프레임 파일이 있는지. 상대 경로 모드에서 없는 프레임은 자리를 만들지 않는다 */
  frameExists?: (fileName: string) => boolean;
  /** 켜면 프레임을 data URI로 싣는다. 파일 하나만 들고 다닐 때 쓴다 */
  inlineFrames?: boolean;
  loadFrame?: (fileName: string) => Buffer | null;
}

export interface RenderHtmlResult {
  html: string;
  warnings: string[];
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;

const e = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** research 렌더러의 예산과 같다. 한 장 5MB, 합계 15MB를 넘으면 그 프레임은 뺀다 */
class FrameBudget {
  private total = 0;

  constructor(private readonly warnings: string[]) {}

  dataUri(data: Buffer, fileName: string): string | null {
    if (data.length > MAX_IMAGE_BYTES) {
      this.warnings.push(`프레임이 5MB를 넘어 건너뛰었다: ${fileName}`);
      return null;
    }
    if (this.total + data.length > MAX_TOTAL_IMAGE_BYTES) {
      this.warnings.push(`프레임 합계가 15MB를 넘어 건너뛰었다: ${fileName}`);
      return null;
    }
    this.total += data.length;
    return `data:image/jpeg;base64,${data.toString('base64')}`;
  }
}

// 본문에 `</script>`가 들어 있어도 태그를 닫지 못하게 꺾쇠를 유니코드 이스케이프로 바꾼다
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * digest.json을 뷰어 HTML 한 장으로 바꾼다. LLM을 부르지 않는다.
 * 본문 글자는 escape한 뒤 굵게와 키워드 마커 두 가지만 태그로 바꾼다.
 */
export function renderDigestHtml(
  digest: Digest,
  transcript: Transcript,
  opts: RenderHtmlOptions = {},
): RenderHtmlResult {
  const warnings: string[] = [];
  const { meta, segments } = transcript;
  const long = meta.durationSec >= 3600;
  const isYoutube = meta.source === 'youtube' && Boolean(meta.videoId);
  const at = (i: number) => segments[i]?.startSec ?? 0;
  const loadFrame = opts.inlineFrames ? opts.loadFrame : undefined;
  const budget = loadFrame ? new FrameBudget(warnings) : null;

  const inline = (text: string, keywordIds: Set<string>): string =>
    e(text)
      .replace(boldPattern(), (_m, inner: string) => `<strong>${inner}</strong>`)
      .replace(keywordPattern(), (_m, id: string, label: string) => {
        if (!keywordIds.has(id)) {
          warnings.push(`키워드 목록에 없는 마커: ${id}`);
          return label;
        }
        return `<button type="button" class="kw" data-kw="${id}">${label}</button>`;
      });

  // 스크립트 줄마다 Tab이 멈추면 긴 영상에서 정지점이 수천 개라 줄 링크는 Tab 순서에서 뺀다
  const timeLink = (sec: number, tabbable = true): string => {
    const label = formatTime(sec, long);
    const url = watchUrlAt(meta, sec);
    if (!url) return `<span class="ts" data-sec="${sec}">${label}</span>`;
    const tab = tabbable ? '' : ' tabindex="-1"';
    return `<a class="ts" href="${e(url)}" target="_blank" rel="noopener" data-sec="${sec}"${tab}>${label}</a>`;
  };

  const cite = (c: Cite): string =>
    `<sup><button type="button" class="cite" data-key="${c.key}" data-from="${c.from}" data-to="${c.to}" aria-label="출처 ${c.key + 1}">[${c.key + 1}]</button></sup>`;

  const missingFrame = (subId: string, file: string) =>
    warnings.push(`프레임이 없어 자리를 비웠다: ${subId} (${file})`);

  // 확인 수단이 없는 렌더에서는 프레임이 없다고 경고하지 않는다. 예산 초과는 FrameBudget이 따로 경고한다
  // 리포트 여럿이 같은 프레임을 쓰면 data URI를 한 번만 만들어 예산을 두 번 쓰지 않는다
  const inlined = new Map<string, string | null>();
  const frame = (sec: number, subId: string): string => {
    const file = frameFileName(sec);
    let src: string | null = null;
    if (inlined.has(file)) {
      src = inlined.get(file)!;
    } else if (budget && loadFrame) {
      const data = loadFrame(file);
      if (data) src = budget.dataUri(data, file);
      else missingFrame(subId, file);
      inlined.set(file, src);
    } else if (opts.frameExists) {
      if (opts.frameExists(file)) src = `frames/${file}`;
      else missingFrame(subId, file);
    }
    if (!src) return '';
    const url = watchUrlAt(meta, sec);
    const img = `<img src="${e(src)}" alt="${formatTime(sec, long)} 장면" loading="lazy">`;
    const body = url
      ? `<a class="frame-link" href="${e(url)}" target="_blank" rel="noopener" data-sec="${sec}">${img}</a>`
      : `<span class="frame-link" data-sec="${sec}">${img}</span>`;
    return `<figure class="frame">${body}<figcaption>${timeLink(sec)}</figcaption></figure>`;
  };

  const reportsMeta = digest.reports.map((r) => ({ report: r, key: reportKey(r.options) }));
  const base = digest.reports[0]!.options;

  // 첫 리포트는 1차와 같은 id를 써서 이미 공유된 앵커가 그대로 열린다. 나머지는 id에 못 쓰는 ~로 접두를 붙여 겹치지 않게 한다
  const renderReport = (report: Report, ri: number, key: string) => {
    const { lead, sections, skipped, keywords } = report;
    const kwIds = new Set(keywords.map((k) => k.id));
    const pfx = ri === 0 ? '' : `r${ri}~`;
    const hidden = ri === 0 ? '' : ' hidden';
    const bullets = (list: Bullet[]): string =>
      `<ul>${list
        .map(
          (b) =>
            `<li>${inline(b.text, kwIds)}${cite(b.cite)}${b.children?.length ? bullets(b.children) : ''}</li>`,
        )
        .join('')}</ul>`;

    const sectionsHtml = sections
      .map((s, si) => {
        const subs = s.subsections
          .map(
            (sub, ui) =>
              `<div class="sub" id="sub-${pfx}${e(sub.id)}" data-from="${sub.cite.from}" data-to="${sub.cite.to}"><h3><span class="num">${si + 1}.${ui + 1}.</span> ${e(stripNumbering(sub.title))} ${timeLink(at(sub.cite.key))}</h3>${frame(sub.frameSec, sub.id)}${bullets(sub.bullets)}</div>`,
          )
          .join('');
        return `<section class="sec" id="sec-${pfx}${e(s.id)}"><h2><span class="num">${si + 1}.</span> ${e(stripNumbering(s.title))} ${timeLink(at(s.cite.key))}</h2><p class="conclusion">${inline(s.conclusion, kwIds)}${cite(s.cite)}</p>${subs}</section>`;
      })
      .join('');

    const toc = `<nav class="toc" aria-label="목차"><h2>목차</h2><ol>${sections
      .map(
        (s, si) =>
          `<li><a href="#sec-${pfx}${e(s.id)}" data-nav="sec-${pfx}${e(s.id)}">${si + 1}. ${e(stripNumbering(s.title))}</a><ol>${s.subsections
            .map(
              (sub, ui) =>
                `<li><a href="#sub-${pfx}${e(sub.id)}">${si + 1}.${ui + 1}. ${e(stripNumbering(sub.title))}</a></li>`,
            )
            .join('')}</ol></li>`,
      )
      .join('')}</ol></nav>`;

    const minimap = `<nav class="minimap" aria-label="섹션 이동" data-ri="${ri}"${hidden}>${sections
      .map(
        (s, si) =>
          `<a href="#sec-${pfx}${e(s.id)}" data-nav="sec-${pfx}${e(s.id)}" title="${e(stripNumbering(s.title))}" aria-label="${si + 1}. ${e(stripNumbering(s.title))}"><span aria-hidden="true">${si + 1}</span></a>`,
      )
      .join('')}</nav>`;

    const keywordsHtml = keywords.length
      ? `<section class="extra" id="${pfx}keywords"><h2>키워드</h2><dl>${keywords
          .map(
            (k) =>
              `<dt>${e(k.term)} ${timeLink(at(k.firstCite.key))}</dt><dd>${inline(k.explanation, kwIds)}</dd>`,
          )
          .join('')}</dl></section>`
      : '';

    const skippedHtml = skipped.length
      ? `<section class="extra" id="${pfx}skipped"><h2>요약에서 뺀 구간</h2><ul>${skipped
          .map(
            (s) =>
              `<li>${timeLink(at(s.from))} 문장 ${s.from + 1}-${s.to + 1}: ${inline(s.reason, kwIds)}</li>`,
          )
          .join('')}</ul></section>`
      : '';

    const scope = [
      report.options.range
        ? `<p class="report-scope">${formatTime(report.options.range[0], long)}~${formatTime(report.options.range[1], long)} 구간만 요약했어요.</p>`
        : '',
      report.options.prompt ? `<p class="report-scope">요청: ${e(report.options.prompt)}</p>` : '',
    ].join('');
    const body = `<div class="report" data-ri="${ri}" data-report="${e(key)}" lang="${e(report.options.lang)}"${hidden}>${scope}<section class="lead"><p class="q">${inline(lead.question, kwIds)}</p><p>${inline(lead.answer, kwIds)}</p><p class="takeaway">${inline(lead.takeaway, kwIds)}</p></section>
${toc}
${sectionsHtml}
${keywordsHtml}
${skippedHtml}</div>`;
    return { body, minimap };
  };
  const rendered = reportsMeta.map(({ report, key }, ri) => renderReport(report, ri, key));

  const pressed = (on: boolean) => `aria-pressed="${on ? 'true' : 'false'}"`;
  const customs = reportsMeta.filter(({ report }) => !isPreset(report.options, base));
  const reportBar = `<div class="report-bar" role="group" aria-label="리포트 고르기"><span class="bar-label">분량</span>${REPORT_LENGTHS.map(
    (l) =>
      `<button type="button" data-length="${l}" ${pressed(l === base.length)}>${LENGTH_LABEL[l]}</button>`,
  ).join('')}<span class="bar-label">난이도</span>${REPORT_DIFFICULTIES.map(
    (d) =>
      `<button type="button" data-difficulty="${d}" ${pressed(d === base.difficulty)}>${DIFFICULTY_LABEL[d]}</button>`,
  ).join('')}${
    customs.length
      ? `<label class="bar-label">다른 리포트 <select id="report-select">${reportsMeta
          .map(
            ({ report, key }, ri) =>
              `<option value="${ri}" data-report="${e(key)}">${e(reportLabel(report.options, long))}</option>`,
          )
          .join('')}</select></label>`
      : ''
  }</div><div id="report-missing" class="report-missing" role="status" hidden><p>이 조합의 리포트는 아직 없어요. 아래 명령을 세션에 붙여 넣으면 만들어요.</p><code id="report-cmd"></code> <button type="button" id="copy-cmd">명령 복사</button></div>`;

  const watchBase = isYoutube ? youtubeWatchUrl(meta.videoId!) : null;
  const player = isYoutube
    ? `<div id="player-slot" class="player-slot"><div id="player" class="player"><div id="player-frame"></div><a class="player-fallback" href="${e(watchBase!)}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${meta.videoId}/hqdefault.jpg" alt=""><span>유튜브에서 열기</span></a><button type="button" id="player-dock" class="player-dock" aria-label="미니 플레이어 닫기">×</button></div></div>`
    : `<div id="player-slot" class="player-slot"><div id="player" class="player player-local"><video id="player-video" controls playsinline preload="metadata"></video><p class="player-note">로컬 영상은 <code>gestalt digest serve ${e(digest.slug)}</code>로 열어야 재생돼요. 원본 파일을 옮겼으면 ingest를 다시 돌려 주세요.</p><button type="button" id="player-dock" class="player-dock" aria-label="미니 플레이어 닫기">×</button></div></div>`;

  const trLang = meta.translationLang;
  const hasTr = trLang !== undefined && segments.some((s) => s.translation);
  const trToggle = hasTr
    ? ` <button type="button" id="tr-toggle" class="tr-toggle" aria-pressed="true" hidden>번역</button>`
    : '';
  const tr = (s: Segment) =>
    hasTr && s.translation
      ? `<span class="tr" lang="${e(trLang ?? '')}">${e(s.translation)}</span>`
      : '';
  const script = `<div class="script"><h2>스크립트 <small>${e(CAPTION_LABEL[meta.captionSource])}</small>${trToggle}</h2><div id="script-body" class="script-body" tabindex="0" role="region" aria-label="영상 스크립트"><ol id="script-list">${segments
    .map(
      (s) =>
        `<li data-i="${s.i}">${timeLink(s.startSec, false)}<span class="txt">${e(s.text)}${tr(s)}</span></li>`,
    )
    .join('')}</ol></div></div>`;

  const facts = [meta.channel, meta.publishedAt, formatTime(meta.durationSec, long)]
    .filter(Boolean)
    .map((f) => `<span>${e(f!)}</span>`)
    .join('');

  const data = {
    videoId: isYoutube ? meta.videoId : null,
    localVideo: meta.source === 'file',
    watchBase,
    long,
    starts: segments.map((s) => s.startSec),
    slug: digest.slug,
    reports: reportsMeta.map(({ report, key }) => ({
      key,
      length: report.options.length,
      difficulty: report.options.difficulty,
      preset: isPreset(report.options, base),
      keywords: Object.fromEntries(
        report.keywords.map((k) => [
          k.id,
          {
            term: k.term,
            explanation: k.explanation.replace(keywordPattern(), '$2').replace(boldPattern(), '$1'),
            sec: at(k.firstCite.key),
          },
        ]),
      ),
      markdown: renderDigestMarkdown(digest, transcript, {
        frameExists: opts.frameExists,
        report,
      }),
    })),
  };

  const html = `<!doctype html>
<html lang="${e(base.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${e(meta.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="layout">
<aside class="side">${player}${script}</aside>
<main class="main">
<header class="head"><h1>${e(meta.title)}</h1><p class="facts">${facts}</p><div class="tools"><button type="button" id="copy-md">마크다운 복사</button><label>글자 크기 <input id="font-range" type="range" min="85" max="145" step="5" value="100"> <output id="font-value">100%</output></label></div>
${reportBar}
<noscript><p class="note">자바스크립트가 꺼져 있어 출처 툴팁과 키워드 팝업, 재생 따라가기, 리포트 전환이 동작하지 않아요.${isYoutube ? ' 시각 링크는 유튜브 새 탭으로 열려요.' : ''}</p></noscript></header>
${rendered.map((r) => r.body).join('\n')}
</main>
</div>
${rendered.map((r) => r.minimap).join('')}
<script type="application/json" id="digest-data">${embedJson(data)}</script>
<script>${VIEWER_JS}</script>
</body>
</html>
`;
  return { html, warnings: [...new Set(warnings)] };
}

// 토큰은 research 렌더러와 같은 값을 쓴다
const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#2563eb;--warn:#b45309;--chip:#f5f5f4;--hl:#fef3c7;--on-accent:#fff;--scale:1;--float-w:min(360px,60vw,calc(40vh * 16 / 9))}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#fbbf24;--chip:#292524;--hl:#422006;--on-accent:#0c0a09}}
:root[data-theme="dark"]{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#fbbf24;--chip:#292524;--hl:#422006;--on-accent:#0c0a09}
*{box-sizing:border-box}
html{font-size:calc(100% * var(--scale))}
body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
a{color:var(--accent)}
button{font:inherit;color:inherit}
.layout{display:grid;grid-template-columns:minmax(300px,420px) minmax(0,1fr);gap:32px;max-width:1360px;margin:0 auto;padding:0 56px 0 16px}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:12px;padding:16px 0}
.player{position:relative;background:#000;border-radius:8px;overflow:hidden;flex:none}
#player-frame{position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;pointer-events:none}
.player.is-live #player-frame{position:static;display:block;height:auto;aspect-ratio:16/9;opacity:1;pointer-events:auto}
.player.is-live .player-fallback{display:none}
.player-fallback{display:block;position:relative;color:#fff;text-decoration:none}
.player-fallback img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;opacity:.7}
.player-fallback span{position:absolute;inset:auto 0 0 0;padding:10px 14px;background:rgba(0,0,0,.6);font-weight:600}
.player-note{background:var(--chip);color:var(--muted);padding:12px 14px;font-size:.9em;margin:0}
.player-local video{display:none;width:100%;aspect-ratio:16/9;background:#000}
.player-local.is-live video{display:block}
.player-local.is-live .player-note{display:none}
.player-slot{flex:none}
.player-slot.is-floating{aspect-ratio:16/9}
.player.is-floating{position:fixed;right:calc(16px + env(safe-area-inset-right, 0px));bottom:calc(16px + env(safe-area-inset-bottom, 0px));width:var(--float-w);z-index:15;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.player-dock{display:none;position:absolute;top:6px;right:6px;width:40px;height:40px;border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;align-items:center;justify-content:center;font-size:18px;line-height:1}
.player.is-floating .player-dock{display:flex}
.script{display:flex;flex-direction:column;min-height:0;flex:1;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.script h2{margin:0;padding:8px 12px;font-size:.95em;border-bottom:1px solid var(--line)}
.script h2 small{color:var(--muted);font-weight:400}
.script-body{overflow:auto;flex:1;position:relative}
#script-list{list-style:none;margin:0;padding:4px 0}
#script-list li{display:flex;gap:10px;padding:4px 12px;font-size:.9em;line-height:1.55}
#script-list li.is-playing{background:var(--hl)}
.tr{display:block;color:var(--muted);font-size:.95em}
.script.hide-tr .tr{display:none}
.tr-toggle{float:right;border:1px solid var(--line);background:var(--card);border-radius:6px;padding:0 8px;font-size:.85em;font-weight:400;cursor:pointer}
.tr-toggle[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.ts{font-variant-numeric:tabular-nums;color:var(--accent);text-decoration:none;font-size:.85em;white-space:nowrap;cursor:pointer}
a.ts:hover{text-decoration:underline}
.main{padding:24px 0 96px;min-width:0}
.head h1{margin:0 0 4px;font-size:1.6em;line-height:1.35}
.facts{margin:0;color:var(--muted);display:flex;flex-wrap:wrap;gap:12px;font-size:.9em}
.tools{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:12px 0;font-size:.85em;color:var(--muted)}
.tools button{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:4px 10px;cursor:pointer}
.note{color:var(--warn);font-size:.9em}
.report-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;font-size:.85em}
.report-bar .bar-label{color:var(--muted);margin-left:6px}
.report-bar .bar-label:first-child{margin-left:0}
.report-bar button{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:3px 12px;cursor:pointer}
.report-bar button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.report-bar select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.report-missing{border:1px dashed var(--line);border-radius:8px;padding:8px 12px;margin:8px 0;font-size:.88em;background:var(--card)}
.report-missing p{margin:0 0 6px}
.report-missing code{display:block;white-space:nowrap;overflow-x:auto;background:var(--chip);padding:4px 8px;border-radius:4px;margin:0 0 6px}
.report-missing button{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:2px 10px;cursor:pointer}
.report-scope{color:var(--muted);font-size:.9em;margin:12px 0 0}
.lead{border-left:3px solid var(--accent);padding:4px 16px;margin:20px 0}
.lead .q{font-weight:700;font-size:1.1em}
.lead .takeaway{color:var(--muted)}
.toc{border:1px solid var(--line);border-radius:8px;padding:8px 20px;background:var(--card);margin:20px 0}
.toc h2{font-size:1em;margin:8px 0}
.toc ol{list-style:none;padding-left:0;margin:4px 0}
.toc ol ol{padding-left:16px;font-size:.92em}
.toc a{text-decoration:none;color:var(--fg)}
.toc a.is-current{color:var(--accent);font-weight:600}
.sec{scroll-margin-top:16px;padding-top:12px}
.sec h2{font-size:1.35em;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{scroll-margin-top:16px}
.sub h3{font-size:1.1em;margin:24px 0 8px}
.num{color:var(--muted)}
.conclusion{font-weight:500}
.frame{margin:8px 0 12px}
.frame img{display:block;width:100%;max-width:640px;height:auto;max-height:360px;aspect-ratio:auto 16/9;object-fit:contain;border-radius:6px;border:1px solid var(--line);cursor:pointer}
.frame figcaption{margin-top:2px}
.cite{border:0;background:none;padding:0 1px;color:var(--accent);cursor:pointer;font-size:.8em}
.kw{border:0;background:none;padding:0;border-bottom:1px dashed var(--accent);cursor:pointer}
.extra dt{font-weight:600;margin-top:8px}
.extra dd{margin:0 0 4px 0;color:var(--muted)}
.pop{position:absolute;z-index:20;max-width:min(420px,calc(100vw - 16px));background:var(--card);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:10px 12px;font-size:.88em}
.pop-head{display:flex;gap:6px;align-items:baseline;margin-bottom:4px}
.pop-range,.pop-more{color:var(--muted)}
.pop-lines{margin:0;padding-left:18px}
.pop-lines li.is-key{font-weight:600}
.pop p{margin:4px 0 0}
.minimap{position:fixed;right:12px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;z-index:10}
.minimap a{display:flex;width:28px;height:28px;border-radius:50%;align-items:center;justify-content:center;background:var(--card);border:1px solid var(--line);color:var(--muted);text-decoration:none;font-size:12px}
.minimap a.is-current{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
@media (max-width:900px){
.layout{grid-template-columns:minmax(0,1fr);padding:0 16px;gap:0}
.side{position:static;height:auto}
.script-body{max-height:40vh}
.minimap{display:none}
.main{padding-bottom:calc(var(--float-w) * 9 / 16 + 32px + env(safe-area-inset-bottom, 0px))}
}
`;
