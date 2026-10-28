import { extname } from 'node:path';
import type { LensKind } from '../digest/schema.js';

export type DetectedKind = 'youtube' | LensKind;

export const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.aac', '.flac'];
const WEB_EXTS = ['.html', '.htm'];

const YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i;
// 주소만으로 피드로 보는 꼴. 경로(쿼리와 # 앞)만 보고 호스트 feeds.와 쿼리 format=rss는 따로 본다.
// 경로는 끝이 /feed, /rss, 워드프레스 피드 꼴(/feed/podcast, /feed/rss2 같은), .rss, .xml일 때만 잡는다.
// 경로 중간의 /feed/는 글 주소(/feed/update/...)에도 있어서 안 잡는다. 애매하면 web으로 두고 스킬이 사용자에게 묻는다
const FEED_PATH = /(?:\/feed(?:\/(?:rss2?|atom|podcast))?|\/rss)\/?$|\.(?:rss|xml)$/i;

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function isFeedUrl(url: URL): boolean {
  if (FEED_PATH.test(url.pathname)) return true;
  if (url.hostname.startsWith('feeds.')) return true;
  return url.searchParams.getAll('format').some((v) => v.toLowerCase() === 'rss');
}

/**
 * 렌즈가 받은 주소나 파일이 무슨 자료인지 판단한다. 유튜브는 video-digest로 넘긴다.
 * 순서는 유튜브, PDF, 오디오와 피드, 나머지 웹 글이다. 로컬 파일은 확장자로만 본다
 */
export function detectLensKind(input: string): DetectedKind | null {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    if (YOUTUBE.test(trimmed)) return 'youtube';
    const url = parseUrl(trimmed);
    const path = (url?.pathname ?? '').toLowerCase();
    if (path.endsWith('.pdf')) return 'pdf';
    if (/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i.test(trimmed)) return 'pdf';
    if (AUDIO_EXTS.includes(extname(path))) return 'podcast';
    if (url && isFeedUrl(url)) return 'podcast';
    return 'web';
  }
  const ext = extname(trimmed).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (AUDIO_EXTS.includes(ext)) return 'podcast';
  if (WEB_EXTS.includes(ext)) return 'web';
  return null;
}

/** arXiv 초록 주소는 PDF 주소로 바꾼다. 다른 주소는 그대로 둔다 */
export function pdfUrlOf(url: string): string {
  const m = /^https?:\/\/(?:www\.)?arxiv\.org\/abs\/([^?#]+)/i.exec(url);
  return m ? `https://arxiv.org/pdf/${m[1]!}` : url;
}
