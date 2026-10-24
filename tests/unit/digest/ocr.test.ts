import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ocrFileSchema, runOcr, tesseractLang, textFromTsv } from '../../../src/digest/ocr.js';
import { DigestStore } from '../../../src/digest/store.js';
import { CommandError, type RunCommand } from '../../../src/digest/ytdlp.js';
import { SLUG, sampleTranscript } from './fixture.js';

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
function fakeRun(texts: Record<string, string>, opts: { noTesseract?: boolean } = {}) {
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
      return { stdout: '', stderr: '' };
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
    expect(r).toMatchObject({ lang: 'eng', intervalSec: 10, frames: 4, items: 2 });
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
