import type { Capture, Research } from './schema.js';
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
export const CONFIDENCE_LABEL = { likely: '유력', trial: '시험', hold: '보류' } as const;
export const ROW_KIND_LABEL = { graded: '기준', burden: '구현 부담', risk: '위험' } as const;

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
          e(CAPTURE_KIND_LABEL[c.kind]),
          `<span class="pii-${c.pii}">${PII_LABEL[c.pii]}</span>`,
          ...(c.sourceNote ? [e(c.sourceNote)] : []),
          ...(shared ? [] : [e(c.path)]),
        ];
        const body = uri
          ? `<img src="${uri}" alt="${e(first)}" loading="lazy">`
          : '<p class="todo">이미지 없음</p>';
        return `<figure>${body}<figcaption><strong>${e(first)}</strong>\n${lines.join('\n')}</figcaption></figure>`;
      });
      parts.push(`<div class="cards">${figs.join('')}</div>`);
    }
  }

  // 2. 시안
  parts.push('<h2>2. 시안</h2>');
  if (research.mockups.length === 0) {
    parts.push('<p class="todo">시안 링크가 없습니다.</p>');
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
        if (!cell) return '<span class="todo">-</span>';
        const sym = cell.symbol ? `<span class="sym">${e(cell.symbol)}</span>` : '';
        return `${sym}${e(cell.text)}`;
      });
      const kind =
        row.kind === 'graded' ? '' : `<span class="chip">${ROW_KIND_LABEL[row.kind]}</span>`;
      return [e(row.phase), `${kind}${e(row.criterion)}`, ...cells];
    });
    parts.push(table(head, rows));
  }

  // 4. 와우 포인트와 페인 포인트
  parts.push('<h2>4. 와우 포인트와 페인 포인트</h2>');
  if (research.wowPain.userViewpoint)
    parts.push(`<p>사용자 관점: ${e(research.wowPain.userViewpoint)}</p>`);
  if (research.wowPain.bizViewpoint)
    parts.push(`<p>비즈니스 관점: ${e(research.wowPain.bizViewpoint)}</p>`);
  for (const w of research.wowPain.items) {
    parts.push(`<div class="card"><h3>${e(refLabel(w.referenceId))}</h3>`);
    parts.push(
      table(
        ['', '와우 포인트', '페인 포인트'],
        [
          ['사용자 관점', list(w.userWow), list(w.userPain)],
          ['비즈니스 관점', list(w.bizWow), list(w.bizPain)],
        ],
      ),
    );
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
    const hold = j.confidence === 'hold' && j.holdUntil ? ` (${e(j.holdUntil)} 뒤에 정함)` : '';
    parts.push(
      `<div class="card"><h3>${e(j.area)} <span class="chip">${CONFIDENCE_LABEL[j.confidence]}</span></h3>` +
        `<p><strong>${e(j.conclusion)}</strong>${hold}</p><p>${e(j.rationale)}</p></div>`,
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
    parts.push(
      table(
        ['질문', '임시로 둔 가정', '영향'],
        research.openQuestions.items.map((q) => [e(q.question), e(q.temporary), e(q.affects)]),
      ),
    );
  } else {
    parts.push('<p class="todo">열린 질문이 없습니다.</p>');
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
