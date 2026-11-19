import { createHash } from 'node:crypto';
import { pdfTextNotices } from './lens-source.js';
import { unitLabel } from './render-lens.js';
import type { Cite } from './schema.js';
import type { SlideSource } from './slides.js';
import { escapeXml as e } from './svg.js';

export function slideLabel(deck: SlideSource, key: number): string {
  const n = deck.transcript.segments[key]?.page;
  const ocr = deck.source.pages.some((p) => p.n === n && p.textMethod === 'ocr');
  return `슬라이드 ${unitLabel(deck.transcript, key)}${ocr ? ' (OCR)' : ''}`;
}

export function slideCiteHtml(cite: Cite, deck: SlideSource): string {
  const label = slideLabel(deck, cite.key);
  return `<button type="button" class="slide-cite" data-slide-source="${e(cite.source!)}" data-slide-key="${cite.key}" aria-haspopup="dialog" aria-label="${e(label)}, 문단 ${cite.key + 1}">${e(label)}</button>`;
}

export function slideDialogHtml(id: string, deck: SlideSource, omitCrops?: boolean): string {
  const pages = new Map(deck.source.pages.map((page) => [page.n, page]));
  const units = new Map<number, typeof deck.transcript.segments>();
  for (const seg of deck.transcript.segments) {
    const page = seg.page ?? 0;
    const list = units.get(page) ?? [];
    list.push(seg);
    units.set(page, list);
  }
  const sections = [...units]
    .map(([page, segments]) => {
      const img = omitCrops ? undefined : pages.get(page);
      const image = img
        ? `<img src="${e(id)}/${e(img.image)}" alt="슬라이드 ${page}쪽" width="${img.width}" height="${img.height}" loading="lazy">`
        : '';
      const lines = segments
        .map(
          ({ i, text }) =>
            `<li data-slide-unit="${i}" value="${i + 1}" tabindex="-1">${e(text)}</li>`,
        )
        .join('');
      return `<section data-slide-page="${page}" hidden><h3>${page > 0 ? `${page}쪽` : '추출 텍스트'}</h3><div class="slide-original">${image}<ol aria-label="추출 문단">${lines}</ol></div></section>`;
    })
    .join('');
  const status = pdfTextNotices(deck.source.pages)
    .map((notice) => `<p class="src-note">${e(notice)}</p>`)
    .join('');
  const url = deck.transcript.meta.url;
  const open =
    url && /^https?:\/\//.test(url)
      ? ` <a class="slide-open-original" href="${e(url)}" target="_blank" rel="noopener noreferrer">PDF 열기</a>`
      : '';
  return `<dialog class="slide-dialog" id="${e(id)}" aria-labelledby="${e(id)}-title"><header><h2 id="${e(id)}-title">${e(deck.transcript.meta.title)}</h2><div>${open} <button type="button" class="slide-close" autofocus>닫기</button></div></header>${status}${sections}</dialog>`;
}

export const SLIDE_CSS = `
.slide-cite{display:inline-block;margin-inline:.3em;padding:.1em .4em;border:1px solid var(--line);border-radius:.35em;background:var(--chip);color:var(--accent);font:inherit;font-size:.8em;cursor:pointer}
.slide-comparison{margin:.45em 0;padding:.5em .75em;border-inline-start:3px solid var(--accent);background:var(--chip)}
.slide-comparison p{margin:.2em 0}.slide-comparison blockquote{margin:.2em 0 .4em 1em}
.slide-dialog{width:min(68rem,90vw);max-height:85dvh;padding:1rem;border:1px solid var(--line);border-radius:.6rem;background:var(--bg);color:var(--fg)}
.slide-dialog::backdrop{background:#0009}
.slide-dialog header{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.slide-dialog img{display:block;width:100%;height:auto;border:1px solid var(--line)}
.slide-original{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:1rem}
.slide-original ol{padding-inline-start:2rem;margin:0}.slide-original li{padding:.35em}
.slide-original .is-slide-key{background:var(--hl);outline:2px solid var(--accent);scroll-margin:1rem}
`;

export const SLIDE_VIEWER_JS = `
(function(){
  document.addEventListener('click', async function(event){
    var button = event.target.closest('.slide-cite');
    if (!button) {
      var close = event.target.closest('.slide-close');
      if (close) close.closest('dialog').close();
      return;
    }
    var id = button.dataset.slideSource;
    var deck = document.getElementById(id);
    // 리포트가 뷰어에 바로 들어올 때 새 원문 창이 아직 없으면 그 창만 가져온다.
    if (!deck && location.protocol !== 'file:') {
      try {
        var response = await fetch(location.pathname, {cache:'no-store', credentials:'same-origin'});
        if (!response.ok) return;
        var html = new DOMParser().parseFromString(await response.text(), 'text/html');
        deck = document.getElementById(id);
        if (!deck) {
          var next = html.getElementById(id);
          if (!next || !next.matches('dialog.slide-dialog')) return;
          deck = document.body.appendChild(document.importNode(next, true));
        }
      } catch (error) { return; }
    }
    if (!deck) return;
    var unit = deck.querySelector('[data-slide-unit="' + button.dataset.slideKey + '"]');
    if (!unit) return;
    var page = unit.closest('[data-slide-page]');
    var original = deck.querySelector('.slide-open-original');
    if (original && Number(page.dataset.slidePage) > 0) {
      original.href = original.href.split('#')[0] + '#page=' + page.dataset.slidePage;
    }
    deck.querySelectorAll('[data-slide-page]').forEach(function(section){ section.hidden = section !== page; });
    deck.querySelectorAll('.is-slide-key').forEach(function(line){ line.classList.remove('is-slide-key'); });
    unit.classList.add('is-slide-key');
    if (!deck.open) deck.showModal();
    unit.focus({preventScroll:true});
    unit.scrollIntoView({block:'nearest'});
  });
})();
`;

export const SLIDE_VIEWER_JS_SHA256 = createHash('sha256').update(SLIDE_VIEWER_JS).digest('base64');
