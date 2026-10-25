import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clipOcrText,
  everyInterval,
  ocrFileSchema,
  runOcr,
  tesseractLang,
  textFromTsv,
} from '../../../src/digest/ocr.js';
import { parseShowinfo } from '../../../src/digest/frames.js';
import { DigestStore } from '../../../src/digest/store.js';
import { CommandError, type RunCommand } from '../../../src/digest/ytdlp.js';
import { SLUG, sampleTranscript } from './fixture.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const tmpDirs: string[] = [];
function tmpRepo(): string {
  const dir = resolve('.gestalt-test', `digest-ocr-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TSV_HEAD =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

/** 단어마다 [줄 번호, 신뢰도, 글자]를 받아 tesseract tsv 꼴로 만든다 */
function tsv(words: Array<[number, number, string]>): string {
  const rows = words.map(([line, conf, text], n) =>
    [
      '5',
      '1',
      '1',
      '1',
      String(line),
      String(n + 1),
      '0',
      '0',
      '10',
      '10',
      String(conf),
      text,
    ].join('\t'),
  );
  return [TSV_HEAD, ...rows].join('\n');
}

/** ffmpeg는 프레임 4장을 쓰고 tesseract는 파일 이름별로 정해 둔 글자를 낸다 */
function fakeRun(
  texts: Record<string, string>,
  opts: { noTesseract?: boolean; showinfo?: number[] } = {},
) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const run: RunCommand = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
    if (cmd === 'yt-dlp') {
      const out = args[args.indexOf('-o') + 1]!;
      writeFileSync(join(dirname(out), 'video.mp4'), 'fake');
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'ffmpeg') {
      const dir = dirname(args.at(-1)!);
      for (const n of [1, 2, 3, 4]) writeFileSync(join(dir, `f0000${n}.png`), 'png');
      const stderr = (opts.showinfo ?? []).map(
        (t) => `[Parsed_showinfo_1 @ 0x1] n: 0 pts_time:${t} duration:1`,
      );
      return { stdout: '', stderr: stderr.join('\n') };
    }
    if (cmd === 'tesseract') {
      if (opts.noTesseract) throw new CommandError('tesseract', '', 'tesseract를 찾지 못했어요.');
      return { stdout: texts[basename(args[0]!)] ?? '', stderr: '' };
    }
    throw new Error(`예상 못 한 명령: ${cmd}`);
  };
  return { run, calls };
}

function seeded() {
  const repo = tmpRepo();
  const store = new DigestStore(repo);
  store.saveTranscript(sampleTranscript());
  return { repo, store };
}

describe('ocr', () => {
  it('스크립트 언어로 tesseract 언어를 고르고 모르는 언어는 eng다', () => {
    expect(tesseractLang('ko')).toBe('kor+eng');
    expect(tesseractLang('en-US')).toBe('eng');
    expect(tesseractLang('pt-BR')).toBe('eng');
  });

  it('신뢰도가 낮거나 글자가 하나뿐인 단어는 버리고 줄 단위로 잇는다', () => {
    const text = textFromTsv(
      tsv([
        [1, 95, 'Code'],
        [1, 91, 'Layers'],
        [1, 30, 'nies'],
        [2, 90, 'x'],
        [2, 88, '|'],
        [3, 80, 'Extract'],
        [3, 75, 'designs'],
      ]),
    );
    expect(text).toBe('Code Layers\nExtract designs');
    expect(textFromTsv(TSV_HEAD)).toBe('');
  });

  it('간격마다 읽고 빈 화면과 앞과 같은 글자는 뺀 뒤 문장 번호를 붙인다', async () => {
    const { repo, store } = seeded();
    const f = fakeRun({
      'f00001.png': tsv([
        [1, 90, 'Intro'],
        [1, 90, 'slide'],
      ]),
      'f00002.png': tsv([
        [1, 90, 'Intro'],
        [1, 90, 'slide'],
        [1, 20, 'zz'],
      ]),
      'f00003.png': tsv([[1, 90, '|']]),
      'f00004.png': tsv([
        [1, 90, 'Code'],
        [1, 90, 'Layers'],
      ]),
    });
    const r = await runOcr(SLUG, { repoRoot: repo, intervalSec: 10, run: f.run });
    expect(r).toMatchObject({ lang: 'eng', intervalSec: 10, frames: 4, items: 2, truncated: 0 });
    expect(r.requestedIntervalSec).toBeUndefined();
    const file = ocrFileSchema.parse(JSON.parse(readFileSync(r.path, 'utf-8')));
    const t = sampleTranscript();
    const idxAt = (sec: number) => t.segments.filter((s) => s.startSec <= sec).length - 1;
    expect(file.items).toEqual([
      { sec: 0, i: 0, text: 'Intro slide' },
      { sec: 30, i: idxAt(30), text: 'Code Layers' },
    ]);
    expect(r.path).toBe(join(store.dir(SLUG), 'ocr.json'));
    const tess = f.calls.filter((c) => c.cmd === 'tesseract');
    expect(tess.every((c) => c.args.join(' ').endsWith('-l eng --psm 11 tsv'))).toBe(true);
    expect(existsSync(f.calls[0]!.cwd)).toBe(false);
  });

  it('글자가 상한을 넘으면 줄 단위로 자르고 잘린 항목 수를 센다', async () => {
    expect(clipOcrText('ab\ncd\nef', 6)).toEqual({ text: 'ab\ncd…', truncated: true });
    expect(clipOcrText('abcdefgh', 4)).toEqual({ text: 'abc…', truncated: true });
    expect(clipOcrText('ab', 6)).toEqual({ text: 'ab', truncated: false });

    const { repo } = seeded();
    const long = Array.from(
      { length: 400 },
      (_, n) => [n + 1, 90, `word${n}`] as [number, number, string],
    );
    const f = fakeRun({ 'f00001.png': tsv(long) });
    const r = await runOcr(SLUG, { repoRoot: repo, run: f.run });
    expect(r.truncated).toBe(1);
    const file = ocrFileSchema.parse(JSON.parse(readFileSync(r.path, 'utf-8')));
    expect(file.items[0]!.truncated).toBe(true);
    expect(file.items[0]!.text.endsWith('…')).toBe(true);
  });

  it('프레임이 상한을 넘으면 간격을 넓히고 처음 요청한 간격을 남긴다', async () => {
    const repo = tmpRepo();
    const t = sampleTranscript();
    new DigestStore(repo).saveTranscript({ ...t, meta: { ...t.meta, durationSec: 7200 } });
    const f = fakeRun({});
    const r = await runOcr(SLUG, { repoRoot: repo, intervalSec: 1, run: f.run });
    expect(r).toMatchObject({ intervalSec: 12, requestedIntervalSec: 1 });
    const ffmpeg = f.calls.find((c) => c.cmd === 'ffmpeg')!;
    expect(ffmpeg.args.join(' ')).toContain(`${everyInterval(12)},`);
    expect(ffmpeg.args).toContain('vfr');
    const file = ocrFileSchema.parse(JSON.parse(readFileSync(r.path, 'utf-8')));
    expect(file).toMatchObject({ intervalSec: 12, requestedIntervalSec: 1 });
  });

  it('프레임 시각은 showinfo 로그에서 받는다', async () => {
    const { repo } = seeded();
    const f = fakeRun(
      {
        'f00001.png': tsv([[1, 90, 'Intro']]),
        'f00002.png': tsv([[1, 90, 'Agenda']]),
      },
      { showinfo: [0, 10.033, 20.02, 30] },
    );
    const r = await runOcr(SLUG, { repoRoot: repo, intervalSec: 10, run: f.run });
    const file = ocrFileSchema.parse(JSON.parse(readFileSync(r.path, 'utf-8')));
    expect(file.items.map((i) => i.sec)).toEqual([0, 10.03]);
    expect(f.calls.find((c) => c.cmd === 'ffmpeg')!.args.join(' ')).toContain(
      `${everyInterval(10)},showinfo,`,
    );
  });

  it('select 식을 글자 그대로 고정한다', () => {
    expect(everyInterval(10)).toBe(
      "select='isnan(prev_selected_t)+gte(floor(t/10)-floor(prev_selected_t/10),1)'",
    );
  });

  it.skipIf(!HAS_FFMPEG)('실제 ffmpeg에서 간격마다 첫 프레임의 시각을 낸다', () => {
    const r = spawnSync(
      'ffmpeg',
      [
        ...['-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'testsrc=duration=5:rate=10'],
        ...['-vf', `${everyInterval(1)},showinfo`, '-vsync', 'vfr', '-f', 'null', '-'],
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    expect(r.status).toBe(0);
    expect(parseShowinfo(r.stderr)).toEqual([0, 1, 2, 3, 4]);
  });

  it('tesseract가 없으면 설치 방법을 알린다', async () => {
    const { repo } = seeded();
    const f = fakeRun({}, { noTesseract: true });
    await expect(runOcr(SLUG, { repoRoot: repo, run: f.run })).rejects.toThrow(
      'brew install tesseract',
    );
  });

  it('간격과 언어 꼴이 틀리면 영상을 받기 전에 던진다', async () => {
    const { repo } = seeded();
    const f = fakeRun({});
    await expect(runOcr(SLUG, { repoRoot: repo, intervalSec: 0, run: f.run })).rejects.toThrow(
      '1~600초',
    );
    await expect(runOcr(SLUG, { repoRoot: repo, lang: 'eng; rm', run: f.run })).rejects.toThrow(
      'kor+eng',
    );
    expect(f.calls).toEqual([]);
  });
});
