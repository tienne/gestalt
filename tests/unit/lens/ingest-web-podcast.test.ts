import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readLensSource } from '../../../src/digest/lens-source.js';
import { DigestServer } from '../../../src/digest/server.js';
import { DigestStore } from '../../../src/digest/store.js';
import type { RunCommand } from '../../../src/digest/ytdlp.js';
import { ingestLens } from '../../../src/lens/ingest.js';
import { assignSpeakers, audioExt, pickEpisode } from '../../../src/lens/podcast.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
function repo(): string {
  const r = resolve('.gestalt-test', `lens-ingest-wp-${randomUUID()}`);
  mkdirSync(r, { recursive: true });
  cleanups.push(() => rmSync(r, { recursive: true, force: true }));
  return r;
}

const FEED = `<?xml version="1.0"?><rss><channel><title>News &amp; Notes</title>
<item><title><![CDATA[Episode 2]]></title><pubDate>Tue, 27 Oct 2026 19:00:00 GMT</pubDate>
<enclosure url="https://cdn.example.com/ep2.mp3?x=1&amp;y=2" type="audio/mpeg"/></item>
<item><title>Episode 1</title><enclosure url="https://cdn.example.com/ep1.m4a"/></item>
</channel></rss>`;

describe('팟캐스트 피드', () => {
  it('최신 에피소드부터 고르고 CDATA와 엔티티를 푼다', () => {
    expect(pickEpisode(FEED)).toEqual({
      show: 'News & Notes',
      title: 'Episode 2',
      audioUrl: 'https://cdn.example.com/ep2.mp3?x=1&y=2',
      pubDate: 'Tue, 27 Oct 2026 19:00:00 GMT',
    });
    expect(pickEpisode(FEED, 1).audioUrl).toBe('https://cdn.example.com/ep1.m4a');
    expect(() => pickEpisode(FEED, 5)).toThrow(/3번째|6번째/);
  });

  it('http(s)가 아닌 오디오 주소는 거절한다', () => {
    expect(() =>
      pickEpisode(
        '<rss><channel><item><enclosure url="file:///etc/passwd"/></item></channel></rss>',
      ),
    ).toThrow(/http\(s\)/);
  });

  it('오디오 확장자를 주소에서 읽고 없으면 mp3로 둔다', () => {
    expect(audioExt('https://a.com/x.m4a?y=1')).toBe('.m4a');
    expect(audioExt('https://a.com/play?id=3')).toBe('.mp3');
  });
});

describe('화자 붙이기', () => {
  it('가장 오래 겹치는 구간의 화자를 처음 나온 순서대로 이름 붙인다', () => {
    const turns = [
      { start: 0, end: 5, speaker: 3 },
      { start: 5, end: 9, speaker: 0 },
      { start: 9, end: 20, speaker: 3 },
    ];
    expect(
      assignSpeakers(
        [
          { start: 0, end: 4 },
          { start: 4, end: 8.5 },
          { start: 8.8, end: 12 },
          { start: 30, end: 31 },
        ],
        turns,
      ),
    ).toEqual(['화자 1', '화자 2', '화자 1', undefined]);
  });
});

describe('ingestLens (web)', () => {
  it('추출한 문단과 표로 transcript.json과 source.json을 쓴다', async () => {
    const root = repo();
    const html = join(root, 'post.html');
    writeFileSync(html, '<html><body><p>hi</p></body></html>');
    const run: RunCommand = async () => ({
      stdout: `\n${JSON.stringify({
        title: 'A Post',
        author: 'Kim',
        date: '2026-10-01',
        site: 'Blog',
        lang: 'en',
        units: [
          { i: 0, role: 'heading', text: 'Intro' },
          { i: 1, role: 'para', text: 'Body 12 percent.' },
          { i: 2, role: 'caption', ref: 'table-1', text: 'Table 1: a | b' },
        ],
        tables: [
          {
            id: 'table-1',
            number: '1',
            caption: 'Table 1: a | b',
            rows: [
              ['a', 'b'],
              ['1', '2'],
            ],
            grid: 'ok',
            unit: 2,
          },
        ],
      })}\n`,
      stderr: '',
    });
    const r = await ingestLens(html, { repoRoot: root, run, python: '/usr/bin/python3' });
    expect(r.kind).toBe('web');
    const store = new DigestStore(root);
    const t = store.readTranscript(r.slug);
    expect(t.ok && t.transcript.meta).toMatchObject({
      source: 'web',
      channel: 'Kim',
      publishedAt: '2026-10-01',
    });
    expect(t.ok && t.transcript.segments[1]).toEqual({
      i: 1,
      startSec: 0,
      text: 'Body 12 percent.',
      role: 'para',
    });
    expect(readLensSource(store, r.slug)?.tables[0]?.unit).toBe(2);
  });
});

describe('ingestLens (podcast)', () => {
  it('피드에서 에피소드를 골라 받아쓰고 내려받은 오디오를 media로 적는다', async () => {
    const root = repo();
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(String(url));
      if (String(url).includes('feed')) return new Response(FEED, { status: 200 });
      return new Response(Buffer.from('ID3audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }) as typeof fetch;
    const run: RunCommand = async (_cmd, args) => {
      expect(args[3]).toMatch(/audio\.mp3$/);
      expect(args[4]).toBe('base');
      return {
        stdout: `\n${JSON.stringify({
          language: 'en',
          duration: 12.5,
          segments: [
            { start: 0, text: 'Hello.' },
            { start: 4.2, text: 'News today.' },
            { start: 4.1, text: 'More.' },
          ],
        })}\n`,
        stderr: '',
      };
    };
    const r = await ingestLens('https://feeds.example.com/show', {
      repoRoot: root,
      run,
      fetchImpl,
      python: '/usr/bin/python3',
      whisperModel: 'base',
    });
    expect(fetched).toEqual([
      'https://feeds.example.com/show',
      'https://cdn.example.com/ep2.mp3?x=1&y=2',
    ]);
    expect(r.kind).toBe('podcast');
    expect(r.warnings[0]).toContain('화자 구분 없이');
    const t = new DigestStore(root).readTranscript(r.slug);
    if (!t.ok) throw new Error(t.message);
    expect(t.transcript.meta).toMatchObject({
      source: 'podcast',
      title: 'Episode 2',
      channel: 'News & Notes',
      publishedAt: '2026-10-27',
      captionSource: 'whisper',
      durationSec: 12.5,
    });
    // 앞 문장보다 이른 시각은 앞 문장에 맞춘다
    expect(t.transcript.segments.map((s) => s.startSec)).toEqual([0, 4.2, 4.2]);
    const media = fileURLToPath(t.transcript.meta.media!);
    expect(readFileSync(media, 'utf-8')).toBe('ID3audio');
  });
});

describe('serve가 팟캐스트 오디오를 내준다', () => {
  it('transcript.json의 media 파일 하나만 오디오 형식으로 내준다', async () => {
    const root = repo();
    const run: RunCommand = async () => ({
      stdout: `\n${JSON.stringify({ language: 'en', duration: 3, segments: [{ start: 0, text: 'Hi.' }] })}\n`,
      stderr: '',
    });
    const audio = join(root, 'talk.m4a');
    writeFileSync(audio, 'AUDIO');
    const r = await ingestLens(audio, { repoRoot: root, run, python: '/usr/bin/python3' });
    const server = new DigestServer(join(root, '.gestalt', 'digest'));
    await server.start(0);
    cleanups.push(() => server.stop());
    const res = await new Promise<{ status: number; type: string; body: string }>(
      (done, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: server.port,
            path: `/${r.slug}/video`,
            headers: { host: '127.0.0.1' },
          },
          (rs) => {
            let body = '';
            rs.on('data', (c: Buffer) => (body += c.toString()));
            rs.on('end', () =>
              done({ status: rs.statusCode!, type: String(rs.headers['content-type']), body }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(res).toEqual({ status: 200, type: 'audio/mp4', body: 'AUDIO' });
    expect(existsSync(join(root, '.gestalt', 'digest', r.slug, 'cache', 'audio.m4a'))).toBe(true);
  });
});

describe('ingestLens (podcast, 화자 구분)', () => {
  it('모델이 있으면 받아쓴 문장에 화자를 붙이고 실패하면 화자 없이 살린다', async () => {
    const root = repo();
    const models = join(root, 'models');
    mkdirSync(join(models, 'sherpa-onnx-pyannote-segmentation-3-0'), { recursive: true });
    writeFileSync(join(models, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'), 'x');
    writeFileSync(join(models, 'wespeaker_en_voxceleb_resnet34.onnx'), 'x');
    const prev = process.env.GESTALT_LENS_MODELS;
    process.env.GESTALT_LENS_MODELS = models;
    cleanups.push(() => {
      if (prev === undefined) delete process.env.GESTALT_LENS_MODELS;
      else process.env.GESTALT_LENS_MODELS = prev;
    });
    const audio = join(root, 'talk.mp3');
    writeFileSync(audio, 'AUDIO');
    const whisper = JSON.stringify({
      language: 'en',
      duration: 10,
      segments: [
        { start: 0, end: 4, text: 'Hello.' },
        { start: 4, end: 9, text: 'Reporting.' },
      ],
    });
    let diarizeOk = true;
    const run: RunCommand = async (_cmd, args) => {
      if (String(args[2]).includes('sherpa_onnx')) {
        if (!diarizeOk) throw new Error('onnx 실패');
        expect(args[4]).toBe(join(models, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'));
        return {
          stdout: `\n${JSON.stringify([
            { start: 0, end: 4.2, speaker: 2 },
            { start: 4.2, end: 9, speaker: 0 },
          ])}\n`,
          stderr: '',
        };
      }
      return { stdout: `\n${whisper}\n`, stderr: '' };
    };
    const r = await ingestLens(audio, {
      repoRoot: root,
      run,
      python: '/usr/bin/python3',
      speakers: true,
    });
    expect(r.warnings[0]).toContain('화자 2명');
    const t = new DigestStore(root).readTranscript(r.slug);
    expect(t.ok && t.transcript.segments.map((s) => s.speaker)).toEqual(['화자 1', '화자 2']);

    diarizeOk = false;
    const r2 = await ingestLens(audio, {
      repoRoot: root,
      run,
      python: '/usr/bin/python3',
      speakers: true,
      slug: 'talk-again',
    });
    expect(r2.warnings[0]).toContain('화자 구분이 실패해');
    const t2 = new DigestStore(root).readTranscript('talk-again');
    expect(t2.ok && t2.transcript.segments.every((s) => s.speaker === undefined)).toBe(true);
  });
});
