import type { NodeKind } from './types.js';

// 밝은 화면은 600 톤, 어두운 화면은 400 톤이다. 같은 색상환 자리라 테마를 바꿔도 같은 종류로 읽힌다
const KIND_COLORS: Record<NodeKind, { light: string; dark: string }> = {
  service: { light: '#2563eb', dark: '#60a5fa' },
  micro_app: { light: '#0369a1', dark: '#7dd3fc' },
  feature: { light: '#0891b2', dark: '#22d3ee' },
  screen: { light: '#4f46e5', dark: '#818cf8' },
  gateway: { light: '#475569', dark: '#94a3b8' },
  endpoint: { light: '#059669', dark: '#34d399' },
  app_module: { light: '#7c3aed', dark: '#a78bfa' },
  external_service: { light: '#d97706', dark: '#fbbf24' },
  db_table: { light: '#dc2626', dark: '#f87171' },
  datastore: { light: '#be123c', dark: '#fb7185' },
  workflow: { light: '#0284c7', dark: '#38bdf8' },
  build: { light: '#0d9488', dark: '#2dd4bf' },
  artifact: { light: '#9333ea', dark: '#c084fc' },
  deploy_target: { light: '#ea580c', dark: '#fb923c' },
  domain: { light: '#db2777', dark: '#f472b6' },
  cdn: { light: '#4338ca', dark: '#a5b4fc' },
  bucket: { light: '#16a34a', dark: '#4ade80' },
  cloud_account: { light: '#57534e', dark: '#a8a29e' },
};

// 24 격자 선 아이콘. 이모지는 플랫폼마다 모양이 달라서 path로 직접 그린다
const KIND_ICONS: Record<NodeKind, string> = {
  service:
    '<path d="M12 3.5l8.5 4.3L12 12 3.5 7.8z"/><path d="M3.5 12.2L12 16.5l8.5-4.3"/><path d="M3.5 16.4L12 20.7l8.5-4.3"/>',
  micro_app:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M17 13.5v7M13.5 17h7"/>',
  feature:
    '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  screen:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><path d="M6.5 6.8h.01M9 6.8h.01"/>',
  gateway: '<path d="M12 3l7.5 3v5.5c0 4.4-3.1 8-7.5 9.5-4.4-1.5-7.5-5.1-7.5-9.5V6z"/>',
  endpoint: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5.5l-3 13"/>',
  app_module:
    '<rect x="3.5" y="4" width="17" height="7" rx="1.8"/><rect x="3.5" y="13" width="17" height="7" rx="1.8"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  external_service:
    '<path d="M9 3v4.5M15 3v4.5"/><path d="M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>',
  db_table:
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  datastore:
    '<ellipse cx="12" cy="5" rx="7.5" ry="2.5"/><path d="M4.5 5v4.5c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V5"/><path d="M4.5 9.5V14c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V9.5"/><path d="M4.5 14v4.5c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V14"/>',
  workflow: '<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/>',
  build:
    '<path d="M14.5 6.2a4 4 0 0 0-5.3 5.3L3.5 17.2l3.3 3.3 5.7-5.7a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.5-.2-.2-2.5z"/>',
  artifact:
    '<path d="M12 2.8l8.5 4.7v9L12 21.2l-8.5-4.7v-9z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9.2"/>',
  deploy_target:
    '<path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.6a4.95 4.95 0 0 1-.8 9.9z"/><path d="M12 11v5M9.8 13.2L12 11l2.2 2.2"/>',
  domain:
    '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cdn: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>',
  bucket:
    '<ellipse cx="12" cy="6.5" rx="8" ry="2.5"/><path d="M4 6.5l2 13a2 2 0 0 0 2 1.5h8a2 2 0 0 0 2-1.5l2-13"/>',
  cloud_account:
    '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.2a3.5 3.5 0 0 1 6.4 0M14.5 10h3M14.5 13.5h3"/>',
};

// 플랫폼 칩 아이콘. 앱 둘은 칩만 보고 바로 알아보게 공식 로고를 채워 그린다. 모양은 simple-icons(CC0)에서 가져왔다
const PLATFORM_ICONS: Record<string, string> = {
  web: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/>',
  android: `<path fill="currentColor" stroke="none" d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z"/>`,
  ios: `<path fill="currentColor" stroke="none" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>`,
};

const UI_ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  focus:
    '<circle cx="12" cy="12" r="3"/><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/>',
  legend: '<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/>',
  question:
    '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.6M12 17h.01"/>',
  person: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  system:
    '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  flow: '<path d="M3.5 7h9M3.5 17h5M12.5 7l3 3-3 3M8.5 17l3-3"/><circle cx="18.5" cy="10" r="2"/>',
};

function symbol(id: string, body: string): string {
  return (
    `<symbol id="${id}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</g></symbol>`
  );
}

/** 페이지에 한 번만 싣는 아이콘 묶음. 카드와 단추는 use로 가져다 쓴다 */
export function renderIconSprite(): string {
  const kinds = (Object.keys(KIND_ICONS) as NodeKind[])
    .sort()
    .map((k) => symbol(`i-${k}`, KIND_ICONS[k]));
  const ui = Object.keys(UI_ICONS)
    .sort()
    .map((k) => symbol(`u-${k}`, UI_ICONS[k]!));
  const platforms = Object.keys(PLATFORM_ICONS)
    .sort()
    .map((k) => symbol(`p-${k}`, PLATFORM_ICONS[k]!));
  return `<svg class="sprite" aria-hidden="true" focusable="false"><defs>${[...kinds, ...ui, ...platforms].join('')}</defs></svg>`;
}

export function iconUse(id: string, cls = ''): string {
  const c = cls ? ` class="${cls}"` : '';
  return `<svg${c} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
}

// 제품 브릭 색. 흰 글자를 올리므로 두 테마 다 같은 진한 색을 쓴다. 제품이 이보다 많으면 처음 색부터 다시 돈다
const PRODUCT_PALETTE = [
  '#0f766e',
  '#c2410c',
  '#be185d',
  '#0369a1',
  '#4d7c0f',
  '#92400e',
  '#6d28d9',
  '#475569',
] as const;
export const PRODUCT_COLORS = PRODUCT_PALETTE.length;

function productRules(): string {
  return PRODUCT_PALETTE.map((c, i) => `.p-${i}{--p:${c};}`).join('');
}

function kindRules(theme: 'light' | 'dark'): string {
  return (Object.keys(KIND_COLORS) as NodeKind[])
    .sort()
    .map((k) => `.k-${k}{--kind:${KIND_COLORS[k][theme]};}`)
    .join('');
}

const LIGHT_TOKENS = `
  color-scheme: light;
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-2: #f1f3f6;
  --border: #e3e6ea;
  --border-strong: #cdd2d9;
  --text: #1b1f24;
  --muted: #6b7280;
  --accent: #2563eb;
  --accent-soft: rgba(37, 99, 235, 0.14);
  --on-accent: #ffffff;
  --edge: #7b8494;
  --edge-alpha: 0.55;
  --edge-strong: #3f4753;
  --lane: rgba(100, 116, 139, 0.085);
  --lane-line: rgba(100, 116, 139, 0.16);
  --warn: #b45309;
  --warn-soft: #fef3c7;
  --ok: #15803d;
  --ok-soft: #dcfce7;
  --live: #0369a1;
  --live-soft: #e0f2fe;
  --x-account: #c026d3;
  --frame: rgba(3, 105, 161, 0.05);
  --frame-line: #0369a1;
  --loads: #0369a1;
  --hit: #f59e0b;
  --brick-base: #ffffff;
  --brick-tint: 24%;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.04);
  --shadow-hover: 0 6px 16px rgba(16, 24, 40, 0.1);
  --shadow-pop: 0 12px 32px rgba(16, 24, 40, 0.14), 0 2px 6px rgba(16, 24, 40, 0.06);
`;

const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #0f1115;
  --surface: #171a21;
  --surface-2: #1e222b;
  --border: #2a2f3a;
  --border-strong: #3b4250;
  --text: #e6e8ec;
  --muted: #8b93a1;
  --accent: #60a5fa;
  --accent-soft: rgba(96, 165, 250, 0.2);
  --on-accent: #0b1220;
  --edge: #8d96a8;
  --edge-alpha: 0.5;
  --edge-strong: #dde1e8;
  --lane: rgba(148, 163, 184, 0.06);
  --lane-line: rgba(148, 163, 184, 0.13);
  --warn: #fbbf24;
  --warn-soft: rgba(251, 191, 36, 0.14);
  --ok: #4ade80;
  --ok-soft: rgba(74, 222, 128, 0.12);
  --live: #38bdf8;
  --live-soft: rgba(56, 189, 248, 0.14);
  --x-account: #e879f9;
  --frame: rgba(125, 211, 252, 0.06);
  --frame-line: #7dd3fc;
  --loads: #7dd3fc;
  --hit: #fbbf24;
  --brick-base: #171a21;
  --brick-tint: 44%;
  --shadow: none;
  --shadow-hover: 0 6px 18px rgba(0, 0, 0, 0.4);
  --shadow-pop: 0 16px 40px rgba(0, 0, 0, 0.55);
`;

const LAYOUT_CSS = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  background: var(--bg); color: var(--text);
  font: 14px/1.45 var(--font); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
.bar {
  flex: none; height: 48px; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px;
  background: var(--surface); border-bottom: 1px solid var(--border); position: relative; z-index: 20;
}
.bar h1 { margin: 0; font-size: 14px; font-weight: 650; white-space: nowrap; }
.crumbs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; font-size: 13px; color: var(--muted); }
.crumbs::before { content: ''; width: 1px; height: 16px; background: var(--border); margin: 0 8px 0 4px; flex: none; }
.crumbs[hidden] { display: none; }
.crumbs button { border: 0; background: none; padding: 4px 6px; border-radius: 6px; cursor: pointer; color: var(--muted); white-space: nowrap; }
.crumbs button:hover { background: var(--surface-2); color: var(--text); }
.crumbs .sep { opacity: 0.6; padding: 0 1px; }
.crumbs .here { color: var(--text); font-weight: 600; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
.focus-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 10px; margin-left: 6px; flex: none; max-width: 320px;
  border-radius: 14px; font-size: 12px; color: var(--accent); background: var(--accent-soft); white-space: nowrap;
}
.focus-chip[hidden] { display: none; }
.focus-chip svg { width: 14px; height: 14px; flex: none; }
.focus-chip b { overflow: hidden; text-overflow: ellipsis; color: var(--text); font-weight: 650; }
.focus-chip button { flex: none; width: 22px; height: 22px; padding: 3px; border: 0; border-radius: 11px; background: none; color: var(--accent); cursor: pointer; }
.focus-chip button:hover { background: var(--accent-soft); }
.btn[hidden] { display: none; }
.search {
  display: flex; align-items: center; gap: 6px; height: 32px; width: 240px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--muted);
}
.search:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search svg { width: 15px; height: 15px; flex: none; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
.search input::-webkit-search-cancel-button { display: none; }
.search .count { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.btn {
  height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; flex: none;
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); font-size: 13px; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: var(--surface-2); }
.btn svg { width: 16px; height: 16px; color: var(--muted); }
.btn.icon { width: 32px; padding: 0; justify-content: center; }
.btn[aria-expanded="true"] { background: var(--surface-2); border-color: var(--border-strong); }
.btn .n {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; background: var(--surface-2); color: var(--muted);
}
.btn .n.warn { background: var(--warn-soft); color: var(--warn); }
.seg { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); flex: none; }
.seg .btn { border: 0; height: 30px; }
.env-picker .btn { padding: 0 9px; color: var(--muted); font-variant-numeric: tabular-nums; }
.env-picker .btn[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.env-off { display: none !important; }
.zoom-level { min-width: 44px; text-align: center; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
#theme-btn .sun { display: none; }
#theme-btn[data-mode="dark"] .sun { display: block; }
#theme-btn[data-mode="dark"] .moon { display: none; }
#theme-btn[data-mode="light"] .moon { display: block; }
#theme-btn[data-mode="light"] .sun { display: none; }
.meta { display: flex; gap: 10px; padding-left: 4px; font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.main { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.stage { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.stage.panning { cursor: grabbing; }
.viewport { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.viewport.glide { transition: transform 0.28s cubic-bezier(0.2, 0.7, 0.2, 1); }
.level { position: relative; }
.level[hidden] { display: none; }
.links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.lane { fill: var(--lane); stroke: var(--lane-line); stroke-width: 1; }
.frame { fill: var(--frame); stroke: var(--frame-line); stroke-width: 1.25; stroke-opacity: 0.6; }
.band-line { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 4 4; }
.band-title {
  position: absolute; height: 20px; padding: 0 6px; display: flex; align-items: center; gap: 6px; border-radius: 4px;
  font-size: 12px; font-weight: 700; color: var(--text); background: var(--bg); white-space: nowrap; pointer-events: none;
}
.band-title .sw { width: 10px; height: 10px; border-radius: 2px; background: var(--p); }
.lane-title {
  position: absolute; display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 22px;
  font-size: 14px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden;
}
.lane-title .n {
  min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; color: var(--muted); background: var(--surface); border: 1px solid var(--border); font-variant-numeric: tabular-nums;
}
.node {
  --brick: color-mix(in srgb, var(--kind) var(--brick-tint), var(--brick-base));
  --brick-edge: color-mix(in srgb, var(--kind) 42%, var(--brick));
  --thick: 0 3px 0 var(--brick-edge);
  position: absolute; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 8px; row-gap: 2px; align-content: center;
  padding: 0 20px 0 10px; cursor: pointer;
  background: var(--brick); border: 1px solid var(--brick-edge); border-radius: 4px; box-shadow: var(--thick);
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s;
}
/* 카드 위 돌기. 하나를 그리고 box-shadow로 셋을 더 찍는다. 그림자 사본도 모서리 둥글기를 따라간다 */
.node::before {
  content: ''; position: absolute; left: 12px; top: -6px; width: 14px; height: 5px; border-radius: 3px 3px 0 0;
  background: var(--brick-edge); box-shadow: 20px 0 var(--brick-edge), 40px 0 var(--brick-edge), 60px 0 var(--brick-edge);
}
/* 같이 쓰는 카드는 돌기 자리에 제품 브릭을 꽂는다 */
.node.shared::before { display: none; }
.pbricks { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 1px); display: flex; gap: 2px; }
.pb {
  flex: none; height: 17px; padding: 0 6px; border-radius: 3px 3px 0 0;
  font: 700 10.5px/17px var(--font); color: #fff; background: var(--p); white-space: nowrap;
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--p) 70%, #000);
}
.pb.more {
  border: 1px solid var(--border-strong); border-bottom: 0; line-height: 15px; cursor: pointer;
  color: var(--text); background: var(--surface); box-shadow: none;
}
.pb.more:hover, .pb.more[aria-expanded="true"] { color: var(--bg); background: var(--text); border-color: var(--text); }
.pb.more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* +N 드롭다운. 캔버스는 확대와 스크롤 상자 안이라 그 안에 두면 잘린다. 화면 기준으로 띄운다 */
.pmenu {
  position: fixed; z-index: 40; min-width: 168px; padding: 6px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px; box-shadow: 0 3px 0 var(--border-strong);
}
.pmenu[hidden] { display: none; }
.pmenu h3 { margin: 2px 6px 6px; font-size: 11px; font-weight: 600; color: var(--muted); }
.pmenu ul { margin: 0; padding: 0; list-style: none; }
.pmenu li { display: flex; align-items: center; gap: 8px; padding: 4px 6px; font-size: 13px; font-weight: 600; color: var(--text); }
.pmenu .pb { height: 15px; padding: 0 5px; font-size: 10px; line-height: 15px; }
.pmenu small { margin-left: auto; font-weight: 500; color: var(--muted); }
.node:hover { box-shadow: var(--thick), var(--shadow-hover); }
.node:focus { outline: none; }
.node:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.node.is-focus { border-color: var(--kind); }
.node.focus-root:not(.selected) { border-color: var(--accent); box-shadow: var(--thick), 0 0 0 3px var(--accent-soft); }
.node.selected { border-color: var(--accent); box-shadow: var(--thick), 0 0 0 4px var(--accent-soft), var(--shadow-hover); }
.node.anchor:not(.selected) { outline: 2px dashed var(--accent); outline-offset: 3px; }
.node.hit { box-shadow: var(--thick), 0 0 0 3px var(--hit); }
.node.hit.current { box-shadow: var(--thick), 0 0 0 4px var(--hit), var(--shadow-hover); }
.kc {
  grid-row: 1; display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 6px 0 4px; border-radius: 5px; align-self: center;
  font-size: 10.5px; font-weight: 650; line-height: 1; white-space: nowrap;
  color: color-mix(in srgb, var(--kind) 72%, var(--text)); background: color-mix(in srgb, var(--kind) 13%, transparent);
}
.kc svg { width: 12px; height: 12px; flex: none; color: var(--kind); }
.nm { grid-row: 1; grid-column: 2; display: flex; align-items: center; min-width: 0; font-size: 13px; font-weight: 600; line-height: 18px; }
.nm .t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tc {
  grid-row: 2; grid-column: 1 / -1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: 11px/16px var(--mono); color: var(--muted);
}
.guess {
  flex: none; margin-left: 6px; padding: 0 5px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px;
  color: var(--warn); background: var(--warn-soft);
}
.flow-badge {
  flex: none; display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; padding: 0 6px; border-radius: 8px;
  font-size: 10.5px; font-weight: 700; line-height: 16px; color: var(--on-accent);
  background: var(--accent); box-shadow: 0 2px 0 color-mix(in srgb, var(--accent) 60%, #000);
}
.flow-badge svg { width: 12px; height: 12px; flex: none; }
.flow-badge:hover { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }
/* 파스텔 브릭 위에서 연한 배지는 묻힌다. 카드 안 추정 배지는 꽉 채운다 */
.node .guess { color: var(--bg); background: var(--warn); }
.go { position: absolute; right: 8px; bottom: 4px; font-size: 14px; line-height: 1; color: var(--muted); }
.pf {
  flex: none; display: inline-flex; align-items: center; gap: 3px; height: 16px; margin-left: 4px; padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--muted) 45%, transparent); border-radius: 4px;
  font-size: 10px; font-weight: 650; line-height: 1; color: var(--muted);
}
.pf svg { width: 11px; height: 11px; flex: none; }
.tc.dom { font-family: var(--font); color: var(--text); }
.l2 { grid-row: 2; grid-column: 1 / -1; display: flex; align-items: center; min-width: 0; }
.l2 .pf:first-child { margin-left: 0; }
/* 도메인 흐름. 행위자 줄은 번갈아 옅게 칠해 줄 경계를 읽히게 하고, 옆 흐름은 정상 흐름과 색으로 가른다 */
.flane { fill: var(--lane); stroke: var(--lane-line); stroke-width: 1; }
.flane.alt { fill: color-mix(in srgb, var(--lane) 55%, var(--bg)); }
.fstage {
  position: absolute; height: 26px; display: flex; align-items: center; justify-content: center; padding: 0 10px;
  border-radius: 999px; background: var(--lane); border: 1px solid var(--lane-line);
  font: 600 12px/1 var(--mono); color: var(--text); pointer-events: none; box-sizing: border-box;
}
.fstage span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fstage.side { font-family: inherit; color: var(--muted); border-style: dashed; }
.fstage.named { font-family: inherit; }
.fstage-line { stroke: var(--lane-line); stroke-width: 1; stroke-dasharray: 4 4; }
.fstage-line.side { stroke-width: 1.5; stroke-dasharray: none; }
.flane-title {
  position: absolute; display: flex; align-items: flex-start; gap: 6px; max-width: 112px;
  font-size: 13px; font-weight: 700; line-height: 18px; color: var(--text); pointer-events: none;
}
.flane-title span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: keep-all; }
.flane-title svg { width: 15px; height: 15px; flex: none; margin-top: 1.5px; color: var(--muted); }
.flow-step { --kind: var(--accent); padding: 0 12px 0 12px; }
.flow-step.p-side { --kind: var(--warn); }
.flow-step.doc-only { border-style: dashed; }
.flow-step .nm { grid-column: 1 / -1; white-space: normal; }
.flow-step .nm .t { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 17px; }
.flow-step .l2 { gap: 6px; }
.flow-step .st {
  min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font: 10.5px/16px var(--mono); padding: 0 5px; border-radius: 4px; color: var(--muted); background: var(--lane);
}
.flow-step .st.named { font-family: inherit; font-weight: 600; }
.flow-step .refs, .flow-step .qb {
  flex: none; display: inline-flex; align-items: center; gap: 2px; font-size: 10.5px; font-weight: 650; color: var(--muted);
}
.flow-step .qb { color: var(--warn); }
.flow-step .end {
  flex: none; font-size: 10.5px; line-height: 16px; font-weight: 700; padding: 0 5px; border-radius: 4px;
  color: var(--surface); background: var(--text);
}
.flow-step .refs svg, .flow-step .qb svg { width: 11px; height: 11px; }
.node .l2 { overflow: hidden; }
.link.flow-t { cursor: pointer; }
.legend-lines line.side-line { stroke: var(--warn); }
.swatch-step { display: inline-block; width: 30px; height: 14px; margin-right: 8px; border: 1.5px dashed var(--border-strong); border-radius: 4px; vertical-align: middle; }
.link.flow-t.p-side .edge { stroke: var(--warn); }
.link.flow-t.p-side .tip { fill: var(--warn); }
.link.flow-t .t-label {
  font-size: 11px; font-weight: 600; text-anchor: middle; fill: var(--muted);
  paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;
}
.link.flow-t .t-who { fill: var(--text); font-weight: 700; }
.link.flow-t .t-back { fill: var(--accent); font-weight: 700; }
.dr-body .refs-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; padding: 0; list-style: none; }
.dr-body .refs-list button {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--text); background: var(--surface); border: 1px solid var(--border);
}
.dr-body .refs-list button:hover { border-color: var(--accent); }
.dr-body .refs-list button svg { width: 12px; height: 12px; flex: none; color: var(--kind, var(--muted)); }
.flow-list { margin: 8px 0 0; padding: 0; list-style: none; }
.flow-list button {
  display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; text-align: left; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--text); background: none;
}
.flow-list button:hover { background: var(--lane); }
.link.x-account .edge { stroke: var(--x-account); stroke-opacity: 0.85; }
.link.x-account .tip { fill: var(--x-account); fill-opacity: 0.85; }
.link.e-contains .edge { stroke-opacity: 0.35; }
.link.e-loads .edge { stroke: var(--loads); stroke-opacity: 0.75; }
.link.e-loads .tip { fill: var(--loads); fill-opacity: 0.8; }
/* 근거가 확인된 로드 선은 점선으로 요청 흐름과 구분한다. 근거가 약한 선은 기존 파선이 그대로 이긴다 */
.link.e-loads .edge:not([stroke-dasharray]) { stroke-dasharray: 1 6; stroke-width: 2.5; }
.link .edge { fill: none; stroke: var(--edge); stroke-opacity: var(--edge-alpha); stroke-linecap: round; transition: stroke 0.15s, stroke-opacity 0.15s; }
.link .tip { fill: var(--edge); fill-opacity: 0.6; transition: fill 0.15s; }
.link .hit { fill: none; stroke: transparent; pointer-events: stroke; }
.link.bundle { cursor: pointer; }
.link:focus { outline: none; }
.link.lit .edge, .link:hover .edge { stroke: var(--edge-strong); stroke-opacity: 0.9; }
.link.lit .tip, .link:hover .tip { fill: var(--edge-strong); fill-opacity: 1; }
.link:focus-visible .edge { stroke: var(--accent); stroke-opacity: 1; }
.pill { opacity: 0; transition: opacity 0.15s; }
.link.lit .pill, .link:hover .pill, .link:focus-visible .pill { opacity: 1; }
.pill rect { fill: var(--surface); stroke: var(--border-strong); }
.pill text { fill: var(--text); font: 600 11px var(--font); text-anchor: middle; dominant-baseline: central; font-variant-numeric: tabular-nums; }
.level .node, .level .link { transition: opacity 0.15s, box-shadow 0.15s, border-color 0.15s; }
.dimmed .node:not(.lit), .dimmed .link:not(.lit) { opacity: 0.15; }
.searching .node:not(.hit) { opacity: 0.35; }
.empty-state { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); }
.hint {
  position: absolute; left: 16px; bottom: 16px; z-index: 5; max-width: min(560px, calc(100% - 32px));
  display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 8px 8px 12px;
  font-size: 12px; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
}
.hint[hidden] { display: none; }
.hint button { flex: none; border: 0; background: none; width: 20px; height: 20px; padding: 2px; border-radius: 5px; cursor: pointer; color: var(--muted); }
.hint button:hover { background: var(--surface-2); }
.hint svg { width: 16px; height: 16px; display: block; }
.drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100%; z-index: 15;
  display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-pop);
  transform: translateX(100%); visibility: hidden; transition: transform 0.2s ease, visibility 0s linear 0.2s;
}
.drawer.open { transform: none; visibility: visible; transition: transform 0.2s ease; }
.dr-close { position: absolute; top: 12px; right: 12px; }
.dr-head { padding: 18px 56px 14px 20px; border-bottom: 1px solid var(--border); }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 11px;
  font-size: 12px; font-weight: 600; color: var(--kind); background: color-mix(in srgb, var(--kind) 13%, transparent);
}
.chip svg { width: 12px; height: 12px; }
.chip.flow { --kind: var(--accent); }
.chip.flow.side { --kind: var(--warn); }
.repo { font: 11px var(--mono); color: var(--muted); word-break: break-all; }
.dr-head h2 { margin: 0; font-size: 17px; line-height: 1.4; word-break: break-word; outline: none; }
.dr-head h2 .guess { vertical-align: 2px; }
.tech { margin-top: 2px; font: 12px/1.5 var(--mono); color: var(--muted); word-break: break-all; }
.guess-note { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; color: var(--warn); background: var(--warn-soft); }
.dr-body { flex: 1; overflow-y: auto; padding: 16px 20px 28px; }
.actions { display: flex; gap: 8px; margin-bottom: 16px; }
.actions button { flex: 1; height: 36px; border-radius: 8px; cursor: pointer; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.actions svg { width: 15px; height: 15px; }
.enter { border: 0; background: var(--accent); color: var(--on-accent); }
.enter:hover { filter: brightness(1.06); }
.actions .focus { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); }
.actions .focus:hover { background: var(--surface-2); }
.desc { margin: 0 0 18px; line-height: 1.6; word-break: break-word; }
.dr-body h3, .pop h3 { margin: 0 0 8px; font-size: 12px; font-weight: 650; color: var(--muted); }
.evidence { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.evidence li { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.badge { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; margin: 0 6px 4px 0; border-radius: 10px; font-size: 11px; font-weight: 600; vertical-align: middle; }
.badge.t-code, .badge.t-spec { color: var(--ok); background: var(--ok-soft); }
.badge.t-doc, .badge.t-user, .badge.guess { color: var(--warn); background: var(--warn-soft); }
.badge.t-live { color: var(--live); background: var(--live-soft); }
.cmd { display: block; margin-top: 4px; font: 12px/1.5 var(--mono); word-break: break-all; color: var(--text); }
.facts { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.facts li { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.facts .env { flex: none; min-width: 44px; font-weight: 650; color: var(--muted); }
.facts .val { min-width: 0; word-break: break-all; }
.evidence.plat { margin-bottom: 18px; }
.evidence .evidence { margin-top: 8px; }
.loc { display: block; font: 12px/1.5 var(--mono); word-break: break-all; }
a.loc { color: var(--accent); text-decoration: none; }
a.loc:hover { text-decoration: underline; }
.ev-meta { margin-top: 4px; font-size: 11px; color: var(--muted); }
.evidence pre {
  margin: 8px 0 0; padding: 8px 10px; max-height: 220px; overflow: auto; border-radius: 6px;
  font: 11.5px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; background: var(--surface-2);
}
.empty { margin: 0; color: var(--muted); }
.pop {
  position: fixed; z-index: 40; width: 360px; max-width: calc(100vw - 16px); max-height: min(70vh, 560px); overflow-x: hidden; overflow-y: auto;
  padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop);
}
.pop[hidden] { display: none; }
.pop:focus { outline: none; }
.pop ul { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 8px; }
.pop li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.legend-kinds { grid-template-columns: 1fr 1fr; }
.legend-lines svg { flex: none; }
.legend-lines line { stroke: var(--edge-strong); stroke-linecap: round; }
.legend-lines line.x-account-line { stroke: var(--x-account); }
.swatch { flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: var(--kind); background: color-mix(in srgb, var(--kind) 14%, transparent); }
.swatch svg { width: 14px; height: 14px; }
.legend-kinds { grid-template-columns: 1fr !important; }
.legend-kinds .kc { flex: none; }
.pop .foot { margin: 0; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11px; line-height: 1.6; color: var(--muted); }
.q-list { gap: 2px !important; }
.q-list li { display: block; }
.q {
  display: block; width: 100%; padding: 8px 10px; text-align: left; border: 0; border-radius: 8px; background: none; cursor: pointer;
}
.q:hover:not(:disabled) { background: var(--surface-2); }
.q:disabled { cursor: default; }
.q-subj { display: block; font-size: 12px; font-weight: 600; color: var(--accent); word-break: break-all; }
.q:disabled .q-subj { color: var(--muted); }
.qlist { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.q-text { display: block; margin-top: 2px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.sheet {
  position: absolute; left: 16px; right: 16px; bottom: 16px; z-index: 10; max-height: 45%; display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop);
}
.sheet[hidden] { display: none; }
.sheet summary { padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
.sheet .scroll { overflow: auto; padding: 0 14px 12px; }
.sheet table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sheet th { position: sticky; top: 0; background: var(--surface); color: var(--muted); font-weight: 600; text-align: left; }
.sheet th, .sheet td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; text-align: left; }
.sheet td .loc { font-size: 11px; }
.sheet th:first-child, .sheet td:first-child { white-space: nowrap; }
@media (max-width: 900px) {
  .meta, .bar h1 { display: none; }
  .crumbs::before { display: none; }
  .search { width: 160px; }
  .btn .label { display: none; }
}
@media (max-width: 560px) {
  .bar { gap: 6px; padding: 0 8px 0 12px; }
  .seg, #zoom-fit, .spacer { display: none; }
  .search { width: auto; flex: 1; min-width: 0; }
  .search input { width: 100%; }
  .drawer { width: 100%; }
  .hint { display: none; }
}
`;

/** 테마 토큰과 레이아웃 CSS. 시스템 설정을 기본으로 따르고 html의 data-theme가 있으면 그걸 따른다 */
export function renderCss(): string {
  return [
    `:root {${LIGHT_TOKENS}  --font: "Pretendard", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif;\n  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;\n}`,
    `@media (prefers-color-scheme: dark) {\n:root:not([data-theme="light"]) {${DARK_TOKENS}}\n${scoped(':root:not([data-theme="light"])', 'dark')}\n}`,
    `:root[data-theme="dark"] {${DARK_TOKENS}}`,
    kindRules('light'),
    productRules(),
    scoped(':root[data-theme="dark"]', 'dark'),
    LAYOUT_CSS,
  ].join('\n');
}

function scoped(prefix: string, theme: 'light' | 'dark'): string {
  return kindRules(theme).replace(/\.k-/g, `${prefix} .k-`);
}
