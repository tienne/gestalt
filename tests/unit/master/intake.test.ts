import { afterEach, describe, expect, it } from 'vitest';
import {
  intakeOrder,
  normalizeIssueType,
  pollJira,
  pollQueue,
  type ExternalQueue,
  type JiraTicket,
} from '../../../src/master/intake.js';
import { MasterStore } from '../../../src/master/store.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

const config = { defaultScope: 'approval' as const };

describe('intake', () => {
  it('말로 던진 주문은 기본 범위와 기본 스킬 체인으로 큐에 들어간다', () => {
    const s = MasterStore.open(tempStateDir());
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
    const s = MasterStore.open(tempStateDir());
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
    const s = MasterStore.open(tempStateDir());
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
      scope: 'merge-through',
      repo: 'acme/web',
    });
    expect(s.orders()).toHaveLength(1);
    expect(acked).toEqual(['m1', 'm2', 'm1', 'm2']);
    expect(s.openGates()).toHaveLength(1);
  });

  it('지라 이슈 유형 이름을 맞춘다', () => {
    expect(normalizeIssueType('Sub-task')).toBe('sub-task');
    expect(normalizeIssueType('Subtask')).toBe('sub-task');
    expect(normalizeIssueType('Sub Bug')).toBe('sub-bug');
    expect(normalizeIssueType('Epic')).toBe('other');
  });
});
