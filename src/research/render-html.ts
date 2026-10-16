import type { BasisKind, EvidenceRef } from './evidence.js';
import type { Capture, Finding, Research } from './schema.js';
import type { ResearchAudience } from './store.js';

export interface LoadedImage {
  mime: string;
  data: Buffer;
}

export interface RenderOptions {
  audience: ResearchAudience;
  /** research 폴더 안 상대 경로의 이미지. 없거나 못 읽으면 null */
  loadImage: (relativePath: string) => LoadedImage | null;
}

export type RenderResult =
  | { ok: true; html: string; warnings: string[] }
  | { ok: false; code: 'SHARE_BLOCKED'; message: string; captureIds: string[] };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;
const MAX_TOTAL_THUMB_BYTES = 4 * 1024 * 1024;

export const AXIS_LABEL = { 'same-market': '같은 시장', 'same-problem': '같은 문제' } as const;
export const SOURCE_LABEL = {
  'app-explore': '앱 탐색',
  uibowl: '유아이볼',
  'site-search': '사이트 검색',
  youtube: '영상',
  'store-screenshot': '스토어 스크린샷',
  'tech-blog': '기술 블로그',
  none: '출처 없음',
} as const;
export const CAPTURE_STATE_LABEL = {
  captured: '캡처함',
  'reference-image': '레퍼런스 이미지',
  'stopped-before-payment': '결제 직전에 멈춤',
  'not-captured': '캡처 못 함',
} as const;
export const CAPTURE_KIND_LABEL = {
  direct: '직접 캡처',
  'reference-db': '레퍼런스 DB',
  'video-frame': '영상 프레임',
  store: '스토어',
} as const;
export const PII_LABEL = {
  replaced: '개인정보를 가짜 값으로 바꿈',
  none: '탐지 0건',
  unchecked: '개인정보 미확인',
} as const;
export const EVIDENCE_LABEL = {
  observation: '관찰',
  'company-statement': '회사 발언',
  interpretation: '해석',
} as const;
export const CONFIDENCE_LABEL = {
  likely: '유력',
  trial: '시험',
  hold: '보류',
  out: '제외',
} as const;
export const ROW_KIND_LABEL = { graded: '기준', burden: '구현 부담', risk: '위험' } as const;
export const BASIS_LABEL = {
  observation: '관찰',
  'company-statement': '회사 발언',
  interpretation: '해석',
  unconfirmed: '확인 못함',
  absent: '없음',
} as const satisfies Record<BasisKind, string>;
export const PATTERN_LABEL = {
  common: '동일 패턴',
  split: '서비스별 분기',
  unique: '단독 구현',
} as const;
export const FINDING_KIND_LABEL = {
  wow: '와우',
  pain: '페인',
  insight: '인사이트',
  design: '설계 힌트',
} as const;
export const VIEWPOINT_LABEL = { user: '사용자', biz: '비즈니스' } as const;
export const OWNER_LABEL = {
  immediate: '바로 정함',
  data: '데이터 확인 선행',
  'other-team': '다른 직군 확인',
} as const;
export const ADOPTION_LABEL = {
  adopted: '채택',
  candidate: '채택 후보',
  rejected: '채택하지 않음',
} as const;
export const VIDEO_KIND_LABEL = {
  'screen-recording': '화면 녹화',
  seminar: '세미나',
  mixed: '섞임',
} as const;
export const VIDEO_ORIGIN_LABEL = { public: '공개 영상', recorded: '직접 녹화' } as const;
export const VIDEO_GROUP_LABEL = {
  flow: '제품별 흐름',
  slot: '구좌별',
  type: '유형별',
  summary: '종합',
} as const;
export const VIDEO_NATURE_LABEL = { direction: '방향성', convention: '관례' } as const;
export const VIDEO_CADENCE_LABEL = { always: '상시', seasonal: '분기', exclusive: '단독' } as const;

export interface VideoTable {
  heading: string;
  head: string[];
  rows: string[][];
}

/** 영상 분석 섹션의 제목. 단독 문서는 0, 1번 뒤에 바로 오므로 2번이다 */
export function videoSectionTitle(research: Research): string {
  return research.meta.kind === 'video-analysis' ? '2. 영상 분석' : '9. 영상 분석';
}

/** 영상 블록이 있거나 영상 분석 문서일 때만 섹션을 낸다 */
export function hasVideoSection(research: Research): boolean {
  return research.meta.kind === 'video-analysis' || research.video !== undefined;
}

function formatSeconds(sec: number): string {
  return `${Number.isInteger(sec) ? sec : sec.toFixed(1)}초`;
}

/**
 * 영상 섹션을 표 목록으로 푼다. 첫 표는 영상 목록이고 뒤는 design.md 8.2절의 묶음 순서
 * (제품별 흐름, 구좌별, 유형별, 종합)대로 발견을 모은다. 두 렌더러가 같은 표를 쓴다
 */
export function buildVideoTables(research: Research): VideoTable[] {
  const video = research.video;
  if (!video || video.clips.length === 0) return [];
  const productName = new Map(research.productCandidates.map((p) => [p.id, p.name]));
  const captureLabel = new Map(
    research.captures.map((c) => {
      const screen = c.screenMapId
        ? research.screenMap.find((s) => s.id === c.screenMapId)?.screen
        : undefined;
      return [c.id, c.label ?? screen ?? c.id];
    }),
  );
  const clipById = new Map(video.clips.map((c) => [c.id, c]));

  const tables: VideoTable[] = [
    {
      heading: '영상 목록',
      head: ['제품', '영상', '종류', '출처', '길이'],
      rows: video.clips.map((c) => [
        productName.get(c.productId) ?? c.productId,
        c.url ? `${c.title}\n${c.url}` : c.title,
        VIDEO_KIND_LABEL[c.kind],
        VIDEO_ORIGIN_LABEL[c.origin],
        c.durationSec === undefined ? '-' : formatSeconds(c.durationSec),
      ]),
    },
  ];
  for (const group of ['flow', 'slot', 'type', 'summary'] as const) {
    const found = video.findings.filter((f) => f.group === group);
    if (found.length === 0) continue;
    tables.push({
      heading: VIDEO_GROUP_LABEL[group],
      head: ['영상', '주제', '내용', '근거', '프레임'],
      rows: found.map((f) => {
        const tags = [
          ...(f.nature ? [`[${VIDEO_NATURE_LABEL[f.nature]}]`] : []),
          ...(f.cadence ? [`[${VIDEO_CADENCE_LABEL[f.cadence]}]`] : []),
        ];
        const evidence =
          f.at === undefined
            ? EVIDENCE_LABEL[f.evidence]
            : `${EVIDENCE_LABEL[f.evidence]} (영상 ${formatSeconds(f.at)})`;
        return [
          clipById.get(f.clipId)?.title ?? f.clipId,
          f.topic,
          [...tags, f.text].join(' '),
          evidence,
          f.captureId ? (captureLabel.get(f.captureId) ?? f.captureId) : '-',
        ];
      }),
    });
  }
  return tables;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#2563eb;--warn:#b45309;--ok:#15803d;--chip:#f5f5f4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#fbbf24;--ok:#4ade80;--chip:#292524}}
:root[data-theme="dark"]{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#fbbf24;--ok:#4ade80;--chip:#292524}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 16px 96px}
h1{font-size:26px;margin:0 0 4px}
h2{font-size:19px;margin:44px 0 12px;padding-top:20px;border-top:1px solid var(--line)}
h3{font-size:15px;margin:24px 0 8px}
p{margin:6px 0}
.sub{color:var(--muted);font-size:14px}
.notice{background:var(--chip);border-left:3px solid var(--warn);padding:10px 14px;margin:16px 0;border-radius:4px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--card)}
th,td{border:1px solid var(--line);padding:8px 10px;vertical-align:top;text-align:left}
th{background:var(--chip);font-weight:600}
td{white-space:pre-line}
.chip{display:inline-block;background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;color:var(--muted);margin-right:4px}
.sym{font-weight:700;margin-right:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
figure img{display:block;width:100%;height:auto;border-radius:4px}
figcaption{font-size:12px;color:var(--muted);margin-top:6px;white-space:pre-line}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.card h3{margin:0 0 6px}
ul{margin:4px 0;padding-left:20px}
.pii-unchecked{color:var(--warn)}
.pii-replaced{color:var(--ok)}
.todo{color:var(--muted)}
.def{margin-top:2px}
.grey{background:var(--chip);color:var(--muted)}
.cell .ev{color:var(--muted);font-size:12px;margin-left:4px}
.cell .why{color:var(--muted);font-size:12px;margin-top:4px}
.thumbs{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.thumbs a{display:block;width:56px;border:1px solid var(--line);border-radius:4px;overflow:hidden}
.thumbs img{display:block;width:100%;height:80px;object-fit:cover;object-position:top}
.chip.basis-unconfirmed,.chip.basis-absent{color:var(--warn)}
.chip.own-immediate{color:var(--ok)}
.chip.own-data{color:var(--warn)}
.chip.own-other-team{color:var(--accent)}
.chip.kind-pain{color:var(--warn)}
.chip.kind-wow{color:var(--ok)}
`;

function list(items: string[]): string {
  if (items.length === 0) return '<p class="todo">없음</p>';
  return `<ul>${items.map((i) => `<li>${e(i)}</li>`).join('')}</ul>`;
}

function table(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th>${e(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

class ImageBudget {
  private total = 0;
  readonly warnings: string[] = [];

  constructor(private readonly loadImage: RenderOptions['loadImage']) {}

  dataUri(capture: Capture): string | null {
    const img = this.loadImage(capture.path);
    if (!img) {
      this.warnings.push(`캡처를 읽지 못했다: ${capture.id}`);
      return null;
    }
    if (img.data.length > MAX_IMAGE_BYTES) {
      this.warnings.push(`캡처가 5MB를 넘어 건너뛰었다: ${capture.id}`);
      return null;
    }
    if (this.total + img.data.length > MAX_TOTAL_IMAGE_BYTES) {
      this.warnings.push(`이미지 합계가 15MB를 넘어 건너뛰었다: ${capture.id}`);
      return null;
    }
    this.total += img.data.length;
    return `data:${img.mime};base64,${img.data.toString('base64')}`;
  }
}

/** 근거 한 줄의 괄호 안 글자. 비교표와 발견 끝에 "(프레임 08)"처럼 붙는다 */
export function evidenceLabel(research: Research, ev: EvidenceRef, shared: boolean): string {
  if (ev.type === 'capture') {
    const c = research.captures.find((x) => x.id === ev.captureId);
    return c?.frameNo ? `프레임 ${c.frameNo}` : (c?.label ?? ev.captureId);
  }
  if (ev.type === 'video') {
    const title = research.video?.clips.find((x) => x.id === ev.clipId)?.title;
    return title && !shared ? `영상 ${ev.at}초, ${title}` : `영상 ${ev.at}초`;
  }
  if (ev.type === 'internal') return ev.source;
  return '링크';
}

export function renderResearchHtml(research: Research, opts: RenderOptions): RenderResult {
  const shared = opts.audience === 'shared';
  const unchecked = research.captures.filter((c) => c.pii === 'unchecked');
  if (shared && unchecked.length > 0) {
    return {
      ok: false,
      code: 'SHARE_BLOCKED',
      captureIds: unchecked.map((c) => c.id),
      message: `개인정보를 확인하지 않은 캡처가 ${unchecked.length}개 있어 공유용 HTML을 만들지 않는다. redact_image로 치환하거나 화면을 확인해 pii 상태를 정한 뒤 다시 렌더한다`,
    };
  }

  const budget = new ImageBudget(opts.loadImage);
  const productName = new Map(research.productCandidates.map((p) => [p.id, p.name]));
  const refById = new Map(research.references.map((r) => [r.id, r]));
  const screenById = new Map(research.screenMap.map((s) => [s.id, s]));
  const refLabel = (id: string): string => {
    const r = refById.get(id);
    return r ? `${r.symbol}. ${r.typeName}` : id;
  };
  const warnings: string[] = [];
  const capById = new Map(research.captures.map((c) => [c.id, c]));

  // 같은 이미지를 격자에도 한 번 더 싣는다. 파일이 불어나지 않게 따로 상한을 둔다
  let thumbBytes = 0;
  const thumbUri = (c: Capture): string | null => {
    const img = opts.loadImage(c.path);
    if (!img || img.data.length > MAX_THUMB_BYTES) return null;
    if (thumbBytes + img.data.length > MAX_TOTAL_THUMB_BYTES) return null;
    thumbBytes += img.data.length;
    return `data:${img.mime};base64,${img.data.toString('base64')}`;
  };
  const thumbsHtml = (ids: string[]): string => {
    const items = ids.flatMap((id) => {
      const c = capById.get(id);
      if (!c) return [];
      const name = c.caption ?? c.label ?? c.id;
      const uri = thumbUri(c);
      const inner = uri ? `<img src="${uri}" alt="${e(name)}" loading="lazy">` : e(c.id);
      return [`<a href="#cap-${e(c.id)}" title="${e(name)}">${inner}</a>`];
    });
    return items.length > 0 ? `<div class="thumbs">${items.join('')}</div>` : '';
  };
  const evidenceHtml = (list: EvidenceRef[]): string =>
    list
      .map((ev) =>
        ev.type === 'url'
          ? `<a class="ev" href="${e(ev.url)}" rel="noopener noreferrer">(링크)</a>`
          : `<span class="ev">(${e(evidenceLabel(research, ev, shared))})</span>`,
      )
      .join('');
  const basisChip = (basis: BasisKind | undefined): string =>
    basis && basis !== 'observation'
      ? `<span class="chip basis-${basis}">${BASIS_LABEL[basis]}</span>`
      : '';

  const parts: string[] = [];
  parts.push(`<h1>${e(research.meta.title)}</h1>`);
  parts.push(`<p class="sub">${e(research.meta.task)}</p>`);
  if (!research.plan.confirmedAt) {
    parts.push(
      '<p class="notice">리서치 구성(제품 후보와 화면 지도)을 아직 확인받지 않았습니다. 확인 전의 결과입니다.</p>',
    );
  }
  if (!shared && research.plan.note) parts.push(`<p class="sub">${e(research.plan.note)}</p>`);

  // 0. 전제
  const pr = research.premise;
  parts.push('<h2>0. 전제</h2>');
  parts.push(
    table(
      ['항목', '내용'],
      [
        ['목표 지표', e(pr.goalMetric)],
        [
          '규모 가정',
          pr.scaleAssumption ? e(pr.scaleAssumption) : '<span class="todo">없음</span>',
        ],
        ['구조 제약', list(pr.structureConstraints)],
        ['아직 안 온 입력', list(pr.pendingInputs)],
        ['근거의 한계', list(pr.evidenceLimits)],
        ['기호 범례', e(pr.symbolLegend)],
      ],
    ),
  );

  // 1. 레퍼런스 선정
  parts.push('<h2>1. 레퍼런스 선정</h2>');
  if (research.references.length > 0) {
    parts.push(
      table(
        ['유형', '제품', '고른 이유'],
        research.references.map((r) => [
          `<span class="sym">${e(r.symbol)}</span>${e(r.typeName)}`,
          e(r.productIds.map((id) => productName.get(id) ?? id).join(', ')),
          e(r.reason),
        ]),
      ),
    );
  }
  if (research.productCandidates.length > 0) {
    parts.push('<h3>제품 후보</h3>');
    parts.push(
      table(
        ['제품', '축', '이유', '규모'],
        research.productCandidates.map((p) => [
          e(p.name),
          e(AXIS_LABEL[p.axis]),
          e(p.reason),
          p.scale
            ? `${e(p.scale.value)}<br><span class="chip">${e(EVIDENCE_LABEL[p.scale.evidence])}</span>${e(p.scale.source)}`
            : '<span class="todo">확인 못함</span>',
        ]),
      ),
    );
  }
  if (research.screenMap.length > 0) {
    parts.push('<h3>화면 지도</h3>');
    parts.push(
      table(
        ['제품', '화면', '들어가는 길', '출처', '상태'],
        research.screenMap.map((s) => [
          e(productName.get(s.productId) ?? s.productId),
          e(s.screen),
          e(s.entryPath.join(' > ')),
          e(SOURCE_LABEL[s.source]),
          e(CAPTURE_STATE_LABEL[s.capture]),
        ]),
      ),
    );
  }

  // 캡처
  if (research.captures.length > 0) {
    parts.push('<h3>캡처</h3>');
    const byProduct = new Map<string, Capture[]>();
    for (const c of research.captures) {
      byProduct.set(c.productId, [...(byProduct.get(c.productId) ?? []), c]);
    }
    for (const [productId, caps] of byProduct) {
      parts.push(`<p><strong>${e(productName.get(productId) ?? productId)}</strong></p>`);
      const figs = caps.map((c) => {
        const uri = budget.dataUri(c);
        const screen = c.screenMapId ? screenById.get(c.screenMapId)?.screen : undefined;
        const first = c.label ?? screen ?? c.id;
        const lines = [
          ...(c.caption ? [e(c.caption)] : []),
          ...(c.frameNo ? [`프레임 ${e(c.frameNo)}`] : []),
          e(CAPTURE_KIND_LABEL[c.kind]),
          `<span class="pii-${c.pii}">${PII_LABEL[c.pii]}</span>`,
          ...(c.sourceNote ? [e(c.sourceNote)] : []),
          ...(shared ? [] : [e(c.path)]),
        ];
        const body = uri
          ? `<img src="${uri}" alt="${e(first)}" loading="lazy">`
          : '<p class="todo">이미지 없음</p>';
        return `<figure id="cap-${e(c.id)}">${body}<figcaption><strong>${e(first)}</strong>\n${lines.join('\n')}</figcaption></figure>`;
      });
      parts.push(`<div class="cards">${figs.join('')}</div>`);
    }
  }

  // 영상 분석 문서는 2~8번을 쓰지 않는다. 아래 구간을 만든 뒤 버린다
  const standalone = research.meta.kind === 'video-analysis';
  const bodyStart = parts.length;

  // 2. 시안
  parts.push('<h2>2. 시안</h2>');
  if (research.mockups.length === 0) {
    parts.push(
      '<p class="todo">시안이 없는 조사라 3번 비교표의 열은 시안 대신 레퍼런스 화면이다.</p>',
    );
  } else {
    parts.push(
      table(
        ['레퍼런스', '시안', '메모'],
        research.mockups.map((m) => [
          e(refLabel(m.referenceId)),
          m.url ? `<a href="${e(m.url)}" rel="noopener noreferrer">${e(m.url)}</a>` : '',
          m.note ? e(m.note) : '',
        ]),
      ),
    );
  }

  if (research.adoptions.length > 0) {
    const findingById = new Map(research.wowPain.findings.map((f) => [f.id, f]));
    const findingList = (ids: string[]): string =>
      list(ids.map((id) => findingById.get(id)?.text ?? id));
    parts.push('<h3>시안이 가져온 것과 푼 것</h3>');
    parts.push(
      table(
        ['시안', '레퍼런스', '판단', '가져온 것', '덜어낸 것', '가져오는 와우', '푸는 페인'],
        research.adoptions.map((a) => [
          e(a.variant),
          e(a.referenceIds.map(refLabel).join(', ')),
          `<span class="chip">${ADOPTION_LABEL[a.status]}</span>${a.reason ? e(a.reason) : ''}`,
          list(a.adopted),
          list(a.mitigated),
          findingList(a.takesFindingIds),
          findingList(a.solvesFindingIds),
        ]),
      ),
    );
  }

  // 3. 비교표
  parts.push('<h2>3. 비교표</h2>');
  if (research.comparison.length === 0) {
    parts.push('<p class="todo">비교표가 없습니다.</p>');
  } else {
    const refs = research.references;
    const head = ['단계', '기준', ...refs.map((r) => `${r.symbol}. ${r.typeName}`)];
    const rows = research.comparison.map((row) => {
      const cells = refs.map((r) => {
        const cell = row.cells.find((c) => c.referenceId === r.id);
        if (!cell) return '<div class="cell grey">-</div>';
        const grey = cell.basis === 'unconfirmed' || cell.basis === 'absent';
        const sym = cell.symbol ? `<span class="sym">${e(cell.symbol)}</span>` : '';
        const why = grey && cell.note ? `<div class="why">${e(cell.note)}</div>` : '';
        return (
          `<div class="cell${grey ? ' grey' : ''}">${basisChip(cell.basis)}${sym}${e(cell.text)}` +
          `${evidenceHtml(cell.evidence)}${why}${thumbsHtml(cell.captureIds)}</div>`
        );
      });
      const chips =
        (row.kind === 'graded' ? '' : `<span class="chip">${ROW_KIND_LABEL[row.kind]}</span>`) +
        (row.pattern ? `<span class="chip">${PATTERN_LABEL[row.pattern]}</span>` : '');
      const def = row.definition ? `<div class="sub def">${e(row.definition)}</div>` : '';
      return [e(row.phase), `${chips}${e(row.criterion)}${def}`, ...cells];
    });
    parts.push(table(head, rows));
  }

  // 4. 와우 포인트와 페인 포인트
  parts.push('<h2>4. 와우 포인트와 페인 포인트</h2>');
  if (research.wowPain.userViewpoint)
    parts.push(`<p>사용자 관점: ${e(research.wowPain.userViewpoint)}</p>`);
  if (research.wowPain.bizViewpoint)
    parts.push(`<p>비즈니스 관점: ${e(research.wowPain.bizViewpoint)}</p>`);
  const findingRow = (f: Finding): string[] => {
    const where = [f.slot, f.screenMapId ? screenById.get(f.screenMapId)?.screen : undefined]
      .filter((x): x is string => Boolean(x))
      .join(' / ');
    const refs = f.captureId ? [{ type: 'capture' as const, captureId: f.captureId }] : [];
    const grey = f.basis === 'unconfirmed' || f.basis === 'absent';
    const why = grey && f.note ? `<div class="why">${e(f.note)}</div>` : '';
    return [
      `<span class="chip kind-${f.kind}">${FINDING_KIND_LABEL[f.kind]}</span>${e(VIEWPOINT_LABEL[f.viewpoint])}`,
      `<div class="cell${grey ? ' grey' : ''}">${basisChip(f.basis)}${e(f.text)}${evidenceHtml([...f.evidence, ...refs])}${why}${f.captureId ? thumbsHtml([f.captureId]) : ''}</div>`,
      e(where),
      f.concrete ? e(f.concrete) : '',
    ];
  };
  for (const ref of research.references) {
    const items = research.wowPain.items.filter((w) => w.referenceId === ref.id);
    const found = research.wowPain.findings.filter((f) => f.referenceId === ref.id);
    if (items.length === 0 && found.length === 0) continue;
    parts.push(`<div class="card"><h3>${e(refLabel(ref.id))}</h3>`);
    for (const w of items) {
      parts.push(
        table(
          ['', '와우 포인트', '페인 포인트'],
          [
            ['사용자 관점', list(w.userWow), list(w.userPain)],
            ['비즈니스 관점', list(w.bizWow), list(w.bizPain)],
          ],
        ),
      );
    }
    if (found.length > 0) {
      parts.push(table(['구분', '발견', '구좌나 단계', '조작과 수치'], found.map(findingRow)));
    }
    parts.push('</div>');
  }

  // 5. 레퍼런스가 그렇게 한 이유
  parts.push('<h2>5. 레퍼런스가 그렇게 한 이유</h2>');
  for (const r of research.reasons) {
    parts.push(
      `<div class="card"><h3>${e(refLabel(r.referenceId))}</h3>` +
        table(
          ['항목', '내용'],
          [
            ['비즈니스', e(r.business)],
            ['화면', e(r.screens)],
            ['우리와 다른 점', e(r.difference)],
            ['가져올 것', list(r.take)],
            ['가져오지 않을 것', list(r.skip)],
          ],
        ) +
        '</div>',
    );
  }

  // 6. 판단
  parts.push('<h2>6. 판단 (해석)</h2>');
  for (const j of research.judgment) {
    const hold = j.confidence === 'hold' && j.holdUntil ? ` (${e(j.holdUntil)} 결정)` : '';
    const rank = j.rank ? `<span class="chip">우선순위 ${j.rank}</span>` : '';
    const todo = j.todo ? `<p>할 일: ${e(j.todo)}</p>` : '';
    parts.push(
      `<div class="card"><h3>${e(j.area)} <span class="chip">${CONFIDENCE_LABEL[j.confidence]}</span>${rank}</h3>` +
        `<p><strong>${e(j.conclusion)}</strong>${hold}</p><p>${e(j.rationale)}${evidenceHtml(j.evidence)}</p>${todo}</div>`,
    );
  }

  // 7. 검증 제안
  parts.push('<h2>7. 검증 제안</h2>');
  research.verification.forEach((v, i) => {
    parts.push(
      `<div class="card"><h3>가설 ${i + 1}. ${e(v.hypothesis)}</h3>` +
        `<p>볼 지표: ${e(v.metric)}</p><p>나눠 볼 조건: ${e(v.splitBy)}</p>` +
        (v.caveat ? `<p class="sub">${e(v.caveat)}</p>` : '') +
        '</div>',
    );
  });

  // 8. 열린 질문
  parts.push('<h2>8. 열린 질문</h2>');
  if (research.openQuestions && research.openQuestions.items.length > 0) {
    parts.push(
      `<p>${e(research.openQuestions.recipient)}</p><p>${e(research.openQuestions.intro)}</p>`,
    );
    const withOwner = research.openQuestions.items.some((q) => q.owner);
    parts.push(
      table(
        withOwner
          ? ['질문', '임시로 둔 가정', '영향', '확인 주체']
          : ['질문', '임시로 둔 가정', '영향'],
        research.openQuestions.items.map((q) => {
          const base = [e(q.question), e(q.temporary), e(q.affects)];
          if (!withOwner) return base;
          const owner = q.owner
            ? `<span class="chip own-${q.owner}">${OWNER_LABEL[q.owner]}</span>${q.ownerNote ? e(q.ownerNote) : ''}`
            : '';
          return [...base, owner];
        }),
      ),
    );
  } else {
    parts.push('<p class="todo">열린 질문이 없습니다.</p>');
  }

  if (standalone) parts.length = bodyStart;

  // 영상 분석
  if (hasVideoSection(research)) {
    parts.push(`<h2>${e(videoSectionTitle(research))}</h2>`);
    const tables = buildVideoTables(research);
    if (tables.length === 0) parts.push('<p class="todo">영상 분석이 없습니다.</p>');
    for (const t of tables) {
      parts.push(`<h3>${e(t.heading)}</h3>`);
      parts.push(
        table(
          t.head,
          t.rows.map((row) => row.map((cell) => e(cell).replace(/\n/g, '<br>'))),
        ),
      );
    }
  }

  warnings.push(...budget.warnings);

  const html =
    '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${e(research.meta.title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n<main>\n` +
    parts.join('\n') +
    '\n</main>\n</body>\n</html>\n';
  return { ok: true, html, warnings };
}
