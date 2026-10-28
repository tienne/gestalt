import { extname } from 'node:path';
import { AUDIO_EXTS } from './kind.js';

/** 피드에서 고른 에피소드 */
export interface FeedEpisode {
  show: string;
  title: string;
  audioUrl: string;
  pubDate?: string;
  link?: string;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]!) : undefined;
};

/**
 * RSS 피드에서 n번째(0부터, 최신순) 에피소드의 오디오 주소를 꺼낸다. XML 파서를 들이지 않으려고
 * item과 enclosure 태그만 정규식으로 읽는다. 주소는 http(s)만 받는다
 */
export function pickEpisode(xml: string, index = 0): FeedEpisode {
  const channel = /<channel[^>]*>([\s\S]*?)<item[\s>]/i.exec(xml)?.[1] ?? '';
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const item = items[index];
  if (!item)
    throw new Error(`피드에 ${index + 1}번째 에피소드가 없어요(에피소드 ${items.length}개)`);
  const enclosure = /<enclosure\b[^>]*\burl=["']([^"']+)["']/i.exec(item)?.[1];
  if (!enclosure) throw new Error('에피소드에 오디오 주소(enclosure)가 없어요');
  const audioUrl = decode(enclosure);
  if (!/^https?:\/\//i.test(audioUrl))
    throw new Error(`오디오 주소가 http(s)가 아니에요: ${audioUrl}`);
  return {
    show: tag(channel, 'title') ?? '',
    title: tag(item, 'title') ?? '',
    audioUrl,
    ...(tag(item, 'pubDate') ? { pubDate: tag(item, 'pubDate') } : {}),
    ...(tag(item, 'link') ? { link: tag(item, 'link') } : {}),
  };
}

/** 오디오 확장자. 주소에 없으면 mp3로 둔다 */
export function audioExt(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // 로컬 경로다
  }
  const ext = extname(path).toLowerCase();
  return AUDIO_EXTS.includes(ext) ? ext : '.mp3';
}

/** 받아쓰기 스크립트. 화자 구분은 하지 않는다. 진행 로그가 섞일 수 있어 결과는 마지막 줄 한 줄로 낸다 */
export const PODCAST_WHISPER_PY = `
import json, sys
from faster_whisper import WhisperModel
audio, model_name, lang = sys.argv[1], sys.argv[2], sys.argv[3] or None
model = WhisperModel(model_name, device="auto", compute_type="auto")
segments, info = model.transcribe(audio, language=lang, vad_filter=True)
out = [{"start": s.start, "text": s.text.strip()} for s in segments if s.text.strip()]
sys.stdout.write("\\n" + json.dumps({"language": info.language, "duration": info.duration, "segments": out}) + "\\n")
`;
