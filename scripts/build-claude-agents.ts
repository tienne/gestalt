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
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentMd } from '../src/agent/parser.js';
import { DEFAULT_TIER_MODELS } from '../src/core/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
export const OUT_DIR = join(ROOT, 'agents');

/** 원본 디렉토리. 레포 루트 기준이다. */
const SOURCE_DIRS = ['plugin/review-agents', 'plugin/role-agents'] as const;

/**
 * 원리 에이전트는 실행 파이프라인이 MCP로 쓴다. 스킬이 단독으로 띄우는 건 리뷰 정합 심급의
 * continuity-judge 하나뿐이다. 나머지까지 뽑으면 매 세션 Agent 도구 설명만 길어진다.
 */
const PRINCIPLE_AGENTS = ['plugin/agents/continuity-judge'] as const;

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const SHELL_TOOLS = [...READ_TOOLS, 'Bash'];

/**
 * 본문이 실제로 쓰는 도구만 연다. 표에 없는 에이전트는 SHELL_TOOLS다 — git diff를 돌려야 하는
 * 리뷰어와 레포를 살피는 역할 에이전트가 대부분이라서다. Edit과 Write가 없으면 프롬프트를
 * 무시해도 파일을 못 고친다.
 */
const TOOL_OVERRIDES: Record<string, string[]> = {
  // 넘겨받은 문장만 고치거나 쓴다. 셸을 쓸 자리가 없다.
  'humanize-monolith': READ_TOOLS,
  'slack-messenger': READ_TOOLS,
  'jira-writer': READ_TOOLS,
  'ux-writer': READ_TOOLS,
  explainer: READ_TOOLS,
  // 본문이 초안 뒤에 ges_agent로 humanize-monolith 지침을 받아 윤문한다.
  'change-context-writer': [...SHELL_TOOLS, 'mcp__plugin_gestalt_gestalt__ges_agent'],
  'impact-writer': [...READ_TOOLS, 'mcp__plugin_gestalt_gestalt__ges_agent'],
  'presentation-writer': [...READ_TOOLS, 'mcp__plugin_gestalt_gestalt__ges_agent'],
  // 산출물이 HTML 파일이다.
  'presentation-designer': [...READ_TOOLS, 'Write'],
  researcher: [...SHELL_TOOLS, 'WebSearch', 'WebFetch'],
  'video-summarizer': [...SHELL_TOOLS, 'WebFetch'],
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
  const tools = TOOL_OVERRIDES[name] ?? SHELL_TOOLS;
  const { body, rewrites } = rewritePaths(systemPrompt, posix.dirname(sourceFile), exists);
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(frontmatter.description)}`,
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

export function collectSources(root: string = ROOT): string[] {
  const files: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const file = posix.join(dir, entry.name, 'AGENT.md');
      if (existsSync(join(root, file))) files.push(file);
    }
  }
  for (const dir of PRINCIPLE_AGENTS) files.push(posix.join(dir, 'AGENT.md'));
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
