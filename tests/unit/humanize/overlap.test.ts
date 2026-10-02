import { describe, it, expect } from 'vitest';
import {
  changedSentences,
  checkOverlap,
  contentWords,
  findCandidates,
  hangulSkeleton,
  latinSkeleton,
  parseRuleEntries,
  runMatrix,
  type DetectorSet,
  type RuleEntry,
} from '../../../src/humanize/overlap.js';
import { detect, DETECTABLE_RULE_IDS } from '../../../src/humanize/detectors.js';

const HEADER = '| ID | 패턴 | 심각도 | 처방 |\n|---|---|---|---|';
const book = (...rows: string[]) => `## F. 테스트\n\n${HEADER}\n${rows.join('\n')}\n`;
const parse = (markdown: string) => parseRuleEntries(markdown, 'rules.md');
const entry = (entries: RuleEntry[], id: string) => entries.find((e) => e.id === id)!;
const kinds = (e: RuleEntry, kind: string) =>
  e.examples.filter((x) => x.kind === kind).map((x) => x.text);

/** 정규식 하나씩 룰에 묶은 가짜 탐지기 */
function fakeDetectors(map: Record<string, RegExp>): DetectorSet {
  return {
    ids: Object.keys(map),
    run: (text) =>
      Object.entries(map).flatMap(([ruleId, re]) => {
        const hits = text.match(new RegExp(re.source, 'g'));
        return hits ? [{ ruleId, samples: hits }] : [];
      }),
  };
}

describe('parseRuleEntries — 예시 종류 가르기', () => {
  it('패턴 칸은 금지, 화살표 오른쪽은 처방이다', () => {
    const e = entry(
      parse(
        book('| X-1 | 별칭 ("맨몸 호출") | S2 | 그대로 쓴다 ("맨몸 호출" → "접두 객체가 없다") |'),
      ),
      'X-1',
    );
    expect(kinds(e, 'before')).toEqual(['맨몸 호출', '맨몸 호출']);
    expect(kinds(e, 'after')).toEqual(['접두 객체가 없다']);
  });

  it('패턴 칸의 화살표는 원어에서 금지어로 간다', () => {
    const e = entry(parse(book('| X-1 | 직역 (canonical → "정본") | S1 | 동사로 쓴다 |')), 'X-1');
    expect(kinds(e, 'before')).toEqual(['정본']);
    expect(kinds(e, 'after')).toEqual([]);
  });

  it('한 문장의 두 마디가 반대 판정을 들고 있으면 마디마다 가른다', () => {
    const e = entry(
      parse(
        book(
          '| X-1 | 관용구 | S2 | 문서가 정하면 대상이고("타입을 못 박다"), 사람들이 협의해 정하면 예외다("팀이 일정을 못 박았다") |',
        ),
      ),
      'X-1',
    );
    expect(kinds(e, 'before')).toContain('타입을 못 박다');
    expect(kinds(e, 'exempt')).toEqual(['팀이 일정을 못 박았다']);
  });

  it('나열한 따옴표는 마지막 따옴표 뒤 서술어로 가른다', () => {
    const e = entry(
      parse(
        book(
          '| X-1 | 명사 ("산출". "산출물", "산출 근거"는 빠지고 "계측기", "실측값"은 걸린다) | S2 | 푼다 |',
        ),
      ),
      'X-1',
    );
    expect(kinds(e, 'exempt')).toEqual(['산출물', '산출 근거']);
    expect(kinds(e, 'before')).toEqual(expect.arrayContaining(['산출', '계측기', '실측값']));
  });

  it('"안 걸린다"는 금지 표지가 아니다', () => {
    const e = entry(
      parse(
        book(
          '| X-1 | 닫다 | S1 | 어순으로 빠지는 "닫힌 PR"은 대상을 요구하는 덕에 자연히 안 걸린다 |',
        ),
      ),
      'X-1',
    );
    expect(kinds(e, 'before')).toEqual([]);
    expect(kinds(e, 'exempt')).toEqual(['닫힌 PR']);
  });

  it('표지 없는 따옴표는 예시가 아니라 언급이다', () => {
    const e = entry(
      parse(book('| X-1 | 측량 | S2 | 이 룰은 물리 "측량" 동사만 보므로 X-2 하나로 판정한다 |')),
      'X-1',
    );
    expect(e.examples).toEqual([]);
  });

  it('표기법 따옴표는 빼고 대문자 자리표시는 한글로 채운다', () => {
    const e = entry(parse(book('| X-1 | "~에 대해(서)", "A에 대해 논의" | S1 | 직결 |')), 'X-1');
    expect(kinds(e, 'before')).toEqual(['가에 대해 논의']);
  });

  it('룰 하나를 부르는 헤딩 아래 문단과 대체어 표를 그 룰에 붙인다', () => {
    const md = [
      book('| B-5 | 직역 ("정본") | S1 | 동사로 쓴다 |'),
      '### B-5 대체어',
      '',
      '| 원어 | 쓰지 말 것 | 이렇게 |',
      '|---|---|---|',
      '| semantics | 의미론 | 규칙 / 동작 방식 |',
      '',
      '"원본"도 "원본은 A다"처럼 딱지로 쓰면 같다. **생성물과 맞세워 "생성물 말고 원본을 고친다"고 쓰는 자리는 대상이 아니다**.',
    ].join('\n');
    const e = entry(parse(md), 'B-5');
    expect(kinds(e, 'before')).toEqual(expect.arrayContaining(['의미론', '원본은 가다']));
    expect(kinds(e, 'after')).toEqual(expect.arrayContaining(['규칙', '동작 방식']));
    expect(kinds(e, 'exempt')).toEqual(['생성물 말고 원본을 고친다']);
  });

  it('"(F-9 오적용 주의)" 같은 볼드 도입구 문단도 그 룰 몫이다', () => {
    const md = `**은유를 다 지우라는 게 아니다 (X-1 오적용 주의):** "널 포인터"는 그대로 둔다.\n\n${book('| X-1 | 별칭 | S2 | 쓴다 |')}`;
    const e = entry(parse(md), 'X-1');
    expect(kinds(e, 'exempt')).toEqual(['널 포인터']);
    expect(e.line).toBeGreaterThan(1);
  });
});

describe('runMatrix', () => {
  it('처방이 다른 룰 탐지기에 걸리면 error다 (꼴 2)', () => {
    const entries = parse(book('| X-1 | 별칭 | S2 | 이렇게 쓴다 ("결정화해 둔다") |'));
    const findings = runMatrix(entries, fakeDetectors({ 'X-2': /결정화/ }));
    expect(findings).toMatchObject([{ code: 'after-hit', level: 'error', hitBy: 'X-2' }]);
  });

  it('예외로 둔 말을 다른 룰이 잡고 둘 사이 순서가 없으면 error, 있으면 info다 (꼴 1)', () => {
    const rows = [
      '| X-1 | 별칭 | S2 | **예외는 정의된 이름이다** ("은탄환") |',
      '| X-2 | 직역 ("낮은 가지 열매") | S2 | 걷는다 |',
    ];
    const detectors = fakeDetectors({ 'X-2': /은탄환|낮은 가지/ });
    expect(runMatrix(parse(book(...rows)), detectors)).toMatchObject([
      { code: 'exempt-hit-other', level: 'error' },
    ]);

    const ordered = [...rows, '| X-3 | 기타 | S2 | 쓴다 |'];
    ordered[1] = '| X-2 | 직역 ("낮은 가지 열매") | S2 | X-1과 겹치면 X-2 하나로 판정한다 |';
    expect(runMatrix(parse(book(...ordered)), detectors)).toMatchObject([
      { code: 'exempt-hit-other', level: 'info' },
    ]);
  });

  it('형태로 빠진다고 적은 예외를 자기 탐지기가 잡으면 error, 뜻으로 가르는 예외면 info다', () => {
    const form = parse(book('| X-1 | 못 박다 | S2 | 형태로 빠지는 예외는 피동 "못 박혀 있다"다 |'));
    const meaning = parse(
      book('| X-1 | 못 박다 | S2 | 실물을 잠그는 자리는 예외다("문을 잠갔다") |'),
    );
    const detectors = fakeDetectors({ 'X-1': /못\s?박|잠갔/ });
    expect(runMatrix(form, detectors)).toMatchObject([{ code: 'form-exempt-hit', level: 'error' }]);
    expect(runMatrix(meaning, detectors)).toMatchObject([
      { code: 'exempt-hit-self', level: 'info' },
    ]);
  });

  it('금지 예시를 자기 탐지기가 놓치면 info다', () => {
    const entries = parse(book('| X-1 | 자책 ("뼈아픕니다") | S1 | 줄인다 |'));
    expect(runMatrix(entries, fakeDetectors({ 'X-1': /뼈아[프픈]/ }))).toMatchObject([
      { code: 'before-miss', level: 'info' },
    ]);
  });

  it('가운뎃점 나열은 다른 룰에는 낱낱으로, 자기 룰에는 통째로도 돌린다', () => {
    const entries = parse(
      book(
        '| X-1 | 접속사 ("또한·따라서") | S2 | 지운다 |',
        '| X-2 | 가운뎃점 ("A·B") | S2 | 푼다 |',
      ),
    );
    const findings = runMatrix(
      entries,
      fakeDetectors({ 'X-1': /^(?:또한|따라서)\s/, 'X-2': /[가-힣]·[가-힣]/ }),
    );
    expect(findings).toEqual([]);
  });
});

describe('findCandidates', () => {
  it('금지 예시와 예외 예시가 같은 낱말을 쓰면 묻는다 (0bcffd0c)', () => {
    const entries = parse(
      book(
        '| X-1 | 원인 비유 ("뿌리가 하나다") | S2 | **"뿌리"는 영어로 root라 부르는 자리에서만 쓴다** — 트리의 root가 그렇다 |',
      ),
    );
    expect(findCandidates(entries)).toMatchObject([
      { code: 'target-exempt-share', rules: ['X-1'] },
    ]);
  });

  it('한 문장이 금지와 예외를 맞세우면 이미 경계를 그은 것이라 안 묻는다', () => {
    const entries = parse(
      book('| X-1 | 측량 | S2 | "근거를 재봤는데"는 걸리고 "온도를 재봤는데"는 대상이 아니다 |'),
    );
    expect(findCandidates(entries).filter((c) => c.code === 'target-exempt-share')).toEqual([]);
  });

  it('예외가 둘 이상인데 앞서는 쪽이 없으면 묻고 적혀 있으면 안 묻는다 (d1c4bc8e)', () => {
    const rows = (extra: string) =>
      book(
        `| X-1 | 별칭 | S2 | **예외는 남이 정의해 둔 이름이다**. **"뿌리"는 root인 자리에서만 쓴다**.${extra} |`,
      );
    expect(findCandidates(parse(rows('')))).toMatchObject([{ code: 'exceptions-no-order' }]);
    expect(
      findCandidates(parse(rows(' 이 기준이 위 일반 예외보다 앞선다.'))).filter(
        (c) => c.code === 'exceptions-no-order',
      ),
    ).toEqual([]);
  });

  it('예외를 말하기만 하는 문장은 예외 개수에 안 센다', () => {
    const entries = parse(
      book(
        '| X-1 | 종결 | S2 | **헤딩은 대상이 아니다**. 예외가 전부 문맥이라 탐지기가 없다. 서식으로만 예외를 주면 샌다 |',
      ),
    );
    expect(findCandidates(entries)).toEqual([]);
  });

  it('경계를 긋고 순서를 안 정하면 묻는다 (658fa436, 3c8528d7)', () => {
    const entries = parse(
      book(
        '| X-1 | 별칭 | S2 | 쓴다 |',
        '| X-2 | 직역 | S2 | **X-1과는 출처로 갈린다** — X-1은 지어낸 별칭이다 |',
      ),
    );
    expect(findCandidates(entries)).toMatchObject([
      { code: 'cited-no-order', rules: ['X-2', 'X-1'] },
    ]);
  });

  it('부르기만 하거나 순서를 정했거나 두 룰이 함께 가진 문단이면 안 묻는다', () => {
    const md = [
      '**한자어를 피하는 게 목적이 아니다 (X-1·X-2 오적용 주의):** 둘은 명사화로 갈린다.',
      '',
      book(
        '| X-1 | 별칭 | S2 | X-2의 "못 박" 탐지기처럼 걸 수 있다 |',
        '| X-2 | 관용구 | S2 | **X-3과는 품사로 갈린다** — 겹치면 X-2 하나로 판정한다 |',
        '| X-3 | 측량 | S2 | 쓴다 |',
      ),
    ].join('\n');
    expect(findCandidates(parse(md)).filter((c) => c.code === 'cited-no-order')).toEqual([]);
  });

  it('두 룰이 서로 안 부르면서 같은 원어를 다루면 묻는다 (4cdcfbb1)', () => {
    const entries = parse(
      book(
        '| B-3 | 음차 | S1 | 통째 음차한 구(룩 앤 필, 로우 행잉 프룻)가 최우선 대상이다 |',
        '| F-11 | 직역 ("낮은 가지 열매"=low-hanging fruit) | S2 | 걷는다 |',
      ),
    );
    expect(findCandidates(entries)).toMatchObject([
      { code: 'shared-source', rules: ['F-11', 'B-3'] },
    ]);
  });

  it('비교 기준을 주면 새로 생긴 문장이 낀 후보만 남긴다', () => {
    const base = parse(
      book('| X-1 | 별칭 | S2 | 쓴다 |', '| X-2 | 직역 | S2 | **X-1과는 출처로 갈린다** |'),
    );
    const head = parse(
      book('| X-1 | 별칭 | S2 | 쓴다 |', '| X-2 | 직역 | S2 | **X-1과는 출처로 갈린다**. 고쳤다 |'),
    );
    const changed = changedSentences(base, head);
    expect([...changed]).toEqual(['고쳤다']);
    expect(findCandidates(head, { changed })).toEqual([]);
    expect(findCandidates(head)).toHaveLength(1);
  });
});

describe('보조 함수', () => {
  it('조사를 떼고 두 글자 이상 내용어만 남긴다', () => {
    expect(contentWords('뿌리가 하나다')).toEqual(['뿌리', '하나']);
  });

  it('음차와 영어 원어를 같은 자음 뼈대로 맞춘다', () => {
    expect(latinSkeleton('low-hanging fruit')).toBe(hangulSkeleton('로우 행잉 프룻'));
    expect(latinSkeleton('source of truth')).not.toBe(hangulSkeleton('룩 앤 필'));
  });
});

describe('실제 룰북', () => {
  it('지금 룰북과 탐지기에서 탐지기 행렬 error가 없다', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const path = resolve('plugin/role-agents/_shared/references/ai-tell-quick-rules.md');
    const report = checkOverlap(parseRuleEntries(readFileSync(path, 'utf-8'), path), {
      ids: DETECTABLE_RULE_IDS,
      run: (text) => detect(text).map((d) => ({ ruleId: d.ruleId, samples: d.samples })),
    });
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([]);
    // 탐지기 없는 룰은 건너뛰지 않고 목록으로 드러난다
    expect(report.undecidable.map((u) => u.ruleId)).toContain('F-9');
  });
});
