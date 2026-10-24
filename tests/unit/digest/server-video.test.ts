import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DIGEST_CSP, DigestServer, parseByteRange } from '../../../src/digest/server.js';
import { sampleTranscript } from './fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const VIDEO = Buffer.from('0123456789');

async function started(videoName = 'talk.mp4') {
  const base = resolve('.gestalt-test', `digest-video-${randomUUID()}`);
  const root = join(base, '.gestalt', 'digest');
  const outside = join(base, 'videos');
  mkdirSync(join(root, 'local'), { recursive: true });
  mkdirSync(join(root, 'yt'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'talk.mp4'), VIDEO);
  writeFileSync(join(outside, 'notes.txt'), 'secret');
  const t = sampleTranscript();
  const local = {
    ...t,
    slug: 'local',
    meta: {
      ...t.meta,
      source: 'file',
      videoId: undefined,
      url: pathToFileURL(join(outside, videoName)).href,
    },
  };
  writeFileSync(join(root, 'local', 'transcript.json'), JSON.stringify(local));
  writeFileSync(join(root, 'yt', 'transcript.json'), JSON.stringify({ ...t, slug: 'yt' }));
  const server = new DigestServer(root);
  await server.start(0);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  cleanups.push(() => server.stop());
  return { server, root, outside };
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((done, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('parseByteRange', () => {
  it('단일 구간과 접미 구간을 받는다', () => {
    expect(parseByteRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseByteRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseByteRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 });
  });

  it('꼴이 틀렸거나 여러 구간이면 무시하고 범위를 벗어나면 거절한다', () => {
    expect(parseByteRange(undefined, 10)).toBe('none');
    expect(parseByteRange('bytes=0-1,3-4', 10)).toBe('none');
    expect(parseByteRange('items=0-1', 10)).toBe('none');
    expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=5-2', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 10)).toBe('unsatisfiable');
  });
});

describe('DigestServer 로컬 영상', () => {
  it('transcript.json에 적힌 영상을 Range로 나눠 내준다', async () => {
    const { server } = await started();
    const whole = await get(server.port!, '/local/video');
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.body).toBe('0123456789');

    const part = await get(server.port!, '/local/video', { range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body).toBe('2345');

    const bad = await get(server.port!, '/local/video', { range: 'bytes=20-' });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */10');
  });

  it('유튜브 영상이거나 영상 확장자가 아니면 내주지 않는다', async () => {
    const yt = await started();
    expect((await get(yt.server.port!, '/yt/video')).status).toBe(404);
    expect((await get(yt.server.port!, '/none/video')).status).toBe(404);
    expect((await get(yt.server.port!, '/local/../yt/video')).status).toBe(404);

    const txt = await started('notes.txt');
    expect((await get(txt.server.port!, '/local/video')).status).toBe(404);
  });

  it('영상 이름의 심링크가 다른 파일을 가리키면 실제 확장자로 막는다', async () => {
    const { server, outside } = await started('alias.mp4');
    symlinkSync(join(outside, 'notes.txt'), join(outside, 'alias.mp4'));
    expect((await get(server.port!, '/local/video')).status).toBe(404);
  });

  it('CSP가 같은 출처 미디어를 연다', () => {
    expect(DIGEST_CSP).toContain("media-src 'self'");
  });
});
