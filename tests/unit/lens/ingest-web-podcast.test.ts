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
import { audioExt, pickEpisode } from '../../../src/lens/podcast.js';

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
