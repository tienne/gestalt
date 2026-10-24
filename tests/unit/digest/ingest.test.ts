import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingest, parseYoutubeId, pickCaption } from '../../../src/digest/ingest.js';
import { DigestStore } from '../../../src/digest/store.js';
import { SLUG, sampleDigest } from './fixture.js';
import { CommandError, type RunCommand } from '../../../src/digest/ytdlp.js';

const tmpDirs: string[] = [];
function tmpRepo(): string {
  const dir = resolve('.gestalt-test', `digest-ingest-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const VIDEO_ID = 'ukY9Dvwm7Gc';
const URL_ = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const META = {
  id: VIDEO_ID,
  title: 'Design with Code Layers | Figma',
  channel: 'Figma',
  duration: 499,
  upload_date: '20261015',
  language: 'en',
  subtitles: {},
  automatic_captions: { en: [{ ext: 'vtt' }], 'en-orig': [{ ext: 'vtt' }], ko: [{ ext: 'vtt' }] },
};

const AUTO_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  "Hi,<00:00:00.320><c> I'm</c><00:00:00.520><c> Anthony.</c><00:00:00.960><c> Let's</c><00:00:01.200><c> start.</c>",
].join('\n');

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

/** yt-dlp 호출을 흉내 낸다. -o 경로에 자막이나 오디오 파일을 써 준다 */
function fakeRun(
  opts: {
    meta?: object;
    vtt?: string;
    fail403Once?: boolean;
    python?: boolean | 'missing' | 'dep-missing';
    whisperStdout?: string;
  } = {},
): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  let failed = false;
  const run: RunCommand = async (cmd, args, runOpts) => {
    calls.push({ cmd, args, cwd: runOpts.cwd, timeoutMs: runOpts.timeoutMs });
    if (cmd === 'yt-dlp') {
      if (opts.fail403Once && !failed) {
        failed = true;
        throw new CommandError('yt-dlp', 'ERROR: HTTP Error 403: Forbidden', 'yt-dlp 실행 실패');
      }
      if (args.includes('-J')) return { stdout: JSON.stringify(opts.meta ?? META), stderr: '' };
      const o = args[args.indexOf('-o') + 1]!;
      if (args.includes('--sub-langs')) {
        const key = args[args.indexOf('--sub-langs') + 1]!;
        writeFileSync(join(dirname(o), `sub.${key}.vtt`), opts.vtt ?? AUTO_VTT);
      } else {
        writeFileSync(join(dirname(o), 'audio.m4a'), 'fake');
      }
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'python3') {
      if (opts.python === 'missing') {
        throw new CommandError(
          'python3',
          '',
          'python3를 찾지 못했어요. 설치한 뒤 PATH에 있는지 확인해 주세요.',
        );
      }
      if (opts.python === 'dep-missing') {
        throw new CommandError(
          'python3',
          "ModuleNotFoundError: No module named 'ctranslate2'",
          'python3 실행 실패',
        );
      }
      if (!opts.python) {
        throw new CommandError(
          'python3',
          "ModuleNotFoundError: No module named 'faster_whisper'",
          'python3 실행 실패',
        );
      }
      if (opts.whisperStdout !== undefined) return { stdout: opts.whisperStdout, stderr: '' };
      return {
        stdout: `Downloading model 100%\r\n${JSON.stringify({
          language: 'ko',
          segments: [
            { start: 0, text: '안녕하세요.' },
            { start: 2.5, text: '오늘은 코드 레이어를 봅니다.' },
          ],
        })}\n`,
        stderr: '',
      };
    }
    if (cmd === 'ffprobe') return { stdout: '12.5\n', stderr: '' };
    throw new Error(`예상 못 한 명령: ${cmd}`);
  };
  return { run, calls };
}

describe('parseYoutubeId', () => {
  it.each([
    [URL_, VIDEO_ID],
    [`https://youtu.be/${VIDEO_ID}?t=30`, VIDEO_ID],
    [`https://m.youtube.com/shorts/${VIDEO_ID}`, VIDEO_ID],
    [`https://www.youtube.com/embed/${VIDEO_ID}`, VIDEO_ID],
    ['https://example.com/watch?v=ukY9Dvwm7Gc', null],
    ['./video.mp4', null],
  ])('%s → %s', (input, expected) => {
    expect(parseYoutubeId(input)).toBe(expected);
  });
});

describe('pickCaption', () => {
  it('수동 자막이 있으면 먼저 고른다', () => {
    expect(
      pickCaption({ ...META, subtitles: { 'en-US': [{ ext: 'vtt' }], live_chat: [] } }),
    ).toEqual({ kind: 'manual', key: 'en-US', lang: 'en-US' });
  });

  it('수동 자막이 없으면 번역이 아닌 원어 자동 자막(-orig)을 고른다', () => {
    expect(pickCaption(META)).toEqual({ kind: 'auto', key: 'en-orig', lang: 'en' });
  });

  it('자막이 하나도 없으면 null', () => {
    expect(pickCaption({ id: VIDEO_ID, subtitles: {}, automatic_captions: {} })).toBeNull();
  });
});

describe('ingest', () => {
  it('자동 자막을 문장으로 합쳐 transcript.json에 저장한다', async () => {
    const repo = tmpRepo();
    const { run } = fakeRun();
    const r = await ingest(URL_, { repoRoot: repo, run });
    expect(r).toMatchObject({
      slug: 'design-with-code-layers-figma-uky9dvwm7gc',
      captionSource: 'auto',
      captionTrack: 'en-orig',
      segmentCount: 2,
    });
    const read = new DigestStore(repo).readTranscript(r.slug);
    if (!read.ok) throw new Error(read.code);
    const t = read.transcript;
    expect(t.meta).toMatchObject({
      source: 'youtube',
      videoId: VIDEO_ID,
      durationSec: 499,
      publishedAt: '2026-10-15',
      lang: 'en',
    });
    expect(t.segments).toEqual([
      { i: 0, startSec: 0, text: "Hi, I'm Anthony." },
      { i: 1, startSec: 0.96, text: "Let's start." },
    ]);
  });

  it('403이 나면 web_embedded 클라이언트로 다시 시도한다', async () => {
    const { run, calls } = fakeRun({ fail403Once: true });
    await ingest(URL_, { repoRoot: tmpRepo(), run });
    expect(calls[0]!.args).not.toContain('youtube:player_client=web_embedded');
    expect(calls[1]!.args).toContain('youtube:player_client=web_embedded');
  });

  it('자막이 없으면 whisper로 넘어간다', async () => {
    const { run, calls } = fakeRun({
      meta: { ...META, automatic_captions: {} },
      python: true,
    });
    const r = await ingest(URL_, { repoRoot: tmpRepo(), run });
    expect(r.captionSource).toBe('whisper');
    expect(r.captionTrack).toBe('large-v3');
    expect(calls.some((c) => c.args.includes('bestaudio/best'))).toBe(true);
  });

  it('whisper가 설치돼 있지 않으면 설치 방법을 알려준다', async () => {
    const { run } = fakeRun({ meta: { ...META, automatic_captions: {} } });
    await expect(ingest(URL_, { repoRoot: tmpRepo(), run })).rejects.toThrow(
      /pip install faster-whisper/,
    );
  });

  it('python3 자체가 없으면 pip 안내 대신 원래 오류를 올린다', async () => {
    const { run } = fakeRun({ meta: { ...META, automatic_captions: {} }, python: 'missing' });
    await expect(ingest(URL_, { repoRoot: tmpRepo(), run })).rejects.toThrow(
      /python3를 찾지 못했어요/,
    );
  });

  it('faster-whisper의 의존 모듈이 빠졌으면 pip 안내 대신 원래 오류를 올린다', async () => {
    const { run } = fakeRun({ meta: { ...META, automatic_captions: {} }, python: 'dep-missing' });
    const err = await ingest(URL_, { repoRoot: tmpRepo(), run }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).stderr).toMatch(/ctranslate2/);
    expect((err as Error).message).not.toMatch(/pip install faster-whisper/);
  });

  it('받아쓰기 결과가 JSON이 아니면 앞부분을 보여준다', async () => {
    const { run } = fakeRun({
      meta: { ...META, automatic_captions: {} },
      python: true,
      whisperStdout: 'Traceback: boom',
    });
    await expect(ingest(URL_, { repoRoot: tmpRepo(), run })).rejects.toThrow(
      /JSON으로 못 읽었어요: Traceback: boom/,
    );
  });

  it('외부 명령마다 시간 상한을 준다', async () => {
    const { run, calls } = fakeRun({ meta: { ...META, automatic_captions: {} }, python: true });
    await ingest(URL_, { repoRoot: tmpRepo(), run });
    expect(calls.every((c) => (c.timeoutMs ?? 0) > 0)).toBe(true);
    const meta = calls.find((c) => c.args.includes('-J'))!;
    const audio = calls.find((c) => c.args.includes('bestaudio/best'))!;
    expect(audio.timeoutMs!).toBeGreaterThan(meta.timeoutMs!);
  });

  it('외부 명령은 레포 밖 임시 폴더를 cwd로 돌린다', async () => {
    const repo = tmpRepo();
    const yt = fakeRun({ meta: { ...META, automatic_captions: {} }, python: true });
    await ingest(URL_, { repoRoot: repo, run: yt.run });
    const video = join(repo, 'talk.mp4');
    writeFileSync(video, 'fake');
    const file = fakeRun({ python: true });
    await ingest(video, { repoRoot: repo, run: file.run });

    const calls = [...yt.calls, ...file.calls];
    expect(new Set(calls.map((c) => c.cmd))).toEqual(new Set(['yt-dlp', 'python3', 'ffprobe']));
    for (const c of calls) {
      expect(c.cwd.startsWith(tmpdir())).toBe(true);
      expect(c.cwd.startsWith(repo)).toBe(false);
      expect(c.cwd.startsWith(process.cwd())).toBe(false);
    }
  });

  describe('같은 slug로 다시 받을 때', () => {
    const slugOpt = { slug: SLUG };

    it('문장이 그대로면 digest.json을 둔다', async () => {
      const repo = tmpRepo();
      await ingest(URL_, { repoRoot: repo, run: fakeRun().run, ...slugOpt });
      const store = new DigestStore(repo);
      store.saveDigest(sampleDigest());
      const r = await ingest(URL_, { repoRoot: repo, run: fakeRun().run, ...slugOpt });
      expect(r.staleDigest).toBeUndefined();
      expect(store.loadDigest(SLUG)).not.toBeNull();
    });

    it('문장이 바뀌면 digest.json을 stale 파일로 옮기고 알린다', async () => {
      const repo = tmpRepo();
      await ingest(URL_, { repoRoot: repo, run: fakeRun().run, ...slugOpt });
      const store = new DigestStore(repo);
      store.saveDigest(sampleDigest());
      const whisper = fakeRun({ python: true });
      const r = await ingest(URL_, { repoRoot: repo, run: whisper.run, whisper: true, ...slugOpt });
      expect(r.staleDigest?.previousSegmentCount).toBe(2);
      expect(r.staleDigest?.movedTo).toMatch(/digest\.stale-.+\.json$/);
      expect(store.readDigestFile(SLUG).kind).toBe('missing');
      expect(existsSync(r.staleDigest!.movedTo)).toBe(true);
    });

    it('transcript 저장이 실패하면 옮긴 digest.json을 되돌린다', async () => {
      const repo = tmpRepo();
      await ingest(URL_, { repoRoot: repo, run: fakeRun().run, ...slugOpt });
      const store = new DigestStore(repo);
      store.saveDigest(sampleDigest());
      const spy = vi.spyOn(DigestStore.prototype, 'saveTranscript').mockImplementation(() => {
        throw new Error('디스크가 꽉 찼어요');
      });
      try {
        const whisper = fakeRun({ python: true });
        await expect(
          ingest(URL_, { repoRoot: repo, run: whisper.run, whisper: true, ...slugOpt }),
        ).rejects.toThrow(/디스크가 꽉 찼어요/);
      } finally {
        spy.mockRestore();
      }
      expect(store.readDigestFile(SLUG).kind).not.toBe('missing');
      expect(readdirSync(store.dir(SLUG)).some((f) => f.startsWith('digest.stale-'))).toBe(false);
    });

    it('digest.json을 되돌리지 못하면 원래 오류에 남은 자리와 못 되돌린 이유를 붙여 던진다', async () => {
      const repo = tmpRepo();
      await ingest(URL_, { repoRoot: repo, run: fakeRun().run, ...slugOpt });
      const store = new DigestStore(repo);
      store.saveDigest(sampleDigest());
      // 원래 자리에 비어 있지 않은 폴더가 생기면 rename이 실패한다
      const spy = vi.spyOn(DigestStore.prototype, 'saveTranscript').mockImplementation(() => {
        mkdirSync(store.digestPath(SLUG));
        writeFileSync(join(store.digestPath(SLUG), 'x'), '');
        throw new Error('디스크가 꽉 찼어요');
      });
      try {
        const whisper = fakeRun({ python: true });
        await expect(
          ingest(URL_, { repoRoot: repo, run: whisper.run, whisper: true, ...slugOpt }),
        ).rejects.toThrow(
          /디스크가 꽉 찼어요.*digest\.stale-.+\.json에 남아 있어요: .*(EISDIR|ENOTEMPTY|EEXIST|EPERM)/,
        );
      } finally {
        spy.mockRestore();
      }
      expect(readdirSync(store.dir(SLUG)).some((f) => f.startsWith('digest.stale-'))).toBe(true);
    });
  });

  it('로컬 파일은 같은 이름의 자막 파일을 수동 자막으로 쓴다', async () => {
    const repo = tmpRepo();
    const video = join(repo, 'talk.mp4');
    writeFileSync(video, 'fake');
    writeFileSync(
      join(repo, 'talk.srt'),
      '1\n00:00:01,000 --> 00:00:03,000\n첫 문장입니다.\n\n2\n00:00:04,000 --> 00:00:05,000\n둘째 문장.\n',
    );
    const { run } = fakeRun();
    const r = await ingest(video, { repoRoot: repo, run, lang: 'ko' });
    expect(r.captionSource).toBe('manual');
    expect(r.slug).toMatch(/^talk-[0-9a-f]{8}$/);
    const read = new DigestStore(repo).readTranscript(r.slug);
    if (!read.ok) throw new Error(read.code);
    const t = read.transcript;
    expect(t.meta).toMatchObject({ source: 'file', durationSec: 12.5, lang: 'ko' });
    expect(t.meta.url).toMatch(/^file:\/\//);
  });

  it('주소도 파일도 아니면 거절한다', async () => {
    await expect(ingest('nope.mp4', { repoRoot: tmpRepo(), run: fakeRun().run })).rejects.toThrow(
      /찾지 못했어요/,
    );
  });
});
