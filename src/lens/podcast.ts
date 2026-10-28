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

/** 받아쓰기 스크립트. 진행 로그가 섞일 수 있어 결과는 마지막 줄 한 줄로 낸다 */
export const PODCAST_WHISPER_PY = `
import json, sys
from faster_whisper import WhisperModel
audio, model_name, lang = sys.argv[1], sys.argv[2], sys.argv[3] or None
model = WhisperModel(model_name, device="auto", compute_type="auto")
segments, info = model.transcribe(audio, language=lang, vad_filter=True)
out = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments if s.text.strip()]
sys.stdout.write("\\n" + json.dumps({"language": info.language, "duration": info.duration, "segments": out}) + "\\n")
`;

/**
 * 화자 구분 스크립트. sherpa-onnx의 오프라인 화자 구분을 쓴다. pyannote 구간 분할 모델을 ONNX로 옮긴 것과
 * 화자 임베딩 모델을 쓰고 둘 다 Hugging Face 토큰 없이 받는다. 오디오는 faster-whisper의 디코더로 16kHz로 읽는다
 */
export const DIARIZE_PY = `
import json, sys
import sherpa_onnx
from faster_whisper import decode_audio
audio, seg_model, emb_model, threshold = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg_model)),
    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb_model),
    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=threshold),
    min_duration_on=0.3, min_duration_off=0.5)
sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
samples = decode_audio(audio, sampling_rate=sd.sample_rate)
turns = sd.process(samples).sort_by_start_time()
sys.stdout.write("\\n" + json.dumps([{"start": t.start, "end": t.end, "speaker": t.speaker} for t in turns]) + "\\n")
`;

export interface SpeakerTurn {
  start: number;
  end: number;
  speaker: number;
}

/**
 * 받아쓴 문장마다 가장 오래 겹치는 화자 구간의 화자를 단다. 이름은 처음 나온 순서대로 "화자 1", "화자 2"다.
 * 사람 이름은 받아쓰기에서 짐작하지 않는다. 겹치는 구간이 없는 문장은 화자를 비운다
 */
export function assignSpeakers(
  segments: Array<{ start: number; end: number }>,
  turns: SpeakerTurn[],
): Array<string | undefined> {
  const names = new Map<number, string>();
  return segments.map((seg) => {
    let best = -1;
    let bestOverlap = 0;
    for (const t of turns) {
      const overlap = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = t.speaker;
      }
    }
    if (best < 0) return undefined;
    if (!names.has(best)) names.set(best, `화자 ${names.size + 1}`);
    return names.get(best);
  });
}
