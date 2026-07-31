import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveSessionId,
  resolveStatusSessionId,
  resolveInterviewSessionId,
  type SessionRef,
  type SelectorDeps,
} from '../../../src/mcp/session-selector.js';
import { handleStatus } from '../../../src/mcp/tools/status.js';
import { EventStore } from '../../../src/events/store.js';
import type { InterviewEngine } from '../../../src/interview/engine.js';
import type { InterviewSession } from '../../../src/core/types.js';
import type { StatusInput } from '../../../src/mcp/schemas.js';

interface TestSession extends SessionRef {
  createdAt: string;
}

/**
 * `list()`가 내놓는 createdAt 내림차순 순서를 흉내낸 목록.
 * updatedAt 최신(b-middle)은 목록 첫 항목도, createdAt 최신도 아니다 —
 * createdAt 정렬이나 목록 순서를 잘못 쓰면 반드시 틀린 답이 나온다.
 */
const MIXED_INTERVIEW: TestSession[] = [
  {
    sessionId: 'iv-c-newest-created',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
  },
  {
    sessionId: 'iv-b-middle',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  },
  {
    sessionId: 'iv-a-oldest-created',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  },
];

const MIXED_EXECUTE: TestSession[] = [
  {
    sessionId: 'ex-c-newest-created',
    createdAt: '2026-03-05T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
  },
  {
    sessionId: 'ex-b-middle',
    createdAt: '2026-02-05T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    sessionId: 'ex-a-oldest-created',
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-04-05T00:00:00.000Z',
  },
];

function bothKinds(cwd?: string): SelectorDeps {
  return {
    listInterviewSessions: () => MIXED_INTERVIEW,
    listExecuteSessions: () => MIXED_EXECUTE,
    cwd,
  };
}

/** active 해석은 process.cwd() 폴백이 있으므로 테스트는 항상 임시 cwd를 명시한다. */
function makeTempCwd(): string {
  return mkdtempSync(join(tmpdir(), `gestalt-selector-${randomUUID()}-`));
}

function writeActiveSessionFile(cwd: string, sessionId: unknown): void {
  const dir = join(cwd, '.gestalt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'active-session.json'),
    JSON.stringify({ sessionId, specId: 'spec-1', updatedAt: '2026-07-01T00:00:00.000Z' }),
    'utf-8',
  );
}

describe('session-selector — UUID passthrough (회귀 고정)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UUID는 셀렉터 해석 없이 그대로 통과한다 (execute)', () => {
    const cwd = makeTempCwd();
    tempDirs.push(cwd);
    const uuid = randomUUID();
    const result = resolveSessionId(uuid, 'execute', bothKinds(cwd));

    expect(result).toEqual({ ok: true, sessionId: uuid });
  });

  it('UUID는 셀렉터 해석 없이 그대로 통과한다 (interview)', () => {
    const uuid = randomUUID();
    const result = resolveSessionId(uuid, 'interview', bothKinds());

    expect(result).toEqual({ ok: true, sessionId: uuid });
  });

  it('세션 목록이 비어 있어도 UUID는 통과한다 — 존재 검증은 셀렉터 책임이 아니다', () => {
    const uuid = randomUUID();
    const result = resolveSessionId(uuid, 'execute', {});

    expect(result).toEqual({ ok: true, sessionId: uuid });
  });

  it('대문자가 섞인 입력도 원문 그대로 반환한다 (소문자화하지 않음)', () => {
    const mixedCase = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
    const result = resolveSessionId(mixedCase, 'execute', bothKinds());

    expect(result).toEqual({ ok: true, sessionId: mixedCase });
  });

  it('셀렉터 단어를 포함하기만 한 값은 셀렉터가 아니다', () => {
    for (const input of ['active-session', 'latest-run', 'my-latest', 'activeX']) {
      expect(resolveSessionId(input, 'execute', bothKinds())).toEqual({
        ok: true,
        sessionId: input,
      });
    }
  });
});

describe('session-selector — latest는 updatedAt 기준', () => {
  it('목록 첫 항목이나 createdAt 최신이 아니라 updatedAt 최신을 고른다 (interview)', () => {
    const result = resolveSessionId('latest', 'interview', bothKinds());

    expect(result).toEqual({ ok: true, sessionId: 'iv-b-middle' });
    // 잘못된 기준으로 골랐을 때 나오는 값들
    expect(result).not.toEqual({ ok: true, sessionId: MIXED_INTERVIEW[0]!.sessionId });
    expect(result).not.toEqual({ ok: true, sessionId: 'iv-c-newest-created' });
  });

  it('목록 순서를 뒤집어도 같은 세션을 고른다 — 순서 의존이 없음', () => {
    const reversed = [...MIXED_INTERVIEW].reverse();
    const result = resolveSessionId('latest', 'interview', {
      listInterviewSessions: () => reversed,
    });

    expect(result).toEqual({ ok: true, sessionId: 'iv-b-middle' });
  });

  it('실행 세션도 updatedAt 최신을 고른다', () => {
    const result = resolveSessionId('latest', 'execute', bothKinds());

    expect(result).toEqual({ ok: true, sessionId: 'ex-b-middle' });
  });

  it('세션이 하나면 그 세션을 고른다', () => {
    const only = MIXED_INTERVIEW[2]!;
    const result = resolveSessionId('latest', 'interview', {
      listInterviewSessions: () => [only],
    });

    expect(result).toEqual({ ok: true, sessionId: only.sessionId });
  });
});

describe('session-selector — latest는 종류를 섞지 않는다', () => {
  it('인터뷰와 실행이 함께 있어도 각각 자기 종류에서 고른다', () => {
    const deps = bothKinds();

    expect(resolveSessionId('latest', 'interview', deps)).toEqual({
      ok: true,
      sessionId: 'iv-b-middle',
    });
    expect(resolveSessionId('latest', 'execute', deps)).toEqual({
      ok: true,
      sessionId: 'ex-b-middle',
    });
  });

  it('다른 종류가 전역 최신이어도 자기 종류에서만 고른다', () => {
    // 실행 세션이 전체 중 가장 최근이지만 interview latest는 인터뷰에서 골라야 한다
    const deps: SelectorDeps = {
      listInterviewSessions: () => [
        { sessionId: 'iv-only', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
      listExecuteSessions: () => [
        { sessionId: 'ex-newest-overall', updatedAt: '2026-12-31T00:00:00.000Z' },
      ],
    };

    expect(resolveSessionId('latest', 'interview', deps)).toEqual({
      ok: true,
      sessionId: 'iv-only',
    });
    expect(resolveSessionId('latest', 'execute', deps)).toEqual({
      ok: true,
      sessionId: 'ex-newest-overall',
    });
  });

  it('인터뷰가 비어 있고 실행만 있으면 interview latest는 에러 — 실행으로 넘어가지 않는다', () => {
    const result = resolveSessionId('latest', 'interview', {
      listInterviewSessions: () => [],
      listExecuteSessions: () => MIXED_EXECUTE,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('인터뷰 세션이 없습니다');
  });
});

describe('session-selector — latest 세션 없음 에러는 다음 행동을 담는다', () => {
  it('인터뷰 0건이면 ges_interview action=start를 안내한다', () => {
    const result = resolveSessionId('latest', 'interview', { listInterviewSessions: () => [] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_interview');
    expect(result.error).toContain('action=start');
  });

  it('실행 0건이면 ges_execute action=start를 안내한다', () => {
    const result = resolveSessionId('latest', 'execute', { listExecuteSessions: () => [] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_execute');
    expect(result.error).toContain('action=start');
  });

  it('목록 함수 자체가 없어도 던지지 않고 안내 에러를 낸다', () => {
    const result = resolveSessionId('latest', 'execute', {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_execute');
  });
});

describe('session-selector — active는 실행 전용', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempCwd();
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it('인터뷰 kind에 active를 넣으면 latest를 쓰라는 에러', () => {
    writeActiveSessionFile(cwd, 'ex-active');
    const result = resolveSessionId('active', 'interview', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('latest');
    expect(result.error).toContain('UUID');
    expect(result.error).toContain('실행 세션');
  });

  it('활성 세션 파일이 있어도 인터뷰는 그 값으로 해석되지 않는다', () => {
    writeActiveSessionFile(cwd, 'ex-active');
    const result = resolveSessionId('active', 'interview', bothKinds(cwd));

    expect(result).not.toEqual({ ok: true, sessionId: 'ex-active' });
    // 조용히 latest로 바꿔치기하지도 않는다
    expect(result).not.toEqual({ ok: true, sessionId: 'iv-b-middle' });
  });

  it('.gestalt/active-session.json의 sessionId로 해석된다', () => {
    writeActiveSessionFile(cwd, 'ex-active-from-file');
    const result = resolveSessionId('active', 'execute', bothKinds(cwd));

    expect(result).toEqual({ ok: true, sessionId: 'ex-active-from-file' });
  });

  it('active는 latest와 다른 값을 낸다 — 파일을 실제로 읽는다', () => {
    writeActiveSessionFile(cwd, 'ex-active-from-file');

    expect(resolveSessionId('active', 'execute', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'ex-active-from-file',
    });
    expect(resolveSessionId('latest', 'execute', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'ex-b-middle',
    });
  });

  it('활성 세션 파일이 없으면 다음 행동을 담은 에러', () => {
    const result = resolveSessionId('active', 'execute', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_execute');
    expect(result.error).toContain('action=start');
    expect(result.error).toContain('UUID');
  });

  it('JSON이 깨져 있으면 활성 세션 없음으로 다룬다', () => {
    mkdirSync(join(cwd, '.gestalt'), { recursive: true });
    writeFileSync(join(cwd, '.gestalt', 'active-session.json'), '{not json', 'utf-8');

    const result = resolveSessionId('active', 'execute', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('활성 실행 세션이 없습니다');
  });

  it('sessionId가 빠진 파일도 활성 세션 없음으로 다룬다', () => {
    mkdirSync(join(cwd, '.gestalt'), { recursive: true });
    writeFileSync(
      join(cwd, '.gestalt', 'active-session.json'),
      JSON.stringify({ specId: 'spec-1' }),
      'utf-8',
    );

    const result = resolveSessionId('active', 'execute', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('활성 실행 세션이 없습니다');
  });
});

describe('session-selector — 대소문자·공백 정규화', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempCwd();
    writeActiveSessionFile(cwd, 'ex-active-from-file');
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it('ACTIVE / Active / 공백 포함 모두 셀렉터로 인식한다', () => {
    for (const input of ['ACTIVE', 'Active', ' active ', '  ACTIVE\t']) {
      expect(resolveSessionId(input, 'execute', bothKinds(cwd))).toEqual({
        ok: true,
        sessionId: 'ex-active-from-file',
      });
    }
  });

  it('Latest / LATEST / 공백 포함 모두 셀렉터로 인식한다', () => {
    for (const input of ['Latest', 'LATEST', ' latest ', '  LaTeSt \n']) {
      expect(resolveSessionId(input, 'interview', bothKinds(cwd))).toEqual({
        ok: true,
        sessionId: 'iv-b-middle',
      });
    }
  });

  it('대소문자 다른 ACTIVE도 인터뷰에서는 거절된다', () => {
    const result = resolveSessionId('ACTIVE', 'interview', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('latest');
  });
});

describe('resolveStatusSessionId — sessionType별 해석', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempCwd();
  });

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  it('UUID는 sessionType 무관하게 그대로 통과한다', () => {
    const uuid = randomUUID();
    for (const type of ['interview', 'execute', 'all'] as const) {
      expect(resolveStatusSessionId(uuid, type, bothKinds(cwd))).toEqual({
        ok: true,
        sessionId: uuid,
      });
    }
  });

  it("sessionType='interview' + latest는 인터뷰에서 고른다", () => {
    expect(resolveStatusSessionId('latest', 'interview', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'iv-b-middle',
    });
  });

  it("sessionType='execute' + latest는 실행에서 고른다", () => {
    expect(resolveStatusSessionId('latest', 'execute', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'ex-b-middle',
    });
  });

  it("sessionType='interview' + active는 에러", () => {
    writeActiveSessionFile(cwd, 'ex-active-from-file');
    const result = resolveStatusSessionId('active', 'interview', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('latest');
  });

  it("sessionType='all' + active는 실행 세션으로 해석한다", () => {
    writeActiveSessionFile(cwd, 'ex-active-from-file');

    expect(resolveStatusSessionId('active', 'all', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'ex-active-from-file',
    });
  });

  it("sessionType='all' + latest는 인터뷰가 더 최근이면 인터뷰를 고른다", () => {
    // iv-b-middle(2026-06-01) > ex-b-middle(2026-05-01)
    expect(resolveStatusSessionId('latest', 'all', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'iv-b-middle',
    });
  });

  it("sessionType='all' + latest는 실행이 더 최근이면 실행을 고른다", () => {
    const deps: SelectorDeps = {
      listInterviewSessions: () => MIXED_INTERVIEW,
      listExecuteSessions: () => [
        ...MIXED_EXECUTE,
        { sessionId: 'ex-newest-overall', updatedAt: '2026-12-31T00:00:00.000Z' },
      ],
      cwd,
    };

    expect(resolveStatusSessionId('latest', 'all', deps)).toEqual({
      ok: true,
      sessionId: 'ex-newest-overall',
    });
  });

  it("sessionType='all' + latest는 한쪽이 비어도 다른 쪽에서 고른다", () => {
    expect(
      resolveStatusSessionId('latest', 'all', {
        listInterviewSessions: () => [],
        listExecuteSessions: () => MIXED_EXECUTE,
        cwd,
      }),
    ).toEqual({ ok: true, sessionId: 'ex-b-middle' });

    expect(
      resolveStatusSessionId('latest', 'all', {
        listInterviewSessions: () => MIXED_INTERVIEW,
        listExecuteSessions: () => [],
        cwd,
      }),
    ).toEqual({ ok: true, sessionId: 'iv-b-middle' });
  });

  it("sessionType='all' + latest에 세션이 하나도 없으면 두 시작 명령을 함께 안내한다", () => {
    const result = resolveStatusSessionId('latest', 'all', {
      listInterviewSessions: () => [],
      listExecuteSessions: () => [],
      cwd,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_interview');
    expect(result.error).toContain('ges_execute');
  });

  it("sessionType='all' + active에 파일이 없으면 다음 행동을 담은 에러", () => {
    const result = resolveStatusSessionId('active', 'all', bothKinds(cwd));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_execute');
  });

  it('대소문자·공백 정규화가 status 경로에서도 동작한다', () => {
    expect(resolveStatusSessionId(' LATEST ', 'all', bothKinds(cwd))).toEqual({
      ok: true,
      sessionId: 'iv-b-middle',
    });
  });
});

describe('resolveInterviewSessionId — 인터뷰 도구용 래퍼', () => {
  const engine = { listSessions: () => MIXED_INTERVIEW };

  it('sessionId가 없으면 그대로 통과시켜 액션별 필수값 검사를 남긴다', () => {
    expect(resolveInterviewSessionId(engine, undefined)).toEqual({
      ok: true,
      sessionId: undefined,
    });
  });

  it('UUID는 그대로 통과한다', () => {
    const uuid = randomUUID();
    expect(resolveInterviewSessionId(engine, uuid)).toEqual({ ok: true, sessionId: uuid });
  });

  it('latest는 엔진 목록의 updatedAt 최신으로 해석된다', () => {
    expect(resolveInterviewSessionId(engine, 'latest')).toEqual({
      ok: true,
      sessionId: 'iv-b-middle',
    });
  });

  it('Latest 대소문자도 인식한다', () => {
    expect(resolveInterviewSessionId(engine, 'Latest')).toEqual({
      ok: true,
      sessionId: 'iv-b-middle',
    });
  });

  it('active는 거절되고 latest를 쓰라고 안내한다', () => {
    const result = resolveInterviewSessionId(engine, 'active');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('latest');
    expect(result.error).toContain('실행 세션');
  });

  it('세션이 없으면 ges_interview action=start를 안내한다', () => {
    const result = resolveInterviewSessionId({ listSessions: () => [] }, 'latest');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ges_interview');
  });
});

describe('handleStatus — 셀렉터 배선', () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = `.gestalt-test/session-selector-${randomUUID()}.db`;
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (existsSync(file)) rmSync(file);
    }
  });

  function fakeSession(sessionId: string, createdAt: string, updatedAt: string): InterviewSession {
    return {
      sessionId,
      topic: `topic-${sessionId}`,
      projectType: 'web',
      status: 'in_progress',
      rounds: [],
      createdAt,
      updatedAt,
    } as unknown as InterviewSession;
  }

  function fakeEngine(sessions: InterviewSession[]): InterviewEngine {
    return {
      listSessions: () => sessions,
      getSession: (id: string) => {
        const found = sessions.find((s) => s.sessionId === id);
        if (!found) throw new Error(`Session not found: ${id}`);
        return found;
      },
    } as unknown as InterviewEngine;
  }

  const mixedSessions = [
    fakeSession('iv-c-newest-created', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
    fakeSession('iv-b-middle', '2026-02-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
    fakeSession('iv-a-oldest-created', '2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
  ];

  it("sessionType='interview' + latest가 updatedAt 최신 세션을 조회한다", () => {
    const input: StatusInput = { sessionId: 'latest', sessionType: 'interview' };
    const result = JSON.parse(handleStatus(fakeEngine(mixedSessions), input, store));

    expect(result.type).toBe('interview');
    expect(result.session.sessionId).toBe('iv-b-middle');
  });

  it('UUID 조회 경로는 그대로 동작한다 (회귀)', () => {
    const uuid = randomUUID();
    const sessions = [fakeSession(uuid, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')];
    const input: StatusInput = { sessionId: uuid, sessionType: 'interview' };
    const result = JSON.parse(handleStatus(fakeEngine(sessions), input, store));

    expect(result.type).toBe('interview');
    expect(result.session.sessionId).toBe(uuid);
  });

  it("sessionType='interview' + active는 안내 에러를 반환한다", () => {
    const input: StatusInput = { sessionId: 'active', sessionType: 'interview' };
    const result = JSON.parse(handleStatus(fakeEngine(mixedSessions), input, store));

    expect(result.error).toContain('latest');
    expect(result.session).toBeUndefined();
  });

  it("sessionType='execute' + latest에 실행 세션이 없으면 ges_execute를 안내한다", () => {
    const input: StatusInput = { sessionId: 'latest', sessionType: 'execute' };
    const result = JSON.parse(handleStatus(fakeEngine([]), input, store));

    expect(result.error).toContain('ges_execute');
    expect(result.error).toContain('action=start');
  });

  it('sessionId를 안 주면 셀렉터 해석 없이 목록 모드로 동작한다 (회귀)', () => {
    const input: StatusInput = { sessionType: 'all' };
    const result = JSON.parse(handleStatus(fakeEngine(mixedSessions), input, store));

    expect(result.total.interview).toBe(3);
    expect(result.error).toBeUndefined();
  });
});
