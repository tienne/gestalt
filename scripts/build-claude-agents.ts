#!/usr/bin/env tsx
/**
 * 리뷰어와 역할 에이전트의 AGENT.md로 Claude Code 플러그인 에이전트(`agents/<name>.md`)를 뽑는다.
 *
 * 스킬이 리뷰어를 띄울 때 Explore를 띄우고 그 안에서 `ges_agent get`으로 지침을 받아오게 하면
 * 서브에이전트 첫 요청에 지연 로딩 도구 목록과 스킬 목록이 통째로 실리고 왕복도 두 번 붙는다.
 * 도구를 좁힌 네이티브 에이전트로 띄우면 둘 다 빠진다. 원본은 그대로 두고 여기서 뽑아서
 * `ges_agent`로 지침을 받는 다른 런타임과 같은 원본을 쓴다.
 *
 * 생성 위치가 레포 루트 `agents/`인 건 Claude 플러그인 루트가 레포 루트라서다. 매니페스트에
 * `agents` 필드를 두면 기본 디렉토리를 대체한다. 디렉토리 문자열을 넣으면 플러그인 로드가
 * 깨진다(2.1.302에서 확인). 루트 `hooks/`처럼 기본 경로에 두고 필드는 안 쓴다.
 *
 * 뽑은 에이전트마다 description이 Agent 도구 설명에 실려 모든 세션의 매 요청에 붙는다. 그래서
 * 스킬이 `subagent_type`으로 띄우는 에이전트만 뽑고 설명도 한 줄로 줄인다. 나머지 역할 에이전트는
 * `/agent`나 `ges_agent`로 메인 세션에서 쓰는 자리라 여기 없어도 된다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentMd } from '../src/agent/parser.js';
import { DEFAULT_TIER_MODELS } from '../src/core/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
export const OUT_DIR = join(ROOT, 'agents');

/** 리뷰 스킬이 `gestalt:<agent-name>`으로 골라 띄우는 후보라 전부 뽑는다. */
const REVIEWER_DIR = 'plugin/review-agents';

/** 스킬이 이름으로 띄우는 에이전트의 원본을 찾는 자리. 레포 루트 기준이다. */
const SOURCE_DIRS = [REVIEWER_DIR, 'plugin/role-agents', 'plugin/agents'] as const;

const SKILLS_DIR = 'plugin/skills';
export const SPAWN_REF_ONE = /subagent_type:\s*"gestalt:([a-z][\w-]*)"/;
const SPAWN_REF = new RegExp(SPAWN_REF_ONE.source, 'g');

/**
 * Agent 도구 설명에 실리는 한 줄. 스킬이 이름으로 띄우니 고르는 데 쓸 설명은 필요 없다. 원본
 * description은 `ges_agent`와 라우팅이 쓰므로 그대로 두고 여기서만 짧게 쓴다.
 */
const SHORT_DESCRIPTIONS: Record<string, string> = {
  'comment-reviewer': '코드 주석 리뷰',
  'frontend-reviewer': '프론트엔드 코드 리뷰',
  'harness-reviewer': '스킬과 에이전트 문서 리뷰',
  'performance-reviewer': '성능 리뷰',
  'quality-reviewer': '코드 품질 리뷰',
  'security-reviewer': '보안 리뷰',
  'writing-reviewer': '문장 어투 리뷰',
  'continuity-judge': '리뷰 결과 정합 판정',
  'suggestion-verifier': '리뷰 제안 게시 전 검증',
  'code-review-writer': '리뷰 코멘트 문장 작성',
  'code-review-responder': '내 PR 리뷰에 답글 작성',
  'change-context-writer': 'diff로 변경 컨텍스트 문서 작성',
  'humanize-monolith': '한국어 AI-tell 윤문',
  'impact-writer': '성과와 기획 문서 작성',
  'presentation-writer': '슬라이드 메시지와 카피 작성',
  'presentation-designer': 'Reveal.js 슬라이드 HTML 제작',
  'slack-messenger': '작성자 어투로 슬랙 메시지 작성',
  'jira-writer': '지라 티켓 본문 작성',
  explainer: '대상에 맞춘 설명 작성',
  'video-summarizer': '영상 스크립트로 요약 리포트 작성',
  'lens-reader': '논문과 글을 출처와 의심 표시로 읽는 리포트 작성',
  'lens-context': '읽기 렌즈의 선행 연구와 반론 카드 작성',
  'lens-link': '읽기 렌즈의 내 노트 연결 카드 작성',
};

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const SHELL_TOOLS = [...READ_TOOLS, 'Bash'];

/**
 * MCP 도구는 열어준 만큼 스키마가 첫 요청에 실린다(에이전트마다 도구 하나에 400~700토큰).
 * 그래서 본문이 실제로 부르는 도구만 연다. 플러그인으로 설치된 서버라 이름이 하나로 정해져 있다.
 */
const GES_AGENT_TOOL = 'mcp__plugin_gestalt_gestalt__ges_agent';

/**
 * 표에 없는 에이전트의 기본값은 원본 위치로 정한다. 리뷰어(plugin/review-agents/)는 git diff를
 * 직접 돌려야 해서 Bash를 받는다. 그 밖의 에이전트는 읽기 도구만 받는다. 새 에이전트가 표에서
 * 빠져도 셸이 열리지 않게 하려는 것이다. Edit과 Write는 없지만 Bash가 있는 에이전트는 셸로
 * 파일을 바꿀 수 있다. 그래서 스킬 프롬프트의 "읽기와 보고만 한다" 한 줄은 계속 필요하다.
 */
const TOOL_OVERRIDES: Record<string, string[]> = {
  // 스킬이 본문과 사전 스캔 결과를 인라인으로 넘기므로 셸이 없다. AGENT.md의 humanize-scan,
  // humanize-check 절은 원문이 파일로 있을 때만 돈다.
  'humanize-monolith': READ_TOOLS,
  'slack-messenger': READ_TOOLS,
  'jira-writer': READ_TOOLS,
  explainer: READ_TOOLS,
  // 본문이 초안 뒤에 ges_agent로 humanize-monolith 지침을 받아 윤문한다.
  'change-context-writer': [...SHELL_TOOLS, GES_AGENT_TOOL],
  'impact-writer': [...READ_TOOLS, GES_AGENT_TOOL],
  'presentation-writer': [...READ_TOOLS, GES_AGENT_TOOL],
  // 경로 따라가기 절차(rule-path-walk.md)가 git diff -U0를 부르므로 리뷰어가 아니어도 셸이 필요하다.
  // suggestion-verifier는 git show도 쓴다.
  'suggestion-verifier': SHELL_TOOLS,
  'continuity-judge': SHELL_TOOLS,
  // 산출물이 HTML 파일이다. 저장 경로는 스킬 프롬프트가 정해서 넘긴다.
  'presentation-designer': [...READ_TOOLS, 'Write'],
  // 산출물이 digest.json 하나다. 저장 경로는 video-digest 스킬이 넘긴다.
  'video-summarizer': [...READ_TOOLS, 'Write'],
  // 산출물이 리포트 JSON 하나다. 저장 경로는 lens 스킬이 넘긴다.
  'lens-reader': [...READ_TOOLS, 'Write'],
  // 바깥 맥락 카드는 웹 페이지를 직접 열어 확인하고 쓴다. 웹 도구를 여는 유일한 에이전트라 셸은 주지 않는다.
  // 연결 카드는 웹 도구가 없는 lens-link가 따로 쓴다. 웹 도구를 가진 lens-context에는 스킬이 노트 경로와
  // 노트 내용을 넘기지 않는다. 다만 Read는 경로 제한 없이 열려 있어서 페이지 지시문이 knowledge.json이나
  // 노트 폴더를 읽게 하는 것은 에이전트 지침으로만 막는다.
  'lens-context': [...READ_TOOLS, 'WebSearch', 'WebFetch', 'Write'],
  'lens-link': [...READ_TOOLS, 'Write'],
};

/**
 * 넘겨받은 입력과 자기 voice 문서만으로 글을 쓰는 에이전트는 CLAUDE.md를 빼고 띄운다.
 * writing-reviewer도 판정 기준이 룰북과 스타일 가이드뿐이라 뺀다. 같은 diff로 재보니 첫 요청이
 * 17.7k에서 8.7k 토큰으로 줄고 지적은 그대로였다. 나머지 리뷰어와 레포를 다루는 역할은 그
 * 레포 CLAUDE.md의 컨벤션이 판정 근거라 그대로 둔다.
 */
const OMIT_CLAUDE_MD = new Set([
  'writing-reviewer',
  'humanize-monolith',
  'slack-messenger',
  'jira-writer',
  'code-review-writer',
  'presentation-writer',
  'presentation-designer',
  'impact-writer',
  'video-summarizer',
  'lens-reader',
  'lens-context',
  'lens-link',
]);

export const GENERATED_NOTICE = (source: string) =>
  `<!-- 생성물이다. 원본은 ${source} 이고 pnpm build:agents 로 다시 뽑는다. 여기서 고치면 다음 빌드에 지워진다. -->`;

// `../`나 `./`로 시작하는 상대 경로, 에이전트 디렉토리 기준 references/와 templates/,
// plugin/ 기준 role-agents/와 review-agents/, 레포 루트 기준 plugin/ 경로를 잡는다. skills/는
// 리뷰 대상 레포를 예로 든 문장에 흔해서 뺀다. 앞 글자가 경로 문자면 더 긴 경로의 일부라
// 건너뛴다. 점과 빗금만 있는 토큰(`../../` 개수를 말하는 산문)은 경로가 아니라서 첫 글자를
// 단어 문자로 묶는다.
const PATH_TOKEN =
  /(?<![\w./<>$-])((?:\.\.?\/)+\w[\w.\-/]*|(?:references|templates)\/[\w.\-/]*|(?:plugin|role-agents|review-agents)\/[\w.\-/]+)/g;

export interface PathRewrite {
  from: string;
  to: string;
}

/**
 * 원본 본문의 상대 경로를 `${CLAUDE_PLUGIN_ROOT}` 기준으로 바꾼다. Claude Code가 에이전트
 * 본문의 이 변수를 설치 경로로 치환한다. 실제로 있는 파일이나 디렉토리만 바꾸고 나머지는 그대로
 * 둔다 — 리뷰 대상 레포의 경로를 말하는 문장까지 바꾸면 뜻이 달라진다.
 */
export function rewritePaths(
  body: string,
  sourceDir: string,
  exists: (repoRelative: string) => boolean,
): { body: string; rewrites: PathRewrite[] } {
  const rewrites: PathRewrite[] = [];
  const next = body.replace(PATH_TOKEN, (token: string) => {
    // 문장 끝 마침표가 토큰에 붙어 온 자리는 떼고 본다.
    const trail = /\.+$/.exec(token)?.[0] ?? '';
    const path = trail ? token.slice(0, -trail.length) : token;
    // 에이전트 디렉토리, plugin/, 레포 루트 순으로 맞춰 보고 처음 있는 자리를 쓴다.
    const target = [posix.join(sourceDir, path), posix.join('plugin', path), path]
      .map((p) => posix.normalize(p))
      .find((p) => !p.startsWith('..') && exists(p.replace(/\/$/, '')));
    if (!target) return token;
    const to = `\${CLAUDE_PLUGIN_ROOT}/${target}`;
    rewrites.push({ from: path, to });
    return to + trail;
  });
  return { body: next, rewrites };
}

export interface GeneratedAgent {
  name: string;
  source: string;
  content: string;
  rewrites: PathRewrite[];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderAgent(
  sourceFile: string,
  raw: string,
  exists: (repoRelative: string) => boolean,
): GeneratedAgent {
  const { frontmatter, systemPrompt } = parseAgentMd(raw, sourceFile);
  const name = frontmatter.name;
  const description = SHORT_DESCRIPTIONS[name];
  if (!description) throw new Error(`${name}의 한 줄 설명이 SHORT_DESCRIPTIONS에 없다`);
  const tools =
    TOOL_OVERRIDES[name] ?? (sourceFile.startsWith(`${REVIEWER_DIR}/`) ? SHELL_TOOLS : READ_TOOLS);
  const { body, rewrites } = rewritePaths(systemPrompt, posix.dirname(sourceFile), exists);
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    `tools: ${tools.join(', ')}`,
    // 스킬은 gestalt.json의 tierModels로 고른 model을 Agent 호출에 따로 넘긴다. 여기 값은 그게
    // 빠졌을 때 쓰는 기본값이다.
    `model: ${DEFAULT_TIER_MODELS[frontmatter.tier]}`,
    ...(OMIT_CLAUDE_MD.has(name) ? ['omitClaudeMd: true'] : []),
    '---',
    '',
    GENERATED_NOTICE(sourceFile),
    '',
    body,
    '',
  ];
  return { name, source: sourceFile, content: lines.join('\n'), rewrites };
}

/** 스킬 문서가 `subagent_type: "gestalt:<이름>"`으로 띄우는 에이전트 이름 */
export function spawnedNames(root: string = ROOT): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(join(root, SKILLS_DIR), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf-8');
    for (const match of text.matchAll(SPAWN_REF)) names.add(match[1]!);
  }
  return names;
}

export function collectSources(root: string = ROOT): string[] {
  const names = spawnedNames(root);
  for (const entry of readdirSync(join(root, REVIEWER_DIR), { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('_')) names.add(entry.name);
  }
  const files = [...names].map((name) => {
    const found = SOURCE_DIRS.map((dir) => posix.join(dir, name, 'AGENT.md')).filter((f) =>
      existsSync(join(root, f)),
    );
    if (found.length === 0) {
      throw new Error(`스킬이 gestalt:${name} 을 띄우는데 원본 AGENT.md가 없다`);
    }
    if (found.length > 1) throw new Error(`원본이 여러 곳에 있다: ${name} (${found.join(', ')})`);
    return found[0]!;
  });
  return files.sort();
}

export function buildAgents(root: string = ROOT): GeneratedAgent[] {
  const exists = (p: string) => existsSync(join(root, p));
  const agents = collectSources(root).map((file) =>
    renderAgent(file, readFileSync(join(root, file), 'utf-8'), exists),
  );
  const seen = new Map<string, string>();
  for (const a of agents) {
    const prev = seen.get(a.name);
    if (prev) throw new Error(`에이전트 이름이 겹친다: ${a.name} (${prev}, ${a.source})`);
    seen.set(a.name, a.source);
  }
  // 뽑지 않는 에이전트 항목이 표에 남으면 나중에 다시 뽑힐 때 근거 없는 설정이 따라붙는다.
  const unused = [
    ...Object.keys(SHORT_DESCRIPTIONS),
    ...Object.keys(TOOL_OVERRIDES),
    ...OMIT_CLAUDE_MD,
  ].filter((name) => !seen.has(name));
  if (unused.length > 0) {
    throw new Error(`뽑지 않는 에이전트가 표에 남아 있다: ${[...new Set(unused)].join(', ')}`);
  }
  return agents;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const checkOnly = process.argv.includes('--check');
  let agents: GeneratedAgent[];
  try {
    agents = buildAgents();
  } catch (error) {
    console.error(`네이티브 에이전트 생성 실패: ${(error as Error).message}`);
    process.exit(1);
  }

  const expected = new Map(agents.map((a) => [`${a.name}.md`, a.content]));
  const existing = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.md')) : [];
  const stale = existing.filter((f) => !expected.has(f));
  const changed = [...expected].filter(([file, content]) => {
    const path = join(OUT_DIR, file);
    return !existsSync(path) || readFileSync(path, 'utf-8') !== content;
  });

  if (checkOnly) {
    if (stale.length > 0 || changed.length > 0) {
      const names = [...stale.map((f) => `${f} (원본 없음)`), ...changed.map(([f]) => f)];
      console.error(
        `agents/ 가 원본 AGENT.md와 어긋납니다. pnpm build:agents 로 다시 뽑으세요\n  ${names.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log(`네이티브 에이전트 최신 상태 (에이전트 ${agents.length}개)`);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const file of stale) rmSync(join(OUT_DIR, file));
    for (const [file, content] of changed) writeFileSync(join(OUT_DIR, file), content, 'utf-8');
    const rewriteCount = agents.reduce((n, a) => n + a.rewrites.length, 0);
    console.log(
      `네이티브 에이전트 생성: ${OUT_DIR} (에이전트 ${agents.length}개, 바뀐 파일 ${changed.length}개, 지운 파일 ${stale.length}개, 경로 치환 ${rewriteCount}곳)`,
    );
  }
}
