import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePeer, sessionPids } from '../../../src/mcp/tools/peer.js';
import { PEER_ACTIONS, peerInputSchema } from '../../../src/mcp/schemas.js';

describe('ges_peer ask_user', () => {
  let dir: string;
  let cfg: string;
  let sock: string;
  let server: Server;
  let seen: unknown[];
  let reply: unknown;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-peer-'));
    cfg = join(dir, 'cfg');
    mkdirSync(join(cfg, 'sessions'), { recursive: true });
    writeFileSync(
      join(cfg, 'sessions', '777.json'),
      JSON.stringify({ pid: 777, sessionId: 'sess-abc', cwd: '/proj' }),
    );
    sock = join(dir, 'peer.sock');
    seen = [];
    reply = {
      ok: true,
      result: { question: 'q_AAAAAAAAAAAAAAAA', to: ['alice'], shares: ['s1'], expiresAt: 1 },
    };
    server = createServer((c) => {
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        seen.push(JSON.parse(buf.slice(0, nl)));
        c.end(JSON.stringify(reply) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('부모 세션 id를 찾아 데몬에 질문을 넘기고 바로 돌아온다', async () => {
    const out = JSON.parse(
      await handlePeer(
        { action: 'ask_user', question: '이름 바꿔도 돼요?', to: 'alice', timeoutSecs: 120 },
        { pids: [1, 777], configDir: cfg, socket: sock },
      ),
    ) as Record<string, unknown>;
    expect(seen).toEqual([
      {
        op: 'ask',
        sessionId: 'sess-abc',
        question: '이름 바꿔도 돼요?',
        to: 'alice',
        timeoutSecs: 120,
      },
    ]);
    expect(out).toMatchObject({ question: 'q_AAAAAAAAAAAAAAAA', to: ['alice'] });
    expect(out['note']).toContain('<peer-answer');
  });

  it('데몬 거절은 error로 돌려준다', async () => {
    reply = { ok: false, error: '지금 이 세션을 보는 팀원이 없어요' };
    const out = JSON.parse(
      await handlePeer(
        { action: 'ask_user', question: '누구 있어요?' },
        { pids: [777], configDir: cfg, socket: sock },
      ),
    ) as { error: string };
    expect(out.error).toBe('지금 이 세션을 보는 팀원이 없어요');
  });

  it('부모 세션을 못 찾거나 데몬이 없으면 이유를 돌려준다', async () => {
    const noSession = JSON.parse(
      await handlePeer(
        { action: 'ask_user', question: '?' },
        { pids: [1], configDir: cfg, socket: sock },
      ),
    ) as { error: string };
    expect(noSession.error).toContain('세션을 못 찾았어요');
    const noDaemon = JSON.parse(
      await handlePeer(
        { action: 'ask_user', question: '?' },
        { pids: [777], configDir: cfg, socket: join(dir, 'missing.sock') },
      ),
    ) as { error: string };
    expect(noDaemon.error).toContain('gestalt peer daemon');
    expect(seen).toEqual([]);
  });

  it('pid 후보는 CLAUDE_PID, 부모 순이다', () => {
    const pids = sessionPids({ CLAUDE_PID: '424242' });
    expect(pids[0]).toBe(424242);
    expect(pids[1]).toBe(process.ppid);
  });

  it('공유 통제 action은 스키마가 받지 않는다', () => {
    expect(PEER_ACTIONS).toEqual(['ask_user']);
    for (const action of ['share', 'kick', 'approve', 'send']) {
      expect(peerInputSchema.safeParse({ action, question: 'x' }).success).toBe(false);
    }
    expect(peerInputSchema.safeParse({ action: 'ask_user', question: 'x' }).success).toBe(true);
  });
});
