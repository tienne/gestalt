import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTERNAL_DESCRIPTION_MAX,
  intakeOrder,
  normalizeIssueType,
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
      status: 'queued',
    });
    expect(() => intakeOrder(s, { source: 'spoken', repo: 'app', title: 'x' }, config)).toThrow(
      /owner\/name/,
    );
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
