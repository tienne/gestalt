#!/usr/bin/env tsx
/**
 * 각 SKILL.md의 triggers로 proactive-routing.md의 스킬 표를 다시 뽑는다.
 *
 * triggers는 파서가 읽기만 하고 아무도 안 쓰던 필드라, 스킬을 고칠 때 표의 예시 문구와
 * 따로 놀았다. 표를 여기서 뽑으면 SKILL.md 한 곳만 고치면 된다.
 * 표에 실을 스킬은 frontmatter에 `routing`을 둔 것뿐이다 — 넓은 트리거가 설치된 모든
 * 레포에서 자동 발동되지 않도록 스킬마다 고른다.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillMd } from '../src/skills/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const SKILLS_DIR = join(ROOT, 'plugin/skills');
export const ROUTING_DOC = join(SKILLS_DIR, '_shared/proactive-routing.md');

export const START_MARKER = '<!-- skill-routing:start -->';
export const END_MARKER = '<!-- skill-routing:end -->';

export interface RoutedSkill {
  name: string;
  triggers: string[];
  note?: string;
}

export function loadRoutedSkills(skillsDir: string = SKILLS_DIR): RoutedSkill[] {
  const skills: RoutedSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { frontmatter } = parseSkillMd(readFileSync(file, 'utf-8'), file);
    if (!frontmatter.routing) continue;
    if (frontmatter.triggers.length === 0) {
      throw new Error(`${frontmatter.name}: routing이 있는데 triggers가 비어 있다`);
    }
    skills.push({
      name: frontmatter.name,
      triggers: frontmatter.triggers,
      note: frontmatter.routing.note,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface TriggerOverlap {
  inner: { skill: string; trigger: string };
  outer: { skill: string; trigger: string };
}

/**
 * 한 스킬의 트리거가 다른 스킬 트리거 안에 그대로 들어 있는 쌍을 찾는다.
 * 짧은 쪽이 걸리는 요청에서 긴 쪽 스킬로 가야 할지 세션이 가릴 근거가 없다.
 * 대소문자와 공백은 무시한다 — "리뷰 루프"와 "리뷰루프"는 같은 요청이다.
 */
export function findTriggerOverlaps(skills: RoutedSkill[]): TriggerOverlap[] {
  const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, '');
  const overlaps: TriggerOverlap[] = [];
  for (const a of skills) {
    for (const b of skills) {
      if (a.name === b.name) continue;
      for (const ta of a.triggers) {
        for (const tb of b.triggers) {
          if (norm(tb).includes(norm(ta))) {
            overlaps.push({
              inner: { skill: a.name, trigger: ta },
              outer: { skill: b.name, trigger: tb },
            });
          }
        }
      }
    }
  }
  return overlaps;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderSkillTable(skills: RoutedSkill[]): string {
  const rows = skills.map((s) => {
    const phrases = s.triggers.map((t) => `"${cell(t)}"`).join(', ');
    return `| ${phrases} | \`${s.name}\` 스킬 사용 | ${s.note ? cell(s.note) : ''} |`;
  });
  return [
    START_MARKER,
    '<!-- 생성물이다. 각 SKILL.md의 triggers와 routing.note를 고치고 pnpm build:routing 으로 다시 뽑는다 -->',
    '',
    '| 요청 문구 | 스킬 | 비고 |',
    '|-----------|------|------|',
    ...rows,
    '',
    END_MARKER,
  ].join('\n');
}

export function applySkillTable(doc: string, table: string): string {
  const start = doc.indexOf(START_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`라우팅 문서에 ${START_MARKER} … ${END_MARKER} 마커가 없다`);
  }
  return doc.slice(0, start) + table + doc.slice(end + END_MARKER.length);
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const checkOnly = process.argv.includes('--check');
  let current: string;
  let next: string;
  let count: number;
  try {
    const skills = loadRoutedSkills();
    const overlaps = findTriggerOverlaps(skills);
    if (overlaps.length > 0) {
      const lines = overlaps.map(
        (o) => `  ${o.inner.skill} "${o.inner.trigger}" ⊂ ${o.outer.skill} "${o.outer.trigger}"`,
      );
      throw new Error(`스킬끼리 트리거가 겹친다\n${lines.join('\n')}`);
    }
    count = skills.length;
    current = readFileSync(ROUTING_DOC, 'utf-8');
    next = applySkillTable(current, renderSkillTable(skills));
  } catch (error) {
    console.error(`스킬 라우팅 표 생성 실패: ${(error as Error).message}`);
    process.exit(1);
  }

  if (checkOnly) {
    if (current !== next) {
      console.error(
        `${ROUTING_DOC} 스킬 표가 SKILL.md triggers와 어긋납니다. pnpm build:routing 으로 다시 뽑으세요`,
      );
      process.exit(1);
    }
    console.log(`스킬 라우팅 표 최신 상태 (스킬 ${count}개)`);
  } else {
    writeFileSync(ROUTING_DOC, next, 'utf-8');
    console.log(`스킬 라우팅 표 생성: ${ROUTING_DOC} (스킬 ${count}개)`);
  }
}
