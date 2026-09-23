import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';
import {
  checkDroppedIssues,
  isUndroppable,
  verificationStats,
} from '../../../src/review/verification.js';
import type {
  ContinuityVerdict,
  DroppedReviewIssue,
  ReviewConsensusResult,
  ReviewIssue,
} from '../../../src/core/types.js';

/**
 * 3.7단계 제안 검증이 엔진에 남기는 자국을 본다.
 *
 * droppedIssues는 이슈를 판정에서 빼는 통로라 우회로로 쓰이기 쉽다. 그래서 거부 쪽은
 * 실제로 금지를 피하려는 입력(대소문자 변형, 하위 분류, 병합하면서 바꾼 severity)을
 * 넣어 본다.
 */

function issue(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id'>): ReviewIssue {
  return {
    severity: 'high',
    category: 'quality',
    file: 'src/a.ts',
    line: 10,
    message: `문제 ${overrides.id}`,
    suggestion: `제안 ${overrides.id}`,
    reportedBy: 'quality-reviewer',
    ...overrides,
  };
}

function drop(base: ReviewIssue, extra?: Partial<DroppedReviewIssue>): DroppedReviewIssue {
  return {
    ...base,
    dropReason: '이슈가 근거로 든 규칙이 base에 없다',
    dropEvidence: 'git show abc123:docs/rule.md\nfatal: path does not exist',
    ...extra,
  };
}

function consensus(
  merged: ReviewIssue[],
  droppedIssues?: DroppedReviewIssue[],
): ReviewConsensusResult {
  return {
    mergedIssues: merged,
    approvedBy: [],
    blockedBy: [],
    summary: '합의 요약',
    overallApproved: false,
    ...(droppedIssues ? { droppedIssues } : {}),
  };
}

describe('isUndroppable', () => {
  it('critical은 category와 상관없이 뺄 수 없다', () => {
    expect(isUndroppable({ severity: 'critical', category: 'quality' })).toBe(true);
    expect(isUndroppable({ severity: 'critical', category: 'performance' })).toBe(true);
  });

  it('security category는 severity가 warning이어도 뺄 수 없다', () => {
    expect(isUndroppable({ severity: 'warning', category: 'security' })).toBe(true);
    expect(isUndroppable({ severity: 'high', category: 'security' })).toBe(true);
  });

  it('대소문자를 바꾸거나 앞뒤에 공백을 붙여도 security로 본다', () => {
    for (const category of ['Security', 'SECURITY', 'sEcUrItY', ' security ', '\tsecurity\n']) {
      expect(isUndroppable({ severity: 'high', category }), category).toBe(true);
    }
  });

  it('콜론 뒤 하위 분류가 붙어도 security로 본다', () => {
    for (const category of ['security:secrets', 'Security:Secrets', 'SECURITY:xss', 'security:']) {
      expect(isUndroppable({ severity: 'warning', category }), category).toBe(true);
    }
  });

  it('콜론이 아닌 구분자를 써도 security로 시작하면 security로 본다', () => {
    for (const category of [
      'security/xss',
      'security-xss',
      'security.xss',
      'security :x',
      'security_headers',
      ' Security/XSS ',
    ]) {
      expect(isUndroppable({ severity: 'warning', category }), category).toBe(true);
    }
  });

  it('security로 시작하지 않아도 secur나 appsec이 들어 있으면 security로 본다', () => {
    for (const category of ['app-security', 'AppSec', 'web:security', 'infosecurity']) {
      expect(isUndroppable({ severity: 'warning', category }), category).toBe(true);
    }
  });

  it('security가 아닌 high와 warning은 뺄 수 있다', () => {
    expect(isUndroppable({ severity: 'high', category: 'quality' })).toBe(false);
    expect(isUndroppable({ severity: 'warning', category: 'quality:comments' })).toBe(false);
    expect(isUndroppable({ severity: 'high', category: 'performance' })).toBe(false);
  });
});

describe('verificationStats', () => {
  it('keep, revise, drop을 세고 검증 없는 critical과 high만 따로 센다', () => {
    const stats = verificationStats(
      consensus(
        [
          issue({ id: 'k1', verification: { verdict: 'keep', reason: '안전' } }),
          issue({ id: 'k2', severity: 'warning', verification: { verdict: 'keep', reason: '' } }),
          issue({
            id: 'r1',
            severity: 'critical',
            verification: { verdict: 'revise', reason: '깨짐', originalSuggestion: '원래' },
          }),
          issue({ id: 'u1', severity: 'critical' }),
          issue({ id: 'u2', severity: 'high' }),
          issue({ id: 'w1', severity: 'warning' }),
        ],
        [drop(issue({ id: 'd1' })), drop(issue({ id: 'd2', severity: 'warning' }))],
      ),
    );

    expect(stats).toEqual({ keep: 2, revise: 1, drop: 2, unverifiedCriticalHigh: 2 });
  });

  it('droppedIssues를 생략하면 drop은 0이다', () => {
    expect(verificationStats(consensus([])).drop).toBe(0);
  });
});

describe('PassthroughReviewEngine 제안 검증', () => {
  let dbPath: string;
  let store: EventStore;
  let engine: PassthroughReviewEngine;

  beforeEach(() => {
    dbPath = `.gestalt-test/suggestion-verification-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughReviewEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  /** 리뷰를 열고 리뷰어별 원본을 review_submit으로 넣는다 */
  function open(originals: Record<string, ReviewIssue[]> = {}): string {
    const started = engine.startReview({ changedFiles: ['src/a.ts'], repoRoot: '/repo' }, [], []);
    if (!started.ok) throw started.error;
    const sessionId = started.value.sessionId;
    for (const [agentName, issues] of Object.entries(originals)) {
      engine.submitReview(sessionId, agentName, {
        agentName,
        issues,
        approved: issues.length === 0,
        summary: `${agentName} 요약`,
      });
    }
    return sessionId;
  }

  function rejection(sessionId: string, input: ReviewConsensusResult): string {
    const result = engine.submitConsensus(sessionId, input);
    expect(result.ok, '거부돼야 할 입력이 통과했다').toBe(false);
    if (result.ok) return '';
    return result.error.message;
  }

  function consensusEvents(sessionId: string) {
    return store
      .getByAggregate('review', sessionId)
      .filter((e) => e.eventType === EventType.REVIEW_CONSENSUS_COMPLETED);
  }

  describe('뺄 수 없는 이슈를 droppedIssues에 넣으면 거부한다', () => {
    it('security category', () => {
      const id = open();
      const message = rejection(
        id,
        consensus([], [drop(issue({ id: 'sec-1', category: 'security', severity: 'warning' }))]),
      );

      expect(message).toContain('sec-1');
      expect(message).toContain('mergedIssues로 되돌려');
    });

    it('category가 security가 아니어도 critical이면 거부한다', () => {
      const id = open();
      const message = rejection(
        id,
        consensus([], [drop(issue({ id: 'crit-1', severity: 'critical', category: 'quality' }))]),
      );

      expect(message).toContain('crit-1');
    });

    it('대문자로 적은 Security도 거부한다', () => {
      const id = open();
      const message = rejection(
        id,
        consensus([], [drop(issue({ id: 'sec-2', category: 'Security' }))]),
      );

      expect(message).toContain('sec-2');
    });

    it('security:secrets 같은 하위 분류도 거부한다', () => {
      const id = open();
      const message = rejection(
        id,
        consensus([], [drop(issue({ id: 'sec-3', category: 'security:secrets' }))]),
      );

      expect(message).toContain('sec-3');
    });

    it('구분자를 콜론 말고 다른 것으로 바꾼 security 계열도 거부한다', () => {
      const id = open();
      for (const category of ['security/xss', 'security-xss', 'security.xss', 'security :x']) {
        const message = rejection(id, consensus([], [drop(issue({ id: 'sec-4', category }))]));
        expect(message, category).toContain('sec-4: security category이거나 critical');
      }
    });

    it('원본이 security/xss인데 병합하면서 quality로 바꿔서 뺀 경우', () => {
      const original = issue({ id: 'issue-5', category: 'security/xss', severity: 'warning' });
      const id = open({ 'security-reviewer': [original] });

      const message = rejection(
        id,
        consensus(
          [],
          [drop({ ...original, category: 'quality', reportedBy: 'security-reviewer' })],
        ),
      );

      expect(message).toContain('review_submit 원본이 warning/security/xss');
    });

    it('걸린 이슈가 여럿이면 에러 하나에 전부 적는다', () => {
      const id = open();
      const message = rejection(
        id,
        consensus(
          [],
          [
            drop(issue({ id: 'a', category: 'SECURITY:xss' })),
            drop(issue({ id: 'b', severity: 'critical' })),
            drop(issue({ id: 'c' }), { dropEvidence: '   ' }),
          ],
        ),
      );

      expect(message).toMatch(/- a: /);
      expect(message).toMatch(/- b: /);
      expect(message).toMatch(/- c: /);
    });
  });

  describe('병합하면서 바꾼 값으로 금지를 피하면 review_submit 원본과 대조해 거부한다', () => {
    it('원본이 critical인데 high로 낮춰서 뺀 경우', () => {
      const original = issue({ id: 'issue-1', severity: 'critical', category: 'quality' });
      const id = open({ 'quality-reviewer': [original] });

      const message = rejection(
        id,
        consensus([], [drop({ ...original, severity: 'high', reportedBy: 'quality-reviewer' })]),
      );

      expect(message).toContain('issue-1');
      expect(message).toContain('review_submit 원본');
    });

    it('원본이 security인데 category를 quality로 바꿔서 뺀 경우', () => {
      const original = issue({ id: 'issue-1', category: 'security', severity: 'high' });
      const id = open({ 'security-reviewer': [original] });

      const message = rejection(
        id,
        consensus(
          [],
          [drop({ ...original, category: 'quality', reportedBy: 'security-reviewer' })],
        ),
      );

      expect(message).toContain('issue-1');
      expect(message).toContain('review_submit 원본이 high/security');
    });

    it('원본이 security:secrets인데 severity와 category를 둘 다 바꿔서 뺀 경우', () => {
      const original = issue({ id: 'issue-7', category: 'security:secrets', severity: 'high' });
      const id = open({ 'security-reviewer': [original] });

      const message = rejection(
        id,
        consensus(
          [],
          [
            drop({
              ...original,
              severity: 'warning',
              category: 'quality',
              reportedBy: 'security-reviewer',
            }),
          ],
        ),
      );

      expect(message).toContain('review_submit 원본이 high/security:secrets');
    });

    it('id를 <reportedBy>:<원래 id> 꼴로 고유화한 뒤 바꿔서 뺀 경우', () => {
      const original = issue({ id: 'issue-1', category: 'security', severity: 'high' });
      const id = open({
        'security-reviewer': [original],
        'quality-reviewer': [issue({ id: 'issue-1', severity: 'warning' })],
      });

      const message = rejection(
        id,
        consensus(
          [],
          [
            drop({
              ...original,
              id: 'security-reviewer:issue-1',
              severity: 'warning',
              category: 'quality',
              reportedBy: 'security-reviewer',
            }),
          ],
        ),
      );

      expect(message).toContain('security-reviewer:issue-1');
      expect(message).toContain('review_submit 원본');
    });

    // 3.7단계 입력 준비 1번은 여러 리뷰어가 같은 자리를 짚었으면 reportedBy를 대표 하나로
    // 적으라고 한다. id가 원래 리뷰어를 이미 밝히는데 reportedBy가 대표로 바뀌었다고
    // 대조를 놓치면, 병합이 곧 금지를 피하는 길이 된다
    it('고유화한 id가 원래 리뷰어를 밝히면 reportedBy를 대표로 바꿔도 원본을 찾는다', () => {
      const original = issue({ id: 'issue-1', category: 'security', severity: 'high' });
      const id = open({
        'security-reviewer': [original],
        'quality-reviewer': [issue({ id: 'issue-1', severity: 'warning' })],
      });

      const result = engine.submitConsensus(
        id,
        consensus(
          [],
          [
            drop({
              ...original,
              id: 'security-reviewer:issue-1',
              severity: 'warning',
              category: 'quality',
              reportedBy: 'quality-reviewer',
            }),
          ],
        ),
      );

      expect(result.ok, 'id가 security-reviewer 원본을 가리키는데 drop이 통과했다').toBe(false);
    });

    it('리뷰어마다 같은 id를 썼을 때 접두 없는 id는 거부하고 접두 붙은 id는 그 리뷰어 원본만 본다', () => {
      const id = open({
        'security-reviewer': [issue({ id: 'issue-1', category: 'security', severity: 'high' })],
        'quality-reviewer': [issue({ id: 'issue-1', severity: 'warning' })],
      });

      // 접두가 없으면 어느 리뷰어의 issue-1인지 갈 수 없다. 후보 중 하나가 security라 막는다
      const bare = engine.submitConsensus(
        id,
        consensus(
          [],
          [drop(issue({ id: 'issue-1', severity: 'warning', reportedBy: 'quality-reviewer' }))],
        ),
      );
      expect(bare.ok).toBe(false);
      if (!bare.ok) expect(bare.error.message).toContain('review_submit 원본이 high/security');

      const prefixed = engine.submitConsensus(
        id,
        consensus(
          [],
          [
            drop(
              issue({
                id: 'quality-reviewer:issue-1',
                severity: 'warning',
                reportedBy: 'quality-reviewer',
              }),
            ),
          ],
        ),
      );
      expect(prefixed.ok).toBe(true);
    });

    it('접두 없는 id에서 reportedBy만 다른 리뷰어로 바꿔 뺀 경우', () => {
      const original = issue({ id: 'issue-1', category: 'security', severity: 'high' });
      const id = open({ 'security-reviewer': [original] });

      const message = rejection(
        id,
        consensus(
          [],
          [
            drop({
              ...original,
              severity: 'warning',
              category: 'quality',
              reportedBy: 'quality-reviewer',
            }),
          ],
        ),
      );

      expect(message).toContain('review_submit 원본이 high/security');
    });

    it('reportedBy를 대소문자만 바꿔 적어 뺀 경우', () => {
      const original = issue({ id: 'issue-1', severity: 'critical', category: 'quality' });
      const id = open({ 'quality-reviewer': [original] });

      const message = rejection(
        id,
        consensus([], [drop({ ...original, severity: 'high', reportedBy: 'Quality-Reviewer ' })]),
      );

      expect(message).toContain('review_submit 원본이 critical/quality');
    });

    it('접두 대소문자를 바꾸거나 id 앞에 공백을 붙여 뺀 경우', () => {
      const original = issue({ id: 'issue-1', category: 'security', severity: 'high' });
      const id = open({ 'security-reviewer': [original] });

      for (const dropId of ['Security-Reviewer:issue-1', ' issue-1', 'ISSUE-1 ']) {
        const message = rejection(
          id,
          consensus(
            [],
            [drop({ ...original, id: dropId, severity: 'warning', category: 'quality' })],
          ),
        );
        expect(message, dropId).toContain('review_submit 원본이 high/security');
      }
    });

    it('접두는 다른 리뷰어를 가리키고 reportedBy 쪽 리뷰어의 같은 id가 security인 경우', () => {
      const id = open({
        'quality-reviewer': [issue({ id: 'issue-3', category: 'quality', severity: 'warning' })],
        'security-reviewer': [issue({ id: 'issue-3', category: 'security', severity: 'high' })],
      });

      const message = rejection(
        id,
        consensus(
          [],
          [
            drop(
              issue({
                id: 'quality-reviewer:issue-3',
                category: 'quality',
                severity: 'warning',
                reportedBy: 'security-reviewer',
              }),
            ),
          ],
        ),
      );

      expect(message).toContain('review_submit 원본이 high/security');
    });

    it('접두와 reportedBy가 같은 리뷰어를 가리키면 다른 리뷰어의 같은 id는 안 본다', () => {
      const id = open({
        'quality-reviewer': [issue({ id: 'issue-3', category: 'quality', severity: 'warning' })],
        'security-reviewer': [issue({ id: 'issue-3', category: 'security', severity: 'high' })],
      });

      const result = engine.submitConsensus(
        id,
        consensus(
          [],
          [
            drop(
              issue({
                id: 'quality-reviewer:issue-3',
                category: 'quality',
                severity: 'warning',
                reportedBy: 'quality-reviewer',
              }),
            ),
          ],
        ),
      );

      expect(result.ok).toBe(true);
    });

    it('원본을 못 찾으면 통과시킨다', () => {
      const id = open({
        'security-reviewer': [issue({ id: 'issue-1', category: 'security', severity: 'high' })],
      });

      const result = engine.submitConsensus(
        id,
        consensus([], [drop(issue({ id: 'perf-9', category: 'performance' }))]),
      );

      expect(result.ok).toBe(true);
    });

    it('접두 꼴이어도 그 리뷰어가 낸 적 없는 id면 후보가 없어 통과시킨다', () => {
      const id = open({
        'security-reviewer': [issue({ id: 'issue-1', category: 'security', severity: 'high' })],
      });

      const result = engine.submitConsensus(
        id,
        consensus(
          [],
          [drop(issue({ id: 'performance-reviewer:issue-2', category: 'performance' }))],
        ),
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('근거가 비었으면 거부한다', () => {
    const blanks = ['', ' ', '   ', '\n', '\t \n '];
    // 제로폭 공백, 단어 결합자, BOM처럼 trim()에 안 걸리는 보이지 않는 문자와 문장부호뿐인 값
    const invisible = ['\u200b', '\u200b\u200b', ' \u2060\ufeff\u200b ', '\u00a0\u3000', '- . -'];

    it('공백뿐인 dropReason', () => {
      const id = open();
      for (const blank of blanks) {
        const message = rejection(
          id,
          consensus([], [drop(issue({ id: 'r-1' }), { dropReason: blank })]),
        );
        expect(message, JSON.stringify(blank)).toContain('r-1');
      }
    });

    it('공백뿐인 dropEvidence', () => {
      const id = open();
      for (const blank of blanks) {
        const message = rejection(
          id,
          consensus([], [drop(issue({ id: 'e-1' }), { dropEvidence: blank })]),
        );
        expect(message, JSON.stringify(blank)).toContain('e-1');
      }
    });

    it('글자나 숫자 없이 보이지 않는 문자나 문장부호만 있는 dropReason', () => {
      const id = open();
      for (const value of invisible) {
        const message = rejection(
          id,
          consensus([], [drop(issue({ id: 'z-1' }), { dropReason: value })]),
        );
        expect(message, JSON.stringify(value)).toContain('z-1');
      }
    });

    it('글자나 숫자 없이 보이지 않는 문자나 문장부호만 있는 dropEvidence', () => {
      const id = open();
      for (const value of invisible) {
        const message = rejection(
          id,
          consensus([], [drop(issue({ id: 'z-2' }), { dropEvidence: value })]),
        );
        expect(message, JSON.stringify(value)).toContain('z-2');
      }
    });

    it('숫자만 있거나 한글만 있는 근거는 받는다', () => {
      const id = open();
      for (const value of ['404', '없음', '\u200b규칙 폐지\u200b']) {
        const result = engine.submitConsensus(
          id,
          consensus([], [drop(issue({ id: 'ok-1' }), { dropReason: value, dropEvidence: value })]),
        );
        expect(result.ok, JSON.stringify(value)).toBe(true);
      }
    });
  });

  it('droppedIssues 안에 같은 id가 두 번 있으면 거부하고 세션을 안 바꾼다', () => {
    const id = open();
    const twice = drop(issue({ id: 'twice', severity: 'warning' }));

    const message = rejection(id, consensus([], [twice, { ...twice, message: '다른 문구' }]));

    expect(message).toContain('twice: droppedIssues 안에 같은 id가 두 번 있다');
    expect(engine.getSession(id).consensus).toBeUndefined();
  });

  it('같은 id가 mergedIssues와 droppedIssues 양쪽에 있으면 거부한다', () => {
    const id = open();
    const both = issue({ id: 'dup-1', severity: 'warning' });

    const message = rejection(id, consensus([both], [drop(both)]));

    expect(message).toContain('dup-1');
    expect(message).toContain('mergedIssues');
  });

  describe('거부된 호출은 세션에 아무것도 남기지 않는다', () => {
    const coherent: ContinuityVerdict = {
      coherent: true,
      driftFindings: [],
      escalate: false,
      summary: '정합',
    };
    const incoherent: ContinuityVerdict = {
      coherent: false,
      driftFindings: [{ axis: 'drift', message: '이탈' }],
      escalate: true,
      summary: '거부될 호출에 딸려 온 판정',
    };

    it('앞서 받은 합의와 정합 판정, 리포트, 상태가 그대로다', () => {
      const id = open();
      const accepted = consensus([issue({ id: 'keep-1', severity: 'warning' })]);
      expect(engine.submitConsensus(id, accepted, coherent).ok).toBe(true);

      const session = engine.getSession(id);
      const before = JSON.stringify({
        consensus: session.consensus,
        continuityVerdict: session.continuityVerdict,
        status: session.status,
        updatedAt: session.updatedAt,
        reports: session.reports,
      });
      const eventsBefore = store.getByAggregate('review', id).length;

      rejection(
        id,
        consensus(
          [issue({ id: 'other', severity: 'critical' })],
          [drop(issue({ id: 'sec', category: 'Security:auth' }))],
        ),
      );
      // incoherent 판정까지 같이 넘겨도 세션에 안 들어가야 한다
      const withVerdict = engine.submitConsensus(
        id,
        consensus([], [drop(issue({ id: 'crit', severity: 'critical' }))]),
        incoherent,
      );
      expect(withVerdict.ok).toBe(false);

      const after = engine.getSession(id);
      expect(
        JSON.stringify({
          consensus: after.consensus,
          continuityVerdict: after.continuityVerdict,
          status: after.status,
          updatedAt: after.updatedAt,
          reports: after.reports,
        }),
      ).toBe(before);
      expect(store.getByAggregate('review', id).length).toBe(eventsBefore);
    });

    it('합의가 아직 없던 세션이면 계속 비어 있다', () => {
      const id = open({ 'security-reviewer': [issue({ id: 's', category: 'security' })] });
      const statusBefore = engine.getSession(id).status;

      rejection(id, consensus([], [drop(issue({ id: 's', category: 'security' }))]));

      const session = engine.getSession(id);
      expect(session.consensus).toBeUndefined();
      expect(session.continuityVerdict).toBeUndefined();
      expect(session.reports).toHaveLength(0);
      expect(session.status).toBe(statusBefore);
      expect(consensusEvents(id)).toHaveLength(0);
    });

    it('거부 뒤 review_fix는 합의가 없다고 알린다', () => {
      const id = open();

      rejection(id, consensus([], [drop(issue({ id: 'x', severity: 'critical' }))]));

      const fix = engine.startFix(id);
      expect(fix.ok).toBe(false);
      expect(engine.getSession(id).currentAttempt).toBe(0);
    });
  });

  describe('받아들인 drop', () => {
    it('뺀 high는 criticalHighCount와 판정에서 빠진다', () => {
      const id = open();

      const result = engine.submitConsensus(
        id,
        consensus(
          [issue({ id: 'w', severity: 'warning' })],
          [drop(issue({ id: 'h', severity: 'high', category: 'performance' }))],
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.criticalHighCount).toBe(0);
      expect(result.value.approved).toBe(true);
      expect(engine.getSession(id).consensus!.droppedIssues).toHaveLength(1);
    });

    it('빈 droppedIssues 배열은 생략한 것과 같다', () => {
      const id = open();

      const result = engine.submitConsensus(
        id,
        consensus([issue({ id: 'h', severity: 'high' })], []),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.verification.drop).toBe(0);
      expect(result.value.criticalHighCount).toBe(1);
    });
  });

  describe('검증 통계', () => {
    it('반환값과 consensus 이벤트 payload에 같은 통계가 실린다', () => {
      const id = open();

      const result = engine.submitConsensus(
        id,
        consensus(
          [
            issue({ id: 'k', severity: 'critical', verification: { verdict: 'keep', reason: '' } }),
            issue({
              id: 'r',
              verification: { verdict: 'revise', reason: '깨짐', originalSuggestion: '원래' },
            }),
            issue({ id: 'u', severity: 'high' }),
          ],
          [drop(issue({ id: 'd', severity: 'warning' }))],
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expected = { keep: 1, revise: 1, drop: 1, unverifiedCriticalHigh: 1 };
      expect(result.value.verification).toEqual(expected);

      const events = consensusEvents(id);
      expect(events).toHaveLength(1);
      expect((events[0]!.payload as { verification: unknown }).verification).toEqual(expected);
    });

    it('새 필드 없이 부르던 입력은 판정이 그대로이고 전부 미검증으로 센다', () => {
      const id = open();

      const result = engine.submitConsensus(
        id,
        consensus([
          issue({ id: 'c', severity: 'critical', category: 'security' }),
          issue({ id: 'w', severity: 'warning' }),
        ]),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.approved).toBe(false);
      expect(result.value.criticalHighCount).toBe(1);
      expect(result.value.canFix).toBe(true);
      expect(result.value.verification).toEqual({
        keep: 0,
        revise: 0,
        drop: 0,
        unverifiedCriticalHigh: 1,
      });
    });
  });

  describe('review_fix 프롬프트', () => {
    it('critical과 high 이슈의 alsoCheck를 수정 지시에 싣는다', () => {
      const id = open();
      engine.submitConsensus(
        id,
        consensus([
          issue({
            id: 'h',
            severity: 'high',
            file: 'src/api.ts',
            line: 42,
            verification: {
              verdict: 'keep',
              reason: '안전',
              alsoCheck: ['src/api.test.ts:88 호출부 인자', 'docs/api.md 예시'],
            },
          }),
        ]),
      );

      const fix = engine.startFix(id);
      expect(fix.ok).toBe(true);
      if (!fix.ok || 'exhausted' in fix.value) throw new Error('수정 컨텍스트가 와야 한다');

      const prompt = fix.value.fixPrompt;
      expect(prompt).toContain('Also update when applying this fix:');
      expect(prompt).toContain('    - src/api.test.ts:88 호출부 인자');
      expect(prompt).toContain('    - docs/api.md 예시');
      // alsoCheck는 해당 이슈의 제안 바로 아래에 붙는다
      expect(prompt.indexOf('Suggestion: 제안 h')).toBeLessThan(
        prompt.indexOf('Also update when applying this fix:'),
      );
    });

    it('alsoCheck가 없거나 비면 줄을 붙이지 않는다', () => {
      const id = open();
      engine.submitConsensus(
        id,
        consensus([
          issue({ id: 'a', severity: 'high' }),
          issue({
            id: 'b',
            severity: 'critical',
            verification: { verdict: 'keep', reason: '', alsoCheck: [] },
          }),
        ]),
      );

      const fix = engine.startFix(id);
      if (!fix.ok || 'exhausted' in fix.value) throw new Error('수정 컨텍스트가 와야 한다');
      expect(fix.value.fixPrompt).not.toContain('Also update when applying this fix:');
    });

    it('뺀 이슈는 수정 대상에 안 들어간다', () => {
      const id = open();
      engine.submitConsensus(
        id,
        consensus(
          [issue({ id: 'h', severity: 'high', message: '남은 문제' })],
          [drop(issue({ id: 'd', severity: 'high', message: '뺀 문제' }))],
        ),
      );

      const fix = engine.startFix(id);
      if (!fix.ok || 'exhausted' in fix.value) throw new Error('수정 컨텍스트가 와야 한다');
      expect(fix.value.fixPrompt).toContain('남은 문제');
      expect(fix.value.fixPrompt).not.toContain('뺀 문제');
    });

    it('시도 횟수를 다 쓰고 나온 리포트에도 뺀 이슈 절이 따라간다', () => {
      const id = open();
      engine.submitConsensus(
        id,
        consensus(
          [issue({ id: 'h', severity: 'high' })],
          [drop(issue({ id: 'd', severity: 'high', message: '뺀 문제' }))],
        ),
      );

      let last = engine.startFix(id);
      for (let i = 0; i < 3; i++) last = engine.startFix(id);

      expect(last.ok).toBe(true);
      if (!last.ok || !('exhausted' in last.value)) throw new Error('소진 리포트가 와야 한다');
      expect(last.value.report.markdown).toContain('## 검증에서 뺀 이슈 (1개)');
      expect(last.value.report.markdown).toContain('### 뺀 문제');
    });
  });
});

describe('checkDroppedIssues', () => {
  it('droppedIssues가 없거나 비면 null이다', () => {
    expect(checkDroppedIssues(consensus([]), [])).toBeNull();
    expect(checkDroppedIssues(consensus([], []), [])).toBeNull();
  });

  it('review_submit 원본이 하나도 없으면 입력만 보고 판단한다', () => {
    expect(checkDroppedIssues(consensus([], [drop(issue({ id: 'ok' }))]), [])).toBeNull();
    expect(
      checkDroppedIssues(consensus([], [drop(issue({ id: 'no', category: 'security' }))]), []),
    ).not.toBeNull();
  });
});
