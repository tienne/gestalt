import type { DigestIssue } from './lint.js';
import type { Cite, Transcript } from './schema.js';
import { citeTranscript, type SlideContext } from './slides.js';

export function locateCite(
  cite: Cite,
  path: string,
  transcript: Transcript,
  slides: SlideContext['slides'] | undefined,
  slidesAllowed: boolean,
  issues: DigestIssue[],
): Transcript | undefined {
  if (cite.source && !slidesAllowed) {
    issues.push({
      path,
      severity: 'error',
      code: 'SLIDE_CITE_NOT_ALLOWED',
      message: '이 자리에는 기본 원문 번호를 쓴다',
    });
    return;
  }
  const original = citeTranscript(cite, transcript, slides);
  if (!original) {
    issues.push({
      path,
      severity: 'error',
      code: 'SLIDE_SOURCE_NOT_FOUND',
      message: `저장된 슬라이드 원문이 없다: ${cite.source}`,
    });
    return;
  }
  if (cite.to >= original.segments.length) {
    const word = cite.source ? '슬라이드 문단' : '문장';
    issues.push({
      path,
      severity: 'error',
      code: 'CITE_OUT_OF_RANGE',
      message: `${cite.to}번 ${word}이 없다. 번호는 0~${original.segments.length - 1}이다`,
    });
    return;
  }
  return original;
}

// 자동 자막은 문장부호와 대소문자가 흔들려서 글자와 숫자만 남겨 비교한다.
export const normalizeQuote = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

export function checkSourceQuote(
  text: string,
  cite: Cite,
  transcript: Transcript,
  path: string,
  issues: DigestIssue[],
  severity: DigestIssue['severity'],
): void {
  const original = transcript.segments
    .slice(cite.from, cite.to + 1)
    .map((s) => s.text)
    .join(' ');
  const normalize =
    severity === 'error'
      ? (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim()
      : normalizeQuote;
  const quote = normalize(text);
  if ((!quote && severity === 'warning') || (quote && normalize(original).includes(quote))) return;
  const word = cite.source ? '슬라이드 문단' : '원문 문장';
  issues.push({
    path,
    severity,
    code: 'QUOTE_NOT_IN_SOURCE',
    message: `인용문이 ${cite.from}~${cite.to}번 ${word}에 그대로 없다`,
  });
}
