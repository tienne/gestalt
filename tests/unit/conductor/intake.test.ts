import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTERNAL_DESCRIPTION_MAX,
  intakeOrder,
  normalizeIssueType,
  parseQueueBody,
  pollJira,
  pollQueue,
  type ExternalQueue,
  type JiraTicket,
} from '../../../src/conductor/intake.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

const config = { defaultScope: 'approval' as const };

describe('intake', () => {
  it('말로 던진 주문은 기본 범위와 기본 스킬 체인으로 큐에 들어간다', () => {
    const s = ConductorStore.open(tempStateDir());
    const { order, created } = intakeOrder(
      s,
      { source: 'spoken', repo: 'acme/app', title: '로그인 버그' },
      config,
    );
    expect(created).toBe(true);
    expect(order).toMatchObject({
      scope: 'approval',
      skillChain: ['solve', 'ship'],
      workClass: 'work',
      status: 'queued',
    });
    expect(() => intakeOrder(s, { source: 'spoken', repo: 'app', title: 'x' }, config)).toThrow(
      /owner\/name/,
    );
  });

  it('접수 때 작업 유형을 남긴다. 직접 정한 값은 체인 유형보다 클 때만 쓴다', () => {
    const s = ConductorStore.open(tempStateDir());
    const add = (title: string, extra: object) =>
      intakeOrder(s, { source: 'spoken', repo: 'acme/app', title, ...extra }, config).order
        .workClass;
    expect(add('리뷰', { skillChain: ['review-loop'] })).toBe('review');
    expect(add('영향', { skillChain: ['blast-radius'] })).toBe('lookup');
    expect(add('반영', { skillChain: ['review-reply'] })).toBe('work');
    expect(add('올림', { skillChain: ['review'], workClass: 'work' })).toBe('work');
    expect(add('내림', { skillChain: ['solve', 'ship'], workClass: 'review' })).toBe('work');
    expect(add('조회로', { skillChain: ['review'], workClass: 'lookup' })).toBe('review');
  });

  it('바깥 출처가 정한 작업 유형은 무시하고 스킬 체인으로 정한다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const direct = intakeOrder(
      s,
      {
        source: 'external-queue',
        repo: 'acme/app',
        title: '직접',
        skillChain: ['solve', 'ship'],
        workClass: 'lookup',
      },
      config,
    ).order;
    expect(direct.workClass).toBe('work');
    expect(
      parseQueueBody({ repo: 'acme/app', title: 't', workClass: 'lookup' }),
    ).not.toHaveProperty('workClass');
    const queue: ExternalQueue = {
      receive: async () => [
        { id: 'm1', body: { repo: 'acme/app', title: '큐', workClass: 'lookup' } },
      ],
      ack: async () => {},
    };
    const { created } = await pollQueue(s, queue, config);
    expect(created[0]?.workClass).toBe('work');
  });

  it('지라 티켓은 한 번만 주문이 되고 레포를 모르면 한 번만 묻는다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const tickets: JiraTicket[] = [
      { key: 'PROJ-1', summary: '버그', issueType: 'Bug', repo: 'acme/app' },
      { key: 'PROJ-2', summary: '레포 없음', issueType: 'Sub-task' },
    ];
    const source = { fetchAssigned: async () => tickets };
    const first = await pollJira(s, source, config);
    const second = await pollJira(s, source, config);
    expect(first.created.map((o) => o.issueKey)).toEqual(['PROJ-1']);
    expect(first.created[0]?.issueType).toBe('bug');
    expect(second.created).toEqual([]);
    expect(s.openGates().filter((g) => g.type === 'no-procedure')).toHaveLength(1);
  });

  it('지운 주문의 출처는 지라나 손으로 다시 넣어도 새 주문이 되지 않는다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const source = {
      fetchAssigned: async (): Promise<JiraTicket[]> => [
        { key: 'PROJ-1', summary: '버그', issueType: 'Bug', repo: 'acme/app' },
      ],
    };
    const [made] = (await pollJira(s, source, config)).created;
    s.updateOrder(made!.id, { status: 'done' });
    s.removeOrder(made!.id);
    expect((await pollJira(s, source, config)).created).toEqual([]);
    const again = intakeOrder(
      s,
      { source: 'jira', sourceRef: 'jira:PROJ-1', repo: 'acme/app', title: '버그' },
      config,
    );
    expect(again).toMatchObject({ created: false, removedAt: expect.any(String) });
    expect(s.orders()).toEqual([]);
  });

  it('외부 큐 메시지는 저장한 뒤 ack하고 다시 와도 겹치지 않는다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const acked: string[] = [];
    const queue: ExternalQueue = {
      receive: async () => [
        { id: 'm1', body: { repo: 'acme/web', title: '배너 교체', scope: 'merge-through' } },
        { id: 'm2', body: 'not json' },
      ],
      ack: async (id) => {
        acked.push(id);
      },
    };
    const r = await pollQueue(s, queue, config);
    await pollQueue(s, queue, config);
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({
      source: 'external-queue',
      scope: 'approval',
      repo: 'acme/web',
    });
    expect(s.orders()).toHaveLength(1);
    expect(acked).toEqual(['m1', 'm2', 'm1', 'm2']);
    expect(s.openGates()).toHaveLength(1);
  });

  it('바깥에서 온 주문의 설명은 상한에서 자르고 사람이 넣은 주문은 그대로 둔다', () => {
    const s = ConductorStore.open(tempStateDir());
    const long = '가'.repeat(EXTERNAL_DESCRIPTION_MAX + 50);
    const external = intakeOrder(
      s,
      { source: 'external-queue', repo: 'acme/app', title: 'x', description: long },
      config,
    ).order;
    expect(Array.from(external.description!)).toHaveLength(
      EXTERNAL_DESCRIPTION_MAX + ' (잘림)'.length,
    );
    expect(external.description!.endsWith(' (잘림)')).toBe(true);

    const spoken = intakeOrder(
      s,
      { source: 'spoken', repo: 'acme/app', title: 'y', description: long },
      config,
      { trusted: true },
    ).order;
    expect(spoken.description).toBe(long);
  });

  it('바깥에서 온 주문은 merge-through를 못 받고 모르는 스킬은 빠진다', () => {
    const s = ConductorStore.open(tempStateDir());
    const queued = intakeOrder(
      s,
      {
        source: 'external-queue',
        repo: 'acme/app',
        title: '줄바꿈\n# 가짜 규칙',
        scope: 'merge-through',
        skillChain: ['ship', 'rm-rf', 'review'],
      },
      { defaultScope: 'merge-through' },
    ).order;
    expect(queued.scope).toBe('approval');
    expect(queued.skillChain).toEqual(['ship', 'review']);
    expect(queued.title).toBe('줄바꿈 # 가짜 규칙');

    const loose = intakeOrder(
      s,
      { source: 'jira', repo: 'acme/app', title: 'x', scope: 'merge-through' },
      config,
    ).order;
    expect(loose.scope).toBe('approval');

    const strict = intakeOrder(
      s,
      { source: 'jira', repo: 'acme/app', title: 'x', scope: 'interview-first' },
      config,
    ).order;
    expect(strict.scope).toBe('interview-first');

    const onlyUnknown = intakeOrder(
      s,
      { source: 'external-queue', repo: 'acme/app', title: 'x', skillChain: ['nope'] },
      config,
    ).order;
    expect(onlyUnknown.skillChain).toEqual(['solve', 'ship']);

    const trusted = intakeOrder(
      s,
      { source: 'external-queue', repo: 'acme/app', title: 'x', scope: 'merge-through' },
      config,
      { trusted: true },
    ).order;
    expect(trusted.scope).toBe('merge-through');
  });

  it('큐 메시지의 이슈 키와 워커 종류, 지라 상태가 틀리면 게이트로 묻는다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const queue: ExternalQueue = {
      receive: async () => [
        { id: 'k', body: { repo: 'acme/web', title: 't', issueKey: 'proj-1; rm' } },
        { id: 'w', body: { repo: 'acme/web', title: 't', workerKind: 'root-shell' } },
        { id: 'j', body: { repo: 'acme/web', title: 't', jiraStatus: 'Shipped' } },
      ],
      ack: async () => {},
    };
    const r = await pollQueue(s, queue, config);
    expect(r.created).toEqual([]);
    expect(r.gated).toHaveLength(3);
    expect(s.openGates()).toHaveLength(3);
  });

  it('지라 키 꼴이 아니면 주문으로 안 받고 상한에 닿았다는 신호를 넘긴다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const source = {
      fetchAssigned: async () => ({
        tickets: [
          { key: 'PROJ-7', summary: '정상', issueType: 'Task', repo: 'acme/app' },
          { key: 'bad key', summary: '이상', issueType: 'Task', repo: 'acme/app' },
        ],
        truncated: true,
      }),
    };
    const r = await pollJira(s, source, config);
    expect(r.created.map((o) => o.issueKey)).toEqual(['PROJ-7']);
    expect(r.gated).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('지라 이슈 유형 이름을 맞춘다', () => {
    expect(normalizeIssueType('Sub-task')).toBe('sub-task');
    expect(normalizeIssueType('Subtask')).toBe('sub-task');
    expect(normalizeIssueType('Sub Bug')).toBe('sub-bug');
    expect(normalizeIssueType('Epic')).toBe('other');
  });
});

describe('배포 주문 접수', () => {
  function seeded() {
    const s = ConductorStore.open(tempStateDir());
    const a = intakeOrder(s, { source: 'spoken', repo: 'acme/app', title: 'a' }, config).order;
    const other = intakeOrder(s, { source: 'spoken', repo: 'acme/web', title: 'w' }, config).order;
    return { s, a, other };
  }

  it('같은 레포의 있는 주문만 배포 대상으로 받고 겹친 id는 하나로 둔다', () => {
    const { s, a } = seeded();
    const { order } = intakeOrder(
      s,
      { source: 'spoken', repo: 'acme/app', title: '배포', deploys: [a.id, a.id] },
      config,
      { trusted: true },
    );
    expect(order.deploys).toEqual([a.id]);
    expect(s.order(order.id)!.deploys).toEqual([a.id]);
  });

  it('없는 주문이나 다른 레포 주문은 이유와 함께 거절한다', () => {
    const { s, other } = seeded();
    const add = (deploys: string[]) =>
      intakeOrder(s, { source: 'spoken', repo: 'acme/app', title: '배포', deploys }, config, {
        trusted: true,
      });
    expect(() => add(['ord-nope'])).toThrow('배포 대상 주문이 없어요: ord-nope');
    expect(() => add([other.id])).toThrow(`acme/web 주문이라 acme/app 배포에 못 넣어요`);
    expect(s.orders()).toHaveLength(2);
  });

  it('바깥 출처의 주문은 배포 대상을 못 정한다', () => {
    const { s, a } = seeded();
    expect(() =>
      intakeOrder(
        s,
        {
          source: 'external-queue',
          sourceRef: 'queue:1',
          repo: 'acme/app',
          title: 'x',
          deploys: [a.id],
        },
        config,
      ),
    ).toThrow(/order add/);
  });
});

/** `.claude/skills/<이름>/SKILL.md`가 있는 가짜 레포 체크아웃 */
function repoWithSkills(...names: string[]): string {
  const root = resolve(tempStateDir());
  for (const name of names) {
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  return root;
}

describe('레포 스킬', () => {
  it('컨덕터 세션이 넣은 주문은 대상 레포에 있는 레포 스킬을 체인에 받는다', () => {
    const s = ConductorStore.open(tempStateDir());
    const root = repoWithSkills('release');
    const repoPaths = { 'acme/app': root };
    const cli = intakeOrder(
      s,
      { source: 'jira', repo: 'acme/app', title: '릴리즈', skillChain: ['repo:release'] },
      { ...config, repoPaths },
      { trusted: true },
    ).order;
    expect(cli.skillChain).toEqual(['repo:release']);

    const spoken = intakeOrder(
      s,
      { source: 'spoken', repo: 'acme/app', title: 'x', skillChain: ['solve', 'repo:release'] },
      { ...config, repoPaths },
    ).order;
    expect(spoken.skillChain).toEqual(['solve', 'repo:release']);
  });

  const skillDoc = (root: string) => join(root, '.claude', 'skills', 'release', 'SKILL.md');

  it.each([
    { label: '오르카 워커', workerKind: 'orca-worktree' as const },
    { label: '종류를 안 정한 주문', workerKind: undefined },
  ])(
    '$label도 오르카가 없으면 repoPaths로 떨어지므로 부모와 repoPaths 가운데 아는 경로를 다 본다',
    ({ workerKind }) => {
      const s = ConductorStore.open(tempStateDir());
      const withSkill = repoWithSkills('release');
      const plain = repoWithSkills();
      const add = (
        title: string,
        parentWorktree: string | undefined,
        repoPaths: Record<string, string>,
      ) =>
        intakeOrder(
          s,
          {
            source: 'spoken',
            repo: 'acme/app',
            title,
            skillChain: ['repo:release'],
            parentWorktree,
            workerKind,
          },
          { ...config, repoPaths },
        );
      expect(() => add('부모에만 있으면 거절', withSkill, { 'acme/app': plain })).toThrow(
        skillDoc(plain),
      );
      expect(() => add('repoPaths에만 있으면 거절', plain, { 'acme/app': withSkill })).toThrow(
        skillDoc(plain),
      );
      expect(
        add('둘 다 있으면 접수', withSkill, { 'acme/app': repoWithSkills('release') }).created,
      ).toBe(true);
      expect(add('부모만 알면 접수', withSkill, {}).created).toBe(true);
      expect(() => add('둘 다 모르면 거절', undefined, {})).toThrow(/로컬 경로를 몰라.*repoPaths/);
    },
  );

  it('git 워크트리 워커는 부모를 무시하고 띄우므로 repoPaths 쪽에서만 찾는다', () => {
    const s = ConductorStore.open(tempStateDir());
    const withSkill = repoWithSkills('release');
    const plain = repoWithSkills();
    const add = (title: string, parentWorktree: string, repoPaths: Record<string, string>) =>
      intakeOrder(
        s,
        {
          source: 'spoken',
          repo: 'acme/app',
          title,
          skillChain: ['repo:release'],
          parentWorktree,
          workerKind: 'git-worktree',
        },
        { ...config, repoPaths },
      );
    expect(add('x', plain, { 'acme/app': withSkill }).created).toBe(true);
    expect(() => add('y', withSkill, { 'acme/app': plain })).toThrow(skillDoc(plain));
    expect(() => add('z', withSkill, {})).toThrow(/로컬 경로를 몰라.*repoPaths/);
    expect(s.orders().map((o) => o.title)).toEqual(['x']);
  });

  it('ship과 레포 스킬은 한 체인에 받지 않는다', () => {
    const s = ConductorStore.open(tempStateDir());
    const root = repoWithSkills('release');
    expect(() =>
      intakeOrder(
        s,
        { source: 'spoken', repo: 'acme/app', title: 'x', skillChain: ['ship', 'repo:release'] },
        { ...config, repoPaths: { 'acme/app': root } },
      ),
    ).toThrow(/ship을 같이 넣을 수 없어요/);
    expect(s.orders()).toEqual([]);
  });

  it('레포 밖을 가리키는 링크로 된 스킬 문서는 거절한다', () => {
    const s = ConductorStore.open(tempStateDir());
    const outside = repoWithSkills('release');
    const root = repoWithSkills();
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    symlinkSync(
      join(outside, '.claude', 'skills', 'release'),
      join(root, '.claude', 'skills', 'release'),
    );
    expect(() =>
      intakeOrder(
        s,
        { source: 'spoken', repo: 'acme/app', title: 'x', skillChain: ['repo:release'] },
        { ...config, repoPaths: { 'acme/app': root } },
      ),
    ).toThrow(/레포 밖을 가리키는 링크/);
  });

  it('같은 sourceRef로 다시 넣으면 그사이 스킬 문서가 지워졌어도 기존 주문을 돌려준다', () => {
    const s = ConductorStore.open(tempStateDir());
    const root = repoWithSkills('release');
    const input = {
      source: 'spoken' as const,
      sourceRef: 'spoken:release-1',
      repo: 'acme/app',
      title: 'x',
      skillChain: ['repo:release'],
    };
    const cfg = { ...config, repoPaths: { 'acme/app': root } };
    const first = intakeOrder(s, input, cfg);
    rmSync(join(root, '.claude', 'skills', 'release'), { recursive: true });
    const again = intakeOrder(s, input, cfg);
    expect(again.created).toBe(false);
    expect(again.order?.id).toBe(first.order?.id);
  });

  it('없는 스킬이나 경로를 모르는 레포는 이유와 함께 거절하고 주문을 만들지 않는다', () => {
    const s = ConductorStore.open(tempStateDir());
    const root = repoWithSkills('release');
    expect(() =>
      intakeOrder(
        s,
        { source: 'spoken', repo: 'acme/app', title: 'x', skillChain: ['repo:deploy'] },
        { ...config, repoPaths: { 'acme/app': root } },
      ),
    ).toThrow(/acme\/app에 repo:deploy 스킬이 없어요/);
    expect(() =>
      intakeOrder(
        s,
        { source: 'spoken', repo: 'acme/web', title: 'x', skillChain: ['repo:release'] },
        { ...config, repoPaths: { 'acme/app': root } },
      ),
    ).toThrow(/로컬 경로를 몰라.*repoPaths/);
    expect(() =>
      intakeOrder(
        s,
        { source: 'spoken', repo: 'acme/app', title: 'x', skillChain: ['repo:release'] },
        config,
      ),
    ).toThrow(/repoPaths/);
    expect(s.orders()).toEqual([]);
  });

  it.each([
    'repo:../outside',
    'repo:a/b',
    'repo:..',
    'repo:',
    'repo:Release',
    'repo:-x',
    'repo:a\\b',
  ])('경로를 벗어날 수 있는 이름 %s는 파일이 있어도 거절한다', (skill) => {
    const s = ConductorStore.open(tempStateDir());
    const root = repoWithSkills('release');
    // repo:../outside가 가리킬 자리에 실제 파일을 둬서 존재 확인이 아니라 꼴 검사로 막히는지 본다
    mkdirSync(join(root, '.claude', 'outside'), { recursive: true });
    writeFileSync(join(root, '.claude', 'outside', 'SKILL.md'), '# outside\n');
    expect(() =>
      intakeOrder(
        s,
        { source: 'spoken', repo: 'acme/app', title: 'x', skillChain: [skill] },
        { ...config, repoPaths: { 'acme/app': root } },
      ),
    ).toThrow(/레포 스킬 이름은/);
  });

  it('레포 스킬 체인은 서브에이전트 워커로 못 받는다', () => {
    const s = ConductorStore.open(tempStateDir());
    const root = repoWithSkills('release');
    expect(() =>
      intakeOrder(
        s,
        {
          source: 'spoken',
          repo: 'acme/app',
          title: 'x',
          skillChain: ['repo:release'],
          workerKind: 'subagent',
        },
        { ...config, repoPaths: { 'acme/app': root } },
      ),
    ).toThrow(/서브에이전트/);
  });

  it.each(['jira', 'external-queue', 'pr-watch'] as const)(
    '%s에서 온 레포 스킬은 레포에 있어도 체인에서 빠진다',
    (source) => {
      const s = ConductorStore.open(tempStateDir());
      const repoPaths = { 'acme/app': repoWithSkills('release') };
      const mixed = intakeOrder(
        s,
        { source, repo: 'acme/app', title: 'x', skillChain: ['repo:release', 'review'] },
        { ...config, repoPaths },
      ).order;
      expect(mixed.skillChain).toEqual(['review']);
      const only = intakeOrder(
        s,
        { source, repo: 'acme/app', title: 'y', skillChain: ['repo:release'] },
        { ...config, repoPaths },
      ).order;
      expect(only.skillChain).toEqual(['solve', 'ship']);
    },
  );

  it('외부 큐 메시지의 레포 스킬은 접수에서 빠진다', async () => {
    const s = ConductorStore.open(tempStateDir());
    const queue: ExternalQueue = {
      receive: async () => [
        {
          id: 'm-1',
          body: { repo: 'acme/app', title: '릴리즈', skillChain: ['repo:release', 'ship'] },
        },
      ],
      ack: async () => {},
    };
    // 레포 스킬 파일이 있어도 바깥 출처라서 빠지는지 보려고 경로를 같이 넘긴다
    const withPaths = { ...config, repoPaths: { 'acme/app': repoWithSkills('release') } };
    const { created } = await pollQueue(s, queue, withPaths);
    expect(created[0]?.skillChain).toEqual(['ship']);
  });
});
