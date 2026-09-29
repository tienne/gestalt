import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  arrowPartners,
  extractCellTerms,
  extractPhraseRoots,
  findSelfContamination,
  parseAddedLines,
  parseRuleTables,
  stripQuoted,
} from '../../../src/harness-review/self-contamination.js';
import { buildPhraseRootRepo } from '../../fixtures/harness-repos/scenarios.js';
import { cleanupFakeRepos, createCommitPair, createFakeRepo } from '../../helpers/fake-repo.js';

afterEach(cleanupFakeRepos);

const RULEBOOK = 'plugin/role-agents/_shared/references/ai-tell-quick-rules.md';

const BASE_RULEBOOK = `# 룰북

## D. 관용구

| ID | 패턴 | 심각도 | 처방 |
|---|---|---|---|
| D-1 | 결산 피벗 "결론적으로" | S1 | 삭제 |

### B-5 대체어

| 원어 | 쓰지 말 것 | 이렇게 |
|---|---|---|
| source of truth (사본 여럿) | 소스 오브 트루스 | 기준 문서 |
`;

function setup(headRows: string, docs: Record<string, string> = {}) {
  const repo = createFakeRepo({ name: 'widget-kit' });
  const pair = createCommitPair(repo, {
    base: { [RULEBOOK]: BASE_RULEBOOK, ...docs },
    head: { [RULEBOOK]: `${BASE_RULEBOOK}${headRows}` },
  });
  return { repo, pair };
}

describe('diff 파싱', () => {
  it('추가 줄의 새 파일 기준 줄 번호를 센다', () => {
    const diff = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,2 +1,3 @@',
      ' 첫 줄',
      '+새 줄',
      ' 셋째 줄',
    ].join('\n');
    expect([...parseAddedLines(diff).get('a.md')!]).toEqual([[2, '새 줄']]);
  });
});

describe('검색어 뽑기', () => {
  it('따옴표 안 나열은 슬래시로 쪼개고 화살표 앞 영어 원어를 함께 뽑는다', () => {
    expect(extractCellTerms('결산 피벗 "결론적으로/이를 통해"', false)).toEqual([
      '결론적으로',
      '이를 통해',
    ]);
    expect(extractCellTerms('canonical → "정본"', false)).toEqual(['정본', 'canonical']);
  });

  it('자리표시자 든 금지 예 구절은 조사를 떼고 한국어 어근만 남긴다', () => {
    expect(extractPhraseRoots('"A가 정본이다", "원본은 A다"')).toEqual(['정본', '원본']);
    // 한 글자 어근과 흔한 말은 버린다
    expect(extractPhraseRoots('"X를 기준 문서로 둔다"')).toEqual(['기준']);
    expect(extractPhraseRoots('"A는 B의 것이다", "이 파일이 A다"')).toEqual([]);
    // 자리표시자 없는 구절은 extractCellTerms가 통째로 쓴다
    expect(extractPhraseRoots('"물질화한다"')).toEqual([]);
  });

  it('처방 칸은 검색어로 안 쓴다', () => {
    const rows = parseRuleTables(BASE_RULEBOOK);
    const b5 = rows.find((r) => r.fullText.includes('소스 오브 트루스'))!;
    expect(b5.terms).toEqual(['source of truth', '소스 오브 트루스']);
    expect(b5.terms).not.toContain('기준 문서');
  });

  it('인용과 괄호 안은 산문에서 뺀다', () => {
    expect(stripQuoted('예시 "결론적으로" 와 `본질적으로` 와 (핵심적으로)').includes('결론')).toBe(
      false,
    );
  });
});

describe('자기오염 검색 (AC1)', () => {
  it('새 금지어를 다른 문서 본문에서 찾고 앞뒤 줄을 함께 돌려준다', () => {
    const { repo, pair } = setup('| D-3 | "본질적으로" | S1 | 삭제 |\n', {
      'agents/writer/AGENT.md': '# 작성자\n\n첫 줄\n이 방식은 본질적으로 빠르다.\n끝 줄\n',
      'agents/other/AGENT.md': '예시로 "본질적으로"를 인용하고 `본질적으로`도 쓴다.\n',
    });
    const found = findSelfContamination({
      repoRoot: repo.root,
      diff: pair.diff,
      repoName: repo.name,
    });

    expect(found).toHaveLength(1);
    const hit = found[0]!;
    expect(hit.kind).toBe('selfContamination');
    expect(hit.targetPath).toBe('agents/writer/AGENT.md');
    expect(hit.targetLine).toBe(4);
    expect(hit.targetRepo).toBe('widget-kit');
    expect(hit.sourceFile).toBe(RULEBOOK);
    expect(hit.needsLlmJudgment).toBe(false);
    expect(hit.contextLines).toEqual(['', '첫 줄', '이 방식은 본질적으로 빠르다.', '끝 줄', '']);
  });

  it('contextLines 옵션으로 앞뒤 줄 수를 조절한다', () => {
    const { repo, pair } = setup('| D-3 | "본질적으로" | S1 | 삭제 |\n', {
      'a.md': '1\n2\n3\n본질적으로 좋다\n5\n6\n7\n',
    });
    const [hit] = findSelfContamination({ repoRoot: repo.root, diff: pair.diff, contextLines: 1 });
    expect(hit!.contextLines).toEqual(['3', '본질적으로 좋다', '5']);
  });

  it('띄어쓰기 변형과 한글 어간 변형도 잡되 확정하지 않는다', () => {
    const { repo, pair } = setup('| B-5 | materialize → "물질화한다" | S1 | 미리 계산 |\n', {
      'a.md': '뷰를 물질 화한다\n',
      'b.md': '캐시가 물질화 된 상태\n',
    });
    const found = findSelfContamination({ repoRoot: repo.root, diff: pair.diff });
    const byPath = Object.fromEntries(found.map((c) => [c.targetPath, c]));

    expect(byPath['a.md']!.needsLlmJudgment).toBe(false);
    expect(byPath['b.md']!.needsLlmJudgment).toBe(true);
  });

  it('룰북 표의 원어 짝으로 영어 원어와 띄어쓰기 변형까지 넓히고 LLM 판정으로 넘긴다', () => {
    const { repo, pair } = setup('| B-3 | 음차 "소스 오브 트루스" | S1 | 의역 |\n', {
      'a.md': '이 문서가 단일 소스오브트루스다\n',
      'b.md': 'The Source-of-Truth is here\n',
    });
    const found = findSelfContamination({ repoRoot: repo.root, diff: pair.diff });
    const byPath = Object.fromEntries(found.map((c) => [c.targetPath, c]));

    expect(byPath['a.md']!.needsLlmJudgment).toBe(false);
    expect(byPath['a.md']!.termOrigin).toBe('literal');
    expect(byPath['b.md']!.searchTerm).toBe('source of truth');
    expect(byPath['b.md']!.termOrigin).toBe('synonym');
    expect(byPath['b.md']!.needsLlmJudgment).toBe(true);
  });

  it('같은 행의 형제 금지어와 다른 룰의 금지어는 동의어로 끌어오지 않는다', () => {
    const { repo, pair } = setup('| D-3 | "본질적으로/핵심적으로" | S1 | 삭제 |\n', {
      'a.md': '결론적으로 정리한다\n',
    });
    expect(findSelfContamination({ repoRoot: repo.root, diff: pair.diff })).toEqual([]);
  });

  it('조건부 룰(횟수, 대상 아님 단서)은 걸려도 확정하지 않는다', () => {
    const { repo, pair } = setup('| D-4 | hype 어휘(파격적·압도적) 3회+ | S1 | 수식어 삭제 |\n', {
      'a.md': '압도적 성능\n',
    });
    const [hit] = findSelfContamination({ repoRoot: repo.root, diff: pair.diff });
    expect(hit!.searchTerm).toBe('압도적');
    expect(hit!.needsLlmJudgment).toBe(true);
  });

  it('뜻으로만 정의된 룰은 정의 줄과 룰 ID 인용 문서를 판정 후보로만 낸다', () => {
    const { repo, pair } = setup(
      '| C-99 | 문단을 요약 문장으로 끝내는 구조 | S1 | 마지막 문장 삭제 |\n',
      {
        'plugin/skills/x/SKILL.md': 'C-99를 지킨다.\n',
        'unrelated.md': '관계없는 글\n',
      },
    );
    const found = findSelfContamination({ repoRoot: repo.root, diff: pair.diff });

    expect(found.map((c) => c.targetPath).sort()).toEqual([RULEBOOK, 'plugin/skills/x/SKILL.md']);
    expect(found.every((c) => c.needsLlmJudgment)).toBe(true);
    expect(found.every((c) => c.termOrigin === 'definition')).toBe(true);
  });

  it('금지어를 정의하는 표 행과 diff에 든 줄은 후보에서 뺀다', () => {
    const { repo, pair } = setup('| D-3 | "본질적으로" | S1 | 삭제 |\n');
    expect(findSelfContamination({ repoRoot: repo.root, diff: pair.diff })).toEqual([]);
  });

  it('verify-rule-refs SELF_CONTAMINATION 고정 목록을 모두 검색어로 잡는다', () => {
    const words = ['결론적으로', '요약하자면', '정리하자면', '본질적으로', '핵심적으로'];
    const docs = Object.fromEntries(words.map((w, i) => [`doc${i}.md`, `이건 ${w} 그렇다\n`]));
    const { repo, pair } = setup(`| D-9 | "${words.join('/')}" | S1 | 삭제 |\n`, docs);
    const found = findSelfContamination({ repoRoot: repo.root, diff: pair.diff });

    expect(found.map((c) => c.searchTerm).sort()).toEqual([...words].sort());
    expect(found.every((c) => !c.needsLlmJudgment)).toBe(true);
  });

  it('금지 예 구절의 한국어 금지어가 다른 AGENT.md 문장에서 잡힌다', () => {
    const sc = buildPhraseRootRepo();
    const found = findSelfContamination({
      repoRoot: sc.repo.root,
      diff: sc.diff,
      repoName: sc.repo.name,
    });

    expect(found.map((c) => ({ path: c.targetPath, line: c.targetLine }))).toEqual(sc.contaminated);
    for (const c of found) {
      expect(sc.roots).toContain(c.searchTerm);
      expect(c.termOrigin).toBe('phraseRoot');
      expect(c.needsLlmJudgment).toBe(true);
      expect(c.sourceFile).toBe(sc.rulebook);
    }
    for (const clean of sc.cleanFiles) {
      expect(found.some((c) => c.targetPath === clean)).toBe(false);
    }
  });

  it('디렉토리 심링크로 두 번 보이는 md는 한 번만 센다', () => {
    const { repo, pair } = setup('| D-3 | "본질적으로" | S1 | 삭제 |\n', {
      'plugin/skills/x/SKILL.md': '본질적으로 좋다\n',
    });
    symlinkSync('plugin/skills', join(repo.root, 'skills'));
    const found = findSelfContamination({ repoRoot: repo.root, diff: pair.diff });
    expect(found.map((c) => c.targetPath)).toEqual(['plugin/skills/x/SKILL.md']);
  });

  it('룰 표가 아닌 md의 추가 줄은 검색어로 안 쓴다', () => {
    const repo = createFakeRepo();
    const pair = createCommitPair(repo, {
      base: { 'README.md': '# 소개\n', 'a.md': '본질적으로 좋다\n' },
      head: { 'README.md': '# 소개\n\n본질적으로 좋은 도구다\n' },
    });
    expect(findSelfContamination({ repoRoot: repo.root, diff: pair.diff })).toEqual([]);
  });
});

describe('라벨링 뒤 걸러낸 잡음', () => {
  const OLD_ROW = '| D-2 | 번역투 (materialize → "물질화", branch → "갈래") | S1 | 동사로 쓴다 |';
  const NEW_ROW =
    '| D-2 | 번역투 (materialize → "물질화", branch → "갈래", canonical → "정본") | S1 | 동사로 쓴다 |';

  function modifyRow(docs: Record<string, string>) {
    const repo = createFakeRepo({ name: 'widget-kit' });
    const base = BASE_RULEBOOK.replace('| D-1 |', `${OLD_ROW}\n| D-1 |`);
    const pair = createCommitPair(repo, {
      base: { [RULEBOOK]: base, ...docs },
      head: { [RULEBOOK]: base.replace(OLD_ROW, NEW_ROW) },
    });
    return findSelfContamination({ repoRoot: repo.root, diff: pair.diff });
  }

  it('고친 룰 행에서는 새로 더한 금지어만 찾는다', () => {
    const found = modifyRow({
      'plugin/skills/a/SKILL.md': '이 파일이 정본이다\n',
      'plugin/skills/b/SKILL.md': 'git branch를 새로 딴다\n',
      'plugin/skills/c/SKILL.md': '물질화 단계를 거친다\n',
    });
    expect(found.map((c) => c.targetPath)).toEqual(['plugin/skills/a/SKILL.md']);
  });

  it('화살표 짝이 있는 행은 짝끼리만 동의어로 넓힌다', () => {
    const found = modifyRow({
      'plugin/skills/a/SKILL.md': 'This is the canonical copy.\n',
      'plugin/skills/b/SKILL.md': 'Run materialize first.\n',
    });
    expect(found.map((c) => c.targetPath)).toEqual(['plugin/skills/a/SKILL.md']);
    expect(arrowPartners(NEW_ROW, '정본')).toEqual(['canonical']);
    expect(arrowPartners(NEW_ROW, '없는말')).toBeNull();
  });

  it('룰 ID도 금지 칸도 없는 표는 칸 내용을 금지어로 안 쓴다', () => {
    const repo = createFakeRepo();
    const table = '| 경로 | 설명 |\n|---|---|\n| kit/components | 컴포넌트 문서 |\n';
    const pair = createCommitPair(repo, {
      base: { 'CLAUDE.md': '# 안내\n', 'plugin/skills/a/SKILL.md': 'kit/components를 읽는다\n' },
      head: { 'CLAUDE.md': `# 안내\n\n${table}` },
    });
    expect(findSelfContamination({ repoRoot: repo.root, diff: pair.diff })).toEqual([]);
  });

  it('CHANGELOG는 지난 표현을 옮겨 적는 자리라 찾지 않는다', () => {
    const found = modifyRow({
      'CHANGELOG.md': '- 정본이라는 말을 걷어냈다\n',
      'plugin/skills/a/SKILL.md': '이 파일이 정본이다\n',
    });
    expect(found.map((c) => c.targetPath)).toEqual(['plugin/skills/a/SKILL.md']);
  });
});
