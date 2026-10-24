import { rangeSpan } from './reports.js';
import type { Segment, Transcript } from './schema.js';

/** `90`, `1:30`, `1:02:03`을 초로 바꾼다. 꼴이 틀리면 null이다 */
export function parseTimeArg(value: string): number | null {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2]!), Number(m[3]!)];
  if (ss >= 60 || (m[1] !== undefined && mm >= 60)) return null;
  return h * 3600 + mm * 60 + ss;
}

/** `1:30-5:00` 꼴 구간을 [시작, 끝) 초로 바꾼다 */
export function parseRangeArg(value: string): [number, number] {
  const parts = value.split('-');
  const from = parts.length === 2 ? parseTimeArg(parts[0]!) : null;
  const to = parts.length === 2 ? parseTimeArg(parts[1]!) : null;
  if (from === null || to === null) {
    throw new Error(`구간은 시작-끝 꼴이어야 해요(예: 1:30-5:00, 90-300): ${value}`);
  }
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error(`구간은 초 단위 정수여야 해요: ${value}`);
  }
  if (from >= to) throw new Error(`구간 시작이 끝보다 앞이어야 해요: ${value}`);
  return [from, to];
}

export interface TranscriptSlice {
  slug: string;
  range: [number, number];
  /** 구간이 덮는 첫 문장과 끝 문장 번호 */
  from: number;
  to: number;
  segments: Segment[];
}

/**
 * 구간 리포트가 읽을 문장만 잘라 낸다. 출처는 원래 스크립트의 문장 번호를 가리켜야 해서
 * i를 다시 매기지 않는다. 그래서 transcript.json 꼴이 아니라 따로 저장한다
 */
export function sliceTranscript(
  transcript: Transcript,
  range: readonly [number, number],
): TranscriptSlice {
  const span = rangeSpan(range, transcript.segments);
  if (!span) {
    throw new Error(
      `구간 ${range[0]}~${range[1]}초에 든 문장이 없어요. 영상 길이는 ${transcript.meta.durationSec}초예요`,
    );
  }
  return {
    slug: transcript.slug,
    range: [range[0], range[1]],
    from: span.from,
    to: span.to,
    segments: transcript.segments.slice(span.from, span.to + 1),
  };
}

export const sliceFileName = (range: readonly [number, number]): string =>
  `transcript.slice-${Math.floor(range[0])}-${Math.floor(range[1])}.json`;
