import { followupClaims, hasFollowupContext } from './followups.js';
import { checkSourceQuote, locateCite, normalizeQuote } from './lint-cite.js';
import type { DigestIssue } from './lint.js';
import type { Cite, Report, Transcript } from './schema.js';

function quoteAtKey(transcript: Transcript, cite: Cite, quote: string): boolean {
  const parts = transcript.segments
    .slice(cite.from, cite.to + 1)
    .map((s) => normalizeQuote(s.text));
  const key = cite.key - cite.from;
  const start = parts.slice(0, key).join('').length;
  const end = start + (parts[key]?.length ?? 0);
  const needle = normalizeQuote(quote);
  const context = parts.join('');
  if (!needle || end === start) return false;
  const at = context.indexOf(needle, Math.max(0, start - needle.length + 1));
  return at >= 0 && at < end;
}

/** 구간 뒤 원문을 허용하는 필드는 여기서 따로 본다. 본문 인용이나 커버리지 범위에는 들어가지 않는다 */
export function checkFollowups(
  report: Report,
  path: string,
  transcript: Transcript,
  span: { from: number; to: number } | null,
  issues: DigestIssue[],
): void {
  if (!report.followups?.length) return;
  const kind = transcript.meta.source;
  const add = (field: string, code: string, message: string) =>
    issues.push({ path: field, code, message, severity: 'error' });
  const range = report.options.range;
  if (!range || !span || (kind !== 'youtube' && kind !== 'file')) {
    add(
      `${path}.followups`,
      'FOLLOWUP_RANGE_REQUIRED',
      '후속 설명은 시간 구간을 정한 영상 리포트에만 쓴다',
    );
    return;
  }

  const claims = new Map(followupClaims(report, span).map(({ anchor }) => [anchor.key, anchor]));
  const seen = new Set<string>();
  for (const [index, followup] of report.followups.entries()) {
    const at = `${path}.followups.${index}`;
    const { anchor, cite, quote } = followup;
    const claim = claims.get(anchor.key);
    if (anchor.source || !claim || claim.from !== anchor.from || claim.to !== anchor.to) {
      add(
        `${at}.anchor`,
        'FOLLOWUP_ANCHOR_UNKNOWN',
        '구간 본문 불릿의 영상 인용이나 슬라이드 비교의 영상 인용을 그대로 쓴다',
      );
    }
    const original = locateCite(cite, `${at}.cite`, transcript, undefined, false, issues);
    if (!original) continue;
    if (cite.from <= span.to || (transcript.segments[cite.from]?.startSec ?? 0) < range[1]) {
      add(
        `${at}.cite`,
        'FOLLOWUP_NOT_AFTER_RANGE',
        '후속 설명의 인용은 요약 구간이 끝난 뒤에 시작해야 한다',
      );
    }
    if (
      cite.key < cite.from ||
      cite.key > cite.to ||
      cite.to - cite.from >= 8 ||
      !quoteAtKey(transcript, cite, quote)
    ) {
      add(
        `${at}.cite`,
        'FOLLOWUP_CITE_SPAN',
        '여덟 문장 이내로 인용 범위를 좁히고 실제 인용문이 걸친 핵심 문장을 key로 둔다',
      );
    }
    const pair = `${anchor.key}:${cite.key}`;
    if (seen.has(pair))
      add(at, 'FOLLOWUP_DUPLICATE', '같은 본문 인용과 후속 설명을 한 번만 잇는다');
    seen.add(pair);
    checkSourceQuote(quote, cite, original, `${at}.quote`, issues, 'error');
    if (claim && !hasFollowupContext(transcript, span, claim, quote)) {
      add(
        `${at}.quote`,
        'FOLLOWUP_CONTEXT_MISSING',
        '앞선 발언과 직접 이어지는 말이 담긴 원문을 인용한다',
      );
    }
  }
}
