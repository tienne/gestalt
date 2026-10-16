import { describe, expect, it } from 'vitest';
import { lintResearch, parseResearch } from '../../../src/research/index.js';
import { sampleResearch } from './fixture.js';

function parseOk(input: unknown) {
  const r = parseResearch(input);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function messageOf(input: unknown): string {
  const r = parseResearch(input);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error.message;
}

describe('근거 상태 스키마', () => {
  it('1.0.0 문서는 새 필드 없이도 읽힌다', () => {
    const input = sampleResearch();
    input.comparison = [
      {
        phase: '노출',
        criterion: '상품 수',
        cells: [{ referenceId: 'ra', symbol: '○', text: '3개' }],
      },
    ];
    input.wowPain = { userViewpoint: '', bizViewpoint: '', items: [] };
    input.adoptions = undefined;
    expect(parseResearch(input).ok).toBe(true);
  });

  it('관찰에 출처가 없으면 거절한다', () => {
    const input = sampleResearch();
    input.comparison![0]!.cells[0]!.evidence = [];
    expect(messageOf(input)).toContain('출처(evidence)');
  });

  it('확인 못함과 없음에는 이유가 있어야 한다', () => {
    const input = sampleResearch();
    delete input.comparison![1]!.cells[1]!.note;
    expect(messageOf(input)).toContain('이유(note)');
  });

  it('확인 못함 칸은 기준 행에서도 기호 없이 받는다', () => {
    const input = sampleResearch();
    input.comparison![0]!.cells[0] = {
      referenceId: 'ra',
      text: '영상에서 확인 못함',
      basis: 'unconfirmed',
      note: '이 구좌까지 스크롤하지 않았다',
    };
    expect(parseResearch(input).ok).toBe(true);
  });

  it('없는 캡처나 영상을 근거로 걸면 거절한다', () => {
    const input = sampleResearch();
    input.comparison![0]!.cells[0]!.evidence = [{ type: 'capture', captureId: 'nope' }];
    input.wowPain!.findings![0]!.evidence = [{ type: 'video', clipId: 'nov', at: 3 }];
    const m = messageOf(input);
    expect(m).toContain('없는 캡처: nope');
    expect(m).toContain('없는 영상: nov');
  });

  it('시안이 없는 발견을 가리키면 거절하고 제외에는 이유를 요구한다', () => {
    const input = sampleResearch();
    input.adoptions![0]!.solvesFindingIds = ['ghost'];
    input.adoptions!.push({ id: 'ad-x', variant: 'B', status: 'rejected' });
    const m = messageOf(input);
    expect(m).toContain('없는 발견: ghost');
    expect(m).toContain('이유(reason)');
  });

  it('발견 id가 겹치면 거절한다', () => {
    const input = sampleResearch();
    input.wowPain!.findings![1]!.id = input.wowPain!.findings![0]!.id;
    expect(messageOf(input)).toContain('id가 겹친다');
  });
});

describe('근거 구조 lint', () => {
  it('근거를 다 단 샘플은 경고가 없다', () => {
    expect(lintResearch(parseOk(sampleResearch()))).toEqual([]);
  });

  it('와우나 페인이 하나도 없는 레퍼런스를 경고한다', () => {
    const input = sampleResearch();
    input.wowPain!.findings = input.wowPain!.findings!.filter((f) => f.referenceId !== 'rb');
    input.adoptions![0]!.solvesFindingIds = ['fp-c'];
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'wowPain' && x.message.includes('B. 혜택 가격형'))).toBe(true);
  });

  it('screens-only 문서는 와우와 페인이 비어도 경고하지 않는다', () => {
    const input = sampleResearch();
    input.meta.kind = 'screens-only';
    input.wowPain = { userViewpoint: '', bizViewpoint: '', items: [], findings: [] };
    input.adoptions = [];
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'wowPain')).toBe(false);
  });

  it('본 페인에 조작 횟수나 수치가 없으면 경고한다', () => {
    const input = sampleResearch();
    const f = input.wowPain!.findings!.find((x) => x.id === 'fp-b')!;
    delete f.concrete;
    f.text = '상품마다 눌러 들어가야 해서 번거로워요';
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path.startsWith('wowPain.findings') && x.message.includes('수치'))).toBe(
      true,
    );
  });

  it('확인 못했다고 적고 근거 상태가 다르면 경고한다', () => {
    const input = sampleResearch();
    input.comparison![1]!.cells[1] = {
      referenceId: 'rb',
      text: '영상에서 확인 못함',
      basis: 'interpretation',
    };
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'comparison.1.cells.1.basis')).toBe(true);
  });

  it('행에 빠진 레퍼런스 칸과 basis 없는 칸을 경고한다', () => {
    const input = sampleResearch();
    input.comparison![1]!.cells = [{ referenceId: 'ra', text: '중간' }];
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'comparison.1.cells' && x.message.includes('B, C'))).toBe(true);
    expect(w.some((x) => x.path === 'comparison' && x.message.includes('근거 상태'))).toBe(true);
  });

  it('어느 시안도 풀지 않는 페인과 주체 없는 질문을 경고한다', () => {
    const input = sampleResearch();
    input.adoptions![0]!.solvesFindingIds = ['fp-c'];
    delete input.openQuestions!.items[0]!.owner;
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.message.includes('풀지 않는 페인') && x.message.includes('fp-b'))).toBe(
      true,
    );
    expect(w.some((x) => x.path === 'openQuestions.items')).toBe(true);
  });
});
