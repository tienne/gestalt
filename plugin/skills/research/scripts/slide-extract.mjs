#!/usr/bin/env node
// 세미나 영상에서 슬라이드가 바뀔 때마다 한 장씩 뽑고, 그 구간에 나온 자막을 붙인다.
// 의존성 없이 ffmpeg만 쓴다. 사용법은 맨 아래 USAGE 참고.
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const THUMB_W = 64;
const THUMB_H = 36;
const THUMB_BYTES = THUMB_W * THUMB_H;

export const DEFAULTS = {
  intervalSec: 2,
  // 64x36 흑백 썸네일의 평균 절대 차이(0~1). 압축 노이즈는 0.005 안팎이라 그 위로 잡는다
  changeThreshold: 0.03,
  // 이보다 짧게 머문 화면은 전환 효과나 카메라 컷으로 보고 버린다
  minStableSec: 4,
  // 이미 뽑은 슬라이드와 이 값보다 덜 다르면 같은 슬라이드로 본다
  dupThreshold: 0.012,
  dupWindow: 5,
};

export function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

/**
 * 표본 썸네일 배열에서 슬라이드 구간을 찾는다.
 * 구간의 대표는 마지막 표본이다. 불릿이 하나씩 나타나는 슬라이드는 다 나타난 뒤의 모습이 마지막이라서다.
 * 버려진 구간의 시간은 앞 슬라이드가 이어받는다(끝 시각이 다음 슬라이드 시작이라서).
 */
export function findSlides(thumbs, durationSec, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const runs = [];
  let start = 0;
  for (let i = 1; i <= thumbs.length; i++) {
    const changed =
      i === thumbs.length || meanAbsDiff(thumbs[i - 1], thumbs[i]) > o.changeThreshold;
    if (changed) {
      runs.push({ first: start, last: i - 1 });
      start = i;
    }
  }

  const kept = [];
  for (const run of runs) {
    const stableSec = (run.last - run.first + 1) * o.intervalSec;
    if (stableSec < o.minStableSec) continue;
    const rep = thumbs[run.last];
    const recent = kept.slice(-o.dupWindow);
    if (recent.some((k) => meanAbsDiff(thumbs[k.thumbIndex], rep) < o.dupThreshold)) continue;
    kept.push({
      startSec: run.first * o.intervalSec,
      atSec: run.last * o.intervalSec,
      thumbIndex: run.last,
    });
  }

  return kept.map((k, i) => ({
    index: i + 1,
    startSec: k.startSec,
    endSec: i + 1 < kept.length ? kept[i + 1].startSec : durationSec,
    atSec: k.atSec,
  }));
}

function toSeconds(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * VTT와 SRT를 읽어 시작 시각과 글만 남긴다.
 * 유튜브 자동 자막은 앞 줄이 다음 큐에 되풀이돼서, 직전 큐에 이미 나온 줄은 뺀다.
 */
export function parseCues(text) {
  const cues = [];
  let prevLines = new Set();
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = lines[at].match(/([\d:.,]+)\s*-->/);
    if (!m) continue;
    const body = lines
      .slice(at + 1)
      .map((l) =>
        l
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean);
    const fresh = body.filter((l) => !prevLines.has(l));
    prevLines = new Set(body);
    if (fresh.length === 0) continue;
    cues.push({ startSec: toSeconds(m[1]), text: fresh.join(' ') });
  }
  return cues;
}

export function attachCaptions(slides, cues) {
  return slides.map((s) => ({
    ...s,
    caption: cues
      .filter((c) => c.startSec >= s.startSec && c.startSec < s.endSec)
      .map((c) => c.text)
      .join(' '),
  }));
}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { rest, opts };
}

function probeDuration(video) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video],
    { encoding: 'utf8' },
  );
  const sec = Number(out.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error('영상 길이를 못 읽었다');
  return sec;
}

function sampleThumbs(video, intervalSec) {
  return new Promise((resolveThumbs, reject) => {
    const ff = spawn(
      'ffmpeg',
      [
        ...['-v', 'error', '-i', video],
        ...['-vf', `fps=1/${intervalSec},scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`],
        ...['-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg가 ${code}로 끝났다`));
      const all = Buffer.concat(chunks);
      const thumbs = [];
      for (let off = 0; off + THUMB_BYTES <= all.length; off += THUMB_BYTES) {
        thumbs.push(all.subarray(off, off + THUMB_BYTES));
      }
      resolveThumbs(thumbs);
    });
  });
}

function extractFrame(video, atSec, outPath) {
  execFileSync(
    'ffmpeg',
    [
      ...['-v', 'error', '-y', '-ss', String(atSec), '-i', video],
      ...['-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', outPath],
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

const USAGE = `사용법: slide-extract.mjs <영상> <출력 폴더> [--captions 자막.vtt|srt]
  [--interval 2] [--threshold 0.03] [--min-stable 4] [--dup 0.012]
출력 폴더에 slide-NN.jpg와 slides.json을 쓴다. 표준 출력에는 한 줄 요약만 낸다.`;

async function main() {
  const { rest, opts } = parseArgs(process.argv.slice(2));
  if (rest.length < 2) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const video = resolve(rest[0]);
  const outDir = resolve(rest[1]);
  const params = {
    intervalSec: Number(opts.interval ?? DEFAULTS.intervalSec),
    changeThreshold: Number(opts.threshold ?? DEFAULTS.changeThreshold),
    minStableSec: Number(opts['min-stable'] ?? DEFAULTS.minStableSec),
    dupThreshold: Number(opts.dup ?? DEFAULTS.dupThreshold),
  };

  const durationSec = probeDuration(video);
  const thumbs = await sampleThumbs(video, params.intervalSec);
  let slides = findSlides(thumbs, durationSec, params);
  if (opts.captions)
    slides = attachCaptions(slides, parseCues(readFileSync(opts.captions, 'utf8')));

  mkdirSync(outDir, { recursive: true });
  const files = slides.map((s) => `slide-${String(s.index).padStart(2, '0')}.jpg`);
  slides.forEach((s, i) => extractFrame(video, s.atSec, join(outDir, files[i])));
  const result = {
    video,
    durationSec,
    params,
    slides: slides.map((s, i) => ({ ...s, file: files[i] })),
  };
  writeFileSync(join(outDir, 'slides.json'), JSON.stringify(result, null, 2));
  process.stdout.write(
    `슬라이드 ${slides.length}장, 표본 ${thumbs.length}개, ${outDir}/slides.json\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`슬라이드 추출 실패: ${err.message}\n`);
    process.exit(1);
  });
}
