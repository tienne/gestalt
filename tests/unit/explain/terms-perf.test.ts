/**
 * 읽기 상한 크기의 입력이 CLI 를 멈춰 세우지 않는지 본다.
 *
 * terms.test.ts 는 무엇이 걸리는지만 세고 얼마나 걸리는지는 안 본다. 그래서 용어마다
 * 전체를 재훑는 꼴로 되돌려도 그쪽은 초록불이다. 실제로 그랬다 — 옛 구현은 1.9MB 입력에서
 * extractTerms 하나에 57초가 걸렸다. 그게 readInput 이 허용하는 크기다.
 *
 * 배수로 선형성을 재는 방식을 안 쓴다. humanize 쪽 detector-perf.test.ts 는 그렇게 하지만
 * 그쪽은 정규식 하나를 재고 여기는 정렬과 Map 적재까지 낀 파이프라인이라 절대 시간이 작을 때
 * 잡음이 배수를 통째로 뒤흔든다. 재보니 같은 두 크기에서 배수가 1.3에서 16까지 벌어졌다.
 *
 * 대신 상한 크기 입력의 절대 시간에 넉넉한 천장을 둔다. 옛 구현과 지금 사이가 두 자릿수 배라
 * 기계가 몇 배 느려도 둘이 갈린다.
 */
import { describe, it, expect } from 'vitest';
import { extractTerms, findTermUses } from '../../../src/explain/index.js';
import { MAX_INPUT_BYTES } from '../../../src/humanize/read-input.js';

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

/** readInput 이 허용하는 끝까지 채운다. 그 아래는 이 검사가 지킬 이유가 없는 크기다 */
function atInputCap(): string {
  let lines = 16000;
  let text = synthetic(lines);
  while (Buffer.byteLength(text) < MAX_INPUT_BYTES) {
    lines = Math.ceil(lines * 1.3);
    text = synthetic(lines);
  }
  return text;
}

function elapsed(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** 옛 구현이 57초였다. 5초면 열 배 넘는 여유라 기계 차이를 흡수한다 */
const CEILING_MS = 5000;

describe('용어 추출 병리 입력', () => {
  const text = atInputCap();

  it('읽기 상한 크기 입력을 몇 초 안에 훑는다', () => {
    expect(Buffer.byteLength(text)).toBeGreaterThanOrEqual(MAX_INPUT_BYTES);
    expect(elapsed(() => extractTerms(text))).toBeLessThan(CEILING_MS);
  });

  it('설명본 쪽 대조도 같은 크기에서 버틴다', () => {
    const { terms } = extractTerms(text);
    expect(elapsed(() => findTermUses(text, terms))).toBeLessThan(CEILING_MS);
  });

  it('용어가 많아도 상한에서 잘리고 잘렸다고 알린다', () => {
    // 후보 수가 텍스트 길이와 함께 늘면 교대 정규식이 감당 못 할 크기가 된다.
    // 잘렸다는 사실이 결과에 안 남으면 드물게 나오는 용어가 소리 없이 판정에서 빠진다
    const result = extractTerms(text);
    expect(result.terms.length).toBeLessThanOrEqual(1000);
    expect(result.truncated).toBe(true);
  });

  it('상한 아래면 안 잘렸다고 알린다', () => {
    expect(extractTerms(synthetic(50)).truncated).toBe(false);
  });
});
