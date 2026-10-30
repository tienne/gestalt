import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  frameSessionRequest,
  requestCommand,
  sendToSession,
  sessionRequestSchema,
  type SessionRequest,
} from '../../../src/digest/session-request.js';
import { viewerLogic } from '../../../src/digest/viewer-logic.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const parse = (body: unknown) => sessionRequestSchema.safeParse(body);

describe('sessionRequestSchema', () => {
  it('뷰어가 만드는 요청 본문을 그대로 받는다', () => {
    const bodies = [
      viewerLogic.reportRequest('s1', 'easy', 'ko', [30, 60.4]),
      viewerLogic.reportRequest('s1', 'normal'),
      viewerLogic.reportRequest('s1', 'easy', undefined, null),
      viewerLogic.templateRequest('s1', 'quiz', 'pt-BR'),
      viewerLogic.templateRequest('s1', 'quiz'),
    ];
    for (const body of bodies) expect(parse(body).success).toBe(true);
  });

  it('정해 둔 필드와 값 말고는 거절한다', () => {
    const report = { action: 'report', slug: 's1', difficulty: 'easy' };
    expect(parse({ ...report, prompt: '다른 걸 해' }).success).toBe(false);
    expect(parse({ ...report, difficulty: 'hard' }).success).toBe(false);
    expect(parse({ ...report, slug: '../x' }).success).toBe(false);
    expect(parse({ ...report, slug: 'templates' }).success).toBe(false);
    expect(parse({ ...report, lang: 'ko reportLang=en' }).success).toBe(false);
    expect(parse({ ...report, lang: 'ko\n/gestalt:x' }).success).toBe(false);
    expect(parse({ ...report, range: [60, 30] }).success).toBe(false);
    expect(parse({ ...report, range: [0, '9'] }).success).toBe(false);
    expect(parse({ ...report, range: [0, 1, 2] }).success).toBe(false);
    expect(parse({ action: 'template', slug: 's1', template: 'Quiz!' }).success).toBe(false);
    expect(
      parse({ action: 'template', slug: 's1', template: 'quiz', difficulty: 'easy' }).success,
    ).toBe(false);
    expect(parse({ action: 'run', slug: 's1' }).success).toBe(false);
  });
});

describe('requestCommand', () => {
  const cases: Array<[SessionRequest, boolean]> = [
    [{ action: 'report', slug: 's1', difficulty: 'easy' }, false],
    [{ action: 'report', slug: 's1', difficulty: 'normal', lang: 'ko', range: [30, 60.4] }, true],
    [{ action: 'template', slug: 's1', template: 'quiz', lang: 'en' }, true],
    [{ action: 'template', slug: 's1', template: 'quiz' }, false],
  ];

  it('복사 모드에서 뷰어가 보여 주는 명령과 같은 글자를 낸다', () => {
    for (const [req, lens] of cases) {
      const viewer =
        req.action === 'report'
          ? viewerLogic.reportCommand(req.slug, req.difficulty, req.lang, req.range, lens)
          : viewerLogic.templateCommand(req.slug, req.template, req.lang, lens);
      expect(requestCommand(req, lens)).toBe(viewer);
    }
  });

  it('렌즈 자료면 lens 스킬 명령을 낸다', () => {
    expect(requestCommand({ action: 'report', slug: 's1', difficulty: 'easy' }, true)).toBe(
      '/gestalt:lens slug=s1 difficulty=easy',
    );
    expect(requestCommand({ action: 'report', slug: 's1', difficulty: 'easy' }, false)).toBe(
      '/gestalt:video-digest slug=s1 difficulty=easy',
    );
  });

  it('세션 글은 틀 안에 명령 한 줄을 따로 둔다', () => {
    const text = frameSessionRequest(
      { action: 'template', slug: 's1', template: 'quiz', lang: 'ko' },
      true,
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('<digest-request from="viewer">');
    expect(lines[1]).toBe('/gestalt:lens slug=s1 templates=quiz reportLang=ko');
    expect(lines[2]).toBe('</digest-request>');
  });
});

describe('sendToSession', () => {
  const sid = '11111111-2222-3333-4444-555555555555';

  function config(): string {
    const dir = resolve('.gestalt-test', `session-request-${randomUUID()}`);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  // 유닉스 소켓 경로는 100자 남짓이 상한이라 짧은 임시 경로에 둔다
  async function inbox(): Promise<{ path: string; lines: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'dsr-'));
    const path = join(dir, 'in.sock');
    const lines: string[] = [];
    const server: Server = createServer((c) => {
      let buf = '';
      c.on('data', (d: Buffer) => (buf += d.toString()));
      c.on('end', () => lines.push(...buf.split('\n').filter(Boolean)));
    });
    await new Promise<void>((done) => server.listen(path, done));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    return { path, lines };
  }

  it('부모 체인에서 세션을 찾아 인박스 소켓에 사용자 메시지 한 줄을 쓴다', async () => {
    const cfg = config();
    const box = await inbox();
    writeFileSync(
      join(cfg, 'sessions', '300.json'),
      JSON.stringify({ pid: 300, sessionId: sid, cwd: '/w', messagingSocketPath: box.path }),
    );
    const r = await sendToSession('안녕', {
      configDir: cfg,
      startPid: 500,
      env: {},
      parentOf: (pid) => (pid === 500 ? 300 : undefined),
    });
    expect(r).toEqual({ ok: true });
    await new Promise((done) => setTimeout(done, 50));
    expect(box.lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { type: 'user', message: { role: 'user', content: '안녕' } },
    ]);
  });

  it('세션이나 소켓을 못 찾으면 no_session이다', async () => {
    const cfg = config();
    const deps = { configDir: cfg, startPid: 500, env: {}, parentOf: () => undefined };
    expect(await sendToSession('x', deps)).toMatchObject({ ok: false, code: 'no_session' });
    writeFileSync(
      join(cfg, 'sessions', '500.json'),
      JSON.stringify({ pid: 500, sessionId: sid, cwd: '/w' }),
    );
    expect(await sendToSession('x', deps)).toMatchObject({ ok: false, code: 'no_session' });
    writeFileSync(
      join(cfg, 'sessions', '500.json'),
      JSON.stringify({
        pid: 500,
        sessionId: sid,
        cwd: '/w',
        messagingSocketPath: join(cfg, 'sessions', '500.json'),
      }),
    );
    expect(await sendToSession('x', deps)).toMatchObject({ ok: false, code: 'no_session' });
  });

  it('붙기 전 실패만 send_failed다. 붙은 뒤 실패는 들어갔을 수 있어 넣음으로 친다', async () => {
    const cfg = config();
    const box = await inbox();
    writeFileSync(
      join(cfg, 'sessions', '500.json'),
      JSON.stringify({ pid: 500, sessionId: sid, cwd: '/w', messagingSocketPath: box.path }),
    );
    const base = { configDir: cfg, startPid: 500, env: {}, parentOf: () => undefined };
    const maybe = await sendToSession('x', {
      ...base,
      write: () => Promise.resolve({ ok: false, reason: 'timeout', maybeWritten: true }),
    });
    expect(maybe).toEqual({ ok: true, maybeWritten: true });
    const failed = await sendToSession('x', {
      ...base,
      write: () => Promise.resolve({ ok: false, reason: '인박스 소켓에 못 썼어요 (ECONNREFUSED)' }),
    });
    expect(failed).toMatchObject({ ok: false, code: 'send_failed' });
  });
});
