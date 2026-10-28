import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from '../core/json-file.js';
import { KNOWLEDGE_FILE, type KnowledgeFile } from '../digest/lint-lens-context.js';
import { readUserLens, userLensFilePath } from './notes.js';
import { DigestStore, readRaw } from '../digest/store.js';

/** 노트로 읽는 확장자. 지식 소스 폴더에 다른 파일이 섞여 있어도 글 노트만 훑는다 */
const NOTE_EXTS = ['.md', '.markdown', '.txt'];
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_HITS = 40;

/**
 * 노션처럼 파일로 없는 노트를 스킬이 받아 두는 폴더(slug 폴더 아래). 파일 첫 줄에
 * `<!-- source: <원래 주소> -->`를 적어 두면 연결 카드가 그 주소를 단다
 */
export const KNOWLEDGE_SNAPSHOTS_DIR = 'knowledge-snapshots';

/**
 * 지식 소스 폴더. 사용자가 연결해 둔 폴더(~/.gestalt/lens.json)와 부를 때 넘긴 경로,
 * gestalt.json의 `lens.knowledgeSources`를 합친다.
 * gestalt.json은 남의 레포에도 있을 수 있어서 거기 적힌 경로도 노트 확장자 파일만 읽는다
 */
export function knowledgeRoots(
  repoRoot: string,
  extra: string[] = [],
  userFile: string = userLensFilePath(),
): string[] {
  // 사용자가 연결해 둔 노트 폴더(~/.gestalt/lens.json)를 먼저 본다
  const out: string[] = [...readUserLens(userFile).knowledgeSources];
  const raw = readRaw(join(repoRoot, 'gestalt.json'));
  if (raw.kind === 'ok') {
    const lens = (raw.value as { lens?: { knowledgeSources?: unknown } }).lens;
    if (Array.isArray(lens?.knowledgeSources)) {
      for (const p of lens.knowledgeSources)
        if (typeof p === 'string') out.push(resolve(repoRoot, p));
    }
  }
  for (const p of extra) out.push(resolve(p));
  const real: string[] = [];
  for (const p of out) {
    try {
      const r = realpathSync(p);
      if (statSync(r).isDirectory() && !real.includes(r)) real.push(r);
    } catch {
      // 없는 폴더는 건너뛴다. 결과의 roots에 안 실리니 보고에서 빠진 걸 알 수 있다
    }
  }
  return real;
}

function* walkNotes(root: string): Generator<string> {
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
      // 숨김 폴더와 의존성 폴더는 노트가 아니다
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && NOTE_EXTS.some((x) => e.name.toLowerCase().endsWith(x))) {
        if (++n > MAX_FILES) return;
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
  return [...new Set([...keywords, ...names])].slice(0, 30);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchNotes(roots: string[], terms: string[]): KnowledgeFile['hits'] {
  if (terms.length === 0) return [];
  const patterns = terms.map((t) => ({
    t,
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'i'),
  }));
  const hits: KnowledgeFile['hits'] = [];
  for (const root of roots) {
    for (const file of walkNotes(root)) {
      let text: string;
      try {
        if (statSync(file).size > MAX_FILE_BYTES) continue;
        text = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, k) => {
        const found = patterns.filter((p) => p.re.test(line)).map((p) => p.t);
        if (found.length === 0) return;
        hits.push({ path: file, line: k + 1, text: line.trim().slice(0, 300), terms: found });
      });
    }
  }
  return hits.sort((a, b) => b.terms.length - a.terms.length).slice(0, MAX_HITS);
}

export interface KnowledgeOptions {
  repoRoot: string;
  sources?: string[];
  /** 사용자 노트 연결 파일. 테스트가 홈 폴더 대신 임시 파일을 넘긴다 */
  userFile?: string;
}

/** 원문 이름과 겹치는 노트 줄을 찾아 knowledge.json에 둔다. lens-context가 여기서 연결 카드를 고른다 */
export function findKnowledge(
  slug: string,
  opts: KnowledgeOptions,
): { path: string; file: KnowledgeFile } {
  const store = new DigestStore(opts.repoRoot);
  const t = store.readTranscript(slug);
  if (!t.ok) throw new Error(t.message);
  // 스킬이 노션 같은 클라우드 노트를 받아 둔 스냅샷 폴더도 노트 폴더로 본다
  const snapshots = join(store.dir(slug), KNOWLEDGE_SNAPSHOTS_DIR);
  const extra = [...(opts.sources ?? []), ...(existsSync(snapshots) ? [snapshots] : [])];
  const roots = knowledgeRoots(resolve(opts.repoRoot), extra, opts.userFile);
  const keywords = store.loadDigest(slug)?.reports[0]?.keywords.map((k) => k.term) ?? [];
  const terms = pickTerms(
    [t.transcript.meta.title, ...t.transcript.segments.map((s) => s.text)],
    keywords,
  );
  const file: KnowledgeFile = { roots, terms, hits: searchNotes(roots, terms) };
  const path = join(store.dir(slug), KNOWLEDGE_FILE);
  writeJsonAtomic(path, file);
  return { path, file };
}
