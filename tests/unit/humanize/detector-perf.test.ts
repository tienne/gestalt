/**
 * 정규식이 병리 입력에서 선형으로 도는지 본다.
 *
 * 코퍼스는 무엇이 걸리는지만 세고 얼마나 걸리는지는 안 본다. 그래서 수량자를 넓혀
 * 제곱으로 되돌려도 코퍼스는 초록불이다. I-7 화자 갈래가 실제로 그랬다 — 공백 없는
 * 입력에서 4만8천 자가 2980ms 였다. 읽기 상한인 2MB 를 채우면 CLI 가 십 분 넘게 멈춘다.
 *
 * 절대 시간은 기계마다 다르니 배수로 본다. 입력을 네 배 늘렸을 때 시간도 네 배 근처면
 * 선형이다. 열여섯 배로 뛰면 제곱이다.
 */
import { describe, it, expect } from 'vitest';
import { detect } from '../../../src/humanize/detectors.js';
import { MAX_INPUT_BYTES } from '../../../src/humanize/read-input.js';

/** 공백이 하나도 없어야 화자 갈래의 부정 선읽기가 매 위치에서 끝까지 훑는다 */
const pathological = (n: number) => '제가x'.repeat(n);

function elapsed(text: string, ruleId: string): number {
  const started = process.hrtime.bigint();
  detect(text, [ruleId]);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe('탐지기 병리 입력', () => {
  it('I-7 화자 갈래가 공백 없는 입력에서 선형으로 돈다', () => {
    // 워밍업 — 첫 호출에 JIT 비용이 실려 배수가 뒤틀린다
    elapsed(pathological(1000), 'I-7');

    const small = Math.max(elapsed(pathological(4000), 'I-7'), 0.5);
    const large = elapsed(pathological(16000), 'I-7');

    // 입력이 네 배다. 선형이면 네 배 근처, 제곱이면 열여섯 배가 된다
    expect(large / small).toBeLessThan(8);
  });

  it('읽기 상한만 한 입력도 한 번에 끝난다', () => {
    // humanize-scan 이 2MB 까지 받는다. "제가x" 한 벌이 7바이트라 285000 번이면 그 언저리다.
    // 상한을 실제로 밟아야 다음 사람이 정규식을 넓혔을 때 이 자리가 잡아준다
    const text = pathological(285000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_INPUT_BYTES * 0.95);
    expect(elapsed(text, 'I-7')).toBeLessThan(2000);
  });
});
