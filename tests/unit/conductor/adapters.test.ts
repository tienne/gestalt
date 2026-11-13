import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileDeploySource,
  fileQueue,
  FAILED_QUEUE_DIR,
  GhAccounts,
  GhAccountSwitcher,
  GhPrStateSource,
  GhPrWatchSource,
  hostJiraClient,
  PR_LIST_LIMIT,
  prWatchTargets,
  hostSlackClient,
  QUEUE_FILE_MAX_BYTES,
  writeDeploySignal,
  writeQueueMessage,
} from '../../../src/conductor/adapters.js';
import { pollQueue } from '../../../src/conductor/intake.js';
import { ConductorStore } from '../../../src/conductor/store.js';
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

describe('파일 큐', () => {
  const body = { repo: 'acme/web', title: '배너 교체' };

  it('넣은 메시지를 이름 순으로 받고 ack하면 파일을 지운다', async () => {
    const dir = join(tempStateDir(), 'queue');
    writeQueueMessage(dir, { ...body, title: '둘째' }, 'b-2');
    writeQueueMessage(dir, body, 'a-1');
    // 쓰다 만 파일은 점으로 시작하니 건너뛴다
    writeFileSync(join(dir, '.c-3.json'), '{"repo"');
    const q = fileQueue(dir);
    const got = await q.receive(1);
    expect(got).toEqual([{ id: 'a-1', body }]);
    await q.ack('a-1');
    await q.ack('a-1');
    expect(readdirSync(dir).sort()).toEqual(['.c-3.json', 'b-2.json']);
    expect(q.errors).toEqual([]);
  });

  it('id를 비우면 새로 만들고 같은 id는 덮지 않으며 꼴이 틀린 본문은 넣지 않는다', () => {
    const dir = join(tempStateDir(), 'queue');
    expect(writeQueueMessage(dir, body)).toMatch(/^\d+-[0-9a-f]{8}$/);
    writeQueueMessage(dir, body, 'm1');
    expect(() => writeQueueMessage(dir, body, 'm1')).toThrow('아직 큐에 있어요');
    expect(() => writeQueueMessage(dir, body, '../x')).toThrow('id 형식');
    expect(() => writeQueueMessage(dir, { title: 'x' }, 'm2')).toThrow('repo');
    expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('못 읽는 파일은 failed로 옮기고 이유를 errors에 남긴다', async () => {
    const dir = join(tempStateDir(), 'queue');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{"repo": "ac');
    writeFileSync(
      join(dir, 'big.json'),
      JSON.stringify({ ...body, description: 'x'.repeat(QUEUE_FILE_MAX_BYTES) }),
    );
    writeFileSync(join(dir, 'b@d.json'), JSON.stringify(body));
    writeFileSync(join(tempStateDir(), 'secret.json'), JSON.stringify(body));
    symlinkSync(join(process.cwd(), 'package.json'), join(dir, 'link.json'));
    const q = fileQueue(dir);
    expect(await q.receive(20)).toEqual([]);
    expect(q.errors).toHaveLength(4);
    expect(readdirSync(join(dir, FAILED_QUEUE_DIR)).sort()).toEqual([
      'b@d.json',
      'big.json',
      'broken.json',
      'link.json',
    ]);
  });

  it('큐 디렉토리가 없으면 빈 목록이고 tick 접수와 이어지면 주문이 한 번만 생긴다', async () => {
    const stateDir = tempStateDir();
    const dir = join(stateDir, 'queue');
    const q = fileQueue(dir);
    expect(await q.receive(20)).toEqual([]);
    expect(existsSync(dir)).toBe(false);

    const store = ConductorStore.open(stateDir);
    writeQueueMessage(dir, { ...body, scope: 'merge-through' }, 'm1');
    const r = await pollQueue(store, q, { defaultScope: 'approval' });
    // 바깥에서 온 주문은 범위를 넓히지 못한다
    expect(r.created[0]).toMatchObject({
      source: 'external-queue',
      sourceRef: 'queue:m1',
      scope: 'approval',
    });
    expect(existsSync(join(dir, 'm1.json'))).toBe(false);
    writeQueueMessage(dir, body, 'm1');
    await pollQueue(store, q, { defaultScope: 'approval' });
    expect(store.orders()).toHaveLength(1);
  });
});

describe('PR 감시 대상', () => {
  const repoPaths = { 'acme/app': '/tmp/app', 'acme/web': '/tmp/web' };

  it('prWatchRepos가 비어 있으면 repoPaths에 레포가 있어도 감시하지 않는다', () => {
    expect(prWatchTargets([], repoPaths)).toEqual({ repoPaths: {}, errors: [] });
  });

  it('prWatchRepos에 적은 레포만 감시한다', () => {
    expect(prWatchTargets(['acme/web'], repoPaths)).toEqual({
      repoPaths: { 'acme/web': '/tmp/web' },
      errors: [],
    });
  });

  it('repoPaths에 경로가 없는 레포는 빼고 이유를 남긴다', () => {
    const got = prWatchTargets(['acme/app', 'acme/api', 'acme/api'], repoPaths);
    expect(got.repoPaths).toEqual({ 'acme/app': '/tmp/app' });
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('acme/api');
    expect(got.errors[0]).toContain('repoPaths');
  });

  it('owner/name 꼴이 아닌 항목은 빼고 따옴표로 감싼 값과 함께 알린다', () => {
    const got = prWatchTargets(['acme/app ', 'acme-app'], repoPaths);
    expect(got.repoPaths).toEqual({});
    expect(got.errors).toEqual([
      '"acme/app ": prWatchRepos 항목이 owner/name 꼴이 아니라 PR 감시에서 뺐어요',
      '"acme-app": prWatchRepos 항목이 owner/name 꼴이 아니라 PR 감시에서 뺐어요',
    ]);
  });

  it('프로토타입 이름은 repoPaths 경로로 잡지 않는다', () => {
    const got = prWatchTargets(['constructor', 'toString/x'], repoPaths);
    expect(got.repoPaths).toEqual({});
    expect(got.errors).toHaveLength(2);
    const proto = prWatchTargets(['a/b'], Object.create({ 'a/b': '/tmp/proto' }));
    expect(proto.repoPaths).toEqual({});
    expect(proto.errors[0]).toContain('철자');
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

describe('GhPrStateSource', () => {
  function stateRunner(stdout: string, code = 0) {
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code, stdout, stderr: code === 0 ? '' : 'not found' };
    };
    return { runner, calls };
  }

  it('PR 상태와 머지 시각을 읽는다', async () => {
    const { runner, calls } = stateRunner(
      JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-02T00:00:00Z' }),
    );
    const src = new GhPrStateSource({ runner, accounts: new GhAccounts({}, { runner }) });
    expect(await src.state('acme/app#7')).toEqual({
      state: 'MERGED',
      mergedAt: '2026-11-02T00:00:00Z',
    });
    expect(calls[0]).toEqual([
      'gh',
      'pr',
      'view',
      '7',
      '--repo',
      'acme/app',
      '--json',
      'state,mergedAt',
    ]);
  });

  it('열린 PR은 머지 시각 없이 돌려준다', async () => {
    const { runner } = stateRunner(JSON.stringify({ state: 'OPEN', mergedAt: null }));
    const src = new GhPrStateSource({ runner, accounts: new GhAccounts({}, { runner }) });
    expect(await src.state('acme/app#7')).toEqual({ state: 'OPEN' });
  });

  it('모르는 상태나 gh 실패는 던진다', async () => {
    const bad = stateRunner(JSON.stringify({ state: 'DRAFT' }));
    await expect(
      new GhPrStateSource({ runner: bad.runner, accounts: new GhAccounts({}, bad) }).state(
        'acme/app#7',
      ),
    ).rejects.toThrow('DRAFT');
    const fail = stateRunner('', 1);
    await expect(
      new GhPrStateSource({ runner: fail.runner, accounts: new GhAccounts({}, fail) }).state(
        'acme/app#7',
      ),
    ).rejects.toThrow('not found');
  });
});
