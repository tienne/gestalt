import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orderActivity, updateWorkerInfo } from '../../../src/conductor/activity.js';
import { changedFilesOf, refreshWorkerActivity } from '../../../src/conductor/activity-tick.js';
import { execRunner } from '../../../src/conductor/launcher.js';
import {
  locateWorkerTranscript,
  projectRoots,
  readTranscript,
} from '../../../src/conductor/transcript.js';
import type { Worker } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir } from './fixtures.js';

afterEach(() => cleanupStateDirs());

const CWD = '/work/repo';
const T0 = Date.parse('2026-11-20T10:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function toolUse(id: string, name: string, input: object, sec: number, extra: object = {}) {
  return {
    type: 'assistant',
    timestamp: at(sec),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], ...extra },
  };
}

function toolResult(
  id: string,
  sec: number,
  content: unknown,
  toolUseResult?: unknown,
  isError = false,
) {
  return {
    type: 'user',
    timestamp: at(sec),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
  };
}

function userText(text: string, sec: number) {
  return { type: 'user', timestamp: at(sec), message: { role: 'user', content: text } };
}

function endTurn(sec: number) {
  return {
    type: 'assistant',
    timestamp: at(sec),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '끝' }],
      stop_reason: 'end_turn',
    },
  };
}

function writeRows(file: string, rows: object[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function transcriptFile(dir: string, name = 'session.jsonl'): string {
  return join(dir, name);
}

describe('readTranscript', () => {
  it('tool 호출과 결과를 짝지어 성공 여부와 걸린 시간을 남긴다', () => {
    const f = transcriptFile(tempStateDir());
    writeRows(f, [
      userText('시작', 0),
      toolUse('t1', 'Edit', { file_path: `${CWD}/src/a.ts` }, 1),
      toolResult('t1', 3, 'ok'),
      toolUse('t2', 'Bash', { command: 'pnpm test', description: '테스트 실행' }, 4),
      toolResult('t2', 5, 'boom', undefined, true),
    ]);
    const s = readTranscript(f, undefined, { cwd: CWD });
    expect(s.digest.timeline.map((t) => [t.tool, t.detail, t.ok, t.ms])).toEqual([
      ['Edit', 'src/a.ts', true, 2000],
      ['Bash', '테스트 실행', false, 1000],
    ]);
    expect(s.digest.activity).toEqual({ tool: 'Bash', at: at(4) });
    expect(s.cursor.partial).toBe(false);
  });

  it('다음 읽기는 새 줄만 보고 쓰다 만 줄은 남겨 둔다', () => {
    const f = transcriptFile(tempStateDir());
    writeRows(f, [toolUse('t1', 'Read', { file_path: `${CWD}/a.ts` }, 1)]);
    const first = readTranscript(f, undefined, { cwd: CWD });
    const half = JSON.stringify(toolResult('t1', 2, 'ok'));
    appendFileSync(f, half.slice(0, 20));
    const second = readTranscript(f, first, { cwd: CWD });
    expect(second.cursor.offset).toBe(first.cursor.offset);
    appendFileSync(f, `${half.slice(20)}\n`);
    const third = readTranscript(f, second, { cwd: CWD });
    expect(third.cursor.offset).toBe(statSync(f).size);
    expect(third.digest.timeline[0]!.ok).toBe(true);
  });

  it('읽기 상한을 넘으면 앞을 자르고 partial로 표시한다', () => {
    const f = transcriptFile(tempStateDir());
    const rows = Array.from({ length: 50 }, (_, i) =>
      toolUse(`t${i}`, 'Read', { file_path: `${CWD}/f${i}.ts` }, i),
    );
    writeRows(f, rows);
    const s = readTranscript(f, undefined, { cwd: CWD, readLimit: 2000 });
    expect(s.cursor.partial).toBe(true);
    expect(s.digest.timeline.length).toBeLessThan(50);
    expect(s.digest.timeline.at(-1)!.detail).toBe('f49.ts');
  });

  it('백그라운드 서브에이전트는 완료 알림이 와야 done이다', () => {
    const f = transcriptFile(tempStateDir());
    writeRows(f, [
      toolUse('a1', 'Agent', { description: '조사', run_in_background: true }, 1),
      toolResult('a1', 2, 'Async agent launched', {
        isAsync: true,
        status: 'async_launched',
        agentId: 'x',
      }),
      toolUse('a2', 'Agent', { description: '검토' }, 3),
      toolResult('a2', 9, '결과', { status: 'completed' }),
    ]);
    let s = readTranscript(f, undefined, { cwd: CWD });
    expect(s.digest.subagents.map((a) => [a.name, a.state])).toEqual([
      ['조사', 'detached'],
      ['검토', 'done'],
    ]);
    appendFileSync(
      f,
      JSON.stringify(
        userText(
          '<task-notification><task-id>x</task-id><tool-use-id>a1</tool-use-id><status>completed</status></task-notification>',
          20,
        ),
      ) + '\n',
    );
    s = readTranscript(f, s, { cwd: CWD });
    expect(s.digest.subagents[0]!.state).toBe('done');
  });

  it('todo tool이 없으면 tasks는 null이고 성공한 결과만 목록에 넣는다', () => {
    const f = transcriptFile(tempStateDir());
    writeRows(f, [toolUse('t1', 'Read', { file_path: 'a' }, 1)]);
    expect(readTranscript(f, undefined).digest.tasks).toBeNull();

    const g = transcriptFile(tempStateDir());
    writeRows(g, [
      toolUse('c1', 'TaskCreate', { subject: '리더 만들기' }, 1),
      toolResult('c1', 2, 'Task #1 created successfully: 리더 만들기'),
      toolUse('c2', 'TaskCreate', { subject: '실패한 것' }, 3),
      toolResult('c2', 4, 'error', undefined, true),
      toolUse('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }, 5),
      toolResult('u1', 6, 'Updated task #1 status'),
    ]);
    expect(readTranscript(g, undefined).digest.tasks).toEqual([
      { id: '1', title: '리더 만들기', status: 'completed' },
    ]);
  });

  it('TodoWrite는 목록 전체를 바꾼다', () => {
    const f = transcriptFile(tempStateDir());
    const todos = [
      { content: '하나', status: 'completed' },
      { content: '둘', status: 'in_progress' },
    ];
    writeRows(f, [
      toolUse('w1', 'TodoWrite', { todos }, 1),
      toolResult('w1', 2, 'Todos have been modified successfully', { newTodos: todos }),
    ]);
    expect(readTranscript(f, undefined).digest.tasks?.map((t) => t.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });

  it('백그라운드 gate를 띄우고 턴이 끝나면 그 시각을 남기고 새 턴이 오면 지운다', () => {
    const f = transcriptFile(tempStateDir());
    writeRows(f, [
      toolUse('g1', 'Bash', { command: 'pnpm gate', run_in_background: true }, 1),
      toolResult('g1', 2, 'started'),
      endTurn(3),
    ]);
    let s = readTranscript(f, undefined);
    expect(s.digest.backgroundGate).toEqual({ at: at(1), turnEndedAt: at(3) });
    appendFileSync(f, JSON.stringify(userText('계속', 10)) + '\n');
    s = readTranscript(f, s);
    expect(s.digest.backgroundGate).toBeUndefined();
  });
});

describe('locateWorkerTranscript', () => {
  function rootWith(cwd: string): { root: string; dir: string } {
    const root = resolve(tempStateDir(), 'projects');
    const dir = join(root, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(dir, { recursive: true });
    return { root, dir };
  }

  it('세션 id가 있으면 그 파일을 고른다', () => {
    const { root, dir } = rootWith(CWD);
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    writeRows(join(dir, `${id}.jsonl`), [userText('a', 0)]);
    writeRows(join(dir, 'other.jsonl'), [userText('b', 100)]);
    expect(
      locateWorkerTranscript({ cwd: CWD, startedAt: at(50), sessionId: id, roots: [root] }),
    ).toBe(join(dir, `${id}.jsonl`));
  });

  it('없으면 워커 시작 뒤에 시작한 세션 중 가장 최근에 쓴 파일을 고른다', () => {
    const { root, dir } = rootWith(CWD);
    const before = join(dir, 'before.jsonl');
    const mine = join(dir, 'mine.jsonl');
    const next = join(dir, 'next.jsonl');
    writeRows(before, [userText('a', -3600)]);
    writeRows(mine, [userText('b', 10)]);
    writeRows(next, [userText('c', 7200)]);
    const now = new Date();
    utimesSync(before, now, now);
    utimesSync(mine, now, new Date(now.getTime() - 1000));
    expect(
      locateWorkerTranscript({ cwd: CWD, startedAt: at(0), endedAt: at(3600), roots: [root] }),
    ).toBe(mine);
  });

  it('CLAUDE_CONFIG_DIR와 홈 아래 projects를 둘 다 본다', () => {
    const home = resolve(tempStateDir());
    const cfg = resolve(tempStateDir());
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(cfg, 'projects'), { recursive: true });
    expect(projectRoots({ CLAUDE_CONFIG_DIR: cfg }, home)).toEqual([
      realpathSync(join(cfg, 'projects')),
      realpathSync(join(home, '.claude', 'projects')),
    ]);
  });
});

describe('작업 내용 저장과 status 필드', () => {
  function gitRepo(): string {
    const dir = resolve(tempStateDir());
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'feat');
    writeFileSync(join(dir, 'a.txt'), 'b');
    git('commit', '-qam', 'change');
    writeFileSync(join(dir, 'new.txt'), 'n');
    return dir;
  }

  it('기준 브랜치에서 갈라진 뒤 고친 파일과 새 파일을 모은다', async () => {
    const repo = gitRepo();
    expect(await changedFilesOf(execRunner, repo, 'main')).toEqual({
      files: ['a.txt', 'new.txt'],
      base: 'main',
    });
  });

  it('tick이 저장한 고친 파일을 status가 읽고 Codex 워커는 나머지를 비운다', async () => {
    const stateDir = tempStateDir();
    const repo = gitRepo();
    const o = order({ baseBranch: 'main' });
    const w: Worker = {
      id: 'wrk-codex',
      orderId: o.id,
      kind: 'git-worktree',
      agent: 'codex',
      handle: repo,
      status: 'running',
      startedAt: at(0),
      lastSeenAt: at(0),
      attempt: 1,
    } as Worker;
    await refreshWorkerActivity([w], () => o, {
      stateDir,
      runner: execRunner,
      launchers: {},
      now: new Date(T0),
    });
    const a = orderActivity(stateDir, o, w);
    expect(a.changedFiles).toEqual(['a.txt', 'new.txt']);
    expect(a.activity).toBeNull();
    expect(a.tasks).toBeNull();
    expect(a.subagents).toBeNull();
    expect(statSync(join(stateDir, 'activity', 'wrk-codex.json')).mode & 0o777).toBe(0o600);
  });

  it('워커가 없으면 필드를 전부 비운다', () => {
    const stateDir = tempStateDir();
    updateWorkerInfo(stateDir, 'wrk-x', { changedFiles: ['a'] });
    expect(orderActivity(stateDir, order(), undefined).changedFiles).toBeNull();
  });
});

describe('parseSessionId', () => {
  it('응답에 세션 id가 있을 때만 꺼낸다', async () => {
    const { parseSessionId } = await import('../../../src/conductor/launcher.js');
    expect(parseSessionId(JSON.stringify({ result: { dispatch: 'ctx_1' } }))).toBeUndefined();
    expect(parseSessionId(JSON.stringify({ result: { sessionId: 'abc-123' } }))).toBe('abc-123');
    expect(parseSessionId(JSON.stringify({ sessionId: '../etc' }))).toBeUndefined();
    expect(parseSessionId('not json')).toBeUndefined();
  });
});
