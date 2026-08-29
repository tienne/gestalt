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

/**
 * 세 번 재서 최솟값을 쓴다.
 *
 * 한 번만 재면 GC 정지나 스케줄링 잡음이 그대로 배수에 실린다. CPU 를 포화시킨 상태에서
 * 재보니 한 번 재기는 배수가 2.3에서 5.5까지 벌어졌다. 최솟값은 그 꼬리를 잘라 4 근처로
 * 눌린다 — 제곱 회귀의 16배와는 여전히 네 배 넘게 갈린다.
 */
function best(n: number): number {
  return Math.min(...[0, 1, 2].map(() => elapsed(pathological(n), 'I-7')));
}

describe('탐지기 병리 입력', () => {
  it('I-7 화자 갈래가 공백 없는 입력에서 선형으로 돈다', () => {
    // 워밍업 — 첫 호출에 JIT 비용이 실려 배수가 뒤틀린다
    elapsed(pathological(1000), 'I-7');

    const small = Math.max(best(4000), 0.5);
    const large = best(16000);

    // 입력이 네 배다. 선형이면 네 배 근처, 제곱이면 열여섯 배가 된다
    expect(large / small).toBeLessThan(8);
  });

  it('읽기 상한의 삼분의 일쯤 되는 입력도 한 번에 끝난다', () => {
    // 상한인 2MB 를 그대로 넣으면 회귀했을 때 이 자리가 이 분 넘게 동기로 붙잡는다.
    // vitest 는 동기 블록을 못 끊어서 피드백만 늦어진다. 앞 배수 테스트가 이미 회귀를
    // 잡으므로 여기는 절대 시간만 확인하고 크기를 줄인다
    const text = pathological(90000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_INPUT_BYTES / 4);
    expect(elapsed(text, 'I-7')).toBeLessThan(1000);
  });
});
