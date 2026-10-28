import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../core/json-file.js';
import { readRaw } from '../digest/store.js';

/**
 * 사용자 노트 폴더 연결. 노트 폴더는 사람마다 다른 개인 경로라 레포의 gestalt.json이 아니라
 * 사용자 설정(~/.gestalt/lens.json)에 둔다. 한 번 연결하면 어느 레포에서 렌즈를 돌려도 같은 노트를 본다
 */

export const userLensFileSchema = z.object({
  knowledgeSources: z.array(z.string()).default([]),
  /** 노션 MCP로도 찾는다. 노션은 파일이 아니라 스킬이 페이지를 받아 스냅샷으로 둔다 */
  notion: z.boolean().default(false),
  /** 연결할 노트 폴더가 없다고 답했다. 다음 실행부터 다시 묻지 않는다 */
  declined: z.boolean().default(false),
});

export type UserLensFile = z.infer<typeof userLensFileSchema>;

export function userLensFilePath(home: string = homedir()): string {
  return join(home, '.gestalt', 'lens.json');
}

export function readUserLens(path: string = userLensFilePath()): UserLensFile {
  const raw = readRaw(path);
  const empty: UserLensFile = { knowledgeSources: [], notion: false, declined: false };
  if (raw.kind !== 'ok') return empty;
  const parsed = userLensFileSchema.safeParse(raw.value);
  return parsed.success ? parsed.data : empty;
}

function save(path: string, file: UserLensFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, file);
}

/** 폴더를 연결한다. 실제 경로로 바꿔 겹치지 않게 넣고 없는 폴더는 거절한다 */
export function addNoteSources(dirs: string[], path: string = userLensFilePath()): UserLensFile {
  const file = readUserLens(path);
  for (const d of dirs) {
    const abs = resolve(d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`폴더가 아니에요: ${d}`);
    const real = realpathSync(abs);
    if (!file.knowledgeSources.includes(real)) file.knowledgeSources.push(real);
  }
  const next = { ...file, declined: false };
  save(path, next);
  return next;
}

export function removeNoteSource(dir: string, path: string = userLensFilePath()): UserLensFile {
  const file = readUserLens(path);
  const abs = resolve(dir);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  const next = {
    ...file,
    knowledgeSources: file.knowledgeSources.filter((s) => s !== real && s !== abs),
  };
  save(path, next);
  return next;
}

export function setNotion(on: boolean, path: string = userLensFilePath()): UserLensFile {
  const next = { ...readUserLens(path), notion: on, ...(on ? { declined: false } : {}) };
  save(path, next);
  return next;
}

export function declineNoteSources(path: string = userLensFilePath()): UserLensFile {
  const next = { ...readUserLens(path), declined: true };
  save(path, next);
  return next;
}

export interface NoteFolderCandidate {
  path: string;
  /** 폴더 안 노트 파일 수(3단 아래까지, 상한에서 멈춘다) */
  notes: number;
  /** 왜 후보가 됐는지. 이름(notes, kb 같은), Obsidian 보관함, Logseq 그래프, 노션 내보내기 폴더다 */
  reason: 'name' | 'obsidian' | 'logseq' | 'notion-export';
  /** 가장 최근에 고친 노트 이름 셋. 사용자가 어느 폴더인지 알아보게 보여 준다 */
  recent: string[];
  /** 가장 최근 노트를 고친 시각(ms) */
  updatedAt: number;
  configured: boolean;
}

// research는 흔한 이름이라 노트가 아닌 폴더(스킬 자료 같은)까지 걸려서 뺐다
const NOTE_DIR =
  /^(notes?|kb|knowledge|knowledge-base|wiki|journal|memos?|til|zettelkasten|vault)$/i;
const NOTE_EXTS = ['.md', '.markdown', '.txt'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target', 'coverage']);
const NOTE_CAP = 2000;
const MIN_NOTES = 3;

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** 노트 파일 수와 최근 노트. 3단 아래까지만 보고 상한을 넘으면 멈춘다 */
function noteStats(dir: string): { notes: number; recent: string[]; updatedAt: number } {
  const files: Array<{ name: string; mtime: number }> = [];
  const walk = (d: string, depth: number) => {
    if (files.length >= NOTE_CAP || depth > 3) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && NOTE_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) {
        try {
          files.push({ name: e.name, mtime: statSync(p).mtimeMs });
        } catch {
          // 읽다 사라진 파일은 건너뛴다
        }
        if (files.length >= NOTE_CAP) return;
      }
    }
  };
  walk(dir, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return {
    notes: files.length,
    recent: files.slice(0, 3).map((f) => f.name),
    updatedAt: files[0]?.mtime ?? 0,
  };
}

/** 노트 앱이 남기는 표식. 이 표식이 있는 폴더는 이름과 상관없이 노트 폴더로 본다 */
function appMarker(dir: string): NoteFolderCandidate['reason'] | null {
  if (existsSync(join(dir, '.obsidian'))) return 'obsidian';
  if (existsSync(join(dir, 'logseq', 'config.edn'))) return 'logseq';
  return null;
}

// 노션 내보내기 파일은 "제목 <32자리 id>.md" 꼴이다
const NOTION_EXPORT_FILE = / [0-9a-f]{32}\.md$/i;

function isNotionExport(dir: string): boolean {
  try {
    return readdirSync(dir).filter((f) => NOTION_EXPORT_FILE.test(f)).length >= MIN_NOTES;
  } catch {
    return false;
  }
}

/** 한 번 훑을 때 볼 폴더 수 상한. 홈 아래 큰 폴더에서 탐지가 오래 붙잡히지 않게 한다 */
const VISIT_CAP = 30000;

/**
 * 폴더를 3단 아래까지 훑어 노트 폴더 후보를 모은다. 이름이 notes, kb, wiki 꼴인 폴더,
 * Obsidian 보관함(.obsidian), Logseq 그래프(logseq/config.edn), 노션 내보내기 폴더를 찾는다.
 * 후보를 찾은 폴더 안으로는 더 내려가지 않는다
 */
function scanBase(
  base: string,
  found: Map<string, NoteFolderCandidate['reason']>,
  budget: { left: number },
): void {
  const walk = (d: string, depth: number) => {
    if (depth > 3 || budget.left <= 0) return;
    for (const sub of listDirs(d)) {
      if (--budget.left <= 0) return;
      const marker = appMarker(sub);
      const reason =
        marker ??
        (NOTE_DIR.test(basename(sub)) ? 'name' : isNotionExport(sub) ? 'notion-export' : null);
      if (reason) {
        try {
          found.set(realpathSync.native(sub), reason);
        } catch {
          // 심링크가 깨졌으면 건너뛴다
        }
        continue;
      }
      walk(sub, depth + 1);
    }
  };
  const top = appMarker(base);
  if (top) found.set(realpathSync.native(base), top);
  else walk(base, 0);
}

/**
 * 탐지할 바탕 폴더. 이 레포와 그 옆 레포들(상위 폴더), 넘겨받은 폴더, 홈의 흔한 작업 폴더와 문서 폴더다.
 * Orca가 없어도 이 목록만으로 돈다. Orca가 있으면 스킬이 등록된 레포를 scan으로 더 넘긴다
 */
export function detectBases(repoRoot: string, home: string, scan: string[] = []): string[] {
  const common = [
    'Documents',
    'Desktop',
    'Downloads',
    'notes',
    'Notes',
    'Obsidian',
    'work',
    'projects',
    'code',
    'dev',
    'src',
    'repos',
    'github',
    join('Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents'),
  ].map((d) => join(home, d));
  const bases = [
    resolve(repoRoot),
    dirname(resolve(repoRoot)),
    ...scan.map((s) => resolve(s)),
    ...common,
  ];
  // macOS는 대소문자를 안 가려서 ~/notes와 ~/Notes가 같은 폴더다. OS가 돌려주는 실제 경로로 겹침을 지운다
  const real = bases.filter((b) => existsSync(b)).map((b) => realpathSync.native(b));
  return [...new Set(real)];
}

/** 노션 앱이 깔려 있는지. 깔려 있으면 스킬이 노션 MCP로 찾을지 묻는다 */
export function notionAppInstalled(home: string = homedir()): boolean {
  return ['/Applications/Notion.app', join(home, 'Applications', 'Notion.app')].some((p) =>
    existsSync(p),
  );
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
};

export interface DetectOptions {
  repoRoot: string;
  /** 더 훑을 폴더. 스킬이 Orca에 등록된 레포 경로를 넘긴다 */
  scan?: string[];
  home?: string;
  userFile?: string;
}

/**
 * 연결할 만한 노트 폴더를 찾는다. 노트가 3개 넘게 든 폴더만 후보로 내고 바깥 폴더에 든 안쪽 후보는 뺀다.
 * 찾기만 하고 연결은 하지 않는다. 연결은 사용자가 고른 뒤 addNoteSources로 한다
 */
export function detectNoteFolders(opts: DetectOptions): NoteFolderCandidate[] {
  const home = opts.home ?? homedir();
  const configured = new Set(readUserLens(opts.userFile).knowledgeSources);
  const found = new Map<string, NoteFolderCandidate['reason']>();
  const budget = { left: VISIT_CAP };
  for (const base of detectBases(opts.repoRoot, home, opts.scan)) scanBase(base, found, budget);
  const paths = [...found.keys()];
  const outer = paths.filter((p) => !paths.some((q) => inside(p, q)));
  const out: NoteFolderCandidate[] = [];
  for (const p of outer) {
    const s = noteStats(p);
    if (s.notes < MIN_NOTES) continue;
    out.push({ path: p, reason: found.get(p)!, ...s, configured: configured.has(p) });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
}
