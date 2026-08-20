import { describe, it, expect } from 'vitest';
import { commentProse } from '../../../scripts/verify-rule-refs.js';

/**
 * 이 파서가 놓치면 그만큼 S1 검사가 조용히 비어버린다. 실제로 세 번의 리뷰에서
 * "검사 범위가 주장보다 좁다"가 반복해서 나왔기 때문에 경계마다 케이스를 둔다.
 */
describe('commentProse', () => {
  it('줄 전체를 차지하는 주석을 뽑는다', () => {
    expect(commentProse('// 설명을 담고, 확인용')).toEqual([
      { line: '설명을 담고, 확인용', number: 1 },
    ]);
  });

  it('코드 뒤 줄끝 주석을 뽑는다', () => {
    expect(commentProse('id: string; // 값을 담는 자리')).toEqual([
      { line: '값을 담는 자리', number: 1 },
    ]);
  });

  it('코드 뒤 블록 주석도 뽑는다', () => {
    expect(commentProse('foo(); /* 값을 담는 자리 */')).toEqual([
      { line: '값을 담는 자리', number: 1 },
    ]);
  });

  it('템플릿 리터럴 안의 //는 주석이 아니다', () => {
    expect(commentProse('const t = `\n// 문자열이라 주석이 아니다\n`;')).toEqual([]);
  });

  it('템플릿이 닫히는 줄의 진짜 주석은 놓치지 않는다', () => {
    expect(commentProse('const a = `시작\n중간\n`; // 닫는 줄의 설명')).toEqual([
      { line: '닫는 줄의 설명', number: 3 },
    ]);
  });

  it('정규식 리터럴 안의 슬래시를 주석 시작으로 읽지 않는다', () => {
    expect(commentProse('const re = /https:\\/\\//; // 진짜 설명')).toEqual([
      { line: '진짜 설명', number: 1 },
    ]);
  });

  it('이스케이프된 따옴표가 섞여도 주석 위치를 맞춘다', () => {
    expect(commentProse("const s = 'a\\'b'; // 진짜 설명")).toEqual([
      { line: '진짜 설명', number: 1 },
    ]);
  });

  it('URL의 //는 주석이 아니다', () => {
    expect(commentProse('const u = "https://example.com/a";')).toEqual([]);
  });

  it('정규식 안의 백틱을 템플릿 시작으로 세지 않는다', () => {
    // 이걸 못 가리면 그 줄부터 파일 끝까지 템플릿 안으로 보고 아래 주석을 통째로 건너뛴다.
    // summarizer.ts의 `/<!--|-->|```/g` 에서 실제로 났다. 주석 45줄 중 33줄이 검사 밖이었다.
    const source = ['const STRUCTURAL = /<!--|-->|```/g;', '// 이 줄이 검사 대상이다'].join('\n');

    expect(commentProse(source)).toEqual([{ line: '이 줄이 검사 대상이다', number: 2 }]);
  });

  it('진짜 템플릿 리터럴은 여전히 건너뛴다', () => {
    const source = [
      'const t = `시작',
      '// 문자열이라 주석이 아니다',
      '`;',
      '// 이건 주석이다',
    ].join('\n');

    expect(commentProse(source)).toEqual([{ line: '이건 주석이다', number: 4 }]);
  });

  it('한글이 없는 주석은 대상이 아니다', () => {
    expect(commentProse('// english only comment')).toEqual([]);
  });
});
