import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { KNOWLEDGE_FILE, type KnowledgeFile } from '../digest/lint-lens-context.js';
import { readUserLens, SKIP_DIRS, userLensFilePath } from './notes.js';
import { DigestStore, readRaw } from '../digest/store.js';

/** 노트로 읽는 확장자. 지식 소스 폴더에 다른 파일이 섞여 있어도 글 노트만 훑는다 */
const NOTE_EXTS = ['.md', '.markdown', '.txt'];
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
/** 한 번 찾을 때 읽는 노트 크기 합계 상한. 파일 수 상한만 두면 큰 노트가 많을 때 수 GB를 동기로 읽는다 */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_HITS = 40;
const MAX_TERMS = 30;

/**
 * 노션처럼 파일로 없는 노트를 스킬이 받아 두는 폴더(slug 폴더 아래). 파일 첫 줄에
 * `<!-- source: <원래 주소> -->`를 적어 두면 연결 카드가 그 주소를 단다
 */
export const KNOWLEDGE_SNAPSHOTS_DIR = 'knowledge-snapshots';

/** 실제 경로가 parent 자신이거나 그 아래인지. 둘 다 realpath를 거친 값을 넘긴다 */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 지식 소스 폴더. 사용자가 연결해 둔 폴더(~/.gestalt/lens.json)와 부를 때 넘긴 경로,
 * gestalt.json의 `lens.knowledgeSources`를 합친다.
 * gestalt.json은 남의 레포에도 있을 수 있어서 거기 적힌 경로는 실제 경로가 레포 안일 때만 받는다.
 * 레포 밖을 가리키면(절대 경로, ../, 밖으로 나가는 심링크) 빼고 warnings에 남긴다
 */
export function knowledgeRoots(
  repoRoot: string,
  extra: string[] = [],
  userFile: string = userLensFilePath(),
): { roots: string[]; warnings: string[] } {
  const roots: string[] = [];
  const warnings: string[] = [];
  const realDir = (p: string): string | null => {
    try {
      const r = realpathSync(p);
      return statSync(r).isDirectory() ? r : null;
    } catch {
      // 없는 폴더는 건너뛴다. 결과의 roots에 안 실리니 보고에서 빠진 걸 알 수 있다
      return null;
    }
  };
  const push = (r: string | null) => {
    if (r !== null && !roots.includes(r)) roots.push(r);
  };
  // 사용자가 연결해 둔 노트 폴더(~/.gestalt/lens.json)를 먼저 본다
  for (const p of readUserLens(userFile).knowledgeSources) push(realDir(p));
  const raw = readRaw(join(repoRoot, 'gestalt.json'));
  if (raw.kind === 'ok') {
    const lens = (raw.value as { lens?: { knowledgeSources?: unknown } }).lens;
    if (Array.isArray(lens?.knowledgeSources)) {
      const repo = realDir(repoRoot) ?? resolve(repoRoot);
      for (const p of lens.knowledgeSources) {
        if (typeof p !== 'string') continue;
        const r = realDir(resolve(repoRoot, p));
        if (r !== null && !within(repo, r)) {
          warnings.push(
            `gestalt.json의 lens.knowledgeSources가 레포 밖을 가리켜 뺐어요: ${p}. 레포 밖 폴더는 gestalt lens notes add나 --source로 연결해요`,
          );
          continue;
        }
        push(r);
      }
    }
  }
  for (const p of extra) push(realDir(resolve(p)));
  return { roots, warnings };
}

/** 노트 파일을 훑는다. maxFiles를 넘는 파일이 더 있으면 거기서 멈추고 cut.files에 적는다 */
function* walkNotes(root: string, maxFiles: number, cut: { files: boolean }): Generator<string> {
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // 숨김 폴더와 의존성, 빌드 산출물 폴더는 노트가 아니다
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile() && NOTE_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) {
        if (++n > maxFiles) {
          cut.files = true;
          return;
        }
        yield p;
      }
    }
  }
}

/**
 * 원문에서 찾을 말. 두 번 넘게 나온 고유 이름(FlavorGraph, DIFUSCO)과 약어(NMI, CSP), 리포트 키워드다.
 * 일상어로 찾으면 노트 줄마다 걸려서 이름 꼴만 고른다
 */
export function pickTerms(texts: string[], keywords: string[] = []): string[] {
  return rankTerms(texts, keywords).slice(0, MAX_TERMS);
}

/** 찾을 말 전부를 순서대로 낸다. findKnowledge가 상한에서 잘렸는지 알려고 자르기 전 목록을 본다 */
function rankTerms(texts: string[], keywords: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const m of t.matchAll(
      /\b(?:[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]{2,}[a-z]?|[A-Z][a-z]+\d+[A-Za-z]*)\b/g,
    )) {
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
  }
  const names = [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);
  return [...new Set([...keywords, ...names])];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 영문자와 숫자에 붙은 자리는 말의 일부라 안 친다 */
const bounded = (body: string) => `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`;

export interface NoteSearchLimits {
  files: number;
  totalBytes: number;
  hits: number;
}

const SEARCH_LIMITS: NoteSearchLimits = {
  files: MAX_FILES,
  totalBytes: MAX_TOTAL_BYTES,
  hits: MAX_HITS,
};

export interface NoteSearch {
  hits: KnowledgeFile['hits'];
  /** 자르기 전 겹친 줄 수 */
  totalHits: number;
  /** 파일 수나 읽기 크기, 겹친 줄 상한에 닿아 일부만 봤는지 */
  truncated: { files: boolean; bytes: boolean; hits: boolean };
}

/** limits는 테스트가 작은 상한을 넘길 때만 준다 */
export function searchNotes(
  roots: string[],
  terms: string[],
  limits: NoteSearchLimits = SEARCH_LIMITS,
): NoteSearch {
  const truncated = { files: false, bytes: false, hits: false };
  if (terms.length === 0) return { hits: [], totalHits: 0, truncated };
  const patterns = terms.map((t) => ({ t, re: new RegExp(bounded(escapeRe(t)), 'i') }));
  // 말을 하나로 합친 정규식으로 파일 전체를 먼저 걸러 걸린 파일만 줄마다 말별로 본다
  const any = new RegExp(bounded(`(?:${terms.map(escapeRe).join('|')})`), 'i');
  const hits: KnowledgeFile['hits'] = [];
  let bytes = 0;
  scan: for (const root of roots) {
    for (const file of walkNotes(root, limits.files, truncated)) {
      let text: string;
      try {
        const size = statSync(file).size;
        if (size > MAX_FILE_BYTES) continue;
        if (bytes + size > limits.totalBytes) {
          truncated.bytes = true;
          break scan;
        }
        bytes += size;
        text = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      if (!any.test(text)) continue;
      text.split('\n').forEach((line, k) => {
        const found = patterns.filter((p) => p.re.test(line)).map((p) => p.t);
        if (found.length === 0) return;
        hits.push({ path: file, line: k + 1, text: line.trim().slice(0, 300), terms: found });
      });
    }
  }
  hits.sort((a, b) => b.terms.length - a.terms.length);
  truncated.hits = hits.length > limits.hits;
  return { hits: hits.slice(0, limits.hits), totalHits: hits.length, truncated };
}

export interface KnowledgeOptions {
  repoRoot: string;
  sources?: string[];
  /** 사용자 노트 연결 파일. 테스트가 홈 폴더 대신 임시 파일을 넘긴다 */
  userFile?: string;
}

/** 원문 이름과 겹치는 노트 줄을 찾아 knowledge.json에 둔다. lens-link가 여기서 연결 카드를 고른다 */
export function findKnowledge(
  slug: string,
  opts: KnowledgeOptions,
): { path: string; file: KnowledgeFile; warnings: string[] } {
  const store = new DigestStore(opts.repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  // 스킬이 노션 같은 클라우드 노트를 받아 둔 스냅샷 폴더도 노트 폴더로 본다
  const snapshots = join(store.dir(slug), KNOWLEDGE_SNAPSHOTS_DIR);
  const extra = [...(opts.sources ?? []), ...(existsSync(snapshots) ? [snapshots] : [])];
  const { roots, warnings } = knowledgeRoots(resolve(opts.repoRoot), extra, opts.userFile);
  const keywords = store.loadDigest(slug)?.reports[0]?.keywords.map((k) => k.term) ?? [];
  const ranked = rankTerms(
    [t.transcript.meta.title, ...t.transcript.segments.map((s) => s.text)],
    keywords,
  );
  const terms = ranked.slice(0, MAX_TERMS);
  const found = searchNotes(roots, terms);
  const file: KnowledgeFile = {
    roots,
    terms,
    hits: found.hits,
    totalHits: found.totalHits,
    // 하나라도 true면 lens-link와 사람이 "관련 노트가 이것뿐"으로 읽지 않게 한다
    truncated: { ...found.truncated, terms: ranked.length > MAX_TERMS },
  };
  const path = join(store.dir(slug), KNOWLEDGE_FILE);
  writeJsonAtomic(path, file);
  return { path, file, warnings };
}
