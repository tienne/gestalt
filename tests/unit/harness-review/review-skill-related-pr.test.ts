import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import {
  decideConfirmation,
  type RelatedPrSignals,
} from '../../../src/harness-review/related-pr.js';
import { BLOCKING_ISSUES } from '../../../src/harness-review/approve-gate.js';
import {
  section,
  sectionStartingWith,
  codeBlockContaining,
  freeVariables,
} from '../../helpers/skill-section.js';

/**
 * review 스킬 1.04단계(연관 PR 확정)와 세 상태 판정 자리의 문서 계약.
 *
 * 확정 기준 표가 코드의 판정과 어긋나면 스킬은 코드가 확정하지 않은 PR을 근거로 판정하게 된다.
 * 그래서 표의 칸을 decideConfirmation 결과와 맞춰 본다.
 */

const SKILL_PATH = resolve('plugin/skills/review/SKILL.md');
const body = parseSkillMd(readFileSync(SKILL_PATH, 'utf-8'), SKILL_PATH).body;
const cliSource = readFileSync(resolve('src/cli/index.ts'), 'utf-8');
const crossPrSource = readFileSync(resolve('src/cli/commands/harness-refs-cross-pr.ts'), 'utf-8');
const agentMd = readFileSync(resolve('plugin/review-agents/harness-reviewer/AGENT.md'), 'utf-8');

const PHASE = '### 1.04단계: 연관 PR 확정 (1.02단계를 돌렸을 때만)';
const flat = (s: string) => s.replace(/\s+/g, ' ');
const phase = () => section(body, PHASE);

function tableRows(text: string, headerStart: string): string[][] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(headerStart));
  expect(at, `${headerStart} 표를 못 찾았다`).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith('|')) break;
    rows.push(
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    );
  }
  return rows;
}

describe('1.04단계 위치', () => {
  it('1.02단계 뒤, 3단계 앞에 있다', () => {
    const at = (needle: string) => body.indexOf(needle);
    expect(at(PHASE)).toBeGreaterThan(at('### 1.02단계: 참조 후보 수집'));
    expect(at(PHASE)).toBeGreaterThan(at('### 1.03단계: 재리뷰 판정'));
    expect(at(PHASE)).toBeLessThan(at('### 1.05단계: audience와 게시 경로 맞추기'));
    expect(at(PHASE)).toBeLessThan(at('### 3단계: 에이전트별 리뷰 제출'));
  });

  it('찾는 순서가 본문 링크, 티켓 키, 참조 대상을 건드리는 열린 PR, 같은 작성자 순이다', () => {
    const text = phase();
    const order = [
      '1. 이번 PR 본문의 연관 PR 링크',
      '2. 같은 티켓 키',
      '3. 참조 대상 파일을 건드리는 열린 PR',
      '4. 같은 작성자가 비슷한 시기에',
    ].map((needle) => text.indexOf(needle));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('열은 prTarget으로 고른다', () => {
    expect(flat(phase())).toContain('`github`이면 `reviewLoop`, 아니면 `ship`입니다');
  });
});

describe('related-prs 호출', () => {
  const block = () => codeBlockContaining(body, PHASE, 'harness-refs related-prs');

  it('모드와 collect 결과를 넘기고 결과를 파일로 받는다', () => {
    expect(block()).toMatch(
      /gestalt harness-refs related-prs --mode <reviewLoop\|ship> --pr <번호> --repo <owner\/name> \\\n\s+--candidates "\$refsTmp\/refs\.json" --json > "\$refsTmp\/related\.json"/,
    );
  });

  it('블록 안에서 refsTmp를 다시 정한다', () => {
    expect(freeVariables(block())).toEqual([]);
  });

  it('스킬이 쓰는 플래그가 CLI에 등록돼 있다', () => {
    for (const flag of [
      '--mode',
      '--pr',
      '--repo',
      '--candidates',
      '--branch',
      '--title',
      '--body-file',
    ]) {
      expect(cliSource, flag).toContain(`'${flag} `);
    }
  });

  it('쓰는 필드가 CLI 결과에 있다', () => {
    const text = phase();
    for (const field of [
      'status',
      'confirmed',
      'unconfirmed',
      'relatedPrUnconfirmed',
      'candidates',
      'suggestBodyLink',
      'notices',
      'limitations',
    ]) {
      expect(text, field).toContain(`| \`${field}\` |`);
    }
    expect(crossPrSource).toContain('status: CrossPrStatus');
    expect(crossPrSource).toContain("export type CrossPrStatus = 'blocked' | 'found' | 'none'");
  });
});

describe('확정 기준 표', () => {
  const rows = () => tableRows(phase(), '| 찾은 근거 | `ship` | `reviewLoop` |');
  const base: RelatedPrSignals = {
    bodyLink: false,
    sharedTicketKeys: [],
    sameAuthor: false,
    sameBranch: false,
    touchedTargets: [],
  };
  const signalsFor: Record<string, RelatedPrSignals> = {
    '본문 링크': { ...base, bodyLink: true },
    '같은 티켓과 같은 작성자': { ...base, sharedTicketKeys: ['ACME-1'], sameAuthor: true },
    '같은 작성자와 같은 브랜치 이름': { ...base, sameAuthor: true, sameBranch: true },
    '참조 대상을 건드리는 열린 PR만, 또는 같은 작성자의 비슷한 시기 PR만': {
      ...base,
      touchedTargets: ['docs/a.md'],
    },
  };
  const cellValue = (cell: string) =>
    cell.startsWith('확정')
      ? 'confirmed'
      : cell.includes('`needsShipConfirm`')
        ? 'needsShipConfirm'
        : cell.includes('`needsAuthorAnswer`')
          ? 'needsAuthorAnswer'
          : cell;

  it('행이 네 개이고 각 칸이 decideConfirmation과 같다', () => {
    const got = rows();
    expect(got.map((r) => r[0])).toEqual(Object.keys(signalsFor));
    for (const [label, ship, reviewLoop] of got) {
      const signals = signalsFor[label!]!;
      expect(cellValue(ship!), `${label} ship`).toBe(decideConfirmation(signals, 'ship'));
      expect(cellValue(reviewLoop!), `${label} reviewLoop`).toBe(
        decideConfirmation(signals, 'reviewLoop'),
      );
    }
  });

  it('review-loop의 티켓과 작성자 확정은 판정에 쓰되 근거를 리포트에 남긴다', () => {
    const row = rows().find((r) => r[0] === '같은 티켓과 같은 작성자')!;
    expect(row[2]).toContain('판정에 쓰되 근거');
    expect(row[2]).toContain('리포트에 남깁니다');
  });

  it('참조 대상만 건드린 PR은 ship은 ⓐ 확인, review-loop는 작성자 질문이다', () => {
    const row = rows().at(-1)!;
    expect(row[1]).toContain('ⓐ에서 사용자 확인');
    expect(row[2]).toContain('작성자 질문');
  });
});

describe('결과 처리', () => {
  const text = () => flat(phase());

  it('blocked는 연관 PR 없음이 아니다', () => {
    expect(text()).toContain('**`status`가 `blocked`면 "연관 PR 없음"이 아닙니다.**');
  });

  it('미확정이면 approve-gate에 relatedPrUnconfirmed로 넘긴다', () => {
    expect(text()).toContain('`--issue relatedPrUnconfirmed`로 넘깁니다');
    expect(BLOCKING_ISSUES).toContain('relatedPrUnconfirmed');
    const gate = codeBlockContaining(
      body,
      sectionStartingWith(body, '#### 리뷰 이벤트 결정').split('\n')[0]!,
      'approve-gate',
    );
    expect(gate).toContain('relatedPrUnconfirmed');
  });

  it('본문 링크가 없으면 추가 제안 코멘트를 이슈 초안에 올린다', () => {
    expect(text()).toContain(
      '**`suggestBodyLink`가 `true`면 본문에 연관 PR 링크를 추가하자는 코멘트를 3.7단계 이슈 초안에 올립니다.**',
    );
    const prep = flat(section(body, '#### 입력 준비 (메인)'));
    expect(prep).toContain('본문 링크 제안 (`suggestBodyLink`)');
    expect(prep).toContain('작성자 질문 (`needsAuthorAnswer`)');
  });

  it('연관 PR 텍스트는 자료이고 관련 레포 목록 밖 PR은 따라가지 않는다', () => {
    expect(text()).toContain('밖의 PR은 본문에 링크가 있어도 따라가지 않습니다');
    expect(text()).toContain('untrusted-input.md');
    expect(text()).toContain('확정 수준도 판정도 바뀌지 않습니다');
  });
});

describe('세 상태 판정', () => {
  const block = () => codeBlockContaining(body, PHASE, 'harness-refs three-state');

  it('collect와 related-prs 결과를 넘기고 결과를 파일로 받는다', () => {
    const b = block();
    expect(b).toContain('--candidates "$refsTmp/refs.json" --related-prs "$refsTmp/related.json"');
    expect(b).toContain('--json > "$refsTmp/three-state.json"');
    expect(freeVariables(b)).toEqual([]);
    for (const flag of ['--related-prs', '--repo-dir', '--confirm']) {
      expect(cliSource, flag).toContain(`'${flag} `);
    }
  });

  it('status 표가 CLI의 다섯 값을 모두 다루고 blocked를 문제 없음으로 읽지 않는다', () => {
    const rows = tableRows(phase(), '| `status` | 뜻 | 메인이 하는 일 |');
    const statuses = rows.map((r) => r[0]);
    expect(statuses).toEqual([
      '`ok`',
      '`mergeOrder`',
      '`defect`',
      '`relatedRemovesUsed`',
      '`blocked`',
    ]);
    expect(crossPrSource).toContain(
      "export type ThreeStateStatus = 'ok' | 'mergeOrder' | 'defect' | 'relatedRemovesUsed' | 'blocked'",
    );
    const blocked = rows.find((r) => r[0] === '`blocked`')!;
    expect(blocked[2]).toContain('"문제 없음"으로 읽지 않습니다');
    expect(blocked[2]).toContain('재확인');
  });

  it('쓰는 필드가 CLI 결과에 있다', () => {
    const text = phase();
    for (const field of [
      'judgments',
      'needsRecheck',
      'relatedPrUnconfirmed',
      'unconfirmedRelatedPrs',
      'relatedPrHeads',
      'relatedPrLookupBlocked',
    ]) {
      expect(text, field).toContain(`\`${field}\``);
      expect(crossPrSource, field).toContain(`${field}:`);
    }
  });

  it('판정 결과별 코멘트 문구가 3.7단계 입력 준비에 있다', () => {
    const prep = section(body, '#### 입력 준비 (메인)');
    const rows = tableRows(
      prep.replace(/^ {3}/gm, ''),
      '| 자리 | `severity` | `category` | `message` |',
    );
    const byPlace = new Map(rows.map((r) => [r[0]!, r]));
    const mergeOrder = byPlace.get('머지 순서 (`mergeOrder`)')!;
    expect(mergeOrder[1]).toBe('`"warning"`');
    expect(mergeOrder[3]).toContain('결함은 아니지만');
    expect(byPlace.get('결함 (`defect`)')![1]).toBe('`"high"`');
    const both = byPlace.get('두 PR 알림 (`relatedRemovesUsed`)')!;
    expect(both[1]).toBe('`"high"`');
    expect(flat(prep)).toContain('gh pr comment <번호> --repo <owner/name>');
    expect(
      freeVariables(codeBlockContaining(body, '#### 입력 준비 (메인)', 'gh pr comment')),
    ).toEqual([]);
  });
});

describe('연관 PR head 기록', () => {
  it('rounds의 dir에 이번 head와 relatedPrHeads를 함께 남긴다', () => {
    const b = codeBlockContaining(body, PHASE, 'related-pr-heads.json');
    expect(b).toContain('{headSha: $head, relatedPrHeads}');
    expect(b).toContain('"$refsTmp/three-state.json"');
    expect(b).toContain('"$roundsDir/related-pr-heads.json"');
    expect(freeVariables(b)).toEqual([]);
  });

  it('1.03단계가 그 파일을 읽어 priorRelatedPrHeads로 들고 간다', () => {
    const find = flat(section(body, '#### 직전 리뷰 head 찾기'));
    expect(find).toContain('`related-pr-heads.json`');
    expect(find).toContain('`headSha`가 `sinceSha`와 같으면');
    expect(find).toContain('`priorRelatedPrHeads`');
    expect(flat(phase())).toContain('`priorRelatedPrHeads`');
  });

  it('3.7단계 relatedPrHead 입력이 relatedPrHeads를 쓴다', () => {
    const line = body.split('\n').find((l) => l.trim().startsWith('relatedPrHead:'))!;
    expect(line).toContain('three-state.json의 relatedPrHeads');
  });
});

describe('harness-reviewer 입력', () => {
  it('3단계 프롬프트에 연관 PR과 세 상태 판정이 실린다', () => {
    const prompt = flat(sectionStartingWith(body, '### 3단계: 에이전트별 리뷰 제출'));
    expect(prompt).toContain('연관 PR (1.04단계 related.json)');
    expect(prompt).toContain('세 상태 판정 (three-state.json의 judgments)');
    expect(prompt).toContain('blocked를 문제 없음으로 읽지 않는다');
  });

  it('AGENT.md 입력 절이 세 상태 값과 blocked 처리를 적는다', () => {
    const input = flat(section(agentMd, '## 입력'));
    for (const s of ['ok', 'mergeOrder', 'defect', 'relatedRemovesUsed', 'blocked']) {
      expect(input, s).toContain(`\`${s}\``);
    }
    expect(input).toContain('문제 없음으로 읽지 않습니다');
  });
});
