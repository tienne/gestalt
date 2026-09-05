/**
 * 용어 추출이 병리 입력에서 선형으로 도는지 본다.
 *
 * terms.test.ts 는 무엇이 걸리는지만 세고 얼마나 걸리는지는 안 본다. 그래서 용어마다
 * 전체를 재훑는 꼴로 되돌려도 그쪽은 초록불이다. 실제로 그랬다 — 1.9MB 입력에서
 * extractTerms 하나에 수십 초였고, 그게 readInput 이 허용하는 크기다.
 * humanize 쪽 detector-perf.test.ts 가 같은 자리를 같은 방식으로 붙잡는다.
 *
 * 절대 시간은 기계마다 다르니 배수로 본다. 입력을 네 배 늘렸을 때 시간도 네 배 근처면
 * 선형이다. 열여섯 배로 뛰면 제곱이다.
 */
import { describe, it, expect } from 'vitest';
import { extractTerms, findTermUses } from '../../../src/explain/index.js';

/** 줄마다 새 식별자와 경로가 나와 후보 수가 텍스트 길이와 함께 는다 */
function synthetic(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(
      `ESM 로더가 src/mod${i}/handler${i}.ts 에서 resolveThing${i} 를 찾다 ERR_CODE_${i} 로 멈췄다.`,
    );
  }
  return out.join('\n');
}

function elapsed(text: string): number {
  const started = process.hrtime.bigint();
  extractTerms(text);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** 세 번 재서 최솟값을 쓴다. 한 번만 재면 GC 정지가 그대로 배수에 실린다 */
function best(lines: number): number {
  const text = synthetic(lines);
  return Math.min(...[0, 1, 2].map(() => elapsed(text)));
}

describe('용어 추출 병리 입력', () => {
  it('입력을 네 배 늘려도 시간이 선형에 가깝다', () => {
    // 워밍업 — 첫 호출에 JIT 비용이 실려 배수가 뒤틀린다
    elapsed(synthetic(200));

    const small = Math.max(best(2000), 0.5);
    const large = best(8000);

    expect(large / small).toBeLessThan(8);
  });

  it('용어가 많아도 상한에서 잘린다', () => {
    // 후보 수가 텍스트 길이와 함께 늘면 교대 정규식이 감당 못 할 크기가 된다
    expect(extractTerms(synthetic(5000)).length).toBeLessThanOrEqual(1000);
  });

  it('용어가 많은 설명본도 한 번에 훑는다', () => {
    const text = synthetic(4000);
    const terms = extractTerms(text);
    const started = process.hrtime.bigint();
    findTermUses(text, terms);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
  });
});
