import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decideApproveGate,
  localRoundsDir,
  nextRoundNumber,
  parseScope,
  readRounds,
  recordRound,
  resolvePostedEvent,
  reusableNoRemoteChoice,
  ROUNDS_FILE,
} from '../../../src/harness-review/approve-gate.js';
import type { ReviewRound } from '../../../src/harness-review/types.js';
import { stateRoot } from '../../../src/review-loop/state.js';
import { cleanupFakeRepos, createFakeRepo } from '../../helpers/fake-repo.js';

const clean = {
  lookupBlocked: false,
  noGitHubRemote: false,
  relatedPrUnconfirmed: false,
  referenceCheckSkipped: false,
};

function round(n: number, over: Partial<ReviewRound> = {}): ReviewRound {
  return { roundNumber: n, ...clean, ...over };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = resolve('.gestalt-test', `approve-gate-${randomUUID()}`);
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  cleanupFakeRepos();
});

describe('decideApproveGate', () => {
  it.each(['lookupBlocked', 'noGitHubRemote', 'relatedPrUnconfirmed'] as const)(
    '이번 라운드에 새로 생긴 %s 는 명시가 있어도 막는다',
    (issue) => {
      for (const scope of ['precondition', 'thisRound'] as const) {
        const gate = decideApproveGate({
          history: [round(1)],
          current: { ...clean, [issue]: true },
          scope,
        });
        expect(gate.decision).toBe('block');
        expect(gate.blockingIssuesThisRound).toEqual([issue]);
        expect(resolvePostedEvent('APPROVE', gate)).toBe('COMMENT');
      }
    },
  );

  it('첫 라운드에 생긴 이슈도 새로 생긴 것이다', () => {
    const gate = decideApproveGate({
      history: [],
      current: { ...clean, noGitHubRemote: true, referenceCheckSkipped: true },
      scope: 'thisRound',
    });
    expect(gate.decision).toBe('block');
  });

  it('이전 라운드에서 이어졌고 새 이슈가 없으면 명시가 있을 때 허용한다', () => {
    for (const scope of ['precondition', 'thisRound'] as const) {
      const gate = decideApproveGate({
        history: [round(1, { lookupBlocked: true, referenceCheckSkipped: true })],
        current: { ...clean, lookupBlocked: true, referenceCheckSkipped: true },
        scope,
      });
      expect(gate.decision).toBe('allow');
      expect(gate.blockingIssuesThisRound).toEqual([]);
      expect(gate.blockingIssuesPriorRounds).toEqual(['lookupBlocked']);
      expect(resolvePostedEvent('APPROVE', gate)).toBe('APPROVE');
    }
  });

  it('이어진 이슈에 새 이슈가 하나라도 더해지면 막는다', () => {
    const gate = decideApproveGate({
      history: [round(1, { lookupBlocked: true })],
      current: { ...clean, lookupBlocked: true, relatedPrUnconfirmed: true },
      scope: 'thisRound',
    });
    expect(gate.decision).toBe('block');
    expect(gate.blockingIssuesThisRound).toEqual(['relatedPrUnconfirmed']);
    expect(gate.blockingIssuesPriorRounds).toEqual(['lookupBlocked']);
  });

  it('해소됐다가 다시 나타난 이슈는 새로 생긴 것이다', () => {
    const gate = decideApproveGate({
      history: [round(1, { lookupBlocked: true }), round(2)],
      current: { ...clean, lookupBlocked: true },
      scope: 'thisRound',
    });
    expect(gate.decision).toBe('block');
  });

  it('이어진 이슈가 있는데 명시가 없으면 막는다', () => {
    const gate = decideApproveGate({
      history: [round(1, { relatedPrUnconfirmed: true })],
      current: { ...clean, relatedPrUnconfirmed: true },
      scope: 'none',
    });
    expect(gate.decision).toBe('block');
  });

  it('참조 검사가 빠졌는데 명시가 없으면 ⓢ 자동 동의가 있어도 막는다 (A3, AC18)', () => {
    const gate = decideApproveGate({
      history: [round(1, { lookupBlocked: true, referenceCheckSkipped: true })],
      current: { ...clean, lookupBlocked: true, referenceCheckSkipped: true },
      scope: 'none',
      autoConsent: true,
    });
    expect(gate.decision).toBe('block');
    expect(gate.reason).toContain('ⓢ');
    expect(resolvePostedEvent('APPROVE', gate)).toBe('COMMENT');
  });

  it('참조 검사만 빠졌고 이슈가 없어도 명시 없으면 막고 명시하면 허용한다', () => {
    const current = { ...clean, referenceCheckSkipped: true };
    expect(decideApproveGate({ history: [], current, scope: 'none' }).decision).toBe('block');
    expect(decideApproveGate({ history: [], current, scope: 'precondition' }).decision).toBe(
      'allow',
    );
  });

  it('막는 게 없으면 명시 없이도 허용한다', () => {
    const gate = decideApproveGate({ history: [round(1)], current: clean, scope: 'none' });
    expect(gate.decision).toBe('allow');
  });

  it('직전 라운드는 기록 순서가 아니라 번호로 고른다', () => {
    const gate = decideApproveGate({
      history: [round(2, { lookupBlocked: true }), round(1)],
      current: { ...clean, lookupBlocked: true },
      scope: 'thisRound',
    });
    expect(gate.decision).toBe('allow');
  });
});

describe('resolvePostedEvent', () => {
  it('막혀도 APPROVE 가 아닌 이벤트는 그대로 둔다', () => {
    const block = decideApproveGate({
      history: [],
      current: { ...clean, lookupBlocked: true },
      scope: 'none',
    });
    expect(resolvePostedEvent('REQUEST_CHANGES', block)).toBe('REQUEST_CHANGES');
    expect(resolvePostedEvent('COMMENT', block)).toBe('COMMENT');
  });
});

describe('parseScope', () => {
  it('없으면 none, 모르는 값은 던진다', () => {
    expect(parseScope(undefined)).toBe('none');
    expect(parseScope('thisRound')).toBe('thisRound');
    expect(() => parseScope('auto')).toThrow();
  });
});

describe('원격 없는 레포의 답 재사용', () => {
  it('첫 라운드에 받은 진행 답을 다음 라운드가 재사용한다', () => {
    const history = [
      round(1, {
        noGitHubRemote: true,
        referenceCheckSkipped: true,
        userChoice: 'proceedWithoutRefs',
      }),
    ];
    expect(reusableNoRemoteChoice(history)).toBe('proceedWithoutRefs');
  });

  it('기록이 없으면 첫 라운드라 물어야 한다', () => {
    expect(reusableNoRemoteChoice([])).toBeUndefined();
  });

  it('기다림은 재사용하지 않는다', () => {
    expect(reusableNoRemoteChoice([round(1, { noGitHubRemote: true, userChoice: 'wait' })])).toBe(
      undefined,
    );
  });

  it('조회 막힘에서 받은 답은 원격 없음 답으로 안 쓴다', () => {
    const history = [round(1, { lookupBlocked: true, userChoice: 'proceedWithoutRefs' })];
    expect(reusableNoRemoteChoice(history)).toBeUndefined();
  });
});

describe('라운드 기록', () => {
  it('없으면 빈 이력, 쓰고 나면 번호 순으로 읽힌다', () => {
    const dir = tmpDir();
    expect(readRounds(dir)).toEqual([]);
    recordRound(dir, round(2));
    recordRound(dir, round(1, { lookupBlocked: true }));
    expect(readRounds(dir).map((r) => r.roundNumber)).toEqual([1, 2]);
    expect(nextRoundNumber(readRounds(dir))).toBe(3);
  });

  it('같은 라운드를 다시 기록하면 바꿔 끼운다', () => {
    const dir = tmpDir();
    recordRound(dir, round(1, { postedEvent: 'COMMENT' }));
    recordRound(dir, round(1, { postedEvent: 'APPROVE' }));
    const rounds = readRounds(dir);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.postedEvent).toBe('APPROVE');
  });

  it('형식이 깨진 기록은 빈 이력으로 넘기지 않고 던진다', () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ROUNDS_FILE), JSON.stringify([{ roundNumber: 1 }]));
    expect(() => readRounds(dir)).toThrow();
  });

  it('PR 없는 리뷰 자리는 상태 자리 뿌리 아래 브랜치별로 둔다', () => {
    const repo = createFakeRepo({ remote: false, branch: 'feat/x' });
    const dir = localRoundsDir(repo.root);
    expect(dir.startsWith(stateRoot(repo.root))).toBe(true);
    expect(dir.endsWith('local--feat_x')).toBe(true);
    expect(() => localRoundsDir(repo.root, '..')).toThrow();
  });
});

describe('CLI approve-gate (원격 없는 fixture 레포)', { timeout: 60_000 }, () => {
  const bin = resolve('bin/gestalt.ts');
  const run = (cwd: string, args: string[]) => {
    try {
      const stdout = execFileSync('npx', ['tsx', bin, ...args], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as SpawnSyncReturns<string> & { status: number | null };
      return { status: err.status ?? -1, stdout: err.stdout ?? '' };
    }
  };

  it('첫 라운드는 막고 답을 남기고 둘째 라운드는 그 답을 재사용해 명시가 있으면 APPROVE 를 낸다', () => {
    const repo = createFakeRepo({ remote: false });

    const before = JSON.parse(run(repo.root, ['review-loop', 'rounds']).stdout);
    expect(before.nextRound).toBe(1);
    expect(before.noRemoteChoice).toBeNull();

    const first = JSON.parse(
      run(repo.root, [
        'review-loop',
        'approve-gate',
        '--issue',
        'noGitHubRemote',
        '--user-choice',
        'proceedWithoutRefs',
        '--scope',
        'thisRound',
        '--record',
      ]).stdout,
    );
    expect(first.gate.decision).toBe('block');
    expect(first.event).toBe('COMMENT');
    expect(first.round.referenceCheckSkipped).toBe(true);

    const mid = JSON.parse(run(repo.root, ['review-loop', 'rounds']).stdout);
    expect(mid.nextRound).toBe(2);
    expect(mid.noRemoteChoice).toBe('proceedWithoutRefs');

    const second = JSON.parse(
      run(repo.root, [
        'review-loop',
        'approve-gate',
        '--issue',
        'noGitHubRemote',
        '--scope',
        'thisRound',
        '--record',
      ]).stdout,
    );
    expect(second.noRemoteChoice).toBe('proceedWithoutRefs');
    expect(second.round.userChoice).toBe('proceedWithoutRefs');
    expect(second.round.referenceCheckSkipped).toBe(true);
    expect(second.gate.decision).toBe('allow');
    expect(second.event).toBe('APPROVE');

    const third = JSON.parse(
      run(repo.root, ['review-loop', 'approve-gate', '--issue', 'noGitHubRemote', '--auto-consent'])
        .stdout,
    );
    expect(third.gate.decision).toBe('block');
    expect(third.event).toBe('COMMENT');
    expect(third.recorded).toBe(false);
  }, 60_000);

  it('모르는 값은 stdout 을 비우고 종료 코드로 답한다', () => {
    const repo = createFakeRepo({ remote: false });
    const r = run(repo.root, ['review-loop', 'approve-gate', '--scope', 'auto']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  }, 30_000);
});
