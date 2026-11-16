import { PRD_COPY as C } from './prd-copy.js';
import {
  allBlocks,
  type Audience,
  type BlockOf,
  type PrdBlock,
  type PrdView,
} from './prd-schema.js';
import { AUDIENCES } from './prd-schema.js';
import { esc, inlineLabel } from './render-prd-blocks.js';

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

// 카드로 가는 링크로 감싸므로 안에 마크다운 링크를 살리면 a가 중첩된다. 글자만 넣는다
const anchor = (b: PrdBlock, text: string) => `<a href="#b-${esc(b.id)}">${inlineLabel(text)}</a>`;
const where = (title: string) => `<span class="where">${esc(title)}</span>`;

function unresolvedHtml(items: ReturnType<typeof deriveUnresolved>): string {
  return `<ul class="xlist">${items
    .map(({ block, sectionTitle }) => {
      const text = block.kind === 'question' ? block.item : block.text;
      const tag = block.kind === 'question' ? C.questions : C.openClaim;
      const extra =
        block.kind === 'question'
          ? [
              block.owner && `${C.owner} ${esc(block.owner)}`,
              block.due && `${C.due} ${esc(block.due)}`,
            ]
              .filter(Boolean)
              .join(', ')
          : '';
      return `<li><span class="badge">${tag}</span> ${anchor(block, text)}${extra ? ` <span class="where">${extra}</span>` : ''} ${where(sectionTitle)}</li>`;
    })
    .join('')}</ul>`;
}

function reqMetricHtml(m: ReqMetricMatrix): string {
  const head = m.metrics.map((x) => `<th scope="col">${anchor(x, x.metricId)}</th>`).join('');
  const rows = m.requirements
    .map((r) => {
      const set = m.links.get(r.id)!;
      const cells = m.metrics
        .map(
          (x) => `<td>${set.has(x.metricId) ? `<span aria-label="${C.linked}">●</span>` : ''}</td>`,
        )
        .join('');
      const flag = set.size === 0 ? ` <span class="badge warn">${C.unlinkedMetrics}</span>` : '';
      return `<tr><th scope="row">${anchor(r, r.title)}${flag}</th>${cells}</tr>`;
    })
    .join('');
  const orphan = m.unlinkedMetrics.length
    ? `<tr class="orphan"><th scope="row"><span class="badge warn">${C.unlinkedRequirements}</span></th>${m.metrics
        .map((x) => `<td>${m.unlinkedMetrics.includes(x.metricId) ? '!' : ''}</td>`)
        .join('')}</tr>`
    : '';
  return `<div class="xwrap"><table class="xmatrix"><thead><tr><th scope="col">${C.requirements}</th>${head}</tr></thead><tbody>${rows}${orphan}</tbody></table></div>`;
}

function decisionsHtml(items: ReturnType<typeof deriveDecisions>): string {
  return `<ul class="xlist">${items
    .map(
      ({ block, sectionTitle }) =>
        `<li>${anchor(block, block.decided)}${block.rejected?.length ? ` <span class="where">${C.rejected} ${block.rejected.length}개</span>` : ''} ${where(sectionTitle)}</li>`,
    )
    .join('')}</ul>`;
}

// 본문 섹션은 s-<id>라서 접두어를 다르게 둬야 섹션 id가 overview여도 안 겹친다
export const OVERVIEW_SECTION_ID = 'x-overview';

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
      title: `${C.unresolved} ${unresolved.length}`,
      body: unresolvedHtml(unresolved),
    });
  }
  const matrix = deriveReqMetric(view);
  if (matrix)
    parts.push({ id: 'x-req-metric', title: C.requirementsMetrics, body: reqMetricHtml(matrix) });
  const decisions = deriveDecisions(view);
  if (decisions.length) {
    parts.push({
      id: 'x-decisions',
      title: `${C.decision} ${decisions.length}`,
      body: decisionsHtml(decisions),
    });
  }
  if (parts.length === 0) return { html: '', toc: [] };
  return {
    html: `<section class="sec overview" id="${OVERVIEW_SECTION_ID}"><h2>${C.overview}</h2>${parts
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
