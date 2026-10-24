export interface Cue {
  startSec: number;
  text: string;
}

/** 자막에서 뽑은 단어 하나와 그 단어가 화면에 나온 시각 */
export interface TimedWord {
  sec: number;
  text: string;
  /** 유튜브 자동 자막의 `>>`(화자 바뀜) 뒤 첫 단어. 앞 문장과 합치지 않는다 */
  breakBefore?: boolean;
}

export interface MergeOptions {
  /** 문장 부호가 없을 때 이만큼 쉬면 끊는다 */
  pauseSec?: number;
  /** 쉼으로 끊을 때 최소 글자 수. 짧은 맞장구가 문장 하나가 되지 않게 */
  minChars?: number;
  /** 부호도 쉼도 없이 이어지면 이 길이에서 끊는다 */
  maxChars?: number;
}

const DEFAULT_MERGE: Required<MergeOptions> = { pauseSec: 1.2, minChars: 40, maxChars: 220 };

const SENTENCE_END = /[.?!。？！…]["'”’)\]]*$/;
const TIME_TAG = /<(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})>/g;

export function toSeconds(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};
const decodeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]!);
/** `[music]`, `[Applause]` 같은 소리 표기. 문장에 섞이면 요약 근거로 쓸 수 없다 */
const SOUND_TAG = /^\[[^\]]*\]$/;

const cleanLine = (l: string) =>
  l
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

interface CueBlock {
  startSec: number;
  /** 직전 큐에 없던 줄만, 태그가 남은 원문 그대로 */
  freshRaw: string[];
}

/**
 * 유튜브 자동 자막은 앞 줄이 다음 큐에 되풀이돼서, 직전 큐에 이미 나온 줄은 뺀다.
 * plugin/skills/research/scripts/slide-extract.mjs의 parseCues와 같은 규칙이다. 플러그인 스크립트는 src를 import하지 않아 두 벌을 두고 테스트로 결과를 맞춘다.
 */
function readBlocks(text: string): CueBlock[] {
  const out: CueBlock[] = [];
  let prevLines = new Set<string>();
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = lines[at]!.match(/([\d:.,]+)\s*-->/);
    if (!m) continue;
    const raw = lines.slice(at + 1).filter((l) => cleanLine(l));
    const body = raw.map(cleanLine);
    const freshRaw = raw.filter((_, k) => !prevLines.has(body[k]!));
    prevLines = new Set(body);
    if (freshRaw.length === 0) continue;
    out.push({ startSec: toSeconds(m[1]!), freshRaw });
  }
  return out;
}

/** VTT와 SRT를 읽어 시작 시각과 글만 남긴다 */
export function parseCues(text: string): Cue[] {
  return readBlocks(text).map((b) => ({
    startSec: b.startSec,
    text: b.freshRaw.map(cleanLine).join(' '),
  }));
}

/**
 * 큐를 단어로 쪼갠다. 유튜브 자동 자막의 `<00:00:01.200>` 태그가 있으면 단어마다 그 시각을 쓰고
 * 없으면 큐 시작 시각을 쓴다. 문장이 큐 중간에서 시작해도 시작 시각이 틀어지지 않게 하려는 것이다.
 */
export function parseTimedWords(text: string): TimedWord[] {
  const words: TimedWord[] = [];
  let pendingBreak = false;
  for (const block of readBlocks(text)) {
    for (const line of block.freshRaw) {
      let sec = block.startSec;
      let last = 0;
      const pieces: Array<{ sec: number; text: string }> = [];
      for (const m of line.matchAll(TIME_TAG)) {
        pieces.push({ sec, text: line.slice(last, m.index) });
        sec = toSeconds(m[1]!);
        last = m.index + m[0].length;
      }
      pieces.push({ sec, text: line.slice(last) });
      for (const p of pieces) {
        for (const w of decodeEntities(cleanLine(p.text)).split(' ')) {
          if (!w || SOUND_TAG.test(w)) continue;
          if (w === '>>') {
            pendingBreak = true;
            continue;
          }
          words.push(
            pendingBreak ? { sec: p.sec, text: w, breakBefore: true } : { sec: p.sec, text: w },
          );
          pendingBreak = false;
        }
      }
    }
  }
  return words;
}

/**
 * 단어를 문장으로 합친다. 끝 부호에서 끊고 부호가 없으면 쉼 간격과 길이로 끊는다.
 * 문장 시작 시각은 첫 단어의 시각이다.
 */
export function mergeSentences(words: TimedWord[], options: MergeOptions = {}): Cue[] {
  const opt = { ...DEFAULT_MERGE, ...options };
  const out: Cue[] = [];
  let buf: TimedWord[] = [];
  let len = 0;

  const flush = () => {
    if (buf.length === 0) return;
    out.push({ startSec: buf[0]!.sec, text: buf.map((w) => w.text).join(' ') });
    buf = [];
    len = 0;
  };

  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    if (w.breakBefore) flush();
    buf.push(w);
    len += w.text.length + (buf.length > 1 ? 1 : 0);
    const next = words[k + 1];
    if (!next) break;
    const gap = next.sec - w.sec;
    if (SENTENCE_END.test(w.text)) flush();
    else if (gap >= opt.pauseSec && len >= opt.minChars) flush();
    else if (len >= opt.maxChars) flush();
  }
  flush();
  return out;
}

/** 단어 시각이 없는 조각(whisper 구간 같은)을 조각 시작 시각의 단어로 편다 */
export function cuesToWords(cues: Cue[]): TimedWord[] {
  return cues.flatMap((c) =>
    c.text
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({ sec: c.startSec, text })),
  );
}

/** 자막 파일 하나를 문장 단위 큐로 만든다 */
export function captionsToSentences(text: string, options?: MergeOptions): Cue[] {
  return mergeSentences(parseTimedWords(text), options);
}
