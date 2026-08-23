import { describe, it, expect, afterEach } from 'vitest';
import {
  consensusVerdict,
  isConsensusApproved,
  openThreads,
  resolveActor,
  unresolvedComments,
  unresolvedCount,
} from '../../../src/local-pr/policy.js';
import type { PullRequest } from '../../../src/local-pr/types.js';
import type { ContinuityVerdict, ReviewIssue } from '../../../src/core/types.js';

/**
 * 표면이 셋이고 산문이 셋 더 있는 규칙들이다.
 *
 * 여기서 값이 갈리면 CLI와 웹이 같은 PR을 다르게 보여주거나, 파이프라인은 통과인데
 * PR은 리젝인 상태가 생긴다. 표면별 테스트로는 두 값이 우연히 같은 입력만 밟는다.
 */

function prWith(comments: { threadId: string; resolved: boolean }[]): PullRequest {
  return {
    id: 'abcd1234',
    comments: comments.map((c, i) => ({ id: `c${i}`, ...c })),
  } as unknown as PullRequest;
}

function issue(severity: ReviewIssue['severity']): ReviewIssue {
  return { id: 'i', severity, category: 'x', file: 'a.ts', message: 'm', suggestion: 's' };
}

const coherent: ContinuityVerdict = {
  coherent: true,
  driftFindings: [],
  escalate: false,
  summary: '',
};
const incoherent: ContinuityVerdict = { ...coherent, coherent: false };

describe('로컬 PR 정책', () => {
  describe('미해결 수', () => {
    it('답글이 달려도 스레드 하나로 센다', () => {
      const pr = prWith([
        { threadId: 't1', resolved: false },
        { threadId: 't1', resolved: false },
        { threadId: 't1', resolved: false },
      ]);

      // 코멘트를 세면 3이 나온다. 답할수록 나빠 보이는 신호는 티키타카를 말린다
      expect(unresolvedCount(pr)).toBe(1);
    });

    it('닫힌 스레드는 안 센다', () => {
      const pr = prWith([
        { threadId: 't1', resolved: true },
        { threadId: 't2', resolved: false },
      ]);

      expect(unresolvedCount(pr)).toBe(1);
    });

    it('헤아린 수와 늘어놓을 목록이 같은 계산에서 나온다', () => {
      // `pr show`가 머리글에 스레드를, 바로 아래 목록에 코멘트를 세어 "미해결 1"이라
      // 찍어놓고 세 줄을 늘어놓았다. 한 화면에서 같은 단어가 다른 수를 가리켰다
      const pr = prWith([
        { threadId: 't1', resolved: false },
        { threadId: 't1', resolved: false },
        { threadId: 't2', resolved: true },
        { threadId: 't3', resolved: false },
      ]);

      const threads = openThreads(pr);

      expect(threads).toHaveLength(unresolvedCount(pr));
      expect(threads.map((t) => t.root.id)).toEqual(['c0', 'c3']);
      // 뿌리와 답글이 한 스레드로 묶이고 답글 수를 표면이 셀 수 있다
      expect(threads[0]!.comments).toHaveLength(2);
      // 늘어놓는 자리(`pr comments --unresolved`)도 같은 술어에서 나온다
      expect(unresolvedComments(pr).map((c) => c.id)).toEqual(['c0', 'c1', 'c3']);
    });
  });

  describe('작업자 해석', () => {
    const saved = process.env['GESTALT_ACTOR'];
    afterEach(() => {
      if (saved === undefined) delete process.env['GESTALT_ACTOR'];
      else process.env['GESTALT_ACTOR'] = saved;
    });

    it('명시한 값이 환경변수보다 앞선다', () => {
      process.env['GESTALT_ACTOR'] = 'codex:worker-1';

      expect(resolveActor('human:tienne')).toBe('human:tienne');
    });

    it('안 주면 환경변수를 본다', () => {
      process.env['GESTALT_ACTOR'] = 'codex:worker-1';

      expect(resolveActor()).toBe('codex:worker-1');
    });

    it('환경변수도 없으면 fallback이고 기본은 human:local이다', () => {
      delete process.env['GESTALT_ACTOR'];

      expect(resolveActor()).toBe('human:local');
      expect(resolveActor(undefined, 'gestalt:review')).toBe('gestalt:review');
    });
  });

  describe('판정 경계', () => {
    it('critical이나 high가 하나라도 있으면 막는다', () => {
      expect(isConsensusApproved([issue('warning'), issue('high')], coherent)).toBe(false);
      expect(isConsensusApproved([issue('critical')], coherent)).toBe(false);
    });

    it('warning만 있으면 통과다', () => {
      expect(isConsensusApproved([issue('warning'), issue('warning')], coherent)).toBe(true);
    });

    it('정합 심급이 막으면 결함이 없어도 막는다', () => {
      expect(isConsensusApproved([], incoherent)).toBe(false);
    });

    it('정합 판정이 없으면 결함만 본다', () => {
      expect(isConsensusApproved([])).toBe(true);
      expect(isConsensusApproved([issue('high')])).toBe(false);
    });

    it('PR 판정이 같은 경계를 그대로 쓴다', () => {
      // 두 함수가 갈리면 파이프라인은 통과인데 PR은 리젝인 상태가 생긴다
      const cases: [ReviewIssue[], ContinuityVerdict | undefined][] = [
        [[], coherent],
        [[issue('warning')], coherent],
        [[issue('high')], coherent],
        [[issue('critical')], incoherent],
        [[], incoherent],
        [[], undefined],
      ];

      for (const [issues, verdict] of cases) {
        const approved = isConsensusApproved(issues, verdict);
        expect(consensusVerdict(issues, verdict)).toBe(approved ? 'approve' : 'request_changes');
      }
    });
  });
});
