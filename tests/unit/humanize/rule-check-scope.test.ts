import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import { countBackticks, proseTargets, stripQuoted } from '../../../scripts/verify-rule-refs.js';
import { raisedEntries } from '../../../scripts/humanize-baseline.js';
import {
  detect,
  splitLines,
  tableCells,
  scanProse,
  DETECTABLE_RULE_IDS,
  TABLE_SCANNED_RULE_IDS,
} from '../../../src/humanize/detectors.js';

/**
 * 검사기 주석이 단언한 것마다 여기에 대응 케이스를 둔다.
 *
 * CM-8을 새로 만든 커밋이 정작 자기 주석 여섯 곳에서 그 룰에 걸렸다. 리뷰가 잡아준
 * 자리를 케이스로 옮긴다.
 */
describe('검사 범위와 예외', () => {
  describe('countBackticks', () => {
    it('정규식 안의 백틱은 세지 않는다', () => {
      expect(countBackticks('const STRUCTURAL = /<!--|-->|```/g;')).toBe(0);
    });

    it('문자열 리터럴 안의 백틱도 세지 않는다', () => {
      expect(countBackticks('const s = "a `b` c";')).toBe(0);
      expect(countBackticks("const s = 'a `b` c';")).toBe(0);
    });

    it('진짜 템플릿 백틱은 센다', () => {
      expect(countBackticks('const t = `시작')).toBe(1);
      expect(countBackticks('const t = `한 줄`;')).toBe(2);
    });
  });

  describe('stripQuoted', () => {
    it('따옴표와 백틱 안을 걷어낸다', () => {
      expect(stripQuoted('설명한다 "잠갔다" 라고')).not.toContain('잠갔다');
      expect(stripQuoted('설명한다 `잠근다` 라고')).not.toContain('잠근다');
    });

    it('감싸지 않은 말은 남긴다', () => {
      expect(stripQuoted('경계를 테스트로 잠갔다')).toContain('잠갔다');
    });
  });

  describe('proseTargets', () => {
    const targets = proseTargets();

    it('src와 scripts, tests를 전부 담는다', () => {
      for (const dir of ['src', 'scripts', 'tests']) {
        expect(targets.some((f) => f.includes(`${sep}${dir}${sep}`))).toBe(true);
      }
    });

    it('문서도 함께 담는다', () => {
      expect(targets.some((f) => f.endsWith('README.ko.md'))).toBe(true);
      expect(targets.some((f) => f.includes(`${sep}docs${sep}`))).toBe(true);
    });
  });

  describe('F-7 탐지기', () => {
    it('기술 비유를 일상 대화에 쓴 자리를 잡는다', () => {
      expect(detect('내용을 증류해서 뽑아낸다', ['F-7']).length).toBeGreaterThan(0);
    });

    it('자물쇠 비유는 이제 F-7이 아니다', () => {
      expect(detect('경계를 테스트로 잠갔다', ['F-7'])).toEqual([]);
    });

    it('기술 비유는 F-10으로 안 샌다', () => {
      expect(detect('내용을 증류해서 뽑아낸다', ['F-10'])).toEqual([]);
    });
  });

  describe('F-10 탐지기', () => {
    it('테스트를 자물쇠에 빗댄 자리를 잡는다', () => {
      for (const line of ['경계를 테스트로 잠갔다', '기준으로 잠근다', '기준에 잠긴 문서']) {
        const hit = detect(line, ['F-10']).find((d) => d.ruleId === 'F-10');
        expect(hit?.count ?? 0).toBeGreaterThan(0);
      }
    });

    // 명사형이 빠지는 건 문자 클래스에 '금'이 없어서다. 뒤의 선읽기가 아니다 —
    // 그건 '잠긴파일'처럼 붙여 쓴 꼴만 막고 띄어 쓴 '잠긴 파일'은 그대로 걸린다
    it('명사로 굳은 잠금은 문자 클래스가 막는다', () => {
      expect(detect('자동 생성 파일은 잠금 파일과 빌드 산출물이다', ['F-10'])).toEqual([]);
    });

    it('부정 부사가 앞에 붙은 잘못 박다는 안 걸린다', () => {
      expect(detect('설정을 잘못 박아넣었다', ['F-10'])).toEqual([]);
    });

    it('관용구를 코드나 규칙에 씌운 자리를 잡는다', () => {
      for (const line of ['타입을 못 박아주세요', '이 규칙은 1번으로 못박는다']) {
        const hit = detect(line, ['F-10']).find((d) => d.ruleId === 'F-10');
        expect(hit?.count ?? 0).toBeGreaterThan(0);
      }
    });

    // 룰이 예외로 둔 자리는 형태로 못 가른다. 사람 사이 합의도 함께 걸리고 걸린 자리를
    // 사람이 다시 본다. 하드코딩 분기만 형태로 빠진다
    it('못이 없는 박아두다는 안 걸린다', () => {
      expect(detect('이 값 그냥 박아두죠', ['F-10'])).toEqual([]);
    });

    it('사람 사이 합의도 걸린다 — 걸린 뒤 사람이 가른다', () => {
      const hit = detect('일정을 못 박았다', ['F-10']).find((d) => d.ruleId === 'F-10');
      expect(hit?.count ?? 0).toBeGreaterThan(0);
    });
  });

  describe('baseline 가드', () => {
    it('올라간 항목만 골라낸다', () => {
      expect(raisedEntries({ 'a.md': 2 }, { 'a.md': 3 })).toHaveLength(1);
    });

    it('내려가거나 그대로면 골라내지 않는다', () => {
      expect(raisedEntries({ 'a.md': 3 }, { 'a.md': 2 })).toEqual([]);
      expect(raisedEntries({ 'a.md': 2 }, { 'a.md': 2 })).toEqual([]);
    });

    it('처음 보는 파일은 0에서 올라간 것으로 본다', () => {
      expect(raisedEntries({}, { 'new.md': 1 })).toHaveLength(1);
    });
  });

  describe('표 셀 어휘 스캔', () => {
    it('TABLE_SCANNED_RULE_IDS 는 전부 탐지기가 있는 룰이다', () => {
      // 탐지기 없는 id 를 넣으면 교집합에서 떨어져 표를 본다고 적어 놓고 한 건도 안 걸린다.
      // B-3 을 그렇게 올렸다가 죽은 항목이 됐다
      const missing = TABLE_SCANNED_RULE_IDS.filter((id) => !DETECTABLE_RULE_IDS.includes(id));
      expect(missing).toEqual([]);
    });

    it('언어 태그 펜스 안의 표는 코드 인용이라 안 본다', () => {
      expect(detect('```json\n| 물질화 | x |\n```\n', ['B-5'])).toEqual([]);
    });

    it('평범한 표 셀의 어휘는 본다', () => {
      expect(detect('| 물질화 | x |\n', ['B-5']).length).toBe(1);
    });

    it('skipTables 를 주면 표를 안 본다', () => {
      expect(detect('| 물질화 | x |\n', ['B-5'], { skipTables: true })).toEqual([]);
    });

    it('excludeQuotes 를 주면 블록인용을 안 본다', () => {
      expect(detect('> 배선이 이상해요\n', ['F-7'], { excludeQuotes: true })).toEqual([]);
      expect(detect('> 배선이 이상해요\n', ['F-7']).length).toBe(1);
    });

    // 탐지 결과로는 이 회귀를 못 가른다. 이스케이프를 안 살린 구현도 그 자리에 역슬래시를
    // 남겨 걸림말이 이어지지 않으므로 양쪽 다 0건이 된다. 나뉜 문자열을 직접 본다
    it('GFM 이스케이프 파이프를 셀 구분자로 안 읽는다', () => {
      const cells = tableCells(splitLines('| a\\|b | c |\n').table);

      expect(cells).toContain('a|b');
      expect(cells).not.toContain('\\');
    });

    it('인용이 남은 산문보다 많으면 allQuoted 로 알린다', () => {
      // 코멘트를 통째로 인용으로 감싸 게이트를 우회하던 자리다. 0건과 뜻이 정반대라
      // 부르는 쪽이 갈라 읽어야 한다
      const wrapped = '=== issue-1\n> 결론적으로 이건 압도적입니다\n> 이 문제에 대해 고쳤어요\n';
      expect(scanProse(wrapped, ['D-1'], { excludeQuotes: true }).allQuoted).toBe(true);

      const normal = '> 원 댓글: 배선이 이상해요\n\n말씀하신 연결 부분 고쳤어요\n';
      expect(scanProse(normal, ['F-7'], { excludeQuotes: true }).allQuoted).toBe(false);
    });
  });
});
