import type { FigmaPlan } from './figma-plan.js';

export interface FigmaImageData {
  base64: string;
}

/**
 * Plugin API 스크립트의 본문. `async () => {...}` 꼴이라 실행기가 그대로 호출한다.
 * 백틱과 템플릿 치환(달러+중괄호)은 쓰지 않는다. 계획과 이미지는 아래 두 자리에 JSON으로 들어간다.
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

  const stats = { tables: 0, imageNodes: [], missingImages: [] };

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
      weights.push(Math.min(Math.max(max, 6), 60));
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
        cell.layoutAlign = 'STRETCH';
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
      }
      card.appendChild(rect);
      addText(card, hash ? item.caption : item.caption + '\n(이미지 없음)', 'caption');
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
  };
}`;

function embed(value: unknown): string {
  return JSON.stringify(value)
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/** 계획을 Figma 새 페이지로 그리는 Plugin API 스크립트. images가 없으면 이미지 자리는 회색 칸으로 남는다 */
export function buildFigmaScript(plan: FigmaPlan, images?: Record<string, FigmaImageData>): string {
  return SCRIPT_TEMPLATE.replace('__PLAN__', () => embed(plan)).replace('__IMAGES__', () =>
    images ? embed(images) : 'null',
  );
}

/** 쓴 뒤 파일에서 이미지 fill이 남았는지 보는 스크립트. 탭을 닫기 전에 업로드가 끝났는지 확인하는 자리다 */
export function buildFigmaVerifyScript(pageId: string, expectedImageIds: string[]): string {
  return (
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
    '}'
  );
}
