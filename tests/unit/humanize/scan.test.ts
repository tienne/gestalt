/**
 * 스캔은 "이번에 볼 룰"을 좁히는 장치다. 좁히기가 실제로 되는지,
 * 좁히다가 볼 것을 빠뜨리지는 않는지 둘 다 본다.
 */
import { describe, it, expect } from 'vitest';
import { DETECTABLE_RULE_IDS } from '../../../src/humanize/detectors.js';
import { parseRuleBook, s1Ids } from '../../../src/humanize/rules.js';
import { formatScan, scan } from '../../../src/humanize/scan.js';
import { SCAN_EXIT } from '../../../src/cli/commands/humanize-scan.js';

const book = parseRuleBook();

describe('scan', () => {
  it('걸린 룰만 처방과 함께 내놓는다', () => {
    const report = scan('이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.');
    expect(report.hits.map((h) => h.ruleId).sort()).toEqual(['A-1', 'D-1']);
    expect(report.s1Total).toBe(2);
    expect(report.hits.every((h) => h.prescription.length > 0)).toBe(true);
  });

  it('안 걸린 룰은 아예 언급하지 않는다', () => {
    const report = scan('이 문제에 대해 검토했다.');
    const mentioned = new Set(report.hits.map((h) => h.ruleId));
    expect(mentioned.has('D-1')).toBe(false);
    expect(mentioned.size).toBeLessThan(s1Ids(book, 'doc').length);
  });

  it('걸리는 게 없으면 윤문하지 않는다', () => {
    const report = scan('배포는 내일입니다. 롤백 기준도 정했습니다.');
    expect(report.worthHumanizing).toBe(false);
    expect(formatScan(report)).toContain('원문을 그대로 낸다');
  });

  it('말투에 따라 볼 룰이 달라진다', () => {
    const draft = '이 작업을 통해 유지보수성을 손봤습니다.';
    expect(scan(draft, { register: 'doc' }).hits.map((h) => h.ruleId)).not.toContain('A-2');
    expect(scan(draft, { register: 'chat' }).hits.map((h) => h.ruleId)).toContain('A-2');
  });

  it('건수가 많은 룰을 앞에 둔다', () => {
    const draft = '이 문제에 대해, 저 문제에 대해, 그 문제에 대해 봤다. 결론적으로 캐시다.';
    const report = scan(draft);
    expect(report.hits[0]!.ruleId).toBe('A-1');
    expect(report.hits[0]!.count).toBe(3);
  });

  it('탐지기가 없는 S1은 감추지 않고 목록으로 넘긴다', () => {
    const report = scan('이 문제에 대해 검토했다.');
    const detectable = new Set(DETECTABLE_RULE_IDS);
    expect(report.unverifiable.length).toBeGreaterThan(0);
    expect(report.unverifiable.every((id) => !detectable.has(id))).toBe(true);
  });

  it('탐지 가능과 직접 확인을 합치면 그 말투의 S1 전체가 된다', () => {
    for (const register of ['doc', 'chat', 'report'] as const) {
      const report = scan('이 문제에 대해 검토했다.', { register });
      const detectableS1 = s1Ids(book, register).filter((id) =>
        new Set(DETECTABLE_RULE_IDS).has(id),
      );
      const covered = new Set([...detectableS1, ...report.unverifiable]);
      expect([...covered].sort()).toEqual(s1Ids(book, register).sort());
    }
  });
});

describe('SCAN_EXIT', () => {
  // humanize-check 는 판정을 종료 코드로 답한다. scan 도 같은 계약을 지켜야
  // 셸에서 stdout 을 파싱하지 않고 0단계 분기를 탈 수 있다
  it('걸린 게 있으면 0, 없으면 10이다', () => {
    expect(SCAN_EXIT.found).toBe(0);
    expect(SCAN_EXIT.clean).toBe(10);
  });

  it('worthHumanizing 이 종료 코드를 가른다', () => {
    const dirty = scan('이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.');
    const clean = scan('배포는 내일입니다. 롤백 기준도 정했습니다.');
    expect(dirty.worthHumanizing).toBe(true);
    expect(clean.worthHumanizing).toBe(false);
    // 커맨드가 이 값으로 고르는 코드
    expect(dirty.worthHumanizing ? SCAN_EXIT.found : SCAN_EXIT.clean).toBe(0);
    expect(clean.worthHumanizing ? SCAN_EXIT.found : SCAN_EXIT.clean).toBe(10);
  });
});
