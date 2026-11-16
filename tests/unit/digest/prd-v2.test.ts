import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { collectPrdGaps, hasBaselineNumber } from '../../../src/digest/lint-prd-gaps.js';
import { parsePrdView, PRD_SCHEMA_VERSION } from '../../../src/digest/prd-schema.js';
import { sourceFromText, classifyLines } from '../../../src/digest/prd-source.js';
import { slugFromSource } from '../../../src/digest/prd-store.js';
import { renderPrdHtml } from '../../../src/digest/render-prd.js';
import { sampleSource, sampleV2, sampleView } from './prd-fixture.js';

const requirement = (v: ReturnType<typeof sampleV2>['view']) => {
  const b = v.sections[0]!.blocks[1]!;
  if (b.kind !== 'requirement') throw new Error('requirement expected');
  return b;
};

describe('PRD 1.1 기능명세서 계약', () => {
  it('1.0.0 JSON을 유지하고 1.1.0 새 필드를 원문 범위별로 검증한다', () => {
    expect(PRD_SCHEMA_VERSION).toBe('1.1.0');
    expect(parsePrdView({ ...sampleView(), schemaVersion: '1.0.0' }).ok).toBe(true);
    expect(parsePrdView({ ...sampleView(), schemaVersion: '2.0.0' }).ok).toBe(false);
    const { view, source } = sampleV2();
    expect(lintPrdView(view, source).issues).toEqual([]);
    expect(lintPrdView(view, source).coverage.uncoveredLines).toBe(0);
    expect(
      collectPrdGaps(view).filter((g) =>
        ['ACCEPTANCE_MISSING', 'SLOTS_INCOMPLETE'].includes(g.code),
      ),
    ).toEqual([]);
  });

  it.each(['acceptance', 'slots', 'priority', 'response', 'roles', 'platforms', 'rows'] as const)(
    '%s의 원문 글과 숫자 모두 대조한다',
    (field) => {
      const { view, source } = sampleV2();
      const r = requirement(view);
      const invented = '원문에 없는 우주선 987대';
      if (field === 'acceptance') r.acceptance![0]!.text = invented;
      if (field === 'slots') r.slots!.data!.text = invented;
      if (field === 'priority') r.priority = invented;
      if (field === 'roles' || field === 'platforms') view.meta[field]![0]!.text = invented;
      if (field === 'rows') view.meta.rows.push({ key: '오너', value: invented, src: [[3, 3]] });
      if (field === 'response') {
        const risk = view.sections[0]!.blocks[3]!;
        if (risk.kind === 'risk') risk.response = invented;
      }
      expect(lintPrdView(view, source).issues.map((i) => i.code)).toEqual(
        expect.arrayContaining(['TEXT_NOT_IN_SOURCE', 'NUMBER_NOT_IN_SOURCE']),
      );
    },
  );

  it('중첩 src를 따로 검사하고 summary에서도 새 필드 숫자를 검사한다', () => {
    const { view, source } = sampleV2();
    const r = requirement(view);
    r.acceptance![0]!.src = [[999, 999]];
    r.slots!.data!.src = [[1, 1]];
    r.summary = true;
    r.priority = '중요도 987';
    const issues = lintPrdView(view, source).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SRC_OUT_OF_RANGE',
          path: 'sections.0.blocks.1.acceptance.0.src.0',
        }),
        expect.objectContaining({
          code: 'SRC_ON_BLANK',
          path: 'sections.0.blocks.1.slots.data.src',
        }),
        expect.objectContaining({
          code: 'NUMBER_NOT_IN_SOURCE',
          path: 'sections.0.blocks.1.priority',
        }),
      ]),
    );
  });

  it.each([
    'unknownParent',
    'wrongParentKind',
    'unknownQuestion',
    'wrongQuestionKind',
    'depth',
    'cycle',
    'self',
  ] as const)('%s 참조 오류를 잡는다', (kind) => {
    const { view, source } = sampleV2();
    const r = requirement(view);
    const group = view.sections[0]!.blocks[0]!;
    if (group.kind !== 'requirement') throw new Error('group');
    if (kind === 'unknownParent') r.parent = 'missing';
    if (kind === 'wrongParentKind') r.parent = 'q1';
    if (kind === 'unknownQuestion') r.questions = ['missing'];
    if (kind === 'wrongQuestionKind') r.questions = ['group'];
    if (kind === 'depth') view.sections[0]!.blocks.push({ ...r, id: 'r2', parent: 'r1' });
    if (kind === 'cycle') group.parent = 'r1';
    if (kind === 'self') r.parent = r.id;
    const expected = kind.includes('Parent')
      ? 'UNKNOWN_PARENT'
      : kind.includes('Question')
        ? 'UNKNOWN_QUESTION'
        : kind === 'depth'
          ? 'REQUIREMENT_TOO_DEEP'
          : 'PARENT_CYCLE';
    expect(lintPrdView(view, source).issues).toContainEqual(
      expect.objectContaining({ code: expected, severity: 'error' }),
    );
  });

  it('기능당 수용 기준과 개발 준비 칸 누락을 각각 한 건으로 묶고 질문을 싣는다', () => {
    const { view } = sampleV2();
    const r = requirement(view);
    delete r.acceptance;
    delete r.slots;
    const gaps = collectPrdGaps(view);
    expect(gaps.filter((g) => g.code === 'ACCEPTANCE_MISSING')).toEqual([
      expect.objectContaining({
        blockIds: ['r1'],
        question: '대여 신청이 끝났다고 판단할 기준은 무엇인가요?',
      }),
    ]);
    expect(gaps.filter((g) => g.code === 'SLOTS_INCOMPLETE')).toEqual([
      expect.objectContaining({
        blockIds: ['r1'],
        missingSlots: expect.arrayContaining(['precondition', 'data']),
      }),
    ]);
    expect(gaps.every((g) => g.question.endsWith('요?'))).toBe(true);
    delete r.parent;
    expect(collectPrdGaps(view).filter((g) => g.code === 'ACCEPTANCE_MISSING')).toHaveLength(2);
  });
});

describe('독립 리뷰 회귀', () => {
  it('그룹과 단독 최상위 기능이 섞여 있어도 단독 기능의 빈칸을 검사한다', () => {
    const { view } = sampleV2();
    view.sections[0]!.blocks.push({
      id: 'solo',
      kind: 'requirement',
      title: '반납 알림',
      src: [[4, 4]],
    });
    const gaps = collectPrdGaps(view);
    for (const code of ['ACCEPTANCE_MISSING', 'SLOTS_INCOMPLETE']) {
      expect(gaps.filter((g) => g.code === code).map((g) => g.blockIds)).toEqual([['solo']]);
    }
  });
});

describe('검증 보고서 회귀', () => {
  it('원문에 지표 id가 전혀 없을 때만 생성한 id 경고를 건너뛴다', () => {
    const parsed = parsePrdView(sampleView());
    if (!parsed.ok) throw new Error('fixture');
    const source = sampleSource();
    const noIds = sourceFromText(
      'docs/rental/PRD.md',
      source.lines.join('\n').replace(/M\d+/g, ''),
    );
    expect(lintPrdView(parsed.value, noIds).issues.map((i) => i.code)).not.toContain(
      'METRIC_ID_NOT_IN_SOURCE',
    );
    const metric = parsed.value.sections[2]!.blocks[0]!;
    if (metric.kind === 'metric') metric.metricId = 'M99';
    expect(lintPrdView(parsed.value, source).issues.map((i) => i.code)).toContain(
      'METRIC_ID_NOT_IN_SOURCE',
    );
  });

  it.each([
    '재추출 필요. 참고: 8.0%',
    '검수 대기 20%',
    '측정 불가 0%',
    '미정 1%',
    '참고: 8%',
    '2026-07',
    '2026/07',
    '2026년 7월',
    undefined,
  ])('기준값 %s는 측정 수치가 아니다', (value) => {
    expect(hasBaselineNumber(value)).toBe(false);
  });
  it.each(['0%', '2026-07 기준 12%', '12% 참고: 30%', '월 100건'])(
    '기준값 %s는 측정 수치다',
    (value) => {
      expect(hasBaselineNumber(value)).toBe(true);
    },
  );

  it('목표 미정과 전체 미연결 요구사항을 묶고 지표 이름으로 질문한다', () => {
    const parsed = parsePrdView(sampleView());
    if (!parsed.ok) throw new Error('fixture');
    for (const section of parsed.value.sections)
      for (const block of section.blocks) {
        if (block.kind === 'requirement') delete block.metrics;
        if (block.kind === 'metric') block.target = '설정 대기';
      }
    const gaps = collectPrdGaps(parsed.value);
    expect(gaps.filter((g) => g.code === 'REQUIREMENT_UNLINKED')).toEqual([
      expect.objectContaining({ blockIds: ['r1', 'r2'] }),
    ]);
    expect(gaps.filter((g) => g.code === 'TARGET_UNDECIDED')[0]?.question).toBe(
      '7일 내 재대여율의 목표는 얼마인가요?',
    );
  });

  it('흔한 파일명에는 부모 폴더 이름을 쓰고 표 머리글은 내용 줄에서 뺀다', () => {
    for (const file of ['PRD.md', 'readme.md', 'index.md'])
      expect(slugFromSource(`docs/rental/${file}`)).toMatch(/^rental-[a-f0-9]{6}$/);
    expect(classifyLines(['| 이름 | 값 |', '|---|---|', '| 대여 | 3 |'])).toEqual([
      'tableHead',
      'tableSep',
      'content',
    ]);
    expect(classifyLines(['```', '| 이름 | 값 |', '|---|---|', '```'])).toEqual([
      'fence',
      'content',
      'content',
      'fence',
    ]);
  });

  it('HTML은 홈 절대 경로를 내보내지 않고 risk를 표시한다', () => {
    const { view, source } = sampleV2();
    view.meta.source = '/Users/private-account/project/docs/rental/PRD.md';
    const options = { sourceSha256: source.sha256, coverage: lintPrdView(view, source).coverage };
    const html = renderPrdHtml(view, { ...options, repoRoot: '/Users/private-account/project' });
    expect(html).toContain('docs/rental/PRD.md');
    expect(html).toContain('대기 목록을 제공한다.');
    view.meta.source = 'C:\\Users\\private-account\\project\\PRD.md';
    expect(renderPrdHtml(view, { ...options, repoRoot: '/other/project' })).not.toContain(
      'private-account',
    );
    view.meta.source = '/Users/private-account/project/docs/rental/PRD.md';
    for (const result of [
      html,
      renderPrdHtml(view, options),
      renderPrdHtml(view, { ...options, repoRoot: '/other/project' }),
    ]) {
      expect(result).not.toMatch(/\/Users\/|private-account|\/home\//);
    }
  });
});
