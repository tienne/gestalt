import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../core/json-file.js';
import { ensureVideo, parseShowinfo } from './frames.js';
import { OCR_FILE, ocrFileSchema, type OcrFile } from './ocr.js';
import { DigestStore, readRaw } from './store.js';
import { findSegmentIndex } from './viewer-logic.js';
import { runCommand, timeoutFor, type RunCommand } from './ytdlp.js';

/**
 * 소섹션 shots가 고를 수 있는 후보 장면. 슬라이드가 넘어가거나 화면이 바뀐 시각이다.
 * 요약 작성자는 장면을 보지 못하니 OCR 글자 앞부분을 붙여 무엇이 화면에 있었는지 짐작하게 한다
 */
export const SCENES_FILE = 'scenes.json';

/** 이보다 글자가 적은 화면은 사람 얼굴이나 자막 한 줄일 때가 많아 슬라이드로 보지 않는다 */
export const SCENE_MIN_CHARS = 40;
/** 앞 항목과 단어가 이 비율보다 많이 달라야 다른 화면으로 본다 */
export const SCENE_CHANGE_RATIO = 0.5;
/** ffmpeg 장면 전환 점수 문턱 */
export const SCENE_THRESHOLD = 0.4;
// 대담 영상은 카메라가 몇 초마다 바뀌어서 장면 전환이 수백 번 잡힌다. 간격과 개수를 묶어 목록이 요약 입력을 덮지 않게 한다
export const SCENE_MIN_GAP_SEC = 3;
export const MAX_SCENES = 300;
const TEXT_HEAD = 80;

export const scenesFileSchema = z.object({
  source: z.enum(['ocr', 'scene']),
  items: z
    .array(
      z.object({
        sec: z.number().nonnegative(),
        i: z.number().int().nonnegative(),
        text: z.string().optional(),
      }),
    )
    .max(MAX_SCENES),
});

export type ScenesFile = z.infer<typeof scenesFileSchema>;
export type SceneItem = ScenesFile['items'][number];

const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();

const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// 단어로 견준다. 두 글자 조각으로 견주면 영어 슬라이드끼리 흔한 조각이 겹쳐 다른 화면도 비슷하게 나온다.
// 띄어쓰기가 없는 중국어와 일본어 덩어리만 두 글자 조각으로 쪼갠다
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length <= 2 || !NO_SPACE_SCRIPT.test(word)) {
      out.add(word);
      continue;
    }
    for (let k = 0; k + 1 < word.length; k++) out.add(word.slice(k, k + 2));
  }
  return out;
}

/** cur의 단어 가운데 prev에 없는 비율. 0이면 같은 화면, 1이면 전혀 다른 화면이다 */
export function textChange(prev: string, cur: string): number {
  const a = tokens(prev);
  const b = tokens(cur);
  if (b.size === 0) return 0;
  let fresh = 0;
  for (const g of b) if (!a.has(g)) fresh += 1;
  return fresh / b.size;
}

export function textHead(text: string, max = TEXT_HEAD): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** 글자가 넉넉하고 앞 항목과 절반 넘게 다른 화면만 남긴다. 슬라이드가 넘어간 자리다 */
export function ocrScenes(ocr: OcrFile): SceneItem[] {
  const out: SceneItem[] = [];
  let prev = '';
  for (const item of ocr.items) {
    const enough = squash(item.text).length >= SCENE_MIN_CHARS;
    if (enough && textChange(prev, item.text) > SCENE_CHANGE_RATIO) {
      out.push({ sec: item.sec, i: item.i, text: textHead(item.text) });
    }
    prev = item.text;
  }
  return out.slice(0, MAX_SCENES);
}

/** 앞 후보와 minGap초 안에 붙은 전환은 버린다. 카메라가 연달아 바뀌는 자리는 하나만 남는다 */
export function thinSceneTimes(secs: number[], minGap = SCENE_MIN_GAP_SEC): number[] {
  const out: number[] = [];
  for (const sec of [...secs].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last === undefined || sec - last >= minGap) out.push(sec);
  }
  return out.slice(0, MAX_SCENES);
}

export type ScenesRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; value: ScenesFile };

export function readScenes(store: DigestStore, slug: string): ScenesRead {
  const raw = readRaw(join(store.dir(slug), SCENES_FILE));
  if (raw.kind === 'missing') return raw;
  if (raw.kind === 'invalid-json') return { kind: 'invalid', message: raw.message };
  const parsed = scenesFileSchema.safeParse(raw.value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { kind: 'invalid', message: issues.join('; ') };
  }
  return { kind: 'ok', value: parsed.data };
}

/** lint가 받는 꼴. 파일이 없거나 깨졌으면 null이다 */
export function sceneSecs(store: DigestStore, slug: string): number[] | null {
  const r = readScenes(store, slug);
  return r.kind === 'ok' ? r.value.items.map((s) => s.sec) : null;
}

function readOcr(store: DigestStore, slug: string): OcrFile | null {
  const path = join(store.dir(slug), OCR_FILE);
  if (!existsSync(path)) return null;
  const raw = readRaw(path);
  if (raw.kind !== 'ok') return null;
  const parsed = ocrFileSchema.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
}

export interface ScenesOptions {
  repoRoot: string;
  run?: RunCommand;
}

export interface ScenesResult {
  path: string;
  source: ScenesFile['source'];
  items: number;
}

/**
 * 후보 장면을 scenes.json에 둔다. ocr.json이 있으면 글자로 고르고 없으면 ffmpeg 장면 전환을 쓴다.
 * 장면 전환만으로는 슬라이드인지 얼굴인지 못 가려서 글자가 있으면 글자를 먼저 쓴다
 */
export async function pickScenes(slug: string, opts: ScenesOptions): Promise<ScenesResult> {
  const store = new DigestStore(opts.repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  const transcript = t.transcript;
  const path = join(store.dir(slug), SCENES_FILE);

  const ocr = readOcr(store, slug);
  if (ocr) {
    const items = ocrScenes(ocr);
    writeJsonAtomic(path, { source: 'ocr', items } satisfies ScenesFile);
    return { path, source: 'ocr', items: items.length };
  }

  const run = opts.run ?? runCommand;
  const cwd = mkdtempSync(join(tmpdir(), 'gestalt-digest-scenes-'));
  try {
    const video = await ensureVideo(run, transcript, store.videoCacheDir(slug), cwd);
    // 점수만 보면 되니 작게 줄여서 디코딩을 가볍게 한다
    const { stderr } = await run(
      'ffmpeg',
      [
        ...['-hide_banner', '-nostats', '-i', video, '-an'],
        ...['-vf', `scale=320:-2,select='gt(scene,${SCENE_THRESHOLD})',showinfo`],
        ...['-f', 'null', '-'],
      ],
      { cwd, timeoutMs: timeoutFor(transcript.meta.durationSec, 0.5) },
    );
    const starts = transcript.segments.map((s) => s.startSec);
    const items = thinSceneTimes(parseShowinfo(stderr)).map((raw) => {
      const sec = Math.round(raw * 100) / 100;
      return { sec, i: Math.max(0, findSegmentIndex(starts, sec)) };
    });
    writeJsonAtomic(path, { source: 'scene', items } satisfies ScenesFile);
    return { path, source: 'scene', items: items.length };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
