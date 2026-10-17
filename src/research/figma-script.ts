import type { FigmaPlan } from './figma-plan.js';

export interface FigmaImageData {
  base64: string;
}

/** 이미지가 없는 자리의 캡션 끝에 붙는 표시. 이미지를 올린 뒤 fit 스크립트가 이 줄을 지운다 */
const NO_IMAGE_MARK = '(이미지 없음)';

/**
 * Plugin API 스크립트의 본문. `async () => {...}` 꼴이라 실행기가 그대로 호출한다.
 * 백틱과 템플릿 치환(달러+중괄호)은 쓰지 않는다. 계획, 이미지, 이미지 없음 표시는 아래 세 자리에 JSON으로 들어간다.
 */
const SCRIPT_TEMPLATE = String.raw`async () => {
  const PLAN = __PLAN__;
  const IMAGES = __IMAGES__;
  if (typeof figma === 'undefined' || typeof figma.createPage !== 'function') {
    return { ok: false, code: 'NO_FIGMA', message: '편집 권한이 있는 Figma 파일에서 실행해야 한다. 보기 전용 파일에는 figma 전역이 없다' };
  }
  let family = null;
  for (const f of ['Pretendard', 'Inter']) {
    try {
      await figma.loadFontAsync({ family: f, style: 'Regular' });
      await figma.loadFontAsync({ family: f, style: 'Bold' });
      family = f;
      break;
    } catch (err) {}
  }
  if (!family) return { ok: false, code: 'NO_FONT', message: 'Pretendard와 Inter를 모두 불러오지 못했다' };

  const W = PLAN.width;
  const PAD = 64;
  const INNER = W - PAD * 2;
  const rgb = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
  const solid = (h) => [{ type: 'SOLID', color: rgb(h) }];
  const STYLES = {
    title: { size: 32, bold: true, color: '#111111' },
    h2: { size: 24, bold: true, color: '#111111' },
    h3: { size: 18, bold: true, color: '#111111' },
    body: { size: 14, bold: false, color: '#222222' },
    caption: { size: 12, bold: false, color: '#666666' },
    notice: { size: 14, bold: true, color: '#8a4b00' },
  };

  const stats = { tables: 0, imageNodes: [], missingImages: [], imageSlots: [] };

  function addText(parent, str, styleName, name) {
    const s = STYLES[styleName] || STYLES.body;
    const t = figma.createText();
    t.fontName = { family: family, style: s.bold ? 'Bold' : 'Regular' };
    t.fontSize = s.size;
    t.fills = solid(s.color);
    t.characters = str;
    if (name) t.name = name;
    parent.appendChild(t);
    t.layoutSizingHorizontal = 'FILL';
    t.textAutoResize = 'HEIGHT';
    return t;
  }

  function vframe(name, width, gap, pad) {
    const f = figma.createFrame();
    f.name = name;
    f.layoutMode = 'VERTICAL';
    f.resize(width, 100);
    f.primaryAxisSizingMode = 'AUTO';
    f.counterAxisSizingMode = 'FIXED';
    f.itemSpacing = gap;
    f.paddingLeft = pad;
    f.paddingRight = pad;
    f.paddingTop = pad;
    f.paddingBottom = pad;
    f.fills = [];
    return f;
  }

  function addTable(parent, node, width) {
    stats.tables += 1;
    const cols = node.head.length;
    const weights = [];
    for (let c = 0; c < cols; c++) {
      let max = String(node.head[c]).length;
      for (const row of node.rows) max = Math.max(max, String(row[c] === undefined ? '' : row[c]).length);
      weights.push(Math.min(Math.max(max, 12), 60));
    }
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.floor((width * w) / total));
    const table = figma.createFrame();
    table.name = 'table';
    table.layoutMode = 'VERTICAL';
    table.resize(width, 100);
    table.primaryAxisSizingMode = 'AUTO';
    table.counterAxisSizingMode = 'FIXED';
    table.itemSpacing = 0;
    table.fills = [];
    parent.appendChild(table);
    table.layoutSizingHorizontal = 'FILL';
    const addRow = (cells, header) => {
      const row = figma.createFrame();
      row.name = header ? 'table-head' : 'table-row';
      row.layoutMode = 'HORIZONTAL';
      row.resize(width, 40);
      row.primaryAxisSizingMode = 'FIXED';
      row.counterAxisSizingMode = 'AUTO';
      row.itemSpacing = 0;
      row.fills = header ? solid('#eef0f2') : [];
      table.appendChild(row);
      for (let c = 0; c < cols; c++) {
        const cell = figma.createFrame();
        cell.name = 'cell';
        cell.layoutMode = 'VERTICAL';
        cell.resize(widths[c], 40);
        cell.primaryAxisSizingMode = 'AUTO';
        cell.counterAxisSizingMode = 'FIXED';
        cell.paddingLeft = 10;
        cell.paddingRight = 10;
        cell.paddingTop = 8;
        cell.paddingBottom = 8;
        cell.fills = [];
        cell.strokes = solid('#dde1e4');
        cell.strokeWeight = 1;
        row.appendChild(cell);
        cell.layoutSizingVertical = 'FILL';
        addText(cell, String(cells[c] === undefined ? '' : cells[c]), header ? 'h3' : 'body');
      }
    };
    addRow(node.head, true);
    for (const r of node.rows) addRow(r, false);
  }

  function decode(b64) {
    if (typeof figma.base64Decode === 'function') return figma.base64Decode(b64);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function addImages(parent, node) {
    const wrap = figma.createFrame();
    wrap.name = 'captures';
    wrap.layoutMode = 'HORIZONTAL';
    wrap.layoutWrap = 'WRAP';
    wrap.resize(INNER - 64, 100);
    wrap.primaryAxisSizingMode = 'FIXED';
    wrap.counterAxisSizingMode = 'AUTO';
    wrap.itemSpacing = 24;
    wrap.counterAxisSpacing = 24;
    wrap.fills = [];
    parent.appendChild(wrap);
    wrap.layoutSizingHorizontal = 'FILL';
    for (const item of node.items) {
      const card = vframe('capture:' + item.imageId, 240, 8, 0);
      wrap.appendChild(card);
      const rect = figma.createRectangle();
      rect.name = 'img:' + item.imageId;
      const data = IMAGES && IMAGES[item.imageId];
      let height = 240;
      let hash = null;
      if (data) {
        try {
          const image = figma.createImage(decode(data.base64));
          const size = await image.getSizeAsync();
          height = Math.max(40, Math.round((240 * size.height) / size.width));
          hash = image.hash;
        } catch (err) {}
      }
      rect.resize(240, height);
      if (hash) {
        rect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: hash }];
        stats.imageNodes.push({ id: item.imageId, nodeId: rect.id });
      } else {
        rect.fills = solid('#e4e6e8');
        stats.missingImages.push(item.imageId);
        stats.imageSlots.push({ id: item.imageId, nodeId: rect.id });
      }
      card.appendChild(rect);
      addText(card, hash ? item.caption : item.caption + __NO_IMAGE_TAIL__, 'caption');
    }
  }

  async function addNode(parent, node, width) {
    if (node.type === 'text') {
      addText(parent, node.text, node.style);
    } else if (node.type === 'table') {
      addTable(parent, node, width);
    } else if (node.type === 'images') {
      await addImages(parent, node);
    } else if (node.type === 'section') {
      const sec = vframe('section', width, 16, 32);
      sec.name = node.title;
      sec.fills = solid('#ffffff');
      sec.cornerRadius = 12;
      parent.appendChild(sec);
      sec.layoutSizingHorizontal = 'FILL';
      addText(sec, node.title, 'h2');
      for (const child of node.children) await addNode(sec, child, width - 64);
    }
  }

  const page = figma.createPage();
  page.name = PLAN.pageName;
  if (typeof figma.setCurrentPageAsync === 'function') await figma.setCurrentPageAsync(page);
  else figma.currentPage = page;

  const root = vframe(PLAN.pageName, W, 32, PAD);
  root.fills = solid('#f6f7f8');
  page.appendChild(root);
  for (const node of PLAN.nodes) await addNode(root, node, INNER);

  return {
    ok: true,
    pageId: page.id,
    rootId: root.id,
    tableCount: stats.tables,
    imageNodes: stats.imageNodes,
    missingImages: stats.missingImages,
    imageSlots: stats.imageSlots,
  };
}`;

function embed(value: unknown): string {
  return JSON.stringify(value)
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/**
 * function: `async () => {...}` 한 덩어리라 실행기가 그대로 호출한다.
 * body: 함수 껍데기를 벗겨 최상위 await와 return으로 쓴 본문이다. Figma 커넥터의 use_figma가 이 꼴만 실행한다.
 */
export type FigmaRunner = 'function' | 'body';

const FN_HEAD = 'async () => {\n';
const FN_TAIL = '\n}';

function shape(fn: string, runner: FigmaRunner | undefined): string {
  if (runner !== 'body' || !fn.startsWith(FN_HEAD) || !fn.endsWith(FN_TAIL)) return fn;
  return fn.slice(FN_HEAD.length, -FN_TAIL.length) + '\n';
}

/** 계획을 Figma 새 페이지로 그리는 Plugin API 스크립트. images가 없으면 이미지 자리는 회색 칸으로 남는다 */
export function buildFigmaScript(
  plan: FigmaPlan,
  images?: Record<string, FigmaImageData>,
  runner?: FigmaRunner,
): string {
  const script = SCRIPT_TEMPLATE.replace('__PLAN__', () => embed(plan))
    .replace('__IMAGES__', () => (images ? embed(images) : 'null'))
    .replace('__NO_IMAGE_TAIL__', () => embed('\n' + NO_IMAGE_MARK));
  return shape(script, runner);
}

/** 쓴 뒤 파일에서 이미지 fill이 남았는지 보는 스크립트. 탭을 닫기 전에 업로드가 끝났는지 확인하는 자리다 */
export function buildFigmaVerifyScript(
  pageId: string,
  expectedImageIds: string[],
  runner?: FigmaRunner,
): string {
  return shape(
    'async () => {\n' +
      '  const page = await figma.getNodeByIdAsync(' +
      embed(pageId) +
      ');\n' +
      "  if (!page) return { ok: false, code: 'NO_PAGE', message: '페이지를 찾지 못했다' };\n" +
      '  const expected = ' +
      embed(expectedImageIds) +
      ';\n' +
      '  const found = new Set();\n' +
      "  for (const n of page.findAll((x) => typeof x.name === 'string' && x.name.indexOf('img:') === 0)) {\n" +
      '    const fill = Array.isArray(n.fills) ? n.fills[0] : null;\n' +
      "    if (fill && fill.type === 'IMAGE' && fill.imageHash) found.add(n.name.slice(4));\n" +
      '  }\n' +
      '  const missing = expected.filter((id) => !found.has(id));\n' +
      '  return { ok: missing.length === 0, expected: expected.length, found: found.size, missing: missing };\n' +
      '}',
    runner,
  );
}

/**
 * upload_assets로 이미지를 올린 뒤 도는 스크립트. 회색 칸으로 그려 둔 사각형의 높이를 올린 이미지 비율에 맞추고
 * 캡션 끝의 이미지 없음 표시를 지운다. 이미지가 안 올라간 자리는 noImage로 알려준다
 */
export function buildFigmaFitScript(pageId: string, runner?: FigmaRunner): string {
  return shape(
    [
      'async () => {',
      '  const page = await figma.getNodeByIdAsync(' + embed(pageId) + ');',
      "  if (!page) return { ok: false, code: 'NO_PAGE', message: '페이지를 찾지 못했다' };",
      '  const tail = ' + embed('\n' + NO_IMAGE_MARK) + ';',
      '  const fitted = [];',
      '  const noImage = [];',
      "  for (const rect of page.findAll((x) => typeof x.name === 'string' && x.name.indexOf('img:') === 0)) {",
      '    const id = rect.name.slice(4);',
      '    const fill = Array.isArray(rect.fills) ? rect.fills[0] : null;',
      "    if (!fill || fill.type !== 'IMAGE' || !fill.imageHash) { noImage.push(id); continue; }",
      '    const size = await figma.getImageByHash(fill.imageHash).getSizeAsync();',
      '    rect.resize(rect.width, Math.max(40, Math.round((rect.width * size.height) / size.width)));',
      '    fitted.push(id);',
      '    for (const t of rect.parent ? rect.parent.children : []) {',
      "      if (typeof t.characters !== 'string' || !t.characters.endsWith(tail)) continue;",
      "      for (const seg of t.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(seg.fontName);",
      '      t.characters = t.characters.slice(0, -tail.length);',
      '    }',
      '  }',
      '  return { ok: noImage.length === 0, fitted: fitted, noImage: noImage };',
      '}',
    ].join('\n'),
    runner,
  );
}
