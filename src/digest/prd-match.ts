import type { PrdBlock } from './prd-schema.js';

/** 블록 글이 원문 범위와 이 비율 이상 글자 bigram이 겹치면 원문에서 온 글로 본다 */
export const TEXT_MATCH_MIN = 0.6;
/** 정규화 뒤 이보다 짧은 글은 대조하지 않는다. 한두 글자는 우연히 겹치거나 안 겹친다 */
export const MIN_MATCH_CHARS = 4;

/**
 * 비교용으로 글을 정리한다. 한국어는 띄어쓰기와 조사가 자주 바뀌어서 단어가 아니라 글자로 비교한다.
 * 링크는 글자만 남기고 마크다운 기호, 태그, 공백, 구두점을 지운다
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`~|>#\\]/g, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s: string): string[] {
  const chars = [...s];
  const out: string[] = [];
  for (let k = 0; k + 1 < chars.length; k++) out.push(chars[k]! + chars[k + 1]!);
  return out;
}

/** 블록 글의 bigram 가운데 원문 범위에도 있는 비율 */
export function bigramContainment(text: string, source: string): number {
  const grams = bigrams(text);
  if (grams.length === 0) return 1;
  const pool = new Set(bigrams(source));
  let hit = 0;
  for (const g of grams) if (pool.has(g)) hit++;
  return hit / grams.length;
}

/** 이미 정규화한 글끼리 비교한다 */
export function matchesSource(normText: string, normSource: string): boolean {
  if ([...normText].length < MIN_MATCH_CHARS) return true;
  if (normSource.includes(normText)) return true;
  return bigramContainment(normText, normSource) >= TEXT_MATCH_MIN;
}

export interface VerbatimField {
  /** 블록 안의 필드 경로(detail.0 같은) */
  field: string;
  text: string;
}

/**
 * 원문에서 옮겨 온 글 필드만 꺼낸다. id, 상태, 단계, 역할, 읽는 사람 태그처럼
 * 세션이 분류해서 붙이는 값은 원문에 글자로 없으니 뺀다
 */
export function verbatimFields(block: PrdBlock): VerbatimField[] {
  const out: VerbatimField[] = [];
  const add = (field: string, text: string | undefined) => {
    if (text) out.push({ field, text });
  };
  switch (block.kind) {
    case 'claim':
    case 'prose':
      add('text', block.text);
      break;
    case 'requirement':
      add('title', block.title);
      add('why', block.why);
      add('boundary', block.boundary);
      block.detail?.forEach((d, k) => add(`detail.${k}`, d));
      break;
    case 'metric':
      add('name', block.name);
      add('denominator', block.denominator);
      add('baseline', block.baseline);
      add('target', block.target);
      add('measure', block.measure);
      break;
    case 'decision':
      add('decided', block.decided);
      add('why', block.why);
      block.rejected?.forEach((r, k) => {
        add(`rejected.${k}.option`, r.option);
        add(`rejected.${k}.reason`, r.reason);
      });
      break;
    case 'question':
      add('item', block.item);
      add('owner', block.owner);
      add('due', block.due);
      break;
    case 'compare':
      block.labels.forEach((l, k) => add(`labels.${k}`, l));
      block.rows.forEach((r, k) => {
        add(`rows.${k}.label`, r.label);
        add(`rows.${k}.left`, r.left);
        add(`rows.${k}.right`, r.right);
      });
      break;
    case 'scope':
      block.out.forEach((o, k) => add(`out.${k}`, o));
      break;
    case 'quote':
      add('text', block.text);
      add('by', block.by);
      break;
    case 'flow':
      block.steps.forEach((x, k) => add(`steps.${k}`, x));
      break;
    case 'stateMatrix':
      block.rows.forEach((x, k) => add(`rows.${k}`, x));
      block.cols.forEach((x, k) => add(`cols.${k}`, x));
      block.cells.forEach((row, i) =>
        row.forEach((c, j) => add(`cells.${i}.${j}`, c ?? undefined)),
      );
      break;
    case 'timeline':
      block.items.forEach((x, k) => {
        add(`items.${k}.date`, x.date);
        add(`items.${k}.what`, x.what);
      });
      break;
    case 'glossary':
      block.terms.forEach((x, k) => {
        add(`terms.${k}.term`, x.term);
        add(`terms.${k}.meaning`, x.meaning);
      });
      break;
    case 'callout':
      add('text', block.text);
      break;
  }
  return out;
}
