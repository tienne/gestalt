import {
  allBlocks,
  type Audience,
  type BlockOf,
  type PrdBlock,
  type PrdView,
} from './prd-schema.js';
import { AUDIENCES } from './prd-schema.js';
import { esc, inlineMd } from './render-prd-blocks.js';

/**
 * 교차 뷰. 세션이 따로 쓰지 않고 렌더러가 블록 참조만으로 모은다.
 * 원문 섹션 여기저기 흩어진 미확정과 결정을 한자리에서 보게 하는 게 목적이다
 */

interface Placed<B extends PrdBlock = PrdBlock> {
  block: B;
  sectionTitle: string;
}

function placed(view: PrdView): Placed[] {
  const titles = new Map(view.sections.map((s) => [s.id, s.title]));
  return [...allBlocks(view)].map(({ block, sectionId }) => ({
    block,
    sectionTitle: titles.get(sectionId) ?? '',
  }));
}

/** question 전부와 상태가 open인 claim */
export function deriveUnresolved(view: PrdView): Placed<BlockOf<'question'> | BlockOf<'claim'>>[] {
  return placed(view).filter(
    (p): p is Placed<BlockOf<'question'> | BlockOf<'claim'>> =>
      p.block.kind === 'question' || (p.block.kind === 'claim' && p.block.status === 'open'),
  );
}

export function deriveDecisions(view: PrdView): Placed<BlockOf<'decision'>>[] {
  return placed(view).filter((p): p is Placed<BlockOf<'decision'>> => p.block.kind === 'decision');
}

export interface ReqMetricMatrix {
  requirements: BlockOf<'requirement'>[];
  metrics: BlockOf<'metric'>[];
  /** requirement id → 연결된 metricId */
  links: Map<string, Set<string>>;
  unlinkedRequirements: string[];
  unlinkedMetrics: string[];
}

/** 요구사항과 지표 연결. 한쪽에만 있는 것을 따로 모은다. 둘 중 하나라도 없으면 null */
export function deriveReqMetric(view: PrdView): ReqMetricMatrix | null {
  const requirements: BlockOf<'requirement'>[] = [];
  const metrics: BlockOf<'metric'>[] = [];
  for (const { block } of allBlocks(view)) {
    if (block.kind === 'requirement') requirements.push(block);
    else if (block.kind === 'metric') metrics.push(block);
  }
  if (requirements.length === 0 || metrics.length === 0) return null;
  const known = new Set(metrics.map((m) => m.metricId));
  const links = new Map<string, Set<string>>();
  const used = new Set<string>();
  for (const r of requirements) {
    const set = new Set((r.metrics ?? []).filter((m) => known.has(m)));
    links.set(r.id, set);
    for (const m of set) used.add(m);
  }
  return {
    requirements,
    metrics,
    links,
    unlinkedRequirements: requirements.filter((r) => links.get(r.id)!.size === 0).map((r) => r.id),
    unlinkedMetrics: metrics.filter((m) => !used.has(m.metricId)).map((m) => m.metricId),
  };
}

const anchor = (b: PrdBlock, text: string) => `<a href="#b-${esc(b.id)}">${text}</a>`;
const where = (title: string) => `<span class="where">${esc(title)}</span>`;

function unresolvedHtml(items: ReturnType<typeof deriveUnresolved>): string {
  return `<ul class="xlist">${items
    .map(({ block, sectionTitle }) => {
      const text = block.kind === 'question' ? block.item : block.text;
      const tag = block.kind === 'question' ? '질문' : '미정 주장';
      const extra =
        block.kind === 'question'
          ? [block.owner && `담당 ${esc(block.owner)}`, block.due && `기한 ${esc(block.due)}`]
              .filter(Boolean)
              .join(', ')
          : '';
      return `<li><span class="badge">${tag}</span> ${anchor(block, inlineMd(text))}${extra ? ` <span class="where">${extra}</span>` : ''} ${where(sectionTitle)}</li>`;
    })
    .join('')}</ul>`;
}

function reqMetricHtml(m: ReqMetricMatrix): string {
  const head = m.metrics.map((x) => `<th scope="col">${anchor(x, esc(x.metricId))}</th>`).join('');
  const rows = m.requirements
    .map((r) => {
      const set = m.links.get(r.id)!;
      const cells = m.metrics
        .map((x) => `<td>${set.has(x.metricId) ? '<span aria-label="연결">●</span>' : ''}</td>`)
        .join('');
      const flag = set.size === 0 ? ' <span class="badge warn">연결 지표 없음</span>' : '';
      return `<tr><th scope="row">${anchor(r, inlineMd(r.title))}${flag}</th>${cells}</tr>`;
    })
    .join('');
  const orphan = m.unlinkedMetrics.length
    ? `<tr class="orphan"><th scope="row"><span class="badge warn">연결 요구사항 없음</span></th>${m.metrics
        .map((x) => `<td>${m.unlinkedMetrics.includes(x.metricId) ? '!' : ''}</td>`)
        .join('')}</tr>`
    : '';
  return `<div class="xwrap"><table class="xmatrix"><thead><tr><th scope="col">요구사항</th>${head}</tr></thead><tbody>${rows}${orphan}</tbody></table></div>`;
}

function decisionsHtml(items: ReturnType<typeof deriveDecisions>): string {
  return `<ul class="xlist">${items
    .map(
      ({ block, sectionTitle }) =>
        `<li>${anchor(block, inlineMd(block.decided))}${block.rejected?.length ? ` <span class="where">버린 안 ${block.rejected.length}개</span>` : ''} ${where(sectionTitle)}</li>`,
    )
    .join('')}</ul>`;
}

export const OVERVIEW_SECTION_ID = 'overview';

export interface OverviewParts {
  html: string;
  toc: { id: string; title: string }[];
}

/** "모아 보기" 섹션. 모을 게 하나도 없으면 빈 문자열 */
export function renderOverview(view: PrdView): OverviewParts {
  const parts: { id: string; title: string; body: string }[] = [];
  const unresolved = deriveUnresolved(view);
  if (unresolved.length) {
    parts.push({
      id: 'x-unresolved',
      title: `미확정 ${unresolved.length}`,
      body: unresolvedHtml(unresolved),
    });
  }
  const matrix = deriveReqMetric(view);
  if (matrix)
    parts.push({ id: 'x-req-metric', title: '요구사항과 지표', body: reqMetricHtml(matrix) });
  const decisions = deriveDecisions(view);
  if (decisions.length) {
    parts.push({
      id: 'x-decisions',
      title: `결정 ${decisions.length}`,
      body: decisionsHtml(decisions),
    });
  }
  if (parts.length === 0) return { html: '', toc: [] };
  return {
    html: `<section class="sec overview" id="s-${OVERVIEW_SECTION_ID}"><h2>모아 보기</h2>${parts
      .map(
        (p) => `<details open id="${p.id}"><summary>${esc(p.title)}</summary>${p.body}</details>`,
      )
      .join('')}</section>`,
    toc: parts.map((p) => ({ id: p.id, title: p.title })),
  };
}

/** 문서에 실제로 쓰인 audience만 필터 버튼으로 낸다. 순서는 AUDIENCES를 따른다 */
export function usedAudiences(view: PrdView): Audience[] {
  const used = new Set<Audience>();
  for (const { block } of allBlocks(view)) for (const a of block.audience ?? []) used.add(a);
  return AUDIENCES.filter((a) => used.has(a));
}
