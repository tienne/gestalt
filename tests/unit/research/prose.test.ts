import { describe, expect, it } from 'vitest';
import {
  applyProse,
  collectProse,
  diffMarkers,
  extractMarkers,
  extractProse,
  MIN_CELL_PROSE_LENGTH,
  parseResearch,
  proseHash,
  type Research,
} from '../../../src/research/index.js';
import { sampleResearch, sampleVideo, videoFrameCapture } from './fixture.js';

function parsed(input = sampleResearch()): Research {
  const r = parseResearch(input);
  if (!r.ok) throw new Error(`픽스처 파싱 실패: ${r.error.issues.join(', ')}`);
  return r.value;
}

/** 영상 findings까지 있는 리서치. 프레임 캡처가 있어야 파싱을 통과한다 */
function withVideo(): Research {
  const base = sampleResearch();
  return parsed({
    ...base,
    captures: [...(base.captures ?? []), videoFrameCapture()],
    video: sampleVideo(),
  });
}

function hashOf(r: Research, path: string): string {
  const item = extractProse(r).items.find((i) => i.path === path);
  if (!item) throw new Error(`path 없음: ${path}`);
  return item.hash;
}

describe('extractProse 대상 선정', () => {
  it('섹션별 path를 모두 뽑는다', () => {
    const paths = extractProse(withVideo()).items.map((i) => i.path);
    for (const p of [
      'references[0].reason',
      'comparison[0].cells[0].text',
      'wowPain.items[0].userWow[0]',
      'wowPain.items[0].userPain[1]',
      'wowPain.items[0].bizWow[0]',
      'wowPain.items[0].bizPain[1]',
      'wowPain.findings[0].text',
      'reasons[0].business',
      'reasons[0].screens',
      'reasons[0].difference',
      'reasons[0].take[0]',
      'reasons[0].skip[0]',
      'judgment[0].conclusion',
      'judgment[0].rationale',
      'judgment[1].holdUntil',
      'verification[0].hypothesis',
      'openQuestions.intro',
      'openQuestions.items[0].question',
      'openQuestions.items[0].temporary',
      'openQuestions.items[0].affects',
      'video.findings[0].text',
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it('회사 발언 영상 finding은 빼고 skipped로 센다', () => {
    const r = withVideo();
    const { items, counts } = extractProse(r);
    const paths = items.map((i) => i.path);
    expect(paths).toContain('video.findings[1].text');
    expect(paths).not.toContain('video.findings[2].text');
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it('회사 발언 비교표 칸과 wowPain finding은 어디서든 뺀다', () => {
    const r = parsed();
    const cell = r.comparison[0]!.cells[0]!;
    cell.basis = 'company-statement';
    const finding = r.wowPain.findings[0]!;
    finding.basis = 'company-statement';
    const paths = extractProse(r).items.map((i) => i.path);
    expect(paths).not.toContain('comparison[0].cells[0].text');
    expect(paths).not.toContain('wowPain.findings[0].text');
    expect(paths).toContain('comparison[0].cells[1].text');
    expect(paths).toContain('wowPain.findings[1].text');
  });

  it('12자 미만 비교표 칸은 빼고 skipped로 센다', () => {
    const r = parsed();
    const short = r.comparison[1]!.cells[1]!;
    expect(Array.from(short.text.trim()).length).toBeLessThan(MIN_CELL_PROSE_LENGTH);
    const { items, counts } = extractProse(r);
    expect(items.map((i) => i.path)).not.toContain('comparison[1].cells[1].text');
    expect(counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it('정확히 12자인 칸은 포함한다', () => {
    const r = parsed();
    r.comparison[0]!.cells[0]!.text = '가'.repeat(MIN_CELL_PROSE_LENGTH);
    r.comparison[0]!.cells[1]!.text = '가'.repeat(MIN_CELL_PROSE_LENGTH - 1);
    const paths = extractProse(r).items.map((i) => i.path);
    expect(paths).toContain('comparison[0].cells[0].text');
    expect(paths).not.toContain('comparison[0].cells[1].text');
  });

  it('라벨 필드와 수치 필드는 대상이 아니다', () => {
    const items = extractProse(withVideo()).items;
    const labelPattern =
      /typeName|symbol|definition|\.area|\.topic|userViewpoint|bizViewpoint|recipient|ownerNote|target|mockups/;
    for (const i of items) expect(i.path).not.toMatch(labelPattern);
    const texts = new Set(items.map((i) => i.text));
    expect(texts.has('순위 리스트형')).toBe(false);
    expect(texts.has('홈')).toBe(false);
    expect(texts.has('PM')).toBe(false);
  });

  it('값이 없거나 공백뿐인 필드는 건너뛰고 skipped에 세지 않는다', () => {
    const r = parsed();
    const before = extractProse(r);
    r.judgment[0]!.rationale = '   ';
    const after = extractProse(r);
    expect(after.items.map((i) => i.path)).not.toContain('judgment[0].rationale');
    expect(after.counts.skipped).toBe(before.counts.skipped);
  });

  it('openQuestions가 없어도 뽑는다', () => {
    const r = parsed();
    delete r.openQuestions;
    const paths = extractProse(r).items.map((i) => i.path);
    expect(paths.some((p) => p.startsWith('openQuestions'))).toBe(false);
  });
});

describe('register 분류', () => {
  it('wowPain은 chat, 나머지 섹션은 report다', () => {
    const { items, counts } = extractProse(withVideo());
    for (const i of items) {
      expect(i.register, i.path).toBe(i.path.startsWith('wowPain.') ? 'chat' : 'report');
    }
    expect(counts.chat).toBe(items.filter((i) => i.register === 'chat').length);
    expect(counts.report).toBe(items.filter((i) => i.register === 'report').length);
    expect(counts.chat + counts.report).toBe(items.length);
    expect(counts.chat).toBeGreaterThan(0);
  });

  it('hash는 원문 sha256 앞 12자다', () => {
    const item = extractProse(parsed()).items[0]!;
    expect(item.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(item.hash).toBe(proseHash(item.text));
  });
});

describe('extractMarkers와 diffMarkers', () => {
  it('표식 여섯 종을 종류별로 뽑는다', () => {
    const text =
      '◎ 전환이 12.5%p 올랐다 (해석) (분석 도구, 2026-10-01) (프레임 08) https://example.com/a?x=1';
    const m = extractMarkers(text);
    expect(m).toContain('링크:https://example.com/a?x=1');
    expect(m).toContain('태그:(해석)');
    expect(m).toContain('출처:(분석 도구, 2026-10-01)');
    expect(m).toContain('위치:(프레임 08)');
    expect(m).toContain('기호:◎');
    expect(m).toContain('수치:12.5%p');
  });

  it('출처 괄호 속 날짜나 URL 속 숫자는 수치로 다시 세지 않는다', () => {
    const m = extractMarkers('(출처 2026-10-01) https://example.com/p/123');
    expect(m.filter((x) => x.startsWith('수치:'))).toEqual([]);
  });

  it('영상 위치 괄호와 화면 위치 괄호도 잡는다', () => {
    const m = extractMarkers('상단 배너 (영상 109.7초), 목록 (화면 5)');
    expect(m).toContain('위치:(영상 109.7초)');
    expect(m).toContain('위치:(화면 5)');
  });

  it('표식이 그대로면 null이다. 위치와 어순은 무시한다', () => {
    expect(diffMarkers('12%에서 18%로 올랐다 (해석)', '(해석) 18%까지 12%에서 올랐다')).toBeNull();
    expect(diffMarkers('12%에서 18%로', '12%→18%')).toBeNull();
  });

  it('숫자 사이 쉼표 나열이 "3과 4"로 바뀌어도 통과한다', () => {
    expect(diffMarkers('3, 4번 화면', '3과 4번 화면')).toBeNull();
    expect(extractMarkers('3, 4')).toEqual(['수치:3', '수치:4']);
  });

  it('천 단위 쉼표 숫자는 하나로 묶는다', () => {
    expect(extractMarkers('20,000명')).toEqual(['수치:20,000']);
  });

  it('(해석) 태그 누락을 missing으로 잡는다', () => {
    expect(diffMarkers('좋아 보인다 (해석)', '좋아 보인다')).toEqual({
      missing: ['태그:(해석)'],
      added: [],
    });
  });

  it('기호가 바뀌면 missing과 added가 함께 나온다', () => {
    expect(diffMarkers('◎ 가장 많다', '○ 가장 많다')).toEqual({
      missing: ['기호:◎'],
      added: ['기호:○'],
    });
  });

  it('숫자가 달라지거나 늘면 잡는다', () => {
    expect(diffMarkers('3개', '4개')).toEqual({ missing: ['수치:3'], added: ['수치:4'] });
    expect(diffMarkers('3개', '3개와 5개')).toEqual({ missing: [], added: ['수치:5'] });
  });

  it('같은 표식의 개수가 줄면 멀티셋으로 잡는다', () => {
    expect(diffMarkers('3개 3개', '3개')).toEqual({ missing: ['수치:3'], added: [] });
  });

  it('링크와 출처 괄호의 누락과 추가를 잡는다', () => {
    expect(diffMarkers('보기 https://example.com/a', '보기')?.missing).toEqual([
      '링크:https://example.com/a',
    ]);
    expect(diffMarkers('(분석, 2026-10-01) 결과', '결과')?.missing).toEqual([
      '출처:(분석, 2026-10-01)',
    ]);
    expect(diffMarkers('결과', '결과 (프레임 08)')?.added).toEqual(['위치:(프레임 08)']);
  });
});

describe('applyProse', () => {
  const reasonPath = 'reasons[0].business';

  it('통과한 항목만 반영하고 applied로 센다', () => {
    const r = parsed();
    const res = applyProse(r, [
      {
        path: reasonPath,
        text: '인기 상품을 앞에 두는 게 본업이다 (해석)',
        hash: hashOf(r, reasonPath),
      },
    ]);
    expect(res.applied).toBe(1);
    expect(res.unchanged).toBe(0);
    expect(res.warnings).toEqual([]);
    expect(res.research.reasons[0]!.business).toBe('인기 상품을 앞에 두는 게 본업이다 (해석)');
  });

  it('배열 칸도 path로 찾아 넣는다', () => {
    const r = parsed();
    const path = 'wowPain.items[0].userWow[1]';
    const res = applyProse(r, [{ path, text: '순위가 확 눈에 띄어요', hash: hashOf(r, path) }]);
    expect(res.applied).toBe(1);
    expect(res.research.wowPain.items[0]!.userWow[1]).toBe('순위가 확 눈에 띄어요');
    expect(res.research.wowPain.items[0]!.userWow[0]).toBe(r.wowPain.items[0]!.userWow[0]);
  });

  it('원본 research 객체는 바꾸지 않는다', () => {
    const r = parsed();
    const snapshot = structuredClone(r);
    applyProse(r, [{ path: reasonPath, text: '고친 문장 (해석)', hash: hashOf(r, reasonPath) }]);
    expect(r).toEqual(snapshot);
  });

  it('원문과 같은 text는 unchanged다', () => {
    const r = parsed();
    const item = extractProse(r).items.find((i) => i.path === reasonPath)!;
    const res = applyProse(r, [{ path: reasonPath, text: item.text, hash: item.hash }]);
    expect(res.unchanged).toBe(1);
    expect(res.applied).toBe(0);
  });

  it('없는 path는 UNKNOWN_PATH다', () => {
    const r = parsed();
    const res = applyProse(r, [
      { path: 'reasons[9].business', text: '문장', hash: 'abcdefabcdef' },
    ]);
    expect(res.warnings).toEqual([{ path: 'reasons[9].business', code: 'UNKNOWN_PATH' }]);
    expect(res.applied).toBe(0);
  });

  it('대상에서 빠진 path도 UNKNOWN_PATH다', () => {
    const r = parsed();
    const res = applyProse(r, [
      { path: 'references[0].typeName', text: '바꿈', hash: 'abcdefabcdef' },
    ]);
    expect(res.warnings[0]!.code).toBe('UNKNOWN_PATH');
    expect(res.research.references[0]!.typeName).toBe(r.references[0]!.typeName);
  });

  it('hash가 다르면 STALE이고 원문을 둔다', () => {
    const r = parsed();
    const res = applyProse(r, [
      { path: reasonPath, text: '바꾼 문장 (해석)', hash: '000000000000' },
    ]);
    expect(res.warnings).toEqual([{ path: reasonPath, code: 'STALE' }]);
    expect(res.research.reasons[0]!.business).toBe(r.reasons[0]!.business);
  });

  it('공백뿐인 text는 EMPTY다', () => {
    const r = parsed();
    const res = applyProse(r, [{ path: reasonPath, text: '  \n ', hash: hashOf(r, reasonPath) }]);
    expect(res.warnings).toEqual([{ path: reasonPath, code: 'EMPTY' }]);
    expect(res.research.reasons[0]!.business).toBe(r.reasons[0]!.business);
  });

  it('같은 path가 둘이면 전부 원문을 두고 경고는 한 번만 낸다', () => {
    const r = parsed();
    const hash = hashOf(r, reasonPath);
    const res = applyProse(r, [
      { path: reasonPath, text: '하나 (해석)', hash },
      { path: reasonPath, text: '둘 (해석)', hash },
    ]);
    expect(res.warnings).toEqual([{ path: reasonPath, code: 'DUPLICATE_PATH' }]);
    expect(res.applied).toBe(0);
    expect(res.research.reasons[0]!.business).toBe(r.reasons[0]!.business);
  });

  it('표식을 빠뜨리면 MARKER_MISMATCH이고 원문을 둔다', () => {
    const r = parsed();
    const res = applyProse(r, [
      { path: reasonPath, text: '인기 상품을 앞에 둔다', hash: hashOf(r, reasonPath) },
    ]);
    expect(res.warnings).toEqual([
      { path: reasonPath, code: 'MARKER_MISMATCH', missing: ['태그:(해석)'], added: [] },
    ]);
    expect(res.applied).toBe(0);
    expect(res.research.reasons[0]!.business).toBe(r.reasons[0]!.business);
  });

  it('표식을 새로 추가해도 MARKER_MISMATCH다', () => {
    const r = parsed();
    const path = 'judgment[0].conclusion';
    const res = applyProse(r, [
      { path, text: '홈은 C의 틀이 유력하다 (해석)', hash: hashOf(r, path) },
    ]);
    expect(res.warnings[0]).toMatchObject({ code: 'MARKER_MISMATCH', added: ['태그:(해석)'] });
  });

  it('일부만 실패해도 나머지는 반영한다', () => {
    const r = parsed();
    const p2 = 'judgment[0].conclusion';
    const res = applyProse(r, [
      { path: reasonPath, text: '표식 뺀 문장', hash: hashOf(r, reasonPath) },
      { path: p2, text: '홈은 C의 틀이 유력하다', hash: hashOf(r, p2) },
    ]);
    expect(res.applied).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.research.judgment[0]!.conclusion).toBe('홈은 C의 틀이 유력하다');
  });

  it('collectProse의 setter는 넘겨받은 객체를 직접 고친다', () => {
    const r = parsed();
    const entry = collectProse(r).find((e) => e.path === reasonPath)!;
    entry.set('직접 바꿈');
    expect(r.reasons[0]!.business).toBe('직접 바꿈');
  });

  it('반영 결과는 스키마 재검증을 통과한다', () => {
    const r = parsed();
    const res = applyProse(r, [
      { path: reasonPath, text: '다듬은 문장 (해석)', hash: hashOf(r, reasonPath) },
    ]);
    expect(parseResearch(res.research).ok).toBe(true);
  });
});
