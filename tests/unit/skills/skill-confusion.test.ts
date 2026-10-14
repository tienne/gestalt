import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MIN_FIXTURE_PROMPTS,
  PAIR_SIMILARITY_MAX,
  PROMPTS_FILE,
  RANK1_MIN,
  buildIndex,
  buildProbes,
  checkFixtureCoverage,
  cosine,
  describeMiss,
  evaluateProbes,
  findConfusablePairs,
  isNameTrigger,
  loadAllSkills,
  rankSkills,
  scorePairs,
  tokenize,
  type PromptFixture,
  type SkillDoc,
} from '../../../scripts/verify-skill-confusion.js';

const dirs: string[] = [];

function skillsDir(skills: Record<string, string>): string {
  const dir = join('.gestalt-test', `skill-confusion-${randomUUID()}`);
  dirs.push(dir);
  for (const [name, frontmatter] of Object.entries(skills)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n${frontmatter}---\n본문\n`);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skill(name: string, description: string, triggers: string[] = []): SkillDoc {
  return { name, description, triggers };
}

describe('tokenize', () => {
  it('한글은 어절 안에서 글자 bigram으로 자른다', () => {
    expect(tokenize('코드 리뷰를')).toEqual(['코드', '리뷰', '뷰를']);
  });

  it('라틴 문자와 숫자는 단어 통째로, 소문자로 둔다', () => {
    expect(tokenize('Review PR-42')).toEqual(['review', 'pr', '42']);
  });

  it('한글과 붙은 영문은 문자 체계 경계에서 가른다', () => {
    expect(tokenize('PR에')).toEqual(['pr', '에']);
  });

  it('한 글자 한글 어절은 그대로 토큰이 된다', () => {
    expect(tokenize('덱 만들')).toEqual(['덱', '만들']);
  });
});

describe('buildIndex와 cosine', () => {
  it('같은 문서는 1, 겹치는 토큰이 없으면 0이다', () => {
    const index = buildIndex([
      { name: 'a', text: '코드 리뷰' },
      { name: 'b', text: '코드 리뷰' },
      { name: 'c', text: '슬랙 전송' },
    ]);
    expect(cosine(index.vectors.get('a')!, index.vectors.get('b')!)).toBeCloseTo(1);
    expect(cosine(index.vectors.get('a')!, index.vectors.get('c')!)).toBe(0);
  });

  it('여러 문서에 흔한 토큰은 드문 토큰보다 가중치가 낮다', () => {
    const index = buildIndex([
      { name: 'a', text: '리뷰 출하' },
      { name: 'b', text: '리뷰 답글' },
      { name: 'c', text: '리뷰 루프' },
    ]);
    expect(index.idf.get('리뷰')!).toBeLessThan(index.idf.get('출하')!);
  });
});

describe('scorePairs와 findConfusablePairs', () => {
  const skills = [
    skill('alpha', '코드 리뷰를 하고 인라인 코멘트를 게시한다'),
    skill('beta', '코드 리뷰를 하고 인라인 코멘트를 게시한다 한 번만'),
    skill('gamma', '슬랙 메시지를 예약 발송한다'),
  ];

  it('쌍을 유사도 높은 순으로 돌려준다', () => {
    const pairs = scorePairs(skills);
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ a: 'alpha', b: 'beta' });
    expect(pairs[0]!.score).toBeGreaterThan(pairs[1]!.score);
  });

  it('상한을 넘는 쌍만 혼동 쌍으로 잡는다', () => {
    const confusable = findConfusablePairs(skills, PAIR_SIMILARITY_MAX);
    expect(confusable.map((p) => `${p.a}/${p.b}`)).toEqual(['alpha/beta']);
  });
});

describe('isNameTrigger', () => {
  it('구분자와 대소문자를 무시하고 스킬 이름과 같은 트리거를 잡는다', () => {
    expect(isNameTrigger('review-loop', 'review loop')).toBe(true);
    expect(isNameTrigger('blast-radius', 'Blast Radius')).toBe(true);
  });

  it('플러그인 네임스페이스 gestalt는 걷어내고 비교한다', () => {
    expect(isNameTrigger('setup', 'gestalt setup')).toBe(true);
    expect(isNameTrigger('setup', 'setup gestalt')).toBe(true);
  });

  it('이름 말고 다른 말이 섞이면 이름 트리거가 아니다', () => {
    expect(isNameTrigger('local-pr', 'gestalt pr')).toBe(false);
    expect(isNameTrigger('interview', 'start interview')).toBe(false);
  });
});

describe('buildProbes', () => {
  it('이름 트리거와 트리거가 모자란 스킬은 빼고 fixture는 모두 싣는다', () => {
    const probes = buildProbes(
      [
        skill('review-loop', '', ['review loop', '리뷰 루프', '재리뷰 반복']),
        skill('few', '', ['하나', '둘']),
      ],
      { few: ['예시 요청'] },
    );
    expect(probes).toEqual([
      { skill: 'review-loop', prompt: '리뷰 루프', source: 'trigger' },
      { skill: 'review-loop', prompt: '재리뷰 반복', source: 'trigger' },
      { skill: 'few', prompt: '예시 요청', source: 'fixture' },
    ]);
  });
});

describe('evaluateProbes', () => {
  describe('같은 문장도 출처에 따라 다르게 잰다', () => {
    const skills = [
      skill('ship', '브랜치를 출하한다', ['출하', '코파일럿 리뷰까지', '드래프트 올리기']),
      skill('other', '코파일럿 설정 안내 문서를 정리한다'),
    ];
    const prompt = '코파일럿 리뷰까지';

    it('트리거 예시는 자기 문서에서 그 트리거를 빼고 잰다', () => {
      const [result] = evaluateProbes(skills, [{ skill: 'ship', prompt, source: 'trigger' }]);
      expect(result!.rank).toBe(2);
      expect(result!.top.name).toBe('other');
    });

    it('fixture 예시는 트리거를 빼지 않은 전체 색인으로 잰다', () => {
      const [result] = evaluateProbes(skills, [{ skill: 'ship', prompt, source: 'fixture' }]);
      expect(result!.rank).toBe(1);
    });
  });

  it('동점은 1위로 치지 않는다', () => {
    const skills = [skill('a', '코드 리뷰'), skill('b', '코드 리뷰')];
    const [result] = evaluateProbes(skills, [
      { skill: 'a', prompt: '코드 리뷰', source: 'fixture' },
    ]);
    expect(result!.rank).toBe(2);
  });

  it('어느 문서와도 겹치지 않으면 꼴찌로 친다', () => {
    const skills = [skill('a', '코드 리뷰'), skill('b', '슬랙 전송'), skill('c', '지라 티켓')];
    const [result] = evaluateProbes(skills, [{ skill: 'a', prompt: 'ELI5', source: 'fixture' }]);
    expect(result!.rank).toBe(3);
    expect(describeMiss(result!)).toContain('어느 스킬과도 겹치는 말이 없음');
  });
});

describe('rankSkills', () => {
  it('요청과 가까운 스킬부터 늘어놓는다', () => {
    const index = buildIndex([
      { name: 'slack', text: '슬랙 메시지 예약 발송' },
      { name: 'jira', text: '지라 티켓 생성' },
    ]);
    expect(rankSkills(index, '지라 티켓 만들어줘').map((r) => r.name)).toEqual(['jira', 'slack']);
  });
});

describe('checkFixtureCoverage', () => {
  it('없는 스킬을 가리키거나 예시가 모자란 스킬을 알린다', () => {
    const fixture: PromptFixture = { ghost: ['a', 'b'], real: ['하나'] };
    const problems = checkFixtureCoverage([skill('real', ''), skill('bare', '')], fixture);
    expect(problems).toEqual([
      'fixture의 "ghost"에 해당하는 스킬이 없다',
      `real: fixture 예시 요청이 1개다 (최소 ${MIN_FIXTURE_PROMPTS}개)`,
      `bare: fixture 예시 요청이 0개다 (최소 ${MIN_FIXTURE_PROMPTS}개)`,
    ]);
  });
});

describe('loadAllSkills', () => {
  it('routing 유무와 상관없이 _로 시작하지 않는 스킬을 이름순으로 싣는다', () => {
    const dir = skillsDir({
      zeta: 'description: "제타"\ntriggers:\n  - "제타"\nrouting: {}\n',
      alpha: 'description: "알파"\n',
      _shared: 'description: "무시"\n',
    });
    expect(loadAllSkills(dir)).toEqual([
      { name: 'alpha', description: '알파', triggers: [] },
      { name: 'zeta', description: '제타', triggers: ['제타'] },
    ]);
  });
});

describe('현재 plugin/skills', () => {
  const skills = loadAllSkills();
  const fixture = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8')) as PromptFixture;

  it('fixture가 모든 스킬을 덮는다', () => {
    expect(checkFixtureCoverage(skills, fixture)).toEqual([]);
  });

  it('description이 상한을 넘게 닮은 쌍이 없다', () => {
    expect(findConfusablePairs(skills)).toEqual([]);
  });

  it('예시 요청이 자기 스킬을 1위로 뽑는 비율이 하한 이상이다', () => {
    const results = evaluateProbes(skills, buildProbes(skills, fixture));
    const ratio = results.filter((r) => r.rank === 1).length / results.length;
    expect(ratio).toBeGreaterThanOrEqual(RANK1_MIN);
  });
});
