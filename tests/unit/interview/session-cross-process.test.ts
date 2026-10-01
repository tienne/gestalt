import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../../../src/interview/session.js';
import { InterviewSessionRepository } from '../../../src/interview/repository.js';
import { EventStore } from '../../../src/events/store.js';
import { GestaltPrinciple } from '../../../src/core/types.js';
import { SessionNotFoundError } from '../../../src/core/errors.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// MCP 프로세스 둘이 같은 DB를 쓰는 상황을 연결 두 개로 흉내 낸다
describe('SessionManager — 같은 DB를 쓰는 두 인스턴스', () => {
  let dbPath: string;
  let storeA: EventStore;
  let storeB: EventStore;
  let a: SessionManager;
  let b: SessionManager;

  beforeEach(() => {
    dbPath = `.gestalt-test/interview-cross-${randomUUID()}.db`;
    storeA = new EventStore(dbPath);
    storeB = new EventStore(dbPath);
    a = new SessionManager(storeA);
    b = new SessionManager(storeB);
    a.loadFromStore();
    b.loadFromStore();
  });

  afterEach(() => {
    storeA.close();
    storeB.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('다른 인스턴스가 기동 뒤에 만든 세션을 찾는다', () => {
    const created = a.create('topic', 'greenfield');

    const found = b.get(created.sessionId);
    expect(found.topic).toBe('topic');
  });

  it('없는 세션은 여전히 NotFound다', () => {
    expect(() => b.get('missing')).toThrow(SessionNotFoundError);
  });

  it('다른 인스턴스가 덧붙인 이벤트를 쓰기 전에 반영한다', () => {
    const { sessionId } = a.create('topic', 'greenfield');
    b.get(sessionId); // b 캐시에 라운드 0개 상태로 올라간다

    a.addQuestion(sessionId, 'Q1', GestaltPrinciple.CLOSURE);
    a.recordResponse(sessionId, 'A1');

    // 낡은 캐시 위에 썼다면 roundNumber가 1로 겹친다
    const round = b.addQuestion(sessionId, 'Q2', GestaltPrinciple.PROXIMITY);
    expect(round.roundNumber).toBe(2);
    expect(a.get(sessionId).rounds.map((r) => r.question)).toEqual(['Q1', 'Q2']);
  });

  it('TTL로 캐시에서 지운 세션도 get()이 다시 찾는다', () => {
    const { sessionId } = a.create('topic', 'greenfield');
    expect(a.cleanup(-1)).toBe(1);

    expect(a.get(sessionId).sessionId).toBe(sessionId);
  });

  it('compressedContext와 abort가 재시작 뒤에도 남는다', () => {
    const { sessionId } = a.create('topic', 'greenfield');
    const compressedContext = {
      summary: 'summary',
      compressedAt: new Date().toISOString(),
      roundsCompressed: 3,
    };
    a.setCompressedContext(sessionId, compressedContext);
    a.abort(sessionId);

    const restarted = new SessionManager(storeB);
    restarted.loadFromStore();
    const session = restarted.get(sessionId);
    expect(session.compressedContext).toEqual(compressedContext);
    expect(session.status).toBe('aborted');
  });

  it('getLatest는 삽입 순서가 아니라 마지막 활동 기준으로 고른다', async () => {
    const first = a.create('first', 'greenfield');
    await new Promise((r) => setTimeout(r, 5));
    a.create('second', 'greenfield');
    await new Promise((r) => setTimeout(r, 5));
    a.addQuestion(first.sessionId, 'Q1', GestaltPrinciple.CLOSURE);

    expect(a.getLatest()?.sessionId).toBe(first.sessionId);
  });

  it('캐시가 최신이면 get()이 replay하지 않고 다른 인스턴스가 쓰면 한 번 replay한다', () => {
    const { sessionId } = a.create('topic', 'greenfield');
    a.complete(sessionId, { force: true });
    const replay = vi.spyOn(storeA, 'replay');

    a.get(sessionId);
    a.get(sessionId);
    expect(replay).not.toHaveBeenCalled();

    b.abort(sessionId);
    a.get(sessionId);
    a.get(sessionId);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('라운드 시각을 찍는 사이 밀리초가 넘어가도 replay한 라운드와 같다', () => {
    // toISOString을 부를 때마다 1ms씩 흐르게 해서 경계에 걸리는 상황을 매번 만든다
    const toISOString = Date.prototype.toISOString;
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let tick = 0;
    const spy = vi
      .spyOn(Date.prototype, 'toISOString')
      .mockImplementation(() => toISOString.call(new Date(base + tick++)));
    try {
      const { sessionId } = a.create('topic', 'greenfield');
      a.addQuestion(sessionId, 'Q1', GestaltPrinciple.CLOSURE);

      const replayed = new InterviewSessionRepository(storeB).reconstruct(sessionId)!;
      expect(replayed.rounds).toEqual(a.get(sessionId).rounds);
    } finally {
      spy.mockRestore();
    }
  });

  it('단계마다 라이브 세션과 다른 연결의 replay 결과가 같다', () => {
    const { sessionId } = a.create('topic', 'greenfield');
    const replayed = () => new InterviewSessionRepository(storeB).reconstruct(sessionId)!;
    const expectSame = () => {
      const { createdAt: _c, updatedAt: _u, ...live } = a.get(sessionId);
      const { createdAt: _rc, updatedAt: _ru, ...rest } = replayed();
      expect(rest).toEqual(live);
    };

    a.addQuestion(sessionId, 'Q1', GestaltPrinciple.CLOSURE);
    a.recordResponse(sessionId, 'A1');
    expectSame();

    a.setCompressedContext(sessionId, {
      summary: 's',
      compressedAt: new Date().toISOString(),
      roundsCompressed: 1,
    });
    a.complete(sessionId, { force: true });
    expectSame();
  });
});
