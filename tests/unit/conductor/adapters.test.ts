import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileDeploySource,
  GhAccounts,
  GhAccountSwitcher,
  GhPrWatchSource,
  hostJiraClient,
  PR_LIST_LIMIT,
  hostSlackClient,
  writeDeploySignal,
} from '../../../src/conductor/adapters.js';
import type { CommandRunner, HostAction } from '../../../src/conductor/launcher.js';
import { cleanupStateDirs, order, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

function ghRunner(prs: { author: unknown[]; reviewing: unknown[] }) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'api') return { code: 0, stdout: 'me\n', stderr: '' };
    if (args[0] === 'pr') {
      const body = args.includes('--author') ? prs.author : prs.reviewing;
      return { code: 0, stdout: JSON.stringify(body), stderr: '' };
    }
    if (args[0] === 'auth') return { code: 1, stdout: '', stderr: 'no such user' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runner, calls };
}

const pr = (n: number, extra: object) => ({
  number: n,
  title: `PR ${n}`,
  headRefOid: 'h2',
  ...extra,
});
const by = (login: string, at: string, extra: object = {}) => ({
  id: `${login}-${at}`,
  author: { login },
  createdAt: at,
  ...extra,
});

describe('호스트로 넘기는 쓰기', () => {
  it('지라 전환과 슬랙 게시는 할 일로만 모은다', async () => {
    const actions: HostAction[] = [];
    await hostJiraClient(actions).transition('APP-1', 'PR');
    expect(await hostSlackClient(actions).post({ channel: '#a', text: '안녕' })).toBe('host');
    expect(actions).toEqual([
      { type: 'jira-transition', issueKey: 'APP-1', to: 'PR' },
      { type: 'slack-post', channel: '#a', text: '안녕' },
    ]);
  });

  it('배포 결과 파일이 없으면 기다리고 있으면 그 값을 읽는다', async () => {
    const dir = join(tempStateDir(), 'deploy');
    const src = fileDeploySource(dir);
    const o = order({ id: 'ord-1' });
    expect(await src.status(o)).toEqual({ status: 'pending' });
    writeDeploySignal(dir, 'ord-1', { status: 'success', ref: 'run-1' });
    expect(await src.status(o)).toEqual({ status: 'success', ref: 'run-1' });
    expect(() => writeDeploySignal(dir, '../x', { status: 'success' })).toThrow();
  });

  it('배포 결과 파일이 깨졌으면 던지지 않고 모름으로 본다', async () => {
    const dir = join(tempStateDir(), 'deploy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ord-1.json'), '{"status": "succ');
    writeFileSync(join(dir, 'ord-2.json'), 'null');
    const src = fileDeploySource(dir);
    expect(await src.status(order({ id: 'ord-1' }))).toEqual({ status: 'unknown' });
    expect(await src.status(order({ id: 'ord-2' }))).toEqual({ status: 'unknown' });
  });
});

describe('gh 읽기', () => {
  it('내 PR은 내가 답한 뒤에 남은 코멘트만 새 코멘트로 본다', async () => {
    const { runner } = ghRunner({
      author: [
        pr(1, { comments: [by('rev', '2026-11-01T00:00:00Z'), by('me', '2026-11-02T00:00:00Z')] }),
        pr(2, {
          comments: [by('me', '2026-11-01T00:00:00Z')],
          reviews: [by('rev', '2026-11-03T00:00:00Z')],
        }),
      ],
      reviewing: [],
    });
    const src = new GhPrWatchSource({ repoPaths: { 'acme/app': '/tmp/app' }, runner });
    const got = await src.authored();
    expect(got.map((p) => [p.ref, p.latestOtherCommentId])).toEqual([
      ['acme/app#1', undefined],
      ['acme/app#2', 'rev-2026-11-03T00:00:00Z'],
    ]);
  });

  it('리뷰한 PR은 내 마지막 리뷰의 head와 그 뒤 답 수를 낸다', async () => {
    const { runner, calls } = ghRunner({
      author: [],
      reviewing: [
        pr(3, {
          reviews: [
            {
              ...by('me', '2026-11-01T00:00:00Z'),
              submittedAt: '2026-11-01T00:00:00Z',
              commit: { oid: 'h1' },
            },
          ],
          comments: [by('author', '2026-11-02T00:00:00Z'), by('author', '2026-10-30T00:00:00Z')],
        }),
        pr(4, { reviews: [], comments: [] }),
      ],
    });
    const src = new GhPrWatchSource({ repoPaths: { 'acme/app': '/tmp/app' }, runner });
    expect(await src.reviewing()).toEqual([
      {
        ref: 'acme/app#3',
        repo: 'acme/app',
        title: 'PR 3',
        headSha: 'h2',
        reviewedHeadSha: 'h1',
        repliesSinceReview: 1,
      },
    ]);
    expect(calls.find((c) => c[1] === 'pr')).toContain('reviewed-by:@me -author:@me');
  });

  it('계정 전환이 실패하면 이유를 던진다', async () => {
    const { runner } = ghRunner({ author: [], reviewing: [] });
    const sw = new GhAccountSwitcher({ runner });
    expect(await sw.current()).toBe('me');
    await expect(sw.switchTo('acme/app', 'other')).rejects.toThrow('no such user');
  });

  it('계정 이름 꼴이 아니면 gh를 부르지 않고 던진다', async () => {
    const { runner, calls } = ghRunner({ author: [], reviewing: [] });
    const sw = new GhAccountSwitcher({ runner });
    await expect(sw.switchTo('acme/app', '--hostname=evil')).rejects.toThrow('계정 이름 꼴');
    expect(calls.some((c) => c.includes('--hostname=evil'))).toBe(false);
  });

  it('PR이 상한에 닿은 레포는 잘렸다고 표시한다', async () => {
    const many = Array.from({ length: PR_LIST_LIMIT }, (_, i) => pr(i + 1, {}));
    const { runner } = ghRunner({ author: many, reviewing: [] });
    const src = new GhPrWatchSource({
      repoPaths: { 'acme/app': '/tmp/app', 'acme/web': '/tmp/web' },
      runner,
    });
    expect(await src.authored()).toHaveLength(PR_LIST_LIMIT * 2);
    expect([...src.truncatedRepos].sort()).toEqual(['acme/app', 'acme/web']);
  });

  it('계정이 정해진 레포는 전역 계정을 바꾸지 않고 그 호출에만 GH_TOKEN을 넘긴다', async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const runner: CommandRunner = async (_cmd, args, opts) => {
      calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
      if (args[0] === 'auth' && args[1] === 'token')
        return { code: 0, stdout: `tok-${args[3]}\n`, stderr: '' };
      if (args[0] === 'api')
        return { code: 0, stdout: opts?.env ? 'team-me\n' : 'me\n', stderr: '' };
      if (args[0] === 'pr') return { code: 0, stdout: '[]', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const accounts = new GhAccounts({ 'acme/web': 'team' }, { runner });
    const src = new GhPrWatchSource({
      repoPaths: { 'acme/app': '/tmp/app', 'acme/web': '/tmp/web' },
      runner,
      accounts,
    });
    await src.authored();
    await src.reviewing();

    const prCalls = calls.filter((c) => c.args[0] === 'pr');
    expect(prCalls.find((c) => c.args.includes('acme/web'))?.env).toEqual({ GH_TOKEN: 'tok-team' });
    expect(prCalls.find((c) => c.args.includes('acme/app'))?.env).toBeUndefined();
    // 토큰과 로그인 계정은 tick 안에서 한 번씩만 묻는다
    expect(calls.filter((c) => c.args[0] === 'auth')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'api')).toHaveLength(2);

    const sw = new GhAccountSwitcher({ accounts });
    await sw.switchTo('acme/web', 'team');
    expect(await sw.current('acme/web')).toBe('team');
    expect(await sw.current('acme/app')).toBe('me');
    expect(calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'switch')).toBe(false);
  });
});
