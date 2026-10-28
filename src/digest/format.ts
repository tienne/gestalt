import type { Transcript } from './schema.js';

/** 1시간이 넘는 영상만 시를 붙인다. 스크립트 패널 폭을 아끼려는 것이다 */
export function formatTime(sec: number, withHours = false): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 || withHours
    ? `${h}:${String(m).padStart(2, '0')}:${r}`
    : `${String(m).padStart(2, '0')}:${r}`;
}

/** 유튜브 영상이면 그 시각으로 여는 주소, 아니면 null */
export function watchUrlAt(meta: Transcript['meta'], sec: number): string | null {
  if (meta.source !== 'youtube' || !meta.videoId) return null;
  return `https://www.youtube.com/watch?v=${meta.videoId}&t=${Math.floor(Math.max(0, sec))}s`;
}

/** 작성자가 "1.2." 같은 번호를 붙여 와도 렌더러가 다시 매기므로 떼어 낸다 */
export function stripNumbering(title: string): string {
  return title.replace(/^\s*\d+(?:\.\d+)*\.?\s+/, '');
}

export const CAPTION_LABEL: Record<Transcript['meta']['captionSource'], string> = {
  manual: '수동 자막',
  auto: '자동 자막',
  whisper: '음성 인식(whisper)',
  text: '본문 추출',
};
