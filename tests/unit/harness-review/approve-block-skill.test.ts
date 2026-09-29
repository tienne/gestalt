import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import { sectionStartingWith } from '../../helpers/skill-section.js';
import { decideApproveGate, resolvePostedEvent } from '../../../src/harness-review/approve-gate.js';
import type { ReviewRound } from '../../../src/harness-review/types.js';

const load = (rel: string) => {
  const p = resolve(rel);
  return parseSkillMd(readFileSync(p, 'utf-8'), p);
};
const review = load('plugin/skills/review/SKILL.md');
const loop = load('plugin/skills/review-loop/SKILL.md');

const clean = {
  lookupBlocked: false,
  noGitHubRemote: false,
  relatedPrUnconfirmed: false,
  referenceCheckSkipped: false,
};
const round = (n: number, over: Partial<ReviewRound> = {}): ReviewRound => ({
  roundNumber: n,
  ...clean,
  ...over,
});

describe('approve 차단 규칙 문서 (AC17, AC18)', () => {
  const eventSection = sectionStartingWith(review.body, '#### 리뷰 이벤트 결정');
  const gateSection = sectionStartingWith(loop.body, '#### ⓟ');

  for (const [name, text] of [
    ['review 이벤트 결정', eventSection],
    ['review-loop ⓟ', gateSection],
  ] as const) {
    describe(name, () => {
      it('approve-gate를 부르고 세 이슈를 한 규칙으로 적는다', () => {
        expect(text).toMatch(/approve-gate/);
        for (const w of ['조회 막힘', '원격 없는 레포', '연관 PR 미확정'])
          expect(text).toContain(w);
        expect(text).toMatch(/이번 라운드에 새로 생겼으면/);
      });

      it('명시의 두 형태를 예문으로 든다', () => {
        expect(text).toMatch(/사전 조건 지시/);
        expect(text).toMatch(/라운드 지시/);
        expect(text).toContain('이런 기준에 도달하면 approve 해줘');
        expect(text).toContain('이번 라운드에 될 수 있으면 approve, 코멘트는 그대로');
      });

      it('ⓢ 자동 동의를 명시로 안 친다', () => {
        expect(text).toMatch(/자동 (판정 )?동의/);
        expect(text).toMatch(/--auto-consent/);
        expect(text).toMatch(/명시(가|로)? 아니|명시로 안 치/);
      });
    });
  }

  it('review는 막힘 이유를 리포트에 적고 참조 검사 표시와 잇는다', () => {
    expect(eventSection).toMatch(/reason/);
    expect(eventSection).toMatch(/참조 검사가 빠졌어요/);
  });

  it('review-loop ⓟ는 block이면 질문 없이 comment로 내린다', () => {
    expect(gateSection).toMatch(/`block`이면 ⓟ의 질문을 건너뛰고 판정을 `--comment`/);
  });

  it('review-loop의 신호 두 자리가 approve-gate로 이어진다', () => {
    expect(gateSection).toMatch(/1\.2a/);
    expect(gateSection).toMatch(/unconfirmedRelatedPrs/);
  });
});

describe('approve 차단 판정 고정 (AC17, AC18)', () => {
  it('세 이슈 중 이번 라운드에 새로 생기면 명시해도 차단하고 COMMENT로 내린다', () => {
    for (const issue of ['lookupBlocked', 'noGitHubRemote', 'relatedPrUnconfirmed'] as const) {
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
    }
  });

  it('이전 라운드에 생겼고 새로 생긴 게 없으며 명시했으면 허용한다', () => {
    const history = [round(1, { lookupBlocked: true, referenceCheckSkipped: true })];
    const gate = decideApproveGate({
      history,
      current: { ...clean, lookupBlocked: true, referenceCheckSkipped: true },
      scope: 'thisRound',
    });
    expect(gate.decision).toBe('allow');
    expect(gate.blockingIssuesPriorRounds).toEqual(['lookupBlocked']);
    expect(resolvePostedEvent('APPROVE', gate)).toBe('APPROVE');
  });

  it('이전 라운드부터 이어진 이슈도 명시가 없으면 차단한다', () => {
    const gate = decideApproveGate({
      history: [round(1, { noGitHubRemote: true })],
      current: { ...clean, noGitHubRemote: true },
      scope: 'none',
    });
    expect(gate.decision).toBe('block');
  });

  it('참조 검사를 비운 라운드는 ⓢ 자동 동의가 있어도 명시 없이는 차단한다', () => {
    const gate = decideApproveGate({
      history: [round(1, { referenceCheckSkipped: true })],
      current: { ...clean, referenceCheckSkipped: true },
      scope: 'none',
      autoConsent: true,
    });
    expect(gate.decision).toBe('block');
    expect(gate.reason).toMatch(/ⓢ 자동 동의는 명시로 치지 않는다/);
    expect(resolvePostedEvent('APPROVE', gate)).toBe('COMMENT');
  });

  it('참조 검사를 비운 라운드도 명시가 있으면 나간다', () => {
    const gate = decideApproveGate({
      history: [],
      current: { ...clean, referenceCheckSkipped: true },
      scope: 'precondition',
    });
    expect(gate.decision).toBe('allow');
  });
});
