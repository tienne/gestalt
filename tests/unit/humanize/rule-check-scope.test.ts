import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import { countBackticks, proseTargets, stripQuoted } from '../../../scripts/verify-rule-refs.js';
import { raisedEntries } from '../../../scripts/humanize-baseline.js';
import { detect } from '../../../src/humanize/detectors.js';

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
  });

  describe('F-10 탐지기', () => {
    it('테스트를 자물쇠에 빗댄 자리를 잡는다', () => {
      for (const line of ['경계를 테스트로 잠갔다', '기준으로 잠근다', '기준에 잠긴 문서']) {
        const hit = detect(line, ['F-10']).find((d) => d.ruleId === 'F-10');
        expect(hit?.count ?? 0).toBeGreaterThan(0);
      }
    });

    it('굳은 말인 잠금 파일은 넘어간다', () => {
      expect(detect('자동 생성 파일은 잠금 파일과 빌드 산출물이다', ['F-10'])).toEqual([]);
    });

    it('관용구를 코드나 규칙에 씌운 자리를 잡는다', () => {
      for (const line of ['타입을 못 박아주세요', '이 규칙은 1번으로 못박는다']) {
        const hit = detect(line, ['F-10']).find((d) => d.ruleId === 'F-10');
        expect(hit?.count ?? 0).toBeGreaterThan(0);
      }
    });

    // 룰이 예외로 둔 자리는 형태로 못 가른다. 사람 사이 합의도 함께 걸리고 걸린 자리를
    // 사람이 다시 본다. 하드코딩 갈래만 형태로 빠진다
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
});
