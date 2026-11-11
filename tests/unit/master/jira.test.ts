import { afterEach, describe, expect, it } from 'vitest';
import {
  decideJiraTransition,
  defaultJiraTarget,
  syncJira,
  type JiraClient,
} from '../../../src/master/jira.js';
import type { JiraStatus } from '../../../src/master/types.js';
import { cleanupStateDirs, clockedStore, order } from './fixtures.js';

afterEach(cleanupStateDirs);

function fakeJira() {
  const calls: { key: string; to: JiraStatus }[] = [];
  const client: JiraClient = {
    async transition(key, to) {
      calls.push({ key, to });
    },
  };
  return { client, calls };
}

describe('지라 기본 규칙', () => {
  it('파악하면 TODO, 시작하면 In Progress, 리뷰면 PR', () => {
    expect(defaultJiraTarget('identified', 'task')).toBe('TODO');
    expect(defaultJiraTarget('started', 'task')).toBe('In Progress');
    expect(defaultJiraTarget('review', 'bug')).toBe('PR');
  });

  it('머지되면 sub-task만 Done이고 bug, task, sub-bug는 배포를 기다린다', () => {
    expect(defaultJiraTarget('merged', 'sub-task')).toBe('Done');
    for (const t of ['bug', 'task', 'sub-bug'] as const) {
      expect(defaultJiraTarget('merged', t)).toBeNull();
      expect(defaultJiraTarget('deployed', t, { status: 'pending' })).toBeNull();
      expect(defaultJiraTarget('deployed', t, { status: 'failed' })).toBeNull();
      expect(defaultJiraTarget('deployed', t, { status: 'success' })).toBe('In-QA');
    }
  });

  it('사용자가 정한 상태가 기본 규칙보다 먼저다', () => {
    const o = order({ issueKey: 'APP-1', issueType: 'task', explicitJiraStatus: 'Done' });
    expect(decideJiraTransition(o, 'review')).toBe('Done');
  });

  it('이미 그 상태거나 뒤로 가는 전환은 하지 않는다', () => {
    const o = order({ issueKey: 'APP-1', issueType: 'task', jiraStatus: 'PR' });
    expect(decideJiraTransition(o, 'review')).toBeNull();
    expect(decideJiraTransition(o, 'started')).toBeNull();
  });
});

describe('syncJira', () => {
  it('전환을 지라에 반영하고 저장소에 남긴다. 같은 단계를 다시 불러도 한 번만 옮긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', issueKey: 'APP-1', issueType: 'bug' }));
    const { client, calls } = fakeJira();
    await syncJira(store, 'ord-1', 'identified', client);
    await syncJira(store, 'ord-1', 'started', client);
    await syncJira(store, 'ord-1', 'started', client);
    await syncJira(store, 'ord-1', 'review', client);
    await syncJira(store, 'ord-1', 'merged', client);
    await syncJira(store, 'ord-1', 'deployed', client, { status: 'success' });
    expect(calls.map((c) => c.to)).toEqual(['TODO', 'In Progress', 'PR', 'In-QA']);
    expect(store.order('ord-1')?.jiraStatus).toBe('In-QA');
    expect(store.snapshot.jiraTransitions.at(-1)).toMatchObject({ from: 'PR', to: 'In-QA' });
  });

  it('지라 키가 없는 주문은 건드리지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { client, calls } = fakeJira();
    expect(await syncJira(store, 'ord-1', 'started', client)).toBeNull();
    expect(calls).toEqual([]);
  });
});
