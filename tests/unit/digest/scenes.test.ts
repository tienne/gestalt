import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectShotSecs,
  extractFrames,
  frameFileName,
  shotFileName,
} from '../../../src/digest/frames.js';
import { lintDigest, lintErrors, type DigestIssue } from '../../../src/digest/lint.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import {
  MAX_SCENES,
  ocrScenes,
  parseShowinfo,
  pickScenes,
  sceneSecs,
  textChange,
  textHead,
  thinSceneTimes,
} from '../../../src/digest/scenes.js';
import { parseDigest, type Digest, type Shot } from '../../../src/digest/schema.js';
import { DigestStore } from '../../../src/digest/store.js';
import type { OcrFile } from '../../../src/digest/ocr.js';
import type { RunCommand } from '../../../src/digest/ytdlp.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const tmpDirs: string[] = [];
function seeded(): { repo: string; store: DigestStore } {
  const repo = resolve('.gestalt-test', `digest-scenes-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  const store = new DigestStore(repo);
  store.saveTranscript(sampleTranscript());
  return { repo, store };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SLIDE_A = 'Product market fit means retention curves flatten out over time';
const SLIDE_B = 'Three ways to find your north star metric for growth teams';

const ocr = (items: Array<[number, string]>): OcrFile => ({
  engine: 'tesseract',
  lang: 'eng',
  intervalSec: 10,
  items: items.map(([sec, text]) => ({ sec, i: Math.floor(sec / 5), text })),
});

// 첫 소섹션은 0~2번 문장이라 [0, 15)초, 마지막 소섹션은 9~11번이라 [45, 62)초다
const withShots = (shots: Shot[], bi = 0, si = 0): Digest => {
  const d = sampleDigest();
  d.reports[0]!.sections[si]!.subsections[bi]!.shots = shots;
  return d;
};
const shot = (sec: number, extra: Partial<Shot> = {}): Shot => ({
  sec,
  caption: '리텐션 곡선 슬라이드',
  cite: { key: 1, from: 1, to: 2 },
  ...extra,
});
const codesAt = (issues: DigestIssue[]) => issues.map((i) => `${i.code} ${i.path}`);
const SHOT0 = 'reports.0.sections.0.subsections.0.shots.0';

describe('후보 장면 고르기', () => {
  it('단어가 얼마나 새로 나왔는지 0~1로 잰다', () => {
    expect(textChange(SLIDE_A, SLIDE_A)).toBe(0);
    expect(textChange('', SLIDE_A)).toBe(1);
    expect(textChange(SLIDE_A, `${SLIDE_A} 2`)).toBeLessThan(0.5);
    expect(textChange(SLIDE_A, SLIDE_B)).toBeGreaterThan(0.5);
  });

  it('흔한 영어 단어가 겹쳐도 다른 슬라이드를 다른 화면으로 본다', () => {
    const a = 'Automate the known unknown. Invest people in customer problems and autofix bugs';
    const b =
      'Build context and judgement. At Linear we use agents to synthesize customer feedback';
    expect(textChange(a, b)).toBeGreaterThan(0.8);
  });

  it('띄어쓰기 없는 일본어는 두 글자 조각으로 견준다', () => {
    expect(textChange('顧客の声を集める', '顧客の声を集める仕組み')).toBeLessThan(0.5);
    expect(textChange('顧客の声を集める', '品質の水曜日会議')).toBeGreaterThan(0.5);
  });

  it('OCR 글자가 40자 이상이고 앞 항목과 절반 넘게 다를 때만 고른다', () => {
    const items = ocrScenes(
      ocr([
        [0, 'Lenny'],
        [10, SLIDE_A],
        [20, `${SLIDE_A} !`],
        [30, SLIDE_B],
        [40, 'short caption only'],
        [50, SLIDE_B],
      ]),
    );
    // 50초는 앞 항목(짧은 자막)과 달라서 같은 슬라이드가 다시 나온 자리로 본다
    expect(items.map((s) => s.sec)).toEqual([10, 30, 50]);
    expect(items[0]!.text).toBe(SLIDE_A);
  });

  it('글자 앞부분은 한 줄로 줄이고 길면 말줄임한다', () => {
    expect(textHead('a\n  b')).toBe('a b');
    expect(textHead('x'.repeat(100))).toHaveLength(80);
    expect(textHead('x'.repeat(100)).endsWith('…')).toBe(true);
  });

  it('showinfo 로그에서 시각을 뽑고 붙은 전환은 하나만 남긴다', () => {
    const log = [
      '[Parsed_showinfo_2 @ 0x1] n:   0 pts:  1 pts_time:1.5 duration: 1',
      '[Parsed_showinfo_2 @ 0x1] n:   1 pts:  2 pts_time:2.9 duration: 1',
      '[Parsed_showinfo_2 @ 0x1] n:   2 pts:  3 pts_time:12 duration: 1',
    ].join('\n');
    expect(parseShowinfo(log)).toEqual([1.5, 2.9, 12]);
    expect(thinSceneTimes([12, 1.5, 2.9])).toEqual([1.5, 12]);
    expect(thinSceneTimes(Array.from({ length: 500 }, (_, k) => k * 10))).toHaveLength(MAX_SCENES);
  });

  it('ocr.json이 있으면 영상 없이 글자로 고른다', async () => {
    const { repo, store } = seeded();
    writeFileSync(
      join(store.dir(SLUG), 'ocr.json'),
      JSON.stringify(
        ocr([
          [10, SLIDE_A],
          [30, SLIDE_B],
        ]),
      ),
    );
    const calls: string[] = [];
    const run: RunCommand = async (cmd) => {
      calls.push(cmd);
      return { stdout: '', stderr: '' };
    };
    const r = await pickScenes(SLUG, { repoRoot: repo, run });
    expect(r).toMatchObject({ source: 'ocr', items: 2 });
    expect(calls).toEqual([]);
    expect(sceneSecs(store, SLUG)).toEqual([10, 30]);
  });

  it('ocr.json이 없으면 ffmpeg 장면 전환을 쓰고 문장 번호를 붙인다', async () => {
    const { repo, store } = seeded();
    mkdirSync(store.videoCacheDir(SLUG), { recursive: true });
    writeFileSync(join(store.videoCacheDir(SLUG), 'video.mp4'), 'fake');
    let args: string[] = [];
    const run: RunCommand = async (cmd, a) => {
      if (cmd === 'ffmpeg') args = a;
      return { stdout: '', stderr: 'x pts_time:12.345 y\nx pts_time:31 y\n' };
    };
    const r = await pickScenes(SLUG, { repoRoot: repo, run });
    expect(r).toMatchObject({ source: 'scene', items: 2 });
    expect(args.join(' ')).toContain("select='gt(scene,0.4)'");
    const file = JSON.parse(readFileSync(r.path, 'utf-8'));
    expect(file.items).toEqual([
      { sec: 12.35, i: 2 },
      { sec: 31, i: 6 },
    ]);
  });

  it('scenes.json이 없으면 null을 돌려준다', () => {
    const { store } = seeded();
    expect(sceneSecs(store, SLUG)).toBeNull();
  });
});

describe('소섹션 shots lint', () => {
  const t = sampleTranscript();

  it('후보 장면 가운데 소섹션 구간 안이면 통과한다', () => {
    const issues = lintDigest(withShots([shot(10), shot(12)]), t, { scenes: [10, 12, 40] });
    expect(lintErrors(issues)).toEqual([]);
  });

  it('셋 이상이면 스키마가 거절한다', () => {
    const raw = JSON.parse(JSON.stringify(withShots([shot(10), shot(11), shot(12)])));
    expect(parseDigest(raw).ok).toBe(false);
  });

  it('구간 밖이면 후보로 잡혔어도 막는다. 마지막 소섹션은 영상 끝까지다', () => {
    const issues = lintDigest(withShots([shot(15)]), t, { scenes: [15] });
    expect(codesAt(lintErrors(issues))).toEqual([`SHOT_OUT_OF_RANGE ${SHOT0}.sec`]);
    const last = withShots([shot(60, { cite: { key: 11, from: 11, to: 11 } })], 1, 1);
    expect(lintErrors(lintDigest(last, t, { scenes: [60] }))).toEqual([]);
  });

  it('후보에 없는 시각과 scenes.json이 없는 경우를 막는다', () => {
    const d = withShots([shot(10)]);
    expect(codesAt(lintErrors(lintDigest(d, t, { scenes: [11] })))).toEqual([
      `SHOT_NOT_SCENE ${SHOT0}.sec`,
    ]);
    expect(codesAt(lintErrors(lintDigest(d, t, { scenes: null })))).toEqual([
      `SHOT_NO_SCENES ${SHOT0}.sec`,
    ]);
    // 대조할 목록을 안 넘기면 구간만 본다
    expect(lintErrors(lintDigest(d, t))).toEqual([]);
  });

  it('장면 출처는 소섹션 안이어야 하고 설명에 마커를 받지 않는다', () => {
    const d = withShots([shot(10, { caption: '**굵게**', cite: { key: 4, from: 4, to: 4 } })]);
    const codes = codesAt(lintErrors(lintDigest(d, t, { scenes: [10] })));
    expect(codes).toContain(`SHOT_CITE_OUT_OF_SUBSECTION ${SHOT0}.cite`);
    expect(codes).toContain(`TITLE_MARKER ${SHOT0}.caption`);
  });
});

describe('shots 프레임', () => {
  function fakeRun(opts: { hiresDownloadFails?: boolean; hiresReadFails?: boolean } = {}) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run: RunCommand = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'yt-dlp') {
        const o = args[args.indexOf('-o') + 1]!;
        if (opts.hiresDownloadFails && o.includes('video-720')) throw new Error('no format');
        writeFileSync(o.replace('%(ext)s', 'mp4'), 'fake');
      } else if (cmd === 'ffmpeg') {
        const input = args[args.indexOf('-i') + 1]!;
        if (opts.hiresReadFails && input.endsWith('video-720.mp4')) throw new Error('decode');
        writeFileSync(args.at(-1)!, 'jpg');
      }
      return { stdout: '', stderr: '' };
    };
    const downloads = () =>
      calls.filter((c) => c.cmd === 'yt-dlp').map((c) => c.args[c.args.indexOf('-o') + 1]!);
    return { run, calls, downloads };
  }

  it('shots 시각을 중복 없이 모은다', () => {
    const d = withShots([shot(12), shot(10)]);
    d.reports[0]!.sections[1]!.subsections[0]!.shots = [shot(10)];
    expect(collectShotSecs(d)).toEqual([10, 12]);
  });

  it('shots 장면은 720p 영상을 따로 받아 다른 이름으로 뽑는다', async () => {
    const { repo, store } = seeded();
    store.saveDigest(withShots([shot(10)]));
    const f = fakeRun();
    const r = await extractFrames(SLUG, { repoRoot: repo, run: f.run });
    expect(r.shots).toMatchObject({ total: 1, extracted: 1, hires: 1, missing: [] });
    expect(existsSync(join(store.framesDir(SLUG), shotFileName(10)))).toBe(true);
    expect(f.downloads().map((o) => o.split('/').at(-1))).toEqual([
      'video.%(ext)s',
      'video-720.%(ext)s',
    ]);
    const hires = f.calls.find(
      (c) => c.cmd === 'ffmpeg' && c.args[c.args.indexOf('-i') + 1]!.endsWith('video-720.mp4'),
    );
    expect(hires?.args.join(' ')).toContain("scale='min(1280,iw)'");

    // 받아 둔 720p 영상은 다시 받지 않는다
    const again = fakeRun();
    await extractFrames(SLUG, { repoRoot: repo, run: again.run, force: true });
    expect(again.downloads()).toEqual([]);
  });

  it('shots가 없으면 720p 영상을 받지 않는다', async () => {
    const { repo, store } = seeded();
    store.saveDigest(sampleDigest());
    const f = fakeRun();
    await extractFrames(SLUG, { repoRoot: repo, run: f.run });
    expect(f.downloads().some((o) => o.includes('video-720'))).toBe(false);
  });

  it('720p를 못 받거나 못 읽으면 저화질 영상으로 물러난다', async () => {
    for (const opts of [{ hiresDownloadFails: true }, { hiresReadFails: true }]) {
      const { repo, store } = seeded();
      store.saveDigest(withShots([shot(10)]));
      const r = await extractFrames(SLUG, { repoRoot: repo, run: fakeRun(opts).run });
      expect(r.shots).toMatchObject({ extracted: 1, hires: 0 });
      expect(existsSync(join(store.framesDir(SLUG), shotFileName(10)))).toBe(true);
    }
  });
});

describe('shots 렌더', () => {
  const t = sampleTranscript();
  const d = () => withShots([shot(10, { caption: '리텐션 [곡선]' })]);
  const exists = (file: string) => file === shotFileName(10) || file === frameFileName(15);

  it('장면이 있으면 첫 문장 프레임 대신 본문 옆에 장면을 크게 싣는다', () => {
    const { html } = renderDigestHtml(d(), t, { frameExists: exists });
    expect(html).toMatch(
      /<div class="sub-body has-shots"><div class="sub-text"><ul>.*<\/ul><\/div><div class="shots"><figure class="shot"><button type="button" class="shot-btn" data-zoom data-sec="10"[^>]*><img src="frames\/s00010000\.jpg" alt="리텐션 \[곡선\]"/s,
    );
    expect(html).not.toContain(frameFileName(0));
    // 장면이 없는 소섹션은 프레임을 그대로 싣는다
    expect(html).toContain(`frames/${frameFileName(15)}`);
  });

  it('장면 파일이 없으면 자리를 비우고 프레임으로 돌아간다', () => {
    const { html } = renderDigestHtml(d(), t, { frameExists: () => false });
    expect(html).not.toContain('class="shot"');
  });

  it('마크다운은 장면 사진과 설명을 싣고 alt의 대괄호를 이스케이프한다', () => {
    const md = renderDigestMarkdown(d(), t, { frameExists: exists });
    expect(md).toContain('![리텐션 \\[곡선\\]](frames/s00010000.jpg)');
    expect(md).toMatch(/^\*리텐션 \\\[곡선\\\]\* \[00:10\]\(/m);
  });

  it('마크다운 alt는 개행을 접고 <, >, !도 이스케이프한다', () => {
    const md = renderDigestMarkdown(withShots([shot(10, { caption: '첫 줄\n# 제목 <b>!' })]), t, {
      frameExists: exists,
    });
    expect(md).toContain('![첫 줄 # 제목 \\<b\\>\\!](frames/s00010000.jpg)');
  });
});
