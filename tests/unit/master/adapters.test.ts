import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileDeploySource,
  GhAccountSwitcher,
  GhPrWatchSource,
  hostJiraClient,
  hostSlackClient,
  writeDeploySignal,
} from '../../../src/master/adapters.js';
import type { CommandRunner, HostAction } from '../../../src/master/launcher.js';
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
});
