import { describe, expect, it } from 'vitest';
import {
  deriveSignal,
  SIGNAL_ACTION,
  type LoopSignal,
  type LoopState,
} from '../../../src/review-loop/signal.js';

/**
 * 신호 도출은 이 루프의 중심 판단이다. 재리뷰할지, 사람에게 넘길지, 끝낼지가 여기서
 * 갈린다. 문서에 셸로 적혀 있던 때는 이 규칙이 감시 스크립트 안에만 있었고 그 스크립트를
 * 지우면서 함께 사라져, 판정 표가 만들어지지 않는 이름으로 분기하고 있었다.
 */
describe('네 값에서 다음에 할 일을 정한다', () => {
  const state = (o: Partial<LoopState> = {}): LoopState => ({
    open: true,
    reviewed: true,
    pending: 0,
    changed: false,
    rerequested: false,
    ...o,
  });

  it('닫힌 PR은 나머지를 안 본다', () => {
    expect(deriveSignal(state({ open: false }))).toBe('CLOSED');
    // 재리뷰 요청이 남아 있어도 닫힌 PR은 볼 게 없다
    expect(deriveSignal(state({ open: false, rerequested: true, pending: 3 }))).toBe('CLOSED');
  });

  it('작성자가 다시 봐달라고 눌렀으면 미대응이 남아도 간다', () => {
    expect(deriveSignal(state({ rerequested: true, pending: 5 }))).toBe('REREVIEW_REQUESTED');
  });

  it('미대응이 남으면 기다린다', () => {
    expect(deriveSignal(state({ pending: 1 }))).toBe('WAITING');
    // 새 커밋이 와도 아직 안 고친 스레드가 있으면 마찬가지다
    expect(deriveSignal(state({ pending: 1, changed: true }))).toBe('WAITING');
  });

  it('전부 대응됐고 새 커밋이 있으면 재리뷰한다', () => {
    expect(deriveSignal(state({ pending: 0, changed: true }))).toBe('READY');
  });

  /**
   * 실제 PR 에 돌려보고 나온 자리다. 아직 한 번도 안 본 PR 이 "답만 오고 코드는
   * 그대로" 로 읽혀 사람에게 넘어갔다.
   */
  it('아직 안 본 PR 은 볼 때다', () => {
    expect(deriveSignal(state({ reviewed: false, changed: false }))).toBe('READY');
    expect(deriveSignal(state({ reviewed: false, changed: true }))).toBe('READY');
  });

  it('전부 대응됐는데 코드가 그대로면 사람에게 넘긴다', () => {
    // 답만 오고 코드는 안 바뀐 자리다. 다시 읽으면 같은 의견이 또 나온다
    expect(deriveSignal(state({ pending: 0, changed: false }))).toBe('REPLIES_ONLY');
  });

  it('다섯 값의 곱집합이 전부 어느 한 쪽으로 간다', () => {
    const signals = new Set<LoopSignal>();
    for (const open of [true, false]) {
      for (const reviewed of [true, false]) {
        for (const pending of [0, 1, 7]) {
          for (const changed of [true, false]) {
            for (const rerequested of [true, false]) {
              const signal = deriveSignal({ open, reviewed, pending, changed, rerequested });
              expect(SIGNAL_ACTION[signal], `${signal} 에 할 일이 안 적혀 있다`).toBeTruthy();
              signals.add(signal);
            }
          }
        }
      }
    }
    // 다섯 신호가 전부 실제로 도달 가능해야 한다. 아무도 못 내는 신호는 죽은 분기다
    expect([...signals].sort()).toEqual([
      'CLOSED',
      'READY',
      'REPLIES_ONLY',
      'REREVIEW_REQUESTED',
      'WAITING',
    ]);
  });
});
