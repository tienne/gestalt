import { PII_CORE_SOURCE } from './pii-core.js';

export interface DomRedactionOptions {
  /** true면 이후 화면이 바뀔 때마다(무한 스크롤, 지연 로딩) 다시 치환한다 */
  observe?: boolean;
}

/**
 * 웹 화면을 캡처하기 전에 DOM의 개인정보를 가짜 값으로 바꾸는 스크립트를 만든다.
 * 세션이 aside나 chrome-devtools의 evaluate로 실행한다. 반환값은 바꾼 개수뿐이고 값은 담지 않는다.
 *
 * 못 건드리는 곳: 닫힌 shadow root, 다른 출처의 iframe, canvas에 그려진 글자.
 * 이런 영역이 화면에 있으면 `pii: none`으로 적지 말고 `unchecked`로 남긴다.
 */
export function buildDomRedactionScript(seed: string, options: DomRedactionOptions = {}): string {
  const observe = options.observe === true;
  return (
    '(function () {\n' +
    'var createPii = ' +
    PII_CORE_SOURCE +
    ';\n' +
    'var pii = createPii(' +
    JSON.stringify(seed) +
    ');\n' +
    'var OBSERVE = ' +
    (observe ? 'true' : 'false') +
    ';\n' +
    DOM_BODY +
    '\n})()'
  );
}

const DOM_BODY = String.raw`
var AVATAR_RE = /avatar|profile|프로필|user-?photo|thumb-?user/i;
var BARCODE_RE = /barcode|qr-?code|qrcode|바코드|큐알/i;
var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
var AVATAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#e5e7eb"/><circle cx="48" cy="38" r="16" fill="#9ca3af"/><path d="M16 88c0-18 14-30 32-30s32 12 32 30z" fill="#9ca3af"/></svg>';
var AVATAR_URI = 'data:image/svg+xml;utf8,' + encodeURIComponent(AVATAR_SVG);

function barcodeUri(width, height, key) {
  var bars = '';
  var x = 0;
  var i = 0;
  while (x < width) {
    var h = pii.hash('bar', key + ':' + i);
    var w = 1 + (h % 3);
    if (i % 2 === 0) bars += '<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '" fill="#111827"/>';
    x += w;
    i++;
  }
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="' + width + '" height="' + height + '" fill="#fff"/>' + bars + '</svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

var counts = { text: 0, inputs: 0, attrs: 0, avatars: 0, barcodes: 0 };

function hintsOf(el) {
  return [el.getAttribute('type'), el.getAttribute('name'), el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('inputmode')].join(' ');
}

function redactTextNodes(root) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var p = node.parentElement;
      if (p && SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var pending = null;
  var node;
  while ((node = walker.nextNode())) {
    var text = node.nodeValue || '';
    if (!text.trim()) continue;
    var label = pii.labelKindOf(text);
    if (label) {
      pending = label;
      continue;
    }
    var r = pii.redactText(text, pending);
    pending = null;
    if (r.spans.length) {
      node.nodeValue = r.text;
      counts.text += r.spans.length;
    }
  }
}

function redactInputs(root) {
  var fields = root.querySelectorAll('input, textarea');
  for (var i = 0; i < fields.length; i++) {
    var el = fields[i];
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') continue;
    var value = el.value || '';
    if (!value) continue;
    var kind = pii.kindFromHints(hintsOf(el));
    var r = pii.redactText(value, kind);
    if (r.spans.length) {
      el.value = r.text;
      el.setAttribute('value', r.text);
      counts.inputs += r.spans.length;
    }
  }
}

function redactAttributes(root) {
  var names = ['alt', 'title', 'placeholder', 'aria-label'];
  var els = root.querySelectorAll('[alt], [title], [placeholder], [aria-label]');
  for (var i = 0; i < els.length; i++) {
    for (var j = 0; j < names.length; j++) {
      var v = els[i].getAttribute(names[j]);
      if (!v) continue;
      var r = pii.redactText(v, null);
      if (r.spans.length) {
        els[i].setAttribute(names[j], r.text);
        counts.attrs += r.spans.length;
      }
    }
  }
}

function classText(el) {
  var c = el.getAttribute('class') || '';
  return c + ' ' + (el.id || '') + ' ' + (el.getAttribute('alt') || '');
}

function redactAvatars(root) {
  var imgs = root.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    if (img.getAttribute('data-pii-done')) continue;
    if (AVATAR_RE.test(classText(img)) || AVATAR_RE.test(img.getAttribute('src') || '')) {
      img.removeAttribute('srcset');
      img.setAttribute('src', AVATAR_URI);
      if (img.hasAttribute('alt')) img.setAttribute('alt', '프로필 사진');
      img.removeAttribute('title');
      img.setAttribute('data-pii-done', '1');
      counts.avatars++;
    }
  }
  var all = root.querySelectorAll('[class*="avatar" i], [class*="profile" i], [class*="프로필"]');
  for (var k = 0; k < all.length; k++) {
    var el = all[k];
    if (el.tagName === 'IMG' || el.getAttribute('data-pii-done')) continue;
    var bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
      el.style.backgroundImage = 'url("' + AVATAR_URI + '")';
      el.setAttribute('data-pii-done', '1');
      counts.avatars++;
    }
  }
}

function redactBarcodes(root) {
  var els = root.querySelectorAll('img, canvas, svg, div, span');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.getAttribute('data-pii-done')) continue;
    if (!BARCODE_RE.test(classText(el)) && !(el.tagName === 'IMG' && BARCODE_RE.test(el.getAttribute('src') || ''))) continue;
    if (el.tagName !== 'IMG' && el.querySelector && el.querySelector('img, canvas, svg')) continue;
    var rect = el.getBoundingClientRect();
    var w = Math.max(60, Math.round(rect.width));
    var h = Math.max(24, Math.round(rect.height));
    var uri = barcodeUri(w, h, w + 'x' + h);
    if (el.tagName === 'IMG') {
      el.removeAttribute('srcset');
      el.setAttribute('src', uri);
      el.setAttribute('data-pii-done', '1');
    } else if (el.tagName === 'DIV' || el.tagName === 'SPAN') {
      el.style.backgroundImage = 'url("' + uri + '")';
      el.style.backgroundSize = '100% 100%';
      el.setAttribute('data-pii-done', '1');
    } else {
      var repl = document.createElement('img');
      repl.setAttribute('src', uri);
      repl.setAttribute('data-pii-done', '1');
      repl.style.width = w + 'px';
      repl.style.height = h + 'px';
      el.replaceWith(repl);
    }
    counts.barcodes++;
  }
}

function runAll() {
  redactTextNodes(document.body);
  redactInputs(document);
  redactAttributes(document);
  redactAvatars(document);
  redactBarcodes(document);
}

function start() {
  runAll();
  if (OBSERVE && typeof MutationObserver !== 'undefined' && !window.__piiObserver) {
    var timer = null;
    window.__piiObserver = new MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        window.__piiObserver.disconnect();
        try { runAll(); } finally {
          window.__piiObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
      }, 150);
    });
    window.__piiObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}

// addInitScript로 심으면 body가 생기기 전에 실행된다. 그때는 DOM이 준비되길 기다린다
if (document.body) start();
else document.addEventListener('DOMContentLoaded', start);

return counts;
`;
