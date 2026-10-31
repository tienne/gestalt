import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeStopHandler,
  peerApproveCommand,
  peerKickCommand,
  peerSendCommand,
  peerShareCommand,
  peerUnshareCommand,
} from '../../../src/cli/commands/peer.js';

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('makeStopHandler', () => {
  it('정리가 끝나면 0으로 끝낸다', async () => {
    const exit = vi.fn();
    const logErr = vi.fn();
    makeStopHandler({ stop: () => Promise.resolve() }, exit, logErr)();
    await settle();
    expect(exit.mock.calls).toEqual([[0]]);
    expect(logErr).not.toHaveBeenCalled();
  });

  it('정리가 실패하면 메시지를 남기고 1로 끝낸다', async () => {
    const exit = vi.fn();
    const logErr = vi.fn();
    makeStopHandler({ stop: () => Promise.reject(new Error('socket busy')) }, exit, logErr)();
    await settle();
    expect(logErr.mock.calls).toEqual([['socket busy']]);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('정리 중에 한 번 더 부르면 기다리지 않고 1로 끝내고 정리는 다시 안 부른다', () => {
    const exit = vi.fn();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const handler = makeStopHandler({ stop }, exit, vi.fn());
    handler();
    expect(exit).not.toHaveBeenCalled();
    handler();
    expect(exit.mock.calls).toEqual([[1]]);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

/** `--here` 경로를 가짜 데몬 소켓으로 돌린다. 세션 파일은 이 테스트 프로세스 pid로 만들어 살아 있다 */
describe('peer CLI --here', () => {
  let dir: string;
  let server: Server;
  let seen: { op: string; [k: string]: unknown }[];
  let replies: Record<string, (req: { op: string; [k: string]: unknown }) => unknown>;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['GESTALT_PEER_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID'];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pcli-'));
    const cfg = join(dir, 'cfg');
    mkdirSync(join(cfg, 'sessions'), { recursive: true });
    mkdirSync(join(cfg, 'projects', '-proj'), { recursive: true });
    writeFileSync(
      join(cfg, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'sess-here', cwd: '/proj' }),
    );
    writeFileSync(join(cfg, 'projects', '-proj', 'sess-here.jsonl'), '');
    for (const k of ENV) saved[k] = process.env[k];
    process.env['GESTALT_PEER_HOME'] = dir;
    process.env['CLAUDE_CONFIG_DIR'] = cfg;
    process.env['CLAUDE_PID'] = String(process.pid);
    delete process.env['CLAUDE_CODE_SESSION_ID'];
    seen = [];
    replies = {
      shares: () => ({
        ok: true,
        result: [
          { id: 'shAAAAAA', sessionId: 'sess-here' },
          { id: 'shBBBBBB', sessionId: 'other' },
          { id: 'shCCCCCC', sessionId: 'sess-here' },
        ],
      }),
      unshare: (req) => ({ ok: true, result: { id: req['id'] } }),
      approve: (req) => ({
        ok: true,
        result: { person: req['person'], shares: req['shares'], count: 1 },
      }),
      share: (req) => ({
        ok: true,
        result: {
          id: 'shNEW001',
          format: 'claude',
          expiresAt: 0,
          url: 'u',
          sessionId: req['sessionId'],
        },
      }),
      send: () => ({ ok: true, result: { id: 'm_AAAAAAAAAAAAAAAA', status: 'sent' } }),
    };
    server = createServer((c) => {
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl)) as { op: string };
        seen.push(req);
        const reply = replies[req.op]?.(req) ?? { ok: false, error: `모르는 요청 ${req.op}` };
        c.end(JSON.stringify(reply) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(join(dir, 'peer.sock'), () => r()));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('share --here는 이 세션 id와 대화 기록 경로로 공유를 연다', async () => {
    await peerShareCommand({ here: true, json: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: 'share', sessionId: 'sess-here' });
    expect(String(seen[0]!['transcriptPath'])).toMatch(/sess-here\.jsonl$/);
  });

  it('세션 밖이면 --here가 실패하고 --session과 같이 주면 거절한다', async () => {
    delete process.env['CLAUDE_PID'];
    await expect(peerShareCommand({ here: true })).rejects.toThrow('exit 1');
    await expect(peerShareCommand({ here: true, session: 'x' })).rejects.toThrow('exit 1');
    expect(seen).toEqual([]);
  });

  it('unshare --here는 이 세션 공유만 닫고 실패를 모아 알린다', async () => {
    replies['unshare'] = (req) =>
      req['id'] === 'shCCCCCC'
        ? { ok: false, error: '열린 공유가 아니에요\n가짜 줄' }
        : { ok: true, result: { id: req['id'] } };
    await peerUnshareCommand({ here: true, json: true });
    expect(seen.filter((r) => r.op === 'unshare').map((r) => r['id'])).toEqual([
      'shAAAAAA',
      'shCCCCCC',
    ]);
    expect(process.exitCode).toBe(1);
    const out = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as {
      closed: { id: string }[];
      failed: { id: string; error: string }[];
    };
    expect(out.closed.map((c) => c.id)).toEqual(['shAAAAAA']);
    expect(out.failed).toEqual([{ id: 'shCCCCCC', error: '열린 공유가 아니에요 가짜 줄' }]);
  });

  it('approve --here는 이 세션 공유만 shares로 넘기고 --share와 같이 주면 거절한다', async () => {
    await peerApproveCommand({ name: 'alice', here: true, json: true });
    expect(seen.at(-1)).toEqual({
      op: 'approve',
      person: 'alice',
      shares: ['shAAAAAA', 'shCCCCCC'],
    });
    seen.length = 0;
    await expect(
      peerApproveCommand({ name: 'alice', here: true, share: 'shAAAAAA' }),
    ).rejects.toThrow('exit 1');
    expect(seen).toEqual([]);
  });

  it('이 세션으로 연 공유가 없으면 통제 명령을 보내지 않는다', async () => {
    replies['shares'] = () => ({ ok: true, result: [{ id: 'shBBBBBB', sessionId: 'other' }] });
    await expect(peerKickCommand({ name: 'alice', here: true })).rejects.toThrow('exit 1');
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      '이 세션으로 연 공유가 없어요',
    );
    expect(seen.map((r) => r.op)).toEqual(['shares']);
  });

  it('에이전트 세션에서 친 send는 에이전트 메시지로 보내고 밖에서 친 건 사람 메시지다', async () => {
    await peerSendCommand({ watch: 'wAAAAAAA', body: ['안녕'], json: true });
    expect(seen.at(-1)).toMatchObject({ op: 'send', origin: 'agent' });
    delete process.env['CLAUDE_PID'];
    await peerSendCommand({ watch: 'wAAAAAAA', body: ['안녕'], json: true });
    expect(seen.at(-1)).not.toHaveProperty('origin');
  });
});
