import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectFrameSecs, extractFrames, frameFileName } from '../../../src/digest/frames.js';
import { DigestStore } from '../../../src/digest/store.js';
import type { RunCommand } from '../../../src/digest/ytdlp.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const tmpDirs: string[] = [];
function tmpRepo(): string {
  const dir = resolve('.gestalt-test', `digest-frames-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** skipFrames에 든 파일 이름은 ffmpeg가 0으로 끝나도 안 쓴다. 영상 끝을 넘긴 시각을 흉내 낸다 */
function fakeRun(skipFrames: string[] = []) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs?: number }> = [];
  const run: RunCommand = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    if (cmd === 'yt-dlp') {
      const o = args[args.indexOf('-o') + 1]!;
      writeFileSync(join(dirname(o), 'video.mp4'), 'fake');
    } else if (cmd === 'ffmpeg') {
      const out = args[args.length - 1]!;
      if (!skipFrames.some((f) => out.endsWith(f))) writeFileSync(out, 'jpg');
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

function seeded(): { repo: string; store: DigestStore } {
  const repo = tmpRepo();
  const store = new DigestStore(repo);
  store.saveTranscript(sampleTranscript());
  store.saveDigest(sampleDigest());
  return { repo, store };
}

describe('frames', () => {
  it('파일 이름은 밀리초를 0으로 채워 정렬되게 한다', () => {
    expect(frameFileName(15)).toBe('t00015000.jpg');
    expect(frameFileName(0.96)).toBe('t00000960.jpg');
  });

  it('소섹션 frameSec을 중복 없이 모은다', () => {
    expect(collectFrameSecs(sampleDigest())).toEqual([0, 15, 30, 45]);
  });

  it('영상을 한 번 받아 시각마다 한 장씩 뽑고 다음엔 있는 건 건너뛴다', async () => {
    const { repo, store } = seeded();
    const first = fakeRun();
    const r = await extractFrames(SLUG, { repoRoot: repo, run: first.run });
    expect(r).toMatchObject({ extracted: 4, skipped: 0, total: 4, missing: [] });
    expect(first.calls.filter((c) => c.cmd === 'yt-dlp')).toHaveLength(1);
    expect(existsSync(join(store.framesDir(SLUG), frameFileName(45)))).toBe(true);

    const second = fakeRun();
    const again = await extractFrames(SLUG, { repoRoot: repo, run: second.run });
    expect(again).toMatchObject({ extracted: 0, skipped: 4 });
    expect(second.calls).toEqual([]);
  });

  it('repoRoot를 상대 경로로 받아도 출력 경로는 절대 경로로 넘겨 프레임이 레포에 남는다', async () => {
    const { repo, store } = seeded();
    const f = fakeRun();
    const r = await extractFrames(SLUG, { repoRoot: relative(process.cwd(), repo), run: f.run });
    expect(r.missing).toEqual([]);
    const outs = f.calls.map((c) =>
      c.cmd === 'yt-dlp' ? c.args[c.args.indexOf('-o') + 1]! : c.args.at(-1)!,
    );
    expect(outs.every((o) => isAbsolute(o))).toBe(true);
    expect(existsSync(join(store.framesDir(SLUG), frameFileName(45)))).toBe(true);
  });

  it('--force면 받아 둔 영상으로 다시 뽑는다', async () => {
    const { repo } = seeded();
    await extractFrames(SLUG, { repoRoot: repo, run: fakeRun().run });
    const again = fakeRun();
    const r = await extractFrames(SLUG, { repoRoot: repo, run: again.run, force: true });
    expect(r.extracted).toBe(4);
    expect(again.calls.filter((c) => c.cmd === 'yt-dlp')).toEqual([]);
  });

  it('영상 주소는 videoId로 다시 만들어 -- 뒤에 넘기고 시간 상한을 준다', async () => {
    const { repo } = seeded();
    const { run, calls } = fakeRun();
    await extractFrames(SLUG, { repoRoot: repo, run });
    const dl = calls.find((c) => c.cmd === 'yt-dlp')!;
    expect(dl.args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=ukY9Dvwm7Gc']);
    expect(dl.timeoutMs).toBeGreaterThan(0);
    expect(calls.filter((c) => c.cmd === 'ffmpeg').every((c) => c.timeoutMs! > 0)).toBe(true);
  });

  it('yt-dlp와 ffmpeg는 레포 밖 임시 폴더를 cwd로 돌리고 끝나면 지운다', async () => {
    const { repo } = seeded();
    const { run, calls } = fakeRun();
    await extractFrames(SLUG, { repoRoot: repo, run });
    expect(new Set(calls.map((c) => c.cmd))).toEqual(new Set(['yt-dlp', 'ffmpeg']));
    for (const c of calls) {
      expect(c.cwd.startsWith(tmpdir())).toBe(true);
      expect(c.cwd.startsWith(repo)).toBe(false);
      expect(c.cwd.startsWith(process.cwd())).toBe(false);
    }
    expect(existsSync(calls[0]!.cwd)).toBe(false);
  });

  it('중단된 다운로드가 남긴 보조 파일은 캐시로 보지 않는다', async () => {
    const { repo, store } = seeded();
    const cache = store.videoCacheDir(SLUG);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'video.mp4.ytdl'), '');
    writeFileSync(join(cache, 'video.mp4.part-Frag3'), '');
    const { run, calls } = fakeRun();
    await extractFrames(SLUG, { repoRoot: repo, run });
    expect(calls.filter((c) => c.cmd === 'yt-dlp')).toHaveLength(1);
  });

  it('ffmpeg가 파일을 안 만든 시각은 missing으로 알린다', async () => {
    const { repo } = seeded();
    const r = await extractFrames(SLUG, {
      repoRoot: repo,
      run: fakeRun([frameFileName(45)]).run,
    });
    expect(r).toMatchObject({ extracted: 3, total: 4, missing: [45] });
  });

  it('digest.json이 없으면 요약부터 쓰라고 알린다', async () => {
    const repo = tmpRepo();
    new DigestStore(repo).saveTranscript(sampleTranscript());
    await expect(extractFrames(SLUG, { repoRoot: repo, run: fakeRun().run })).rejects.toThrow(
      /digest.json/,
    );
  });
});
