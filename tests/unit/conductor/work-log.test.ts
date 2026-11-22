import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConductorWebServer } from '../../../src/conductor-web/server.js';
import { updateWorkerInfo } from '../../../src/conductor/activity.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Worker } from '../../../src/conductor/types.js';
import {
  orderWork,
  readWorkSummary,
  saveFinishedSummaries,
} from '../../../src/conductor/work-log.js';
import { cleanupStateDirs, order, tempStateDir } from './fixtures.js';

const servers: ConductorWebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  cleanupStateDirs();
});

const CWD = '/work/repo';
const T0 = Date.parse('2026-11-20T10:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const SECRET = '파일 본문 비밀';
const LONG = 'pnpm vitest run ' + 'x'.repeat(200);

function rows(sec: number): object[] {
  return [
    { type: 'user', timestamp: at(sec), message: { role: 'user', content: '프롬프트 비밀' } },
    {
      type: 'assistant',
      timestamp: at(sec + 1),
      message: { role: 'assistant', content: [{ type: 'text', text: '테스트부터 돌려 볼게요' }] },
    },
    {
      type: 'assistant',
      timestamp: at(sec + 2),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${sec}`, name: 'Bash', input: { command: LONG } }],
      },
    },
    {
      type: 'user',
      timestamp: at(sec + 3),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${sec}`, content: SECRET }],
      },
    },
  ];
}

function writeTranscript(root: string, name: string, sec: number): string {
  const dir = join(root, CWD.replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(
    file,
    rows(sec)
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  return file;
}

function worker(id: string, orderId: string, attempt: number, sec: number, status: string): Worker {
  return {
    id,
    orderId,
    kind: 'git-worktree',
    agent: 'claude',
    handle: CWD,
    spawnedBy: 'conductor',
    status,
    attempt,
    startedAt: at(sec),
    lastSeenAt: at(sec),
  } as Worker;
}

describe('끝난 워커의 타임라인 요약', () => {
  it('끝난 워커만 한 번 저장하고 0600에 명령 앞부분만 남긴다', () => {
    const stateDir = tempStateDir();
    const roots = [join(tempStateDir(), 'projects')];
    writeTranscript(roots[0]!, 'sess-1', 0);
    const done = worker('wrk-done', 'ord-1', 1, 0, 'finished');
    const live = worker('wrk-live', 'ord-2', 1, 0, 'running');
    const untracked = worker('wrk-old', 'ord-3', 1, 0, 'finished');
    updateWorkerInfo(stateDir, done.id, { worktreePath: CWD, changedFiles: ['a.ts'] });
    updateWorkerInfo(stateDir, live.id, { worktreePath: CWD });

    const saved = saveFinishedSummaries(stateDir, [done, live, untracked], { now: at(60), roots });
    expect(saved).toEqual(['wrk-done']);
    const file = join(stateDir, 'activity', 'wrk-done.summary.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('프롬프트 비밀');
    expect(raw).not.toContain('테스트부터');
    const s = readWorkSummary(stateDir, 'wrk-done')!;
    expect(s.timeline).toHaveLength(1);
    expect(s.timeline[0]!.tool).toBe('Bash');
    expect(s.timeline[0]!.detail.length).toBeLessThanOrEqual(60);
    expect(s.changedFiles).toEqual(['a.ts']);

    expect(saveFinishedSummaries(stateDir, [done], { now: at(120), roots })).toEqual([]);
  });
});

describe('작업 내용 탭', () => {
  it('재개 회차별로 묶고 트랜스크립트가 없으면 저장한 요약으로 그린다', () => {
    const stateDir = tempStateDir();
    const roots = [join(tempStateDir(), 'projects')];
    const first = writeTranscript(roots[0]!, 'sess-1', 0);
    writeTranscript(roots[0]!, 'sess-2', 600);
    const w1 = worker('wrk-1', 'ord-1', 1, 0, 'stopped');
    const w2 = worker('wrk-2', 'ord-1', 2, 600, 'running');
    updateWorkerInfo(stateDir, w1.id, { worktreePath: CWD });
    updateWorkerInfo(stateDir, w2.id, { worktreePath: CWD });
    saveFinishedSummaries(stateDir, [w1, w2], {
      now: at(700),
      roots,
      nextStartOf: (w) => (w.id === 'wrk-1' ? w2.startedAt : undefined),
    });

    const cache = new Map();
    const live = orderWork(stateDir, [w2, w1], cache, { roots });
    expect(live.live).toBe(true);
    expect(live.sections.map((s) => [s.attempt, s.source])).toEqual([
      [1, 'transcript'],
      [2, 'transcript'],
    ]);
    expect(live.sections[0]!.texts.map((t) => t.text)).toEqual(['테스트부터 돌려 볼게요']);
    expect(live.sections[0]!.timeline[0]!.at).toBe(at(2));
    expect(live.sections[1]!.timeline[0]!.at).toBe(at(602));
    expect(JSON.stringify(live)).not.toContain(SECRET);

    rmSync(first);
    const after = orderWork(stateDir, [w1, { ...w2, status: 'finished' }], new Map(), { roots });
    expect(after.sections[0]!.source).toBe('summary');
    expect(after.sections[0]!.texts).toEqual([]);
    expect(after.live).toBe(false);
  });

  it('/api/orders/:id/work는 주문 id로만 고르고 경로를 싣지 않는다', async () => {
    const stateDir = tempStateDir();
    const roots = [join(tempStateDir(), 'projects')];
    writeTranscript(roots[0]!, 'sess-1', 0);
    const o = order({ id: 'ord-aaaaaaaa' });
    const store = ConductorStore.open(stateDir);
    store.addOrder(o);
    store.startWorker(worker('wrk-1', o.id, 1, 0, 'running'));
    updateWorkerInfo(stateDir, 'wrk-1', { worktreePath: CWD });
    const server = new ConductorWebServer({ stateDir, transcriptRoots: roots });
    servers.push(server);
    await server.start(0);
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/api/orders/${o.id}/work`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body).sections[0].source).toBe('transcript');
    expect(body).not.toContain('.jsonl');
    expect(body).not.toContain(SECRET);
    expect((await fetch(`${base}/api/orders/ord-nope/work`)).status).toBe(404);
    expect(
      (
        await fetch(`${base}/api/orders/${o.id}/work`, {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });
});
