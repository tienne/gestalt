import type { FollowUpMarker } from './types.js';

const MARKER_TAG = 'gestalt-followup';
const MARKER_VERSION = 'v1';
const MARKER_PATTERN = new RegExp(
  `<!--\\s*${MARKER_TAG}\\s+${MARKER_VERSION}\\s+(\\{.*?\\})\\s*-->`,
  'g',
);

const REPO_PATTERN = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const PR_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const MAX_FIELD_LENGTH = 500;
const MIN_WORK_COVERAGE = 0.5;

// 작업 문장에서 뽑은 단어가 너무 흔하면 이행 여부를 못 가르므로 뺀다.
const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'to',
  'of',
  'in',
  'on',
  'a',
  'an',
  '추가',
  '작업',
  '수정',
]);

export interface FollowUpPr {
  repo: string;
  number: number;
  body: string;
  diff: string;
}

export type FollowUpMatchStatus = 'fulfilled' | 'unmet' | 'wrongRepo';

export interface FollowUpMatch {
  status: FollowUpMatchStatus;
  mentionsOrigin: boolean;
  coverage: number;
  missingTerms: string[];
}

/**
 * resolve 답글 본문을 만든다. 첫 줄은 기계가 읽는 HTML 주석, 둘째 줄은 사람이 읽는 문장이다.
 * JSON 안의 `<`, `>`는 이스케이프해서 값이 주석을 조기에 닫지 못하게 한다.
 */
export function buildFollowUpMarker(marker: FollowUpMarker): string {
  const payload = JSON.stringify(pickFields(marker))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/-/g, '\\u002d');
  const human = `후속 작업 예정: ${marker.targetRepo}에서 "${oneLine(marker.plannedWork)}"`;
  return `<!-- ${MARKER_TAG} ${MARKER_VERSION} ${payload} -->\n${human}`;
}

/**
 * 코멘트 본문에서 마커의 정해진 필드만 뽑는다. 주석 밖 문장과 모르는 필드는 버리고
 * 필드가 하나라도 형식에 안 맞는 마커는 통째로 건너뛴다.
 * 코멘트 작성자는 검증하지 않으므로 호출부가 신뢰할 작성자의 코멘트만 넘겨야 한다.
 */
export function parseFollowUpMarkers(commentBody: string): FollowUpMarker[] {
  const markers: FollowUpMarker[] = [];
  for (const m of commentBody.matchAll(MARKER_PATTERN)) {
    const marker = toMarker(m[1]!);
    if (marker) markers.push(marker);
  }
  return markers;
}

export function isFulfilled(marker: FollowUpMarker): boolean {
  return marker.fulfilledByPr !== undefined;
}

/** 후속 PR이 마커의 레포와 작업을 이행하는지 본다. 본문과 diff는 단어 매칭에만 쓴다. */
export function matchFollowUp(marker: FollowUpMarker, pr: FollowUpPr): FollowUpMatch {
  const mentionsOrigin = mentionsOriginPr(marker, pr.body);
  if (pr.repo.toLowerCase() !== marker.targetRepo.toLowerCase()) {
    return { status: 'wrongRepo', mentionsOrigin, coverage: 0, missingTerms: [] };
  }
  const terms = extractTerms(marker.plannedWork);
  if (terms.length === 0) {
    return { status: 'unmet', mentionsOrigin, coverage: 0, missingTerms: [] };
  }
  const haystack = `${pr.body}\n${addedDiffText(pr.diff)}`.toLowerCase();
  const missingTerms = terms.filter((t) => !termAppears(t, haystack));
  const coverage = (terms.length - missingTerms.length) / terms.length;
  return {
    status: coverage >= MIN_WORK_COVERAGE ? 'fulfilled' : 'unmet',
    mentionsOrigin,
    coverage,
    missingTerms,
  };
}

function pickFields(marker: FollowUpMarker): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    originRepo: marker.originRepo,
    originPrNumber: marker.originPrNumber,
    threadId: marker.threadId,
    targetRepo: marker.targetRepo,
    plannedWork: oneLine(marker.plannedWork),
  };
  if (marker.fulfilledByPr !== undefined) fields.fulfilledByPr = marker.fulfilledByPr;
  return fields;
}

function toMarker(json: string): FollowUpMarker | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { originRepo, originPrNumber, threadId, targetRepo, plannedWork, fulfilledByPr } = r;
  if (typeof originRepo !== 'string' || !REPO_PATTERN.test(originRepo)) return null;
  if (typeof targetRepo !== 'string' || !REPO_PATTERN.test(targetRepo)) return null;
  if (
    typeof originPrNumber !== 'number' ||
    !Number.isInteger(originPrNumber) ||
    originPrNumber <= 0
  )
    return null;
  if (!isBoundedString(threadId) || !isBoundedString(plannedWork)) return null;
  const marker: FollowUpMarker = { originRepo, originPrNumber, threadId, targetRepo, plannedWork };
  if (fulfilledByPr !== undefined) {
    if (typeof fulfilledByPr !== 'string' || !PR_REF_PATTERN.test(fulfilledByPr)) return null;
    marker.fulfilledByPr = fulfilledByPr;
  }
  return marker;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function mentionsOriginPr(marker: FollowUpMarker, body: string): boolean {
  const escaped = marker.originRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(#|/pull/)${marker.originPrNumber}(?!\\d)`, 'i');
  return pattern.test(body);
}

function addedDiffText(diff: string): string {
  return diff
    .split('\n')
    .filter(
      (line) => (line.startsWith('+') && !line.startsWith('+++')) || line.startsWith('+++ b/'),
    )
    .join('\n');
}

function extractTerms(work: string): string[] {
  const tokens = work.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
  const unique = new Set(tokens.filter((t) => t.length >= 2 && !STOP_TOKENS.has(t)));
  return [...unique];
}

// 한글 토큰은 조사가 붙어 형태가 달라지므로 마지막 글자를 뗀 어간도 허용한다.
function termAppears(term: string, haystack: string): boolean {
  if (haystack.includes(term)) return true;
  return /^\p{Script=Hangul}{3,}$/u.test(term) && haystack.includes(term.slice(0, -1));
}
