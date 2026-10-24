import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { z } from 'zod';
import { BLOCK_TYPES, templateIdSchema, type BlockType } from './blocks.js';
import { DigestStore } from './store.js';

/** 템플릿 하나는 프롬프트 한 장이라 이보다 크면 잘못 넣은 파일로 본다 */
const TEMPLATE_MAX_BYTES = 64 * 1024;

/** 템플릿이 요약 전에 따로 받아 둬야 하는 자료. 없으면 스킬이 먼저 받는다 */
export const TEMPLATE_NEEDS = ['comments'] as const;

// src/research/source-schema.ts와 같은 이유로 js 엔진을 막는다. 사용자 폴더 파일이라도 frontmatter가 코드로 돌면 안 된다
const SAFE_MATTER_OPTIONS = {
  engines: {
    js: () => {
      throw new Error('js frontmatter는 쓰지 않는다');
    },
    javascript: () => {
      throw new Error('js frontmatter는 쓰지 않는다');
    },
  },
};

const frontmatterSchema = z.object({
  id: templateIdSchema,
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
  blocks: z
    .array(z.enum(BLOCK_TYPES as [BlockType, ...BlockType[]]))
    .min(1)
    .transform((list) => [...new Set(list)]),
  needs: z.array(z.enum(TEMPLATE_NEEDS)).default([]),
  /** 탭과 메뉴에 놓이는 순서. 작을수록 앞이다 */
  order: z.number().int().default(100),
});

export interface DigestTemplate {
  id: string;
  title: string;
  description: string;
  blocks: BlockType[];
  needs: (typeof TEMPLATE_NEEDS)[number][];
  order: number;
  /** 요약 에이전트에게 넘기는 지시. frontmatter 아래 본문이다 */
  prompt: string;
  source: 'builtin' | 'user';
  path: string;
  /** 레포의 사용자 템플릿이 같은 id의 기본 템플릿을 대신했다 */
  overridesBuiltin?: boolean;
}

export interface TemplateLoad {
  templates: DigestTemplate[];
  warnings: string[];
}

export function parseTemplate(
  content: string,
  source: DigestTemplate['source'],
  path: string,
): DigestTemplate {
  if (Buffer.byteLength(content, 'utf-8') > TEMPLATE_MAX_BYTES) {
    throw new Error('템플릿이 64KB를 넘는다');
  }
  const parsed = matter(content, SAFE_MATTER_OPTIONS);
  const fm = frontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    const issues = fm.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`frontmatter 형식 오류: ${issues.join('; ')}`);
  }
  const prompt = parsed.content.trim();
  if (!prompt) throw new Error('본문(요약 지시)이 비어 있다');
  return { ...fm.data, prompt, source, path };
}

function readDir(dir: string, source: DigestTemplate['source'], warnings: string[]) {
  if (!existsSync(dir)) return [];
  const out: DigestTemplate[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    // 심링크는 레포 밖 파일을 템플릿 지시로 끌어올 수 있어 따라가지 않는다
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      warnings.push(`${path}: 심링크라 건너뛰었다`);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > TEMPLATE_MAX_BYTES) {
      warnings.push(`${path}: 템플릿이 64KB를 넘어 건너뛰었다`);
      continue;
    }
    try {
      const t = parseTemplate(readFileSync(path, 'utf-8'), source, path);
      // 파일 이름과 id가 다르면 템플릿을 찾을 때 둘 중 무엇을 써야 할지 헷갈린다
      if (`${t.id}.md` !== name) {
        warnings.push(`${path}: 파일 이름이 id(${t.id})와 달라 건너뛰었다`);
        continue;
      }
      out.push(t);
    } catch (e) {
      warnings.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * 기본 템플릿과 레포의 사용자 템플릿을 읽는다. 같은 id면 사용자 것이 이긴다.
 * 깨진 파일은 건너뛰고 warnings에 적는다. 템플릿 하나가 깨졌다고 나머지를 못 쓰게 하지 않는다
 */
export function loadTemplates(builtinDir: string | null, repoRoot: string): TemplateLoad {
  const warnings: string[] = [];
  const byId = new Map<string, DigestTemplate>();
  if (builtinDir) for (const t of readDir(builtinDir, 'builtin', warnings)) byId.set(t.id, t);
  for (const t of readDir(new DigestStore(repoRoot).templatesDir(), 'user', warnings)) {
    if (byId.has(t.id)) {
      warnings.push(`${t.path}: 기본 템플릿 ${t.id}를 대신한다`);
      byId.set(t.id, { ...t, overridesBuiltin: true });
    } else {
      byId.set(t.id, t);
    }
  }
  const templates = [...byId.values()].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  return { templates, warnings };
}

/** 스킬 디렉토리 아래 video-digest 스킬의 기본 템플릿 자리 */
export const builtinTemplatesDir = (skillsDir: string): string =>
  join(skillsDir, 'video-digest', 'templates');

// src/digest와 dist/digest 둘 다 두 칸 위가 패키지 루트다
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 기본 템플릿 폴더를 찾는다. config.skillsDir은 cwd에 plugin/skills가 있으면 그쪽으로 풀려서
 * 남의 레포에서는 video-digest가 없을 수 있다. 그때는 패키지에 실린 폴더로 내려간다
 */
export function findBuiltinTemplatesDir(skillsDir?: string): string | null {
  const candidates = [
    skillsDir ? builtinTemplatesDir(skillsDir) : null,
    builtinTemplatesDir(join(PACKAGE_ROOT, 'plugin', 'skills')),
  ];
  return candidates.find((d): d is string => d !== null && existsSync(d)) ?? null;
}

export const loadDigestTemplates = (repoRoot: string, skillsDir?: string): TemplateLoad =>
  loadTemplates(findBuiltinTemplatesDir(skillsDir), repoRoot);

/** lint가 받는 꼴로 바꾼다 */
export const templateMap = (templates: DigestTemplate[]): Map<string, DigestTemplate> =>
  new Map(templates.map((t) => [t.id, t]));
