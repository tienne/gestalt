import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFromText, type PrdSource } from '../../../src/digest/prd-source.js';
import { parsePrdView, PRD_SCHEMA_VERSION } from '../../../src/digest/prd-schema.js';

/** 가상 서비스(도서 대여 앱 추천 영역) PRD. 줄 번호를 테스트가 직접 가리키니 줄을 바꾸면 sampleView도 고친다 */
export const SAMPLE_PRD = `---
title: 대여 추천 개편
---

# 대여 추천 개편 PRD

| | |
|---|---|
| 오너 | 박기획 |
| 일정 | 2026-03-02 오픈 |

## 문제

반납 직후 다음 책을 못 고른 회원의 40%가 한 달 안에 이탈한다.
추천 영역은 인기순 고정이라 회원 취향을 반영하지 않는다.

## 요구사항

**반납 직후 추천 카드**: 반납 완료 화면에 비슷한 책 3권을 보여 준다.
- 가설: 바로 다음 책을 보여 주면 재대여가 늘어난다
- 경계: 푸시 알림은 이번에 하지 않는다

**찜 목록 연결**: 추천 카드에서 바로 찜할 수 있다.

## 지표

| ID | 지표 | 분모 | 베이스라인 | 목표 |
|---|---|---|---|---|
| M1 | 7일 내 재대여율 | 반납 회원 | 22% | 27% |
| M2 | 추천 카드 클릭률 | 카드 노출 | 재추출 필요 | 8% |

## 결정 기록

- 추천 기준은 같은 장르로 한다. 협업 필터링은 데이터가 부족해 버렸다.

## 미확정

- 성인 도서를 추천에 넣을지 (담당 정책팀, 3/10)

## 변경 이력

- v1 초안 작성
`;

export function sampleSource(path = 'docs/rental/PRD.md'): PrdSource {
  return sourceFromText(path, SAMPLE_PRD);
}

export function sampleView(): Record<string, unknown> {
  return {
    schemaVersion: PRD_SCHEMA_VERSION,
    slug: 'rental-reco',
    meta: {
      title: '대여 추천 개편 PRD',
      source: 'docs/rental/PRD.md',
      rows: [
        { key: '오너', value: '박기획', src: [[9, 9]] },
        { key: '일정', value: '2026-03-02 오픈', src: [[10, 10]] },
      ],
    },
    sections: [
      {
        id: 'problem',
        title: '문제',
        blocks: [
          {
            id: 'c1',
            kind: 'claim',
            src: [[14, 14]],
            text: '반납 직후 다음 책을 못 고른 회원의 40%가 한 달 안에 이탈한다.',
            status: 'confirmed',
          },
          {
            id: 'c2',
            kind: 'claim',
            src: [[15, 15]],
            text: '추천 영역은 인기순 고정이라 회원 취향을 반영하지 않는다.',
            status: 'open',
            audience: ['pm'],
          },
        ],
      },
      {
        id: 'req',
        title: '요구사항',
        blocks: [
          {
            id: 'r1',
            kind: 'requirement',
            src: [[19, 21]],
            title: '반납 직후 추천 카드',
            detail: ['반납 완료 화면에 비슷한 책 3권을 보여 준다.'],
            why: '바로 다음 책을 보여 주면 재대여가 늘어난다',
            boundary: '푸시 알림은 이번에 하지 않는다',
            phase: 'mvp',
            metrics: ['M1', 'M2'],
            audience: ['dev', 'design'],
          },
          {
            id: 'r2',
            kind: 'requirement',
            src: [[23, 23]],
            title: '찜 목록 연결',
            detail: ['추천 카드에서 바로 찜할 수 있다.'],
            phase: 'later',
          },
        ],
      },
      {
        id: 'metrics',
        title: '지표',
        blocks: [
          {
            id: 'm1',
            kind: 'metric',
            src: [[27, 29]],
            metricId: 'M1',
            name: '7일 내 재대여율',
            role: 'primary',
            denominator: '반납 회원',
            baseline: '22%',
            target: '27%',
          },
          {
            id: 'm2',
            kind: 'metric',
            src: [
              [27, 27],
              [30, 30],
            ],
            metricId: 'M2',
            name: '추천 카드 클릭률',
            role: 'secondary',
            denominator: '카드 노출',
            baseline: '재추출 필요',
            target: '8%',
          },
        ],
      },
      {
        id: 'decisions',
        title: '결정 기록',
        blocks: [
          {
            id: 'd1',
            kind: 'decision',
            src: [[34, 34]],
            decided: '추천 기준은 같은 장르로 한다.',
            rejected: [{ option: '협업 필터링', reason: '데이터가 부족해 버렸다' }],
          },
        ],
      },
      {
        id: 'open',
        title: '미확정',
        blocks: [
          {
            id: 'q1',
            kind: 'question',
            src: [[38, 38]],
            item: '성인 도서를 추천에 넣을지',
            owner: '정책팀',
            due: '3/10',
          },
        ],
      },
    ],
    omitted: [{ src: [[42, 42]], reason: '변경 이력' }],
  };
}

/** repoRoot 아래에 원문과 view를 써 둔다 */
export function writeSample(
  repoRoot: string,
  view: Record<string, unknown> = sampleView(),
): { sourcePath: string; viewPath: string } {
  const sourcePath = join(repoRoot, 'docs', 'rental', 'PRD.md');
  mkdirSync(join(repoRoot, 'docs', 'rental'), { recursive: true });
  writeFileSync(sourcePath, SAMPLE_PRD);
  const dir = join(repoRoot, '.gestalt', 'prd-view', String(view.slug));
  mkdirSync(dir, { recursive: true });
  const viewPath = join(dir, 'prd-view.json');
  writeFileSync(viewPath, JSON.stringify(view));
  return { sourcePath, viewPath };
}

/** 3단계 블록 8개를 하나씩 담은 섹션. 원문 줄을 빌려 쓰므로 글자 대조 경고는 날 수 있지만 오류는 없다 */
export function stage3Section(): Record<string, unknown> {
  return {
    id: 'more',
    title: '요구사항',
    blocks: [
      {
        id: 'x-compare',
        kind: 'compare',
        src: [[15, 15]],
        labels: ['지금', '바꾼 뒤'],
        rows: [{ label: '추천 기준', left: '인기순 고정', right: '회원 취향' }, { left: '인기순' }],
      },
      { id: 'x-scope', kind: 'scope', src: [[21, 21]], out: ['푸시 알림은 이번에 하지 않는다'] },
      {
        id: 'x-quote',
        kind: 'quote',
        src: [[20, 20]],
        text: '바로 다음 책을 보여 주면 좋겠다',
        origin: 'virtual',
      },
      { id: 'x-flow', kind: 'flow', src: [[19, 19]], steps: ['반납 완료', '추천 카드', '찜'] },
      {
        id: 'x-matrix',
        kind: 'stateMatrix',
        src: [[29, 30]],
        rows: ['M1', 'M2'],
        cols: ['베이스라인', '목표'],
        cells: [
          ['22%', '27%'],
          [null, '8%'],
        ],
      },
      {
        id: 'x-timeline',
        kind: 'timeline',
        src: [[10, 10]],
        items: [{ date: '2026-03-02', what: '오픈' }],
      },
      {
        id: 'x-glossary',
        kind: 'glossary',
        src: [[29, 29]],
        terms: [{ term: '재대여율', meaning: '7일 내 재대여율' }],
      },
      {
        id: 'x-callout',
        kind: 'callout',
        src: [[14, 14]],
        text: '한 달 안에 이탈한다',
        tone: 'warn',
      },
    ],
  };
}

export function sampleViewWithStage3(): Record<string, any> {
  const v = sampleView() as Record<string, any>;
  v.sections.push(stage3Section());
  return v;
}

/** 기존 픽스처의 줄 번호는 유지하고 기능 트리 사례를 별도로 둔다 */
export function sampleV2() {
  const lines = [
    '# 도서 대여',
    '## 기능',
    '도서 대여 기능',
    '대여 신청',
    '회원은 대여할 책을 선택한다.',
    '배송은 포함하지 않는다.',
    '중요도 P0',
    '신청 뒤 대여 목록에 책 1권이 나타난다.',
    '회원이 로그인했다.',
    '대여 버튼을 누른다.',
    '선택한 도서를 신청한다.',
    '대여 목록을 볼 수 있다.',
    '재고가 없으면 신청을 막는다.',
    '신청 결과를 표시한다.',
    '회원은 목록을 볼 수 있다.',
    '회원당 3권까지 빌린다.',
    '도서 번호를 저장한다.',
    '성인 도서의 허용 여부',
    '재고가 부족할 수 있다.',
    '대기 목록을 제공한다.',
    '회원',
    '웹',
  ];
  const at = (text: string): [[number, number]] => [
    [lines.indexOf(text) + 1, lines.indexOf(text) + 1],
  ];
  const sourced = (text: string) => ({ text, src: at(text) });
  const source = sourceFromText('docs/rental/PRD.md', lines.join('\n'));
  const raw = {
    schemaVersion: PRD_SCHEMA_VERSION,
    slug: 'rental-v2',
    meta: {
      title: '도서 대여',
      source: source.path,
      roles: [sourced('회원')],
      platforms: [sourced('웹')],
      rows: [],
    },
    sections: [
      {
        id: 'features',
        title: '기능',
        blocks: [
          { id: 'group', kind: 'requirement', title: '도서 대여 기능', src: at('도서 대여 기능') },
          {
            id: 'r1',
            kind: 'requirement',
            title: '대여 신청',
            src: [[4, 7]],
            parent: 'group',
            detail: ['회원은 대여할 책을 선택한다.'],
            boundary: '배송은 포함하지 않는다.',
            priority: 'P0',
            questions: ['q1'],
            acceptance: [sourced('신청 뒤 대여 목록에 책 1권이 나타난다.')],
            slots: {
              precondition: sourced('회원이 로그인했다.'),
              trigger: sourced('대여 버튼을 누른다.'),
              behavior: sourced('선택한 도서를 신청한다.'),
              result: sourced('대여 목록을 볼 수 있다.'),
              exception: sourced('재고가 없으면 신청을 막는다.'),
              display: sourced('신청 결과를 표시한다.'),
              permission: sourced('회원은 목록을 볼 수 있다.'),
              businessRule: sourced('회원당 3권까지 빌린다.'),
              data: sourced('도서 번호를 저장한다.'),
            },
          },
          {
            id: 'q1',
            kind: 'question',
            item: '성인 도서의 허용 여부',
            src: at('성인 도서의 허용 여부'),
          },
          {
            id: 'risk1',
            kind: 'risk',
            text: '재고가 부족할 수 있다.',
            response: '대기 목록을 제공한다.',
            src: [[19, 20]],
          },
        ],
      },
    ],
    omitted: [],
  };
  const result = parsePrdView(raw);
  if (!result.ok) throw new Error(result.issues.join('\n'));
  return { source, view: result.value };
}
