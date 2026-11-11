import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  masterCheckpointSaveCommand,
  masterDeployReportCommand,
  masterGateListCommand,
  masterGateResolveCommand,
  masterOrderAddCommand,
  masterSlackDraftCommand,
  masterStatusCommand,
  masterWorkerReportCommand,
} from '../../../src/cli/commands/master.js';
import { MasterStore } from '../../../src/master/store.js';
import { cleanupStateDirs, tempStateDir, worker } from './fixtures.js';

let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => void out.push(String(v)));
  vi.spyOn(console, 'error').mockImplementation((v: unknown) => void err.push(String(v)));
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupStateDirs();
});

const last = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;

describe('gestalt master', () => {
  it('주문을 받고 같은 출처는 한 번만 받으며 상태를 짧게 보여준다', () => {
    const stateDir = tempStateDir();
    const add = {
      stateDir,
      json: true,
      repo: 'acme/app',
      title: '배너 고치기',
      source: 'jira',
      sourceRef: 'jira:APP-1',
    };
    masterOrderAddCommand({ ...add, issueKey: 'APP-1', issueType: 'bug', scope: 'merge-through' });
    expect(last()['created']).toBe(true);
    masterOrderAddCommand(add);
    expect(last()['created']).toBe(false);

    masterStatusCommand({ stateDir, json: true });
    expect(last()['orders']).toEqual([
      expect.objectContaining({ status: 'queued', scope: 'merge-through', issue: 'APP-1' }),
    ]);
  });

  it('잘못된 값은 stderr와 exit 1로 끝낸다', () => {
    const stateDir = tempStateDir();
    expect(() =>
      masterOrderAddCommand({ stateDir, repo: 'acme/app', title: 'x', scope: 'yolo' }),
    ).toThrow('exit 1');
    expect(err[0]).toContain('--scope');
    expect(() =>
      masterDeployReportCommand({ stateDir, order: 'ord-none', status: 'success' }),
    ).toThrow('exit 1');
  });

  it('워커는 체크포인트와 결과를 남기고 원문 섞인 결과는 거절된다', () => {
    const stateDir = tempStateDir();
    masterOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'x' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = MasterStore.open(stateDir);
    const w = worker(orderId);
    store.startWorker(w);
    store.updateOrder(orderId, { status: 'running', workerId: w.id });

    masterCheckpointSaveCommand({
      stateDir,
      json: true,
      worker: w.id,
      skill: 'solve',
      next: '스펙 확인',
      done: '',
    });
    expect(last()).toMatchObject({ skill: 'solve', next: '스펙 확인' });

    masterWorkerReportCommand({
      stateDir,
      json: true,
      worker: w.id,
      status: 'progress',
      summary: '진행 중',
      ref: ['a.md'],
    });
    expect(String(last()['queued'])).toMatch(/\.json$/);
    expect(() =>
      masterWorkerReportCommand({
        stateDir,
        worker: w.id,
        status: 'done',
        summary: '```\nlog\n```',
      }),
    ).toThrow('exit 1');
  });

  it('슬랙 초안은 게이트로 올라가고 resolve로 닫힌다', async () => {
    const stateDir = tempStateDir();
    const textFile = join(stateDir, 'draft.txt');
    writeFileSync(textFile, '배포 끝났어요~');
    masterSlackDraftCommand({ stateDir, json: true, channel: '#release', textFile });
    const gateId = String(last()['gateId']);

    masterGateListCommand({ stateDir, json: true });
    expect(JSON.parse(out.at(-1)!)).toEqual([
      expect.objectContaining({ id: gateId, type: 'slack-post' }),
    ]);

    await masterGateResolveCommand(gateId, { stateDir, json: true, approve: true });
    expect((last()['gate'] as { decision: string }).decision).toBe('approved');
    await expect(masterGateResolveCommand(gateId, { stateDir, approve: true })).rejects.toThrow(
      'exit 1',
    );
    expect(err.at(-1)).toContain('이미 닫힌');
  });
});
