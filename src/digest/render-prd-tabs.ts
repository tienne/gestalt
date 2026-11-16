import type { PrdCoverage, PrdIssue } from './lint-prd.js';
import type { PrdGap } from './lint-prd-gaps.js';
import type { PrdProseGroup } from './lint-prd-prose.js';
import {
  PRD_COPY as C,
  SLOT_NAMES,
  prdGapQuestion,
  prdBlockTitle as blockTitle,
} from './prd-copy.js';
import {
  REQUIREMENT_SLOTS,
  allBlocks,
  type BlockOf,
  type PrdBlock,
  type PrdView,
} from './prd-schema.js';
import {
  esc,
  fmtSrc,
  inlineLabel,
  inlineMd,
  renderBlock,
  type BlockContext,
} from './render-prd-blocks.js';

export interface PrdReview {
  gaps: readonly PrdGap[];
  prose: readonly PrdProseGroup[];
  issues: readonly PrdIssue[];
  coverage: PrdCoverage;
}

const chip = (text: string, warn = false) =>
  `<span class="chip${warn ? ' warn' : ''}">${esc(text)}</span>`;
const aud = (b: PrdBlock) => `data-aud="${(b.audience ?? []).join(' ')}"`;
const empty = () => `<p class="empty-state">${C.empty}</p>`;
const missing = (question?: string) =>
  `<div class="empty">${question ? inlineMd(question) : C.missing}${question ? chip(C.missing) : ''}</div>`;
const field = (name: string, html: string) =>
  `<section class="field"><h3>${name}</h3>${html}</section>`;
const reqLink = (b: BlockOf<'requirement'>, parents: ReadonlySet<string>) =>
  `<a href="#${parents.has(b.id) ? 'b' : 'f'}-${esc(b.id)}">${inlineLabel(b.title)}</a>`;

export function renderPrdToc(view: PrdView): string {
  return view.sections
    .map(
      (s, i) =>
        `<div class="toc-group" data-section-nav="s-${esc(s.id)}"><a class="grp" href="#s-${esc(s.id)}"><span class="n">${i + 1}</span>${inlineLabel(s.title)}</a>${s.blocks.map((b) => `<a class="toc-item" data-block-nav="b-${esc(b.id)}" href="#b-${esc(b.id)}">${inlineLabel(blockTitle(b))}</a>`).join('')}</div>`,
    )
    .join('');
}

export function renderPrdSections(view: PrdView, ctx: BlockContext): string {
  return view.sections
    .map(
      (s) =>
        `<section class="sec card" id="s-${esc(s.id)}"><h2>${inlineMd(s.title)}</h2>${s.blocks.map((b) => renderBlock(b, ctx)).join('')}</section>`,
    )
    .join('');
}

export function renderSpec(view: PrdView, review: PrdReview): { toc: string; html: string } {
  const blocks = [...allBlocks(view)].map(({ block }) => block);
  const requirements = blocks.filter((b) => b.kind === 'requirement');
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const parents = new Set(requirements.flatMap((r) => (r.parent ? [r.parent] : [])));
  const features = requirements.filter((r) => !parents.has(r.id));
  const questions = blocks.filter((b) => b.kind === 'question');
  const metrics = blocks.filter((b) => b.kind === 'metric');
  const seen = new Set<string>();
  const node = (r: BlockOf<'requirement'>): string => {
    if (seen.has(r.id)) return '';
    seen.add(r.id);
    return `<li data-req-node="${esc(r.id)}">${parents.has(r.id) ? `<a class="req-folder" href="#b-${esc(r.id)}">${inlineLabel(r.title)}</a>` : `<a href="#f-${esc(r.id)}" data-req-link="${esc(r.id)}">${inlineLabel(r.title)}</a>`}<ul>${requirements
      .filter((b) => b.parent === r.id)
      .map(node)
      .join('')}</ul></li>`;
  };
  const roots = requirements.filter((r) => !r.parent || !byId.has(r.parent));
  let toc = view.sections
    .map((s) => {
      const sectionRoots = roots.filter((r) => s.blocks.some((b) => b.id === r.id));
      return sectionRoots.length
        ? `<div class="req-group"><p class="grp">${inlineLabel(s.title)}</p><ul>${sectionRoots.map(node).join('')}</ul></div>`
        : '';
    })
    .join('');
  toc += `<ul>${requirements
    .filter((r) => !seen.has(r.id))
    .map(node)
    .join('')}</ul>`;
  const details = features.map((r, index) => {
    const pending = questions.filter((q) => r.questions?.includes(q.id));
    const related = review.gaps.filter((g) => g.blockIds.includes(r.id));
    const slotGap = related.find((g) => g.code === 'SLOTS_INCOMPLETE');
    const gapQuestion = (code: PrdGap['code']) => related.find((g) => g.code === code)?.question;
    const values = REQUIREMENT_SLOTS.filter((k) => r.slots?.[k]).length;
    const phase = r.phase === 'mvp' ? 'MVP' : r.phase === 'later' ? C.later : C.missing;
    const links = (r.metrics ?? [])
      .map((id) => {
        const metric = metrics.find((m) => m.metricId === id);
        return metric
          ? `<a class="chip" href="#m-${esc(metric.id)}">${inlineLabel(metric.name)}</a>`
          : chip(id);
      })
      .join(' ');
    const questionHtml = pending.length
      ? pending
          .map(
            (q) =>
              `<div class="mq"><a href="#d-${esc(q.id)}">${inlineLabel(q.item)}</a>${chip(q.owner ? `${C.owner} ${q.owner}` : C.ownerMissing, !q.owner)}${chip(q.due ? `${C.due} ${q.due}` : C.dueMissing, !q.due)}</div>`,
          )
          .join('')
      : missing();
    const slots = `<div class="slots">${REQUIREMENT_SLOTS.map((key) => {
      const value = r.slots?.[key];
      const question = prdGapQuestion(
        {
          ...slotGap,
          code: 'SLOTS_INCOMPLETE',
          blockIds: [r.id],
          message: '',
          missingSlots: [key],
        },
        new Map([[r.id, r]]),
      );
      return `<div class="slot${value ? ' filled' : ''}" id="slot-${esc(r.id)}-${key}"><div class="k">${SLOT_NAMES[key]}</div><div class="v">${value ? `${inlineMd(value.text)}<span class="src">${fmtSrc(value.src)}</span>` : `${inlineMd(question)} ${chip(C.missing)}`}</div></div>`;
    }).join('')}</div>`;
    const html = `<article class="req-detail" id="f-${esc(r.id)}" data-req="${esc(r.id)}" data-phase="${r.phase ?? ''}" ${aud(r)}>
<div class="lab">${C.requirements} ${index + 1}</div><h1>${inlineMd(r.title)}</h1>
<div class="metaline"><span>${C.id} <b>${esc(r.id)}</b></span>${chip(phase)}${chip(pending.length ? `${C.questions} ${pending.length}` : C.ready, pending.length > 0)}<span>${C.priority} <b>${r.priority ? inlineMd(r.priority) : C.missing}</b></span><span class="src">${fmtSrc(r.src)}</span></div>
${field(C.description, r.detail?.length ? r.detail.map((d) => `<p>${inlineMd(d)}</p>`).join('') : missing())}
${field(C.why, r.why ? `<div class="box">${inlineMd(r.why)}</div>` : missing())}
${field(C.boundary, r.boundary ? `<div class="box">${inlineMd(r.boundary)}</div>` : missing())}
${field(C.linkedMetrics, links || missing(gapQuestion('REQUIREMENT_UNLINKED')))}
${field(C.acceptance, r.acceptance?.length ? r.acceptance.map((a) => `<label class="ac"><input type="checkbox"><span>${inlineMd(a.text)}<span class="src">${fmtSrc(a.src)}</span></span></label>`).join('') : missing(gapQuestion('ACCEPTANCE_MISSING')))}
${field(C.questions, questionHtml)}${field(C.slots, slots)}</article>`;
    const card = `<a class="fcard" href="#f-${esc(r.id)}" data-feature-card="${esc(r.id)}" data-phase="${r.phase ?? ''}" ${aud(r)}><div class="h"><b>${inlineLabel(r.title)}</b>${chip(phase)}</div>${r.detail?.length ? `<p>${r.detail.map(inlineLabel).join('<br>')}</p>` : ''}<div class="fill"><progress max="9" value="${values}"></progress><span>${C.slots} ${values}/9</span></div></a>`;
    return { html, card };
  });
  return {
    toc,
    html: `<div class="spectool"><div class="seg" role="group" aria-label="${C.features}"><button type="button" data-spec-mode="directory" aria-pressed="true">${C.directory}</button><button type="button" data-spec-mode="cards" aria-pressed="false">${C.cards}</button><button type="button" disabled title="${C.graphHint}">${C.graph}</button></div><div class="seg" role="group" aria-label="${C.phase}"><button type="button" data-phase-filter="" aria-pressed="true">${C.all}</button><button type="button" data-phase-filter="mvp" aria-pressed="false">MVP</button><button type="button" data-phase-filter="later" aria-pressed="false">${C.later}</button></div></div><div class="spec-directory detail">${details.map((d) => d.html).join('')}${!features.length ? empty() : ''}<p class="empty-state spec-empty" hidden>${C.empty}</p></div><div class="spec-cards grid" hidden>${details.map((d) => d.card).join('')}${!features.length ? empty() : ''}<p class="empty-state cards-empty" hidden>${C.empty}</p></div><div class="bottombar"><button type="button" data-req-step="-1">${C.previous}</button><span data-req-count></span><button type="button" data-req-step="1">${C.next}</button></div>`,
  };
}

export function renderMetrics(view: PrdView): string {
  const blocks = [...allBlocks(view)].map(({ block }) => block);
  const metrics = blocks.filter((b) => b.kind === 'metric');
  const reqs = blocks.filter((b) => b.kind === 'requirement');
  const parents = new Set(reqs.flatMap((r) => (r.parent ? [r.parent] : [])));
  const groups = [
    ['primary', C.primary],
    ['secondary', C.secondary],
    ['guardrail', C.guardrail],
    ['', C.unclassified],
  ] as const;
  return (
    groups
      .map(([role, title]) => {
        const items = metrics.filter((m) => (m.role ?? '') === role);
        return !items.length
          ? ''
          : `<section class="card sec" id="metrics-${role || 'other'}"><h2>${title}</h2><div class="xwrap"><table class="tbl metrics-table"><thead><tr>${[C.metrics, C.denominator, C.baseline, C.target, C.measure, C.movingRequirements].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${items
              .map(
                (m) =>
                  `<tr id="m-${esc(m.id)}" ${aud(m)}><th scope="row">${inlineMd(m.name)}<span class="src">${esc(m.metricId)} ${fmtSrc(m.src)}</span></th>${[m.denominator, m.baseline, m.target, m.measure].map((v) => `<td>${v ? inlineMd(v) : chip(C.missing, true)}</td>`).join('')}<td>${
                    reqs
                      .filter((r) => r.metrics?.includes(m.metricId))
                      .map((r) => reqLink(r, parents))
                      .join('<br>') || chip(C.missing, true)
                  }</td></tr>`,
              )
              .join('')}</tbody></table></div></section>`;
      })
      .join('') || empty()
  );
}

export function renderDecisions(view: PrdView, ctx: BlockContext, gaps: readonly PrdGap[]): string {
  const blocks = [...allBlocks(view)].map(({ block }) => block);
  const reqs = blocks.filter((b) => b.kind === 'requirement');
  const parents = new Set(reqs.flatMap((r) => (r.parent ? [r.parent] : [])));
  const unconfirmed = new Set(
    gaps.filter((g) => g.code === 'DECISION_UNCONFIRMED').flatMap((g) => g.blockIds),
  );
  const items = blocks.filter(
    (b) =>
      b.kind === 'decision' || b.kind === 'question' || (b.kind === 'claim' && b.status === 'open'),
  );
  return (
    items
      .map((b) => {
        let status = '';
        if (b.kind === 'decision')
          status = chip(unconfirmed.has(b.id) ? C.unconfirmed : C.confirmed, unconfirmed.has(b.id));
        if (b.kind === 'question')
          status = `${chip(b.owner ? `${C.owner} ${b.owner}` : C.ownerMissing, !b.owner)}${chip(b.due ? `${C.due} ${b.due}` : C.dueMissing, !b.due)}`;
        const linked = b.kind === 'question' ? reqs.filter((r) => r.questions?.includes(b.id)) : [];
        return `<section class="card sec" id="d-${esc(b.id)}" ${aud(b)}><div class="metaline">${status}</div>${renderBlock(b, ctx).replace(`id="b-${esc(b.id)}"`, `id="decision-block-${esc(b.id)}"`)}${linked.length ? field(C.linkedRequirements, linked.map((r) => reqLink(r, parents)).join('<br>')) : ''}</section>`;
      })
      .join('') || empty()
  );
}

function reviewIssues(review: PrdReview): readonly PrdIssue[] {
  return review.issues.filter(
    (i) =>
      !(i.code === 'COVERAGE_GAP' && i.severity === 'warning' && review.coverage.ranges.length > 0),
  );
}

export function reviewCount(review: PrdReview): number {
  return (
    review.gaps.length +
    reviewIssues(review).length +
    review.prose.reduce((n, p) => n + p.samples.length, 0) +
    review.coverage.ranges.length
  );
}

export function renderReview(view: PrdView, review: PrdReview): string {
  const blocks = new Map([...allBlocks(view)].map(({ block }) => [block.id, block]));
  const parents = new Set(
    [...blocks.values()].flatMap((b) => (b.kind === 'requirement' && b.parent ? [b.parent] : [])),
  );
  const link = (id: string, label: string) =>
    `<a href="#${blocks.get(id)?.kind === 'requirement' && !parents.has(id) ? 'f' : 'b'}-${esc(id)}">${inlineLabel(label)}</a>`;
  const row = (text: string, ids: readonly string[]) =>
    `<div class="gaprow"><div class="w">${inlineMd(text)}</div><div>${ids.length ? ids.map((id) => link(id, blocks.has(id) ? blockTitle(blocks.get(id)!) : C.go)).join('<br>') : `<a href="#source-coverage">${C.go}</a>`}</div></div>`;
  const informational = new Set<PrdGap['code']>([
    'QUOTE_VIRTUAL',
    'METRIC_UNLINKED',
    'REQUIREMENT_UNLINKED',
  ]);
  const issues = reviewIssues(review);
  const block = issues
    .filter((i) => i.severity === 'error')
    .map((i) => row(i.message, i.blockId ? [i.blockId] : []))
    .join('');
  const needed =
    review.gaps
      .filter((g) => !informational.has(g.code))
      .map((g) => row(g.question, g.blockIds))
      .join('') +
    review.coverage.ranges
      .map((r) => row(`${C.uncovered} L${r.from}-${r.to}: ${r.preview}`, []))
      .join('');
  const reference =
    review.gaps
      .filter((g) => informational.has(g.code))
      .map((g) => row(g.question, g.blockIds))
      .join('') +
    issues
      .filter((i) => i.severity === 'warning')
      .map((i) => row(i.message, i.blockId ? [i.blockId] : []))
      .join('');
  const labels = {
    REQ_NO_SUBJECT: C.noSubject,
    REQ_NO_BOUNDARY: C.noBoundary,
    MODAL_AMBIGUOUS: C.ambiguous,
    RISK_NO_RESPONSE: C.noResponse,
    SENTENCE_LONG: C.longSentence,
    PROSE_AI_TELL: C.aiTell,
  };
  const prose = review.prose
    .map(
      (p) =>
        `<h3>${labels[p.code]} ${chip(String(p.count))}</h3>${p.samples.map((s) => row(s.sentence, s.blockId ? [s.blockId] : [])).join('')}`,
    )
    .join('');
  return [
    [C.blockers, block],
    [C.needed, needed],
    [C.reference, reference],
    [C.prose, prose],
  ]
    .map(
      ([title, html], i) =>
        `<section class="sec card" id="review-${i}"><h2>${title}</h2>${html || `<p class="empty-state">${C.emptyReview}</p>`}</section>`,
    )
    .join('');
}
