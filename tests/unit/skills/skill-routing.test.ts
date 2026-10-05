import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  END_MARKER,
  START_MARKER,
  applySkillTable,
  findTriggerOverlaps,
  loadRoutedSkills,
  renderSkillTable,
} from '../../../scripts/build-skill-routing.js';

const dirs: string[] = [];

function skillsDir(skills: Record<string, string>): string {
  const dir = join('.gestalt-test', `skill-routing-${randomUUID()}`);
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

describe('loadRoutedSkills', () => {
  it('routing이 있는 스킬만 이름순으로 싣는다', () => {
    const dir = skillsDir({
      zeta: 'triggers:\n  - "제타"\nrouting: {}\n',
      alpha: 'triggers:\n  - "알파"\nrouting:\n  note: "비고"\n',
      quiet: 'triggers:\n  - "해결해줘"\n',
      _shared: 'triggers:\n  - "무시"\nrouting: {}\n',
    });
    expect(loadRoutedSkills(dir)).toEqual([
      { name: 'alpha', triggers: ['알파'], note: '비고' },
      { name: 'zeta', triggers: ['제타'], note: undefined },
    ]);
  });

  it('routing이 있는데 triggers가 비면 실패한다', () => {
    const dir = skillsDir({ empty: 'routing: {}\n' });
    expect(() => loadRoutedSkills(dir)).toThrow(/triggers가 비어/);
  });
});

describe('renderSkillTable', () => {
  it('표 칸을 깨는 파이프는 이스케이프한다', () => {
    const table = renderSkillTable([{ name: 'x', triggers: ['a|b'], note: 'c|d' }]);
    expect(table).toContain('| "a\\|b" | `x` 스킬 사용 | c\\|d |');
  });
});

describe('applySkillTable', () => {
  it('마커 사이만 바꾸고 앞뒤 산문은 둔다', () => {
    const doc = `앞\n${START_MARKER}\n옛 표\n${END_MARKER}\n뒤\n`;
    const next = applySkillTable(doc, `${START_MARKER}\n새 표\n${END_MARKER}`);
    expect(next).toBe(`앞\n${START_MARKER}\n새 표\n${END_MARKER}\n뒤\n`);
  });

  it('마커가 없으면 실패한다', () => {
    expect(() => applySkillTable('표 없음', 'x')).toThrow(/마커가 없다/);
  });
});

describe('findTriggerOverlaps', () => {
  it('다른 스킬 트리거 안에 들어 있는 트리거를 공백과 대소문자 무시하고 찾는다', () => {
    const overlaps = findTriggerOverlaps([
      { name: 'loop', triggers: ['리뷰 루프'] },
      { name: 'ship', triggers: ['리뷰루프 돌려줘', 'Ship'] },
    ]);
    expect(overlaps).toEqual([
      {
        inner: { skill: 'loop', trigger: '리뷰 루프' },
        outer: { skill: 'ship', trigger: '리뷰루프 돌려줘' },
      },
    ]);
  });

  it('같은 스킬 안의 포함 관계는 겹침으로 안 본다', () => {
    expect(findTriggerOverlaps([{ name: 'pr', triggers: ['PR', 'PR 만들어'] }])).toEqual([]);
  });
});
