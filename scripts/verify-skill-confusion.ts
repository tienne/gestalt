#!/usr/bin/env tsx
/**
 * 스킬 description과 triggers가 서로 너무 닮아 세션이 어느 스킬로 갈지 헷갈리는 쌍을 잡는다.
 *
 * build-skill-routing.ts는 routing을 둔 스킬끼리 트리거 문자열이 그대로 겹치는지만 본다.
 * 여기서는 routing 유무와 상관없이 모든 스킬을 문서로 본다. 표현이 달라도 뜻이 겹치는 쌍과
 * 예시 요청이 엉뚱한 스킬로 가는 경우를 통계로 잡는다. 둘은 보는 층위가 달라 따로 둔다.
 *
 * 문서는 스킬 이름과 description, triggers를 이어 붙인 것이다. 이름은 세션이 스킬 목록에서
 * description과 함께 보는 글자라 넣는다. 한글은 띄어쓰기와 조사가 들쭉날쭉해
 * 어절 단위로 자르면 "리뷰를"과 "리뷰"가 남남이 된다. 그래서 한글은 글자 bigram으로,
 * 라틴 문자와 숫자는 단어 통째로 토큰을 만든다.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillMd } from '../src/skills/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
export const SKILLS_DIR = join(ROOT, 'plugin/skills');
export const PROMPTS_FILE = join(ROOT, 'tests/fixtures/skill-routing-prompts.json');

// 두 스킬 문서의 cosine이 이 값을 넘으면 토큰 가중치 절반 넘게 겹친다는 뜻이라,
// 세션이 description만 읽고 둘을 가를 근거가 약하다. 통과시키려고 올리지 않는다.
export const PAIR_SIMILARITY_MAX = 0.5;
// 예시 요청이 자기 스킬을 1위로 뽑는 비율의 하한. 원본(addyosmani/agent-skills evals)과 같은 값이다.
export const RANK1_MIN = 0.95;
// 트리거가 이보다 적으면 하나를 빼고 재는 순간 문서가 description만 남아 측정이 아니게 된다.
export const MIN_TRIGGERS_FOR_HOLDOUT = 3;
// 스킬마다 fixture 예시 요청을 최소 이만큼 둔다. 하나뿐이면 그 문장 하나에 결과가 휘둘린다.
export const MIN_FIXTURE_PROMPTS = 2;

export interface SkillDoc {
  name: string;
  description: string;
  triggers: string[];
}

export function loadAllSkills(skillsDir: string = SKILLS_DIR): SkillDoc[] {
  const skills: SkillDoc[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const file = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const { frontmatter } = parseSkillMd(readFileSync(file, 'utf-8'), file);
    skills.push({
      name: frontmatter.name,
      description: frontmatter.description,
      triggers: frontmatter.triggers,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const WORD = /\p{Script=Hangul}+|(?:(?!\p{Script=Hangul})[\p{L}\p{N}])+/gu;
const HANGUL = /^\p{Script=Hangul}/u;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (!HANGUL.test(word)) {
      tokens.push(word);
      continue;
    }
    if (word.length === 1) {
      tokens.push(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
  }
  return tokens;
}

export type Vector = Map<string, number>;

export interface Index {
  idf: Map<string, number>;
  vectors: Map<string, Vector>;
}

export function skillText(skill: SkillDoc): string {
  return [skill.name, skill.description, ...skill.triggers].join('\n');
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

export function vectorize(tokens: string[], idf: Map<string, number>, fallbackIdf: number): Vector {
  const vec: Vector = new Map();
  let norm = 0;
  for (const [term, count] of termCounts(tokens)) {
    const weight = (1 + Math.log(count)) * (idf.get(term) ?? fallbackIdf);
    vec.set(term, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [term, w] of vec) vec.set(term, w / norm);
  return vec;
}

/** 문서 이름과 본문으로 TF-IDF 색인을 만든다. TF는 1+log(c), IDF는 log((N+1)/(df+1))+1. */
export function buildIndex(docs: { name: string; text: string }[]): Index {
  const tokenized = docs.map((d) => ({ name: d.name, tokens: tokenize(d.text) }));
  const df = new Map<string, number>();
  for (const { tokens } of tokenized) {
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log((n + 1) / (count + 1)) + 1);
  const fallback = Math.log(n + 1) + 1;
  const vectors = new Map<string, Vector>();
  for (const { name, tokens } of tokenized) vectors.set(name, vectorize(tokens, idf, fallback));
  return { idf, vectors };
}

export function cosine(a: Vector, b: Vector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other !== undefined) sum += w * other;
  }
  return sum;
}

export interface PairScore {
  a: string;
  b: string;
  score: number;
}

/** 모든 스킬 쌍의 유사도를 높은 순으로 돌려준다. */
export function scorePairs(skills: SkillDoc[]): PairScore[] {
  const index = buildIndex(skills.map((s) => ({ name: s.name, text: skillText(s) })));
  const pairs: PairScore[] = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]!.name;
      const b = skills[j]!.name;
      pairs.push({ a, b, score: cosine(index.vectors.get(a)!, index.vectors.get(b)!) });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

export function findConfusablePairs(
  skills: SkillDoc[],
  max: number = PAIR_SIMILARITY_MAX,
): PairScore[] {
  return scorePairs(skills).filter((p) => p.score > max);
}

export interface Ranked {
  name: string;
  score: number;
}

export function rankSkills(index: Index, prompt: string): Ranked[] {
  const fallback = Math.max(0, ...index.idf.values());
  const query = vectorize(tokenize(prompt), index.idf, fallback);
  const ranked: Ranked[] = [];
  for (const [name, vec] of index.vectors) ranked.push({ name, score: cosine(query, vec) });
  return ranked.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
}

/**
 * 스킬 이름을 그대로 적은 트리거("interview", "review loop", "gestalt setup")는 빼고 잰다.
 * 이런 트리거는 슬래시 호출에 가깝다. 다른 스킬이 "interview를 먼저 돌려라"처럼 갈 곳을
 * 안내하느라 이름을 적어 둔 문장에 끌려가 혼동이 아닌데도 실패로 잡힌다.
 * "gestalt"는 플러그인 네임스페이스(gestalt:setup)라 이름 비교에서 걷어낸다.
 */
export function isNameTrigger(skillName: string, trigger: string): boolean {
  const words = (t: string): string[] =>
    t
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== '' && w !== 'gestalt');
  return words(trigger).join('') === words(skillName).join('');
}

export interface Probe {
  skill: string;
  prompt: string;
  source: 'trigger' | 'fixture';
}

export type PromptFixture = Record<string, string[]>;

export function buildProbes(skills: SkillDoc[], fixture: PromptFixture): Probe[] {
  const probes: Probe[] = [];
  for (const skill of skills) {
    if (skill.triggers.length < MIN_TRIGGERS_FOR_HOLDOUT) continue;
    for (const trigger of skill.triggers) {
      if (isNameTrigger(skill.name, trigger)) continue;
      probes.push({ skill: skill.name, prompt: trigger, source: 'trigger' });
    }
  }
  for (const [skill, prompts] of Object.entries(fixture)) {
    for (const prompt of prompts) probes.push({ skill, prompt, source: 'fixture' });
  }
  return probes;
}

/** fixture가 없는 스킬을 가리키거나, 예시가 모자란 스킬이 있으면 그 사유를 돌려준다. */
export function checkFixtureCoverage(skills: SkillDoc[], fixture: PromptFixture): string[] {
  const problems: string[] = [];
  const names = new Set(skills.map((s) => s.name));
  for (const name of Object.keys(fixture)) {
    if (!names.has(name)) problems.push(`fixture의 "${name}"에 해당하는 스킬이 없다`);
  }
  for (const name of names) {
    const count = fixture[name]?.length ?? 0;
    if (count < MIN_FIXTURE_PROMPTS) {
      problems.push(`${name}: fixture 예시 요청이 ${count}개다 (최소 ${MIN_FIXTURE_PROMPTS}개)`);
    }
  }
  return problems;
}

export interface ProbeResult extends Probe {
  /** 자기 스킬보다 점수가 같거나 높은 스킬 수 + 1. 동점은 혼동으로 본다. */
  rank: number;
  top: Ranked;
}

/**
 * 트리거 예시는 자기 문서에서 그 트리거를 뺀 색인으로 잰다(leave-one-out).
 * 빼지 않으면 같은 문장이 문서에 그대로 있어 언제나 1위가 나온다.
 */
export function evaluateProbes(skills: SkillDoc[], probes: Probe[]): ProbeResult[] {
  const docsOf = (holdout?: Probe): { name: string; text: string }[] =>
    skills.map((s) => {
      if (!holdout || s.name !== holdout.skill) return { name: s.name, text: skillText(s) };
      const triggers = s.triggers.filter((t) => t !== holdout.prompt);
      return { name: s.name, text: skillText({ ...s, triggers }) };
    });
  const fullIndex = buildIndex(docsOf());

  return probes.map((probe) => {
    const index = probe.source === 'trigger' ? buildIndex(docsOf(probe)) : fullIndex;
    const ranked = rankSkills(index, probe.prompt);
    const own = ranked.find((r) => r.name === probe.skill);
    const ownScore = own?.score ?? 0;
    const rank =
      ownScore > 0
        ? 1 + ranked.filter((r) => r.name !== probe.skill && r.score >= ownScore).length
        : ranked.length;
    return { ...probe, rank, top: ranked[0]! };
  });
}

function fmt(n: number): string {
  return n.toFixed(3);
}

/** 1위를 놓친 예시 한 줄. 어느 스킬과도 겹치는 말이 없으면 1위 이름은 의미가 없어 따로 적는다. */
export function describeMiss(r: ProbeResult): string {
  const where =
    r.top.score > 0 ? `${r.top.name} ${fmt(r.top.score)}` : '어느 스킬과도 겹치는 말이 없음';
  return `[${r.source}] "${r.prompt}" (${r.skill}, ${r.rank}위) → ${where}`;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const skills = loadAllSkills();
  const fixture = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8')) as PromptFixture;
  const failures: string[] = [];

  const coverage = checkFixtureCoverage(skills, fixture);
  if (coverage.length > 0) {
    failures.push(
      `예시 요청 fixture(${PROMPTS_FILE}) 문제\n${coverage.map((c) => `  ${c}`).join('\n')}`,
    );
  }

  const pairs = scorePairs(skills);
  const confusable = pairs.filter((p) => p.score > PAIR_SIMILARITY_MAX);
  if (confusable.length > 0) {
    const lines = confusable.map((p) => `  ${p.a} ↔ ${p.b}  ${fmt(p.score)}`);
    failures.push(
      `description이 너무 닮은 스킬 쌍 (상한 ${PAIR_SIMILARITY_MAX})\n${lines.join('\n')}\n` +
        '  두 SKILL.md의 description에서 겹치는 표현을 덜어내고 각자 하는 일을 앞에 세우세요',
    );
  }

  const results = evaluateProbes(skills, buildProbes(skills, fixture));
  const hits = results.filter((r) => r.rank === 1).length;
  const ratio = results.length > 0 ? hits / results.length : 1;
  const misses = results.filter((r) => r.rank !== 1);
  if (ratio < RANK1_MIN) {
    const lines = misses.map((r) => `  ${describeMiss(r)}`);
    failures.push(
      `예시 요청이 자기 스킬을 1위로 뽑은 비율 ${fmt(ratio)} (${hits}/${results.length}), 하한 ${RANK1_MIN}\n` +
        `${lines.join('\n')}\n` +
        '  괄호 안 스킬의 description에 그 요청의 말을 담거나, 화살표 오른쪽 description에서\n' +
        '  남의 일을 설명하느라 끌어온 표현을 덜어내세요',
    );
  }

  const top = pairs
    .slice(0, 5)
    .map((p) => `${p.a}↔${p.b} ${fmt(p.score)}`)
    .join(', ');
  const summary = `스킬 ${skills.length}개, 최고 쌍 유사도 ${top}; 1위 비율 ${fmt(ratio)} (${hits}/${results.length})`;

  if (failures.length > 0) {
    console.error(`스킬 혼동 검사 실패\n\n${failures.join('\n\n')}\n\n${summary}`);
    process.exit(1);
  }
  console.log(`스킬 혼동 검사 통과: ${summary}`);
  if (misses.length > 0) {
    console.log(
      `1위를 놓친 예시 (비율은 하한 이상)\n${misses.map((r) => `  ${describeMiss(r)}`).join('\n')}`,
    );
  }
}
