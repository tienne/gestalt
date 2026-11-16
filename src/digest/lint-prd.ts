import { lintPrdReferences } from './lint-prd-references.js';
import { numbersIn } from './lint-lens.js';
import { matchesSource, normalizeForMatch, verbatimFields } from './prd-match.js';
import { allBlocks, type LineRange, type PrdView } from './prd-schema.js';
import { classifyLines, headingTexts, type PrdSource } from './prd-source.js';

export type PrdSeverity = 'error' | 'warning';

export interface PrdIssue {
  path: string;
  severity: PrdSeverity;
  code: string;
  message: string;
  blockId?: string;
}

/** 내용 줄 가운데 어느 블록에도 안 걸린 비율이 이보다 크면 경고 */
export const COVERAGE_WARN_RATIO = 0.1;
/** 이보다 크면 원문 3분의 1 가까이가 화면에 없는 것이라 렌더를 막는다 */
export const COVERAGE_ERROR_RATIO = 0.3;
/** 생략 선언이 내용 줄의 이 비율을 넘으면 경고. 생략으로 coverage를 채우는 걸 막는다 */
export const OMITTED_WARN_RATIO = 0.25;
/** 요약이 아닌 블록이 이보다 많은 내용 줄을 src로 잡으면 경고 */
export const SRC_WIDE_LINES = 25;
/** 블록 하나가 문서 내용 줄의 이 비율을 넘게 잡으면 경고 */
export const SRC_MOST_RATIO = 0.4;
/** 내용 줄이 이보다 적은 짧은 문서는 SRC_COVERS_MOST를 보지 않는다. 블록 하나가 절반을 덮는 게 자연스럽다 */
const SRC_MOST_MIN_LINES = 20;
const MAX_RANGES = 20;
const PREVIEW_CHARS = 80;

export interface UncoveredRange {
  from: number;
  to: number;
  preview: string;
}

export interface PrdCoverage {
  contentLines: number;
  coveredLines: number;
  omittedLines: number;
  uncoveredLines: number;
  uncoveredRatio: number;
  ranges: UncoveredRange[];
  truncated: boolean;
}

export interface PrdLintResult {
  issues: PrdIssue[];
  coverage: PrdCoverage;
}

function* linesOf(ranges: readonly LineRange[], max: number): Generator<number> {
  for (const [a, b] of ranges) for (let n = a; n <= Math.min(b, max); n++) yield n;
}

function rangeText(source: PrdSource, ranges: readonly LineRange[]): string {
  return [...linesOf(ranges, source.lines.length)].map((n) => source.lines[n - 1]!).join('\n');
}

const fmtRange = ([a, b]: LineRange) => (a === b ? `L${a}` : `L${a}-${b}`);

/**
 * PRD 뷰를 원문과 대조한다. 의미까지 보지는 않는다.
 * 보장하는 건 블록 글이 지목한 줄 근처에서 왔고 원문 내용 줄이 어딘가에 옮겨졌다는 것까지다
 */
export function lintPrdView(view: PrdView, source: PrdSource): PrdLintResult {
  const issues: PrdIssue[] = lintPrdReferences(view);
  const total = source.lines.length;
  const classes = classifyLines(source.lines);
  const isContent = (n: number) => classes[n - 1] === 'content';
  const contentLines = classes.filter((c) => c === 'content').length;
  const push = (i: PrdIssue) => issues.push(i);

  if (view.meta.sourceSha256 && view.meta.sourceSha256 !== source.sha256) {
    push({
      path: 'meta.sourceSha256',
      severity: 'warning',
      code: 'SOURCE_STALE',
      message: '뷰를 만든 뒤 원문이 바뀌었다. 바뀐 곳을 다시 읽고 sourceSha256을 갱신한다',
    });
  }

  const checkRanges = (ranges: readonly LineRange[], path: string, blockId?: string): boolean => {
    let ok = true;
    for (const [k, r] of ranges.entries()) {
      if (r[1] > total) {
        ok = false;
        push({
          path: `${path}.${k}`,
          severity: 'error',
          code: 'SRC_OUT_OF_RANGE',
          message: `${fmtRange(r)}가 원문 줄 수(${total})를 넘는다`,
          blockId,
        });
      }
    }
    return ok;
  };

  const covered = new Set<number>();
  const checkText = (
    text: string,
    ranges: readonly LineRange[],
    path: string,
    summary = false,
    blockId?: string,
  ) => {
    const original = rangeText(source, ranges);
    if (!summary && !matchesSource(normalizeForMatch(text), normalizeForMatch(original))) {
      push({
        path,
        severity: 'warning',
        code: 'TEXT_NOT_IN_SOURCE',
        message: `"${text.slice(0, 40)}"가 src 범위 원문에 없다. 줄 범위와 원문을 대조한다`,
        blockId,
      });
    }
    const sourceNumbers = new Set(numbersIn(original));
    const missing = numbersIn(text).filter((n) => !sourceNumbers.has(n));
    if (missing.length)
      push({
        path,
        severity: 'warning',
        code: 'NUMBER_NOT_IN_SOURCE',
        message: `숫자 ${[...new Set(missing)].join(', ')}가 src 범위 원문에 없다`,
        blockId,
      });
  };
  for (const [k, row] of view.meta.rows.entries()) {
    if (checkRanges(row.src, `meta.rows.${k}.src`))
      checkText(row.value, row.src, `meta.rows.${k}.value`);
    for (const n of linesOf(row.src, total)) covered.add(n);
  }
  for (const key of ['roles', 'platforms'] as const) {
    for (const [k, value] of (view.meta[key] ?? []).entries()) {
      if (checkRanges(value.src, `meta.${key}.${k}.src`))
        checkText(value.text, value.src, `meta.${key}.${k}.text`);
      for (const n of linesOf(value.src, total)) covered.add(n);
    }
  }

  // id와 지표 참조
  const ids = new Map<string, string>();
  const claimId = (id: string, path: string) => {
    const prev = ids.get(id);
    if (prev) {
      push({
        path,
        severity: 'error',
        code: 'DUPLICATE_ID',
        message: `id "${id}"가 ${prev}에도 있다`,
        blockId: id,
      });
    } else ids.set(id, path);
  };
  const metricIds = new Map<string, string>();
  for (const [si, s] of view.sections.entries()) claimId(s.id, `sections.${si}`);
  for (const { block, path } of allBlocks(view)) {
    claimId(block.id, path);
    if (block.kind === 'metric') {
      const prev = metricIds.get(block.metricId);
      if (prev) {
        push({
          path: `${path}.metricId`,
          severity: 'error',
          code: 'DUPLICATE_METRIC_ID',
          message: `metricId "${block.metricId}"가 ${prev}에도 있다`,
          blockId: block.id,
        });
      } else metricIds.set(block.metricId, path);
    }
  }

  const headings = headingTexts(source.lines, classes).map(normalizeForMatch);
  for (const [si, s] of view.sections.entries()) {
    const t = normalizeForMatch(s.title);
    if (!headings.some((h) => h.includes(t) || t.includes(h) || matchesSource(t, h))) {
      push({
        path: `sections.${si}.title`,
        severity: 'warning',
        code: 'SECTION_TITLE_NOT_IN_SOURCE',
        message: `섹션 제목 "${s.title}"가 원문 헤딩에 없다. 원문 섹션 이름을 따른다`,
      });
    }
  }

  for (const { block, path } of allBlocks(view)) {
    if (block.kind === 'requirement') {
      for (const [k, m] of (block.metrics ?? []).entries()) {
        if (!metricIds.has(m)) {
          push({
            path: `${path}.metrics.${k}`,
            severity: 'error',
            code: 'UNKNOWN_METRIC',
            message: `없는 metricId "${m}"를 참조한다`,
            blockId: block.id,
          });
        }
      }
    }

    if (!checkRanges(block.src, `${path}.src`, block.id)) continue;
    const blockLines = [...linesOf(block.src, total)];
    for (const n of blockLines) covered.add(n);
    const blockContent = blockLines.filter(isContent).length;
    if (blockContent === 0) {
      push({
        path: `${path}.src`,
        severity: 'error',
        code: 'SRC_ON_BLANK',
        message: `src ${block.src.map(fmtRange).join(', ')}에 내용 줄이 없다`,
        blockId: block.id,
      });
      continue;
    }
    if (!block.summary && blockContent > SRC_WIDE_LINES) {
      push({
        path: `${path}.src`,
        severity: 'warning',
        code: 'SRC_TOO_WIDE',
        message: `src가 내용 줄 ${blockContent}줄을 잡는다. 블록을 나누거나 실제로 옮긴 줄만 단다`,
        blockId: block.id,
      });
    }
    if (contentLines >= SRC_MOST_MIN_LINES && blockContent > contentLines * SRC_MOST_RATIO) {
      push({
        path: `${path}.src`,
        severity: 'warning',
        code: 'SRC_COVERS_MOST',
        message: `블록 하나가 문서 내용 줄의 ${Math.round((blockContent / contentLines) * 100)}%를 잡는다`,
        blockId: block.id,
      });
    }

    const text = rangeText(source, block.src);
    for (const f of verbatimFields(block)) {
      if (f.src) {
        const fieldPath = `${path}.${f.field.replace(/\.text$/, '')}.src`;
        if (!checkRanges(f.src, fieldPath, block.id)) continue;
        const fieldLines = [...linesOf(f.src, total)];
        for (const n of fieldLines) covered.add(n);
        if (!fieldLines.some(isContent))
          push({
            path: fieldPath,
            severity: 'error',
            code: 'SRC_ON_BLANK',
            message: 'src에 내용 줄이 없다',
            blockId: block.id,
          });
      }
      checkText(f.text, f.src ?? block.src, `${path}.${f.field}`, block.summary, block.id);
    }
    if (
      block.kind === 'metric' &&
      /\bM\d+\b/.test(source.lines.join('\n')) &&
      !text.includes(block.metricId)
    ) {
      push({
        path: `${path}.metricId`,
        severity: 'warning',
        code: 'METRIC_ID_NOT_IN_SOURCE',
        message: `metricId "${block.metricId}"가 src 범위 원문에 없다`,
        blockId: block.id,
      });
    }
  }

  const omitted = new Set<number>();
  for (const [k, o] of view.omitted.entries()) {
    checkRanges(o.src, `omitted.${k}.src`);
    for (const n of linesOf(o.src, total)) if (isContent(n) && !covered.has(n)) omitted.add(n);
  }

  const coverage = computeCoverage(source, classes, covered, omitted, contentLines);
  if (contentLines > 0 && omitted.size / contentLines > OMITTED_WARN_RATIO) {
    push({
      path: 'omitted',
      severity: 'warning',
      code: 'OMITTED_TOO_MUCH',
      message: `생략 선언이 내용 줄의 ${Math.round((omitted.size / contentLines) * 100)}%다. 옮길 수 있는 구간은 블록으로 옮긴다`,
    });
  }
  if (coverage.uncoveredRatio > COVERAGE_ERROR_RATIO) {
    push({
      path: 'sections',
      severity: 'error',
      code: 'COVERAGE_LOW',
      message: `원문 내용 줄의 ${pct(coverage.uncoveredRatio)}가 어느 블록에도 없다. coverage.ranges를 읽고 블록을 더하거나 omitted로 이유를 적는다`,
    });
  } else if (coverage.uncoveredRatio > COVERAGE_WARN_RATIO) {
    push({
      path: 'sections',
      severity: 'warning',
      code: 'COVERAGE_GAP',
      message: `원문 내용 줄의 ${pct(coverage.uncoveredRatio)}가 어느 블록에도 없다`,
    });
  }
  return { issues, coverage };
}

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

function computeCoverage(
  source: PrdSource,
  classes: readonly string[],
  covered: ReadonlySet<number>,
  omitted: ReadonlySet<number>,
  contentLines: number,
): PrdCoverage {
  const ranges: UncoveredRange[] = [];
  let uncovered = 0;
  let coveredContent = 0;
  let open: UncoveredRange | null = null;
  for (let n = 1; n <= source.lines.length; n++) {
    if (classes[n - 1] !== 'content') continue;
    if (covered.has(n)) coveredContent++;
    const gap = !covered.has(n) && !omitted.has(n);
    if (!gap) {
      open = null;
      continue;
    }
    uncovered++;
    // 사이에 낀 빈 줄이나 헤딩은 건너뛰고 이어지는 미포함 내용 줄을 한 구간으로 묶는다
    if (open) open.to = n;
    else {
      open = { from: n, to: n, preview: source.lines[n - 1]!.trim().slice(0, PREVIEW_CHARS) };
      ranges.push(open);
    }
  }
  return {
    contentLines,
    coveredLines: coveredContent,
    omittedLines: omitted.size,
    uncoveredLines: uncovered,
    uncoveredRatio: contentLines === 0 ? 0 : uncovered / contentLines,
    ranges: ranges.slice(0, MAX_RANGES),
    truncated: ranges.length > MAX_RANGES,
  };
}

export const prdLintErrors = (issues: readonly PrdIssue[]) =>
  issues.filter((i) => i.severity === 'error');
export const prdLintWarnings = (issues: readonly PrdIssue[]) =>
  issues.filter((i) => i.severity === 'warning');
