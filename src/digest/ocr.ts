import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureVideo } from './frames.js';
import { DigestStore } from './store.js';
import { findSegmentIndex } from './viewer-js.js';
import { CommandError, runCommand, timeoutFor, type RunCommand } from './ytdlp.js';

export const OCR_FILE = 'ocr.json';
export const DEFAULT_OCR_INTERVAL_SEC = 10;
const MAX_TEXT = 2000;

/** tesseract 언어 이름. kor+eng처럼 +로 잇는다 */
export const TESSERACT_LANG_PATTERN = /^[a-z][a-z_]{1,15}(\+[a-z][a-z_]{1,15})*$/;

/**
 * 화면 글자 한 벌. 영상 화면에서 읽은 글자라 자막만큼 믿지 않는다.
 * 요약 에이전트가 보조 자료로만 읽고 렌더러는 이 파일을 쓰지 않는다
 */
export const ocrFileSchema = z.object({
  engine: z.literal('tesseract'),
  lang: z.string().regex(TESSERACT_LANG_PATTERN),
  intervalSec: z.number().positive(),
  items: z.array(
    z.object({
      sec: z.number().nonnegative(),
      i: z.number().int().nonnegative(),
      text: z.string().min(1).max(MAX_TEXT),
    }),
  ),
});

export type OcrFile = z.infer<typeof ocrFileSchema>;

export interface OcrOptions {
  repoRoot: string;
  intervalSec?: number;
  /** tesseract 언어. 비우면 스크립트 언어에서 고른다 */
  lang?: string;
  run?: RunCommand;
}

export interface OcrResult {
  path: string;
  lang: string;
  intervalSec: number;
  frames: number;
  items: number;
}

const TESSERACT_BY_LANG: Record<string, string> = {
  ko: 'kor+eng',
  ja: 'jpn+eng',
  zh: 'chi_sim+eng',
  en: 'eng',
};

/** 화면 글자에는 코드와 제품 이름 같은 영문이 섞여서 영어가 아닌 언어에도 eng를 붙인다 */
export function tesseractLang(lang: string): string {
  return TESSERACT_BY_LANG[lang.toLowerCase().split(/[-_]/)[0]!] ?? 'eng';
}

/** 이보다 낮은 신뢰도의 단어는 아이콘이나 지도 무늬를 글자로 읽은 경우가 대부분이다 */
export const MIN_WORD_CONFIDENCE = 70;

/**
 * tesseract tsv 출력을 줄 단위 글자로 바꾼다. 신뢰도가 낮은 단어와 글자 하나짜리 단어는 버리고
 * 글자나 숫자가 두 개 안 남은 줄도 버린다
 */
export function textFromTsv(tsv: string, minConfidence = MIN_WORD_CONFIDENCE): string {
  const lines = new Map<string, string[]>();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const cols = row.split('\t');
    if (cols.length < 12) continue;
    const word = cols.slice(11).join(' ').trim();
    if (Number(cols[10]) < minConfidence) continue;
    if ((word.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
    const key = `${cols[2]}-${cols[3]}-${cols[4]}`;
    const words = lines.get(key) ?? [];
    words.push(word);
    lines.set(key, words);
  }
  return [...lines.values()]
    .map((w) => w.join(' '))
    .join('\n')
    .slice(0, MAX_TEXT);
}

const FRAME_FILE = /^f(\d{5})\.png$/;

/**
 * intervalSec마다 프레임을 뽑아 화면 글자를 읽고 ocr.json에 둔다.
 * 슬라이드처럼 한동안 그대로인 화면은 앞 항목과 글자가 같아서 한 번만 남긴다
 */
export async function runOcr(slug: string, opts: OcrOptions): Promise<OcrResult> {
  const run = opts.run ?? runCommand;
  const intervalSec = opts.intervalSec ?? DEFAULT_OCR_INTERVAL_SEC;
  if (!Number.isFinite(intervalSec) || intervalSec < 1 || intervalSec > 600) {
    throw new Error(`OCR 간격은 1~600초여야 해요: ${intervalSec}`);
  }
  const store = new DigestStore(opts.repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  const transcript = t.transcript;
  const lang = opts.lang ?? tesseractLang(transcript.meta.lang);
  if (!TESSERACT_LANG_PATTERN.test(lang)) {
    throw new Error(`tesseract 언어는 kor+eng 꼴이어야 해요: ${lang}`);
  }

  const cwd = mkdtempSync(join(tmpdir(), 'gestalt-digest-ocr-'));
  try {
    const video = await ensureVideo(run, transcript, store.videoCacheDir(slug), cwd);
    await run(
      'ffmpeg',
      [
        ...['-v', 'error', '-y', '-i', video],
        // 작은 글자는 tesseract가 못 읽어서 1280보다 좁은 화면은 두 배로 키운다
        ...['-vf', `fps=1/${intervalSec},scale='if(lt(iw,1280),iw*2,iw)':-2`],
        join(cwd, 'f%05d.png'),
      ],
      { cwd, timeoutMs: timeoutFor(transcript.meta.durationSec, 0.2) },
    );
    const frames = readdirSync(cwd)
      .filter((f) => FRAME_FILE.test(f))
      .sort();

    const starts = transcript.segments.map((s) => s.startSec);
    const items: OcrFile['items'] = [];
    let prev = '';
    for (const f of frames) {
      const n = Number(FRAME_FILE.exec(f)![1]!);
      const sec = (n - 1) * intervalSec;
      let raw: string;
      try {
        // 화면 녹화는 글자가 흩어져 있어서 문단 분할(기본 psm 3)로는 거의 못 읽는다
        ({ stdout: raw } = await run(
          'tesseract',
          [join(cwd, f), 'stdout', '-l', lang, '--psm', '11', 'tsv'],
          { cwd, timeoutMs: 60_000 },
        ));
      } catch (e) {
        if (e instanceof CommandError && e.message.includes('찾지 못했어요')) {
          throw new Error(
            'tesseract를 찾지 못했어요. brew install tesseract tesseract-lang으로 설치해 주세요.',
            { cause: e },
          );
        }
        throw e;
      }
      const text = textFromTsv(raw);
      if (!text || text === prev) continue;
      prev = text;
      items.push({ sec, i: Math.max(0, findSegmentIndex(starts, sec)), text });
    }

    const out: OcrFile = { engine: 'tesseract', lang, intervalSec, items };
    const path = join(store.dir(slug), OCR_FILE);
    writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
    return { path, lang, intervalSec, frames: frames.length, items: items.length };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
