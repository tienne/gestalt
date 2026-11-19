import { rangeSpan } from './reports.js';
import type { Bullet, Cite, Report, Segment, Transcript } from './schema.js';

const STOP_WORDS = new Set(
  'about actually after again also and are because been being both can could does each even every first for from gonna had has have here how just like make might more most much now only other our out over really say see should some than that the their them then there these they thing this those through time too two use used very want was way were what when where which who will with would yeah you your'.split(
    ' ',
  ),
);
const REFERS_BACK =
  /\b(?:earlier|up until now|to be precise|to clarify|i meant|let me correct)\b|앞에서|정확히 말하면|정정하/u;
const CLARIFICATION_CUE = /\bactually\b|실제로는|정확히는/u;
const MAX_CANDIDATES = 24;
const MAX_PER_CLAIM = 3;
const MAX_SEGMENT_CHARS = 350;

type Span = { from: number; to: number };
interface Claim {
  anchor: Cite;
  text: string;
  comparison?: string;
}

function* bullets(items: Bullet[]): Generator<Bullet> {
  for (const item of items) {
    yield item;
    if (item.children) yield* bullets(item.children);
  }
}

/** 구간 본문에 이미 인용된 영상 발언만 후속 설명의 시작점으로 쓴다 */
export function followupClaims(report: Report, span: Span): Claim[] {
  const claims = new Map<number, Claim>();
  for (const section of report.sections) {
    for (const sub of section.subsections) {
      for (const bullet of bullets(sub.bullets)) {
        const anchor = bullet.comparison?.video.cite ?? bullet.cite;
        if (anchor.source || anchor.from < span.from || anchor.to > span.to) continue;
        if (anchor.key < anchor.from || anchor.key > anchor.to) continue;
        const comparison = bullet.comparison?.note;
        if (!claims.has(anchor.key) || comparison) {
          claims.set(anchor.key, {
            anchor,
            text: bullet.text,
            ...(comparison ? { comparison } : {}),
          });
        }
      }
    }
  }
  return [...claims.values()];
}

function terms(text: string): Set<string> {
  const found =
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}]{3,}/gu) ?? [];
  return new Set(
    found
      .map((word) => word.replace(/^([a-z]{3,}[^s])s$/, '$1'))
      .filter((word) => !STOP_WORDS.has(word)),
  );
}

function excerpt(segments: Segment[], from: number, to: number) {
  return segments
    .slice(from, to + 1)
    .map(({ i, startSec, text }) => ({ i, startSec, text: text.slice(0, MAX_SEGMENT_CHARS) }));
}

function anchorExcerpt(transcript: Transcript, anchor: Cite, span: Span) {
  return excerpt(
    transcript.segments,
    Math.max(span.from, anchor.key - 3),
    Math.min(span.to, anchor.key + 2),
  );
}

/** 후속 인용에 앞선 발언의 문맥을 식별하는 말이 있는지 최소한으로 검사한다 */
export function hasFollowupContext(
  transcript: Transcript,
  span: Span,
  anchor: Cite,
  quote: string,
): boolean {
  const before = terms(
    anchorExcerpt(transcript, anchor, span)
      .map((s) => s.text)
      .join(' '),
  );
  return [...terms(quote)].filter((word) => before.has(word)).length >= 2;
}

/** 지역에서 관련 대목만 고른다. 후보가 실제로 같은 주장을 보충하는지는 양쪽 원문으로 판정한다 */
export function findFollowupCandidates(transcript: Transcript, report: Report) {
  const range = report.options.range;
  const video = transcript.meta.source === 'youtube' || transcript.meta.source === 'file';
  const span = range && video ? rangeSpan(range, transcript.segments) : null;
  if (!span) return [];
  const claims = followupClaims(report, span);
  const { segments } = transcript;
  const first = span.to + 1;
  const after = segments.slice(first).map((segment) => terms(segment.text));
  const frequencies = new Map<string, number>();
  for (const tokens of after) {
    for (const word of tokens) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  const weight = (word: string) => Math.log1p(after.length / (frequencies.get(word) ?? 1));

  const ranked = claims.flatMap((claim) => {
    const { anchor } = claim;
    const before = anchorExcerpt(transcript, anchor, span);
    const keyTerms = terms(segments[anchor.key]?.text ?? '');
    const anchorTerms = terms(before.map((s) => s.text).join(' '));
    const windows = after.flatMap((tokens, offset) => {
      if (![...tokens].some((word) => keyTerms.has(word))) return [];
      const key = first + offset;
      const from = Math.max(first, key - 2);
      const to = Math.min(segments.length - 1, key + 4);
      const nearby = excerpt(segments, from, to);
      const windowText = nearby
        .map((s) => s.text)
        .join(' ')
        .toLowerCase();
      const local = terms(windowText);
      const shared = [...local].filter((word) => anchorTerms.has(word));
      if (shared.length < 2) return [];
      const score =
        shared.reduce((n, word) => n + weight(word), 0) +
        [...tokens].filter((word) => keyTerms.has(word)).reduce((n, word) => n + weight(word), 0) +
        (REFERS_BACK.test(windowText) ? 12 : 0) +
        (CLARIFICATION_CUE.test(segments[key]?.text.toLowerCase() ?? '') ? 3 : 0);
      return [{ score, cite: { key, from, to }, after: nearby }];
    });
    windows.sort((a, b) => b.score - a.score || a.cite.key - b.cite.key);
    const best: typeof windows = [];
    for (const window of windows) {
      if (
        best.some((other) => other.cite.to >= window.cite.from && other.cite.from <= window.cite.to)
      )
        continue;
      best.push(window);
      if (best.length === MAX_PER_CLAIM) break;
    }
    return best.map(({ score, cite, after }) => ({
      rank: score + (claim.comparison ? 100 : 0),
      claim: claim.text.slice(0, MAX_SEGMENT_CHARS),
      ...(claim.comparison ? { comparison: claim.comparison.slice(0, MAX_SEGMENT_CHARS) } : {}),
      anchor,
      before,
      cite,
      after,
    }));
  });
  return ranked
    .sort((a, b) => b.rank - a.rank || a.anchor.key - b.anchor.key)
    .slice(0, MAX_CANDIDATES)
    .map(({ claim, comparison, anchor, before, cite, after }) => ({
      claim,
      comparison,
      anchor,
      before,
      cite,
      after,
    }));
}
