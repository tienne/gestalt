/**
 * 정규식이 병리 입력에서 선형으로 도는지 본다.
 *
 * 코퍼스는 무엇이 걸리는지만 세고 얼마나 걸리는지는 안 본다. 그래서 수량자를 넓혀
 * 제곱으로 되돌려도 코퍼스는 초록불이다. I-7 화자 분기가 실제로 그랬다 — 공백 없는
 * 입력에서 4만8천 자가 2980ms 였다. 읽기 상한인 2MB 를 채우면 CLI 가 십 분 넘게 멈춘다.
 *
 * 절대 시간은 기계마다 다르니 배수로 본다. 입력을 열여섯 배 늘렸을 때 시간도 열여섯 배
 * 근처면 선형이다. 제곱이면 이백오십육 배로 뛴다.
 */
import { describe, it, expect } from 'vitest';
import { detect } from '../../../src/humanize/detectors.js';
import { MAX_INPUT_BYTES } from '../../../src/humanize/read-input.js';

/** 공백이 하나도 없어야 화자 분기의 부정 선읽기가 매 위치에서 끝까지 훑는다 */
const pathological = (n: number) => '제가x'.repeat(n);

function elapsed(text: string, ruleId: string, repeat = 1): number {
  const started = process.hrtime.bigint();
  for (let i = 0; i < repeat; i++) detect(text, [ruleId]);
  return Number(process.hrtime.bigint() - started) / 1e6 / repeat;
}

/**
 * 작은 입력과 큰 입력을 번갈아 일곱 번씩 재서 각자 최솟값을 쓴다.
 *
 * 한 번만 재면 GC 정지나 스케줄링 잡음이 그대로 배수에 실린다. 최솟값은 그 꼬리를 자른다.
 * 한쪽을 다 재고 다른 쪽을 재면 부하가 몰린 구간을 한쪽만 맞아, CPU 를 포화시킨 상태에서
 * 선형인데도 배수가 84까지 튀었다. 번갈아 재면 같은 구간을 함께 맞아 31을 안 넘었다.
 *
 * 작은 입력은 한 번에 1ms 도 안 걸려 잡음에 묻히므로 입력 비만큼 되풀이해 한 표본의 길이를
 * 큰 입력과 맞춘다.
 */
function ratio(smallN: number, largeN: number): number {
  const repeat = largeN / smallN;
  const small = pathological(smallN);
  const large = pathological(largeN);
  const smalls: number[] = [];
  const larges: number[] = [];
  for (let i = 0; i < 7; i++) {
    smalls.push(elapsed(small, 'I-7', repeat));
    larges.push(elapsed(large, 'I-7'));
  }
  return Math.min(...larges) / Math.min(...smalls);
}

describe('탐지기 병리 입력', () => {
  it('I-7 화자 분기가 공백 없는 입력에서 선형으로 돈다', () => {
    // 워밍업 — 첫 호출에 JIT 비용이 실려 배수가 뒤틀린다
    elapsed(pathological(1000), 'I-7', 16);

    // 입력 비를 네 배로 두면 선형 4와 제곱 16 사이가 좁아, coverage 를 켠 macOS CI 에서
    // 선형인데도 8을 넘었다. 열여섯 배로 벌려 선형 16과 제곱 256 사이에 둔다.
    // 큰 쪽은 16000 에서 멈춘다 — 제곱으로 회귀하면 한 번에 3초쯤 걸려 일곱 번 재는 데만 20초를
    // 넘긴다. 부하가 걸린 채 재보니 25초에서 45초였다. 더 키우면 피드백이 그만큼 늦다.
    // 기준은 16과 256의 로그 중간인 64다. 이론값으로는 양쪽에 네 배씩 여유가 있지만
    // 부하에서 선형이 31까지 오르므로 선형 쪽 여유는 두 배쯤이다
    expect(ratio(1000, 16000)).toBeLessThan(64);
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
