import {
  at,
  dotGrid,
  donut,
  durationBar,
  esc,
  focusAt,
  frame,
  nodeGraph,
  statusMatrix,
  trendLine,
  type DonutData,
  type DurationSegment,
  type GraphEdge,
  type GraphNode,
  type Source,
  type TrendData,
} from './render.js';
import type { StatusKind } from './color.js';

/**
 * 조합 15개. 기본 요소 렌더러 위에 상태 순서만 얹는다. 모든 조합이 마지막 단계를 기본으로 그려서
 * 정지본에는 최종 값과 라벨이 남는다.
 */

export const donutSync = (d: DonutData): string => donut({ ...d, sync: true }, 'combo-donut-sync');

export const dotGridDenominator = (d: {
  value: number;
  denominator: number;
  label: string;
  source?: Source;
}): string => dotGrid({ ...d, stepped: true }, 'combo-dot-grid');

export const axisBand = (d: TrendData): string => trendLine(d, 'combo-axis-band');

export const trendEndLabel = (d: TrendData): string =>
  trendLine({ ...d, endLabels: 'step' }, 'combo-trend-label');

export interface FormulaData {
  terms: Array<{ label: string; value: string; assumption?: string }>;
  op: string;
  result: { label: string; value: string };
  bars?: Array<{ label: string; value: number }>;
  unit?: string;
  source?: Source;
}

export function formula(d: FormulaData): string {
  const terms = d.terms
    .map(
      (t, i) =>
        `${i ? `<span class="vs-op" aria-hidden="true">${esc(d.op)}</span>` : ''}<div class="vs-term"><b>${esc(t.value)}</b><span>${esc(t.label)}</span>${t.assumption ? `<small>가정: ${esc(t.assumption)}</small>` : ''}</div>`,
    )
    .join('');
  const max = Math.max(...(d.bars ?? [{ value: 1 }]).map((b) => b.value));
  const bars = d.bars
    ? `<div class="vs-bars">${d.bars
        .map(
          (b, i) =>
            `<div class="vs-bar-row${i === d.bars!.length - 1 ? ' is-focus' : ''}"><span class="vs-bar-l">${esc(b.label)}</span><span class="vs-bar-t"><span class="vs-bar" style="width:${((b.value / max) * 100).toFixed(1)}%"></span></span><span class="vs-bar-v">${b.value}${esc(d.unit ?? '')}</span></div>`,
        )
        .join('')}</div>`
    : '';
  return frame(
    'combo-formula',
    `<div class="vs-formula">${terms}<span class="vs-op" aria-hidden="true">=</span><div class="vs-term is-result"><b>${esc(d.result.value)}</b><span>${esc(d.result.label)}</span></div></div>${bars}`,
    { source: d.source },
  );
}

export const durationDeviation = (d: {
  total: number;
  unit: string;
  segments: DurationSegment[];
  source?: Source;
}): string => durationBar({ ...d, deviation: true }, 'combo-duration-deviation');

export interface WaveformData {
  /** 0~1 진폭 */
  samples: number[];
  segments: Array<{ from: number; to: number; time: string; line: string }>;
  source?: Source;
}

export function waveform(d: WaveformData): string {
  const W = 560;
  const H = 90;
  const bw = W / d.samples.length;
  const bars = d.samples
    .map((v, i) => {
      const h = Math.max(2, v * (H - 10));
      const seg = d.segments.findIndex((s) => i >= s.from && i < s.to);
      return `<rect x="${(i * bw + 1).toFixed(1)}" y="${((H - h) / 2).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" class="vs-wave"${seg >= 0 ? focusAt(seg + 1) : ''}/>`;
    })
    .join('');
  const lines = d.segments
    .map((s, i) => `<li${focusAt(i + 1)}><time>${esc(s.time)}</time> ${esc(s.line)}</li>`)
    .join('');
  return frame(
    'combo-waveform',
    `<svg viewBox="0 0 ${W} ${H}" class="vs-svg" role="img" aria-label="음성 파형과 구간">${bars}</svg><ol class="vs-lines vs-script">${lines}</ol>`,
    {
      source: d.source,
      steps: d.segments.map((s) => s.time),
    },
  );
}

export function chapterMap(d: {
  chapters: Array<{ n: string; title: string }>;
  source?: Source;
}): string {
  const cells = d.chapters
    .map((c, i) => `<li${focusAt(i + 1)}><b>${esc(c.n)}</b><span>${esc(c.title)}</span></li>`)
    .join('');
  return frame('combo-chapter-map', `<ol class="vs-chapters">${cells}</ol>`, {
    source: d.source,
    steps: d.chapters.map((c) => `${c.n} ${c.title}`),
  });
}

export function captureZoom(d: { lines: string[]; focus: number; source?: Source }): string {
  const rows = d.lines
    .map(
      (l, i) =>
        `<li class="${i === d.focus ? 'is-target' : ''}"><span class="vs-ln">${i + 1}</span>${esc(l)}</li>`,
    )
    .join('');
  return frame(
    'combo-capture-zoom',
    `<div class="vs-capture"><ol class="vs-lines vs-shot">${rows}</ol><div class="vs-zoom"${at(2)}><span class="vs-ln">${d.focus + 1}</span>${esc(d.lines[d.focus] ?? '')}</div></div>`,
    { source: d.source, steps: ['원문 캡처 전체', `${d.focus + 1}번째 줄 확대`] },
  );
}

export function judgmentRevision(d: {
  first: string;
  evidence: string;
  revised: string;
  source?: Source;
}): string {
  return frame(
    'combo-judgment-revision',
    `<ol class="vs-judge"><li class="vs-judge-first"><small>최초 판단</small><p><span class="vs-strike" data-strike-at="2">${esc(d.first)}</span></p></li><li${at(2)}><small>새 근거</small><p>${esc(d.evidence)}</p></li><li${at(3)} class="vs-judge-rev"><small>수정 판단</small><p>${esc(d.revised)}</p></li></ol>`,
    { source: d.source, steps: ['최초 판단', '새 근거', '수정 판단'] },
  );
}

export function fixedReveal(d: {
  title: string;
  slots: Array<{ label: string; value: string }>;
  source?: Source;
}): string {
  const cells = d.slots
    .map((s, i) => `<li><span>${esc(s.label)}</span><b${at(i + 1)}>${esc(s.value)}</b></li>`)
    .join('');
  return frame(
    'combo-fixed-reveal',
    `<h4 class="vs-h">${esc(d.title)}</h4><ol class="vs-slots">${cells}</ol>`,
    { source: d.source, steps: d.slots.map((s) => s.label) },
  );
}

export function branchReveal(d: {
  root: string;
  branches: Array<{ label: string; result: string }>;
  source?: Source;
}): string {
  const n = d.branches.length;
  const nodes: GraphNode[] = [{ id: 'root', label: d.root, group: 0, x: 90, y: 130 }];
  const edges: GraphEdge[] = [];
  d.branches.forEach((b, i) => {
    const y = 40 + (i * 180) / Math.max(1, n - 1);
    // 나뉘는 선과 도착점이 같은 단계에 함께 나와야 어디로 이어지는지 바로 보인다
    nodes.push({ id: `b${i}`, label: b.result, group: 1, x: 440, y, at: i + 1 });
    edges.push({ from: 'root', to: `b${i}`, label: b.label, at: i + 1 });
  });
  return nodeGraph(
    {
      nodes,
      edges,
      groups: ['판단 지점', '결과'],
      steps: d.branches.map((b) => b.label),
      source: d.source,
    },
    'combo-branch-reveal',
  );
}

export function converge(d: { inputs: string[]; result: string; source?: Source }): string {
  const n = d.inputs.length;
  const nodes: GraphNode[] = d.inputs.map((l, i) => ({
    id: `i${i}`,
    label: l,
    group: 1 + (i % 3),
    x: 100,
    y: 40 + (i * 180) / Math.max(1, n - 1),
    at: 1,
  }));
  nodes.push({ id: 'r', label: d.result, group: 0, x: 440, y: 130, at: 2 });
  const edges: GraphEdge[] = d.inputs.map((_, i) => ({ from: `i${i}`, to: 'r', at: 2 }));
  return nodeGraph(
    {
      nodes,
      edges,
      groups: ['결과', '입력 A', '입력 B', '입력 C'].slice(0, Math.min(4, n + 1)),
      steps: ['입력', '결과로 수렴'],
      source: d.source,
    },
    'combo-converge',
  );
}

export function cycleHuman(d: { steps: string[]; human: number; source?: Source }): string {
  const n = d.steps.length;
  const cx = 280;
  const cy = 130;
  const r = 100;
  const nodes: GraphNode[] = d.steps.map((l, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return {
      id: `s${i}`,
      label: l,
      group: i === d.human ? 1 : 0,
      x: Math.round(cx + Math.cos(a) * r * 1.6),
      y: Math.round(cy + Math.sin(a) * r),
      human: i === d.human,
      at: 1,
    };
  });
  const edges: GraphEdge[] = d.steps.map((_, i) => ({
    from: `s${i}`,
    to: `s${(i + 1) % n}`,
    at: i === n - 1 ? 2 : 1,
    dashed: i === n - 1,
  }));
  return nodeGraph(
    {
      nodes,
      edges,
      groups: ['자동 단계', '사람 개입'],
      steps: ['기존 경로', '순환으로 닫힘'],
      source: d.source,
    },
    'combo-cycle-human',
  );
}

export const matrixReveal = (d: {
  cols: string[];
  rows: Array<{ label: string; cells: Array<StatusKind | null> }>;
  source?: Source;
}): string => statusMatrix({ ...d, reveal: true }, 'combo-matrix-reveal');
