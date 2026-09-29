/**
 * 순방향 참조 검색.
 *
 * 바뀐 하네스 문서가 밖으로 부르는 것(경로, 헤딩 앵커, GitHub 링크, PR 번호)의 대상이 실제로 있는지 본다.
 * 경로와 자리표시자는 로컬 체크아웃에서, PR 번호는 gh로 조회해 "머지 전" 같은 문장과 대조한다.
 * 확정 못 하는 건 결함으로 단정하지 않고 needsLlmJudgment로 넘긴다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { runGh, type GhRunner } from '../review-loop/fetch.js';
import { classifyGhFailure, type BlockReason } from './github-backend.js';
import {
  extractPlaceholderRefs,
  resolvePlaceholders,
  type PlaceholderRepo,
} from './placeholders.js';
import type { ReferenceCandidate } from './types.js';

export interface ForwardSearchInput {
  ownRepo: PlaceholderRepo;
  otherRepos?: PlaceholderRepo[];
  /** ownRepo.dir 기준 상대 경로. 이번 변경에서 바뀐 하네스 문서 */
  files: string[];
  /** 테스트에서 가짜로 바꾼다. 기본은 실제 gh */
  gh?: GhRunner;
}

export interface ForwardSearchBlocked {
  reason: BlockReason;
  detail: string;
}

export interface ForwardSearchResult {
  candidates: ReferenceCandidate[];
  /** 이 검사가 못 보는 것. 리포트 한계 절로 흘러간다 */
  limitations: string[];
  /** gh 조회가 막혔으면 채운다. 경로와 헤딩 검사는 막힘과 무관하게 끝까지 돈다 */
  blocked?: ForwardSearchBlocked;
}

export const FORWARD_SEARCH_LIMITATIONS: readonly string[] = [
  '역방향 검색에는 PR 번호 상태를 대조하는 짝이 없다. 다른 레포 문서가 이 PR을 "머지 전"이라 적어둔 경우는 잡지 못한다',
  '코드 펜스 안의 경로는 예시로 보고 건너뛴다',
  '경로는 로컬 체크아웃 기준이다. GitHub 링크의 브랜치나 커밋이 로컬과 다르면 존재 여부가 어긋날 수 있다',
];

/** 조회하는 서로 다른 PR 수 상한. 넘으면 뒤는 건너뛰고 한계로 적는다 */
export const MAX_PR_LOOKUPS = 30;

const PATH_EXTENSIONS =
  'md|mdx|ts|tsx|js|jsx|mjs|cjs|json|jsonc|yml|yaml|toml|sh|py|css|html|txt|mdc';
const FILE_PATH = new RegExp(
  `^(?:\\.{1,2}/)?[\\w@.\\-]+(?:/[\\w@.\\-]+)*\\.(?:${PATH_EXTENSIONS})$`,
);
const CHUNK = /[^\s`'"()[\],;<>]+/g;
const URL_RE = /https?:\/\/[^\s)>\]`]+/g;
const MD_LINK = /\]\(([^)\s]+)\)/g;
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  '.git',
  '.gestalt',
  '.gestalt-test',
]);
// 문서가 "이 경로에 만든다"고 말하는 줄의 경로는 아직 없는 게 정상이다
const CREATION_CUE = /만든다|만들|생성|작성|저장|기록|내보|출력|create|write|generate|output|emit/i;

const PENDING_CLAIM =
  /머지\s*전|머지되기\s*전|머지되면|머지\s*예정|아직\s*머지|머지\s*안|미머지|머지\s*대기|열려\s*있|open\s*상태|not\s+(?:yet\s+)?merged|once\s+.*merged/i;
const MERGED_CLAIM =
  /머지됐|머지되었|이미\s*머지|머지된\s*(?:PR|풀|브랜치|상태)|병합됐|병합되었|already\s+merged|was\s+merged|has\s+been\s+merged/i;

interface DocContext {
  file: string;
  lines: string[];
}

export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function extractHeadingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = githubSlug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

function stripFences(lines: string[]): string[] {
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

function contextOf(lines: string[], index: number): string[] {
  return lines.slice(Math.max(0, index - 1), index + 2);
}

function repoMatches(slug: string, repo: PlaceholderRepo): boolean {
  return repo.repo === slug || repo.repo === slug.split('/')[1];
}

function failureText(e: unknown): string {
  if (typeof e !== 'object' || e === null) return String(e);
  const { stderr, stdout, message } = e as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  return [stderr, stdout, message]
    .filter((v) => v !== undefined && v !== null)
    .map(String)
    .join('\n');
}

/** 문서 위치에서 저장소 루트까지 올라가며 찾는다. 플러그인 루트 기준으로 적은 상대 경로를 살리려는 순서다 */
function existsFromDoc(repoDir: string, docFile: string, target: string): boolean {
  const clean = target.replace(/^\.\//, '');
  let dir = dirname(docFile);
  for (;;) {
    if (existsSync(join(repoDir, dir === '.' ? '' : dir, clean))) return true;
    if (dir === '.' || dir === '/') return false;
    dir = dirname(dir);
  }
}

function existsInRepos(repos: PlaceholderRepo[], target: string): boolean {
  return repos.some((r) => existsSync(join(r.dir, target.replace(/^\.\//, ''))));
}

function isIgnoredPath(path: string): boolean {
  return path.split('/').some((seg) => IGNORED_SEGMENTS.has(seg));
}

interface PrRef {
  repo: string | null;
  number: number;
  line: number;
}

function findPrRefs(text: string, lineNo: number, ownSlug: string | null): PrRef[] {
  const refs: PrRef[] = [];
  for (const m of text.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
    refs.push({ repo: m[1]!, number: Number(m[2]!), line: lineNo });
  }
  // URL은 위에서 처리했으니 지우고 백틱 안(색상 코드 등)은 PR 번호가 아니다
  const rest = text.replace(URL_RE, ' ').replace(/`[^`]*`/g, ' ');
  for (const m of rest.matchAll(/(?<![\w&/#])#(\d{1,7})\b/g)) {
    refs.push({ repo: ownSlug, number: Number(m[1]!), line: lineNo });
  }
  return refs;
}

type PrStatus =
  | { kind: 'ok'; state: 'open' | 'merged' | 'closed' }
  | { kind: 'notFound' }
  | { kind: 'blocked'; reason: BlockReason; detail: string }
  | { kind: 'error'; detail: string };

function lookupPr(gh: GhRunner, repo: string, number: number): PrStatus {
  let out: string;
  try {
    out = gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergedAt']);
  } catch (e) {
    const text = failureText(e);
    // 없는 번호는 404가 아니라 "Could not resolve"로 온다. 권한 실패와 섞이지 않게 먼저 본다
    if (/could not resolve to a pullrequest|no pull requests? found/i.test(text)) {
      return { kind: 'notFound' };
    }
    const reason = classifyGhFailure(text);
    if (reason) return { kind: 'blocked', reason, detail: text.trim().split('\n')[0] ?? '' };
    return { kind: 'error', detail: text.trim().split('\n')[0] ?? '' };
  }
  try {
    const json = JSON.parse(out) as { state?: string; mergedAt?: string | null };
    const state = String(json.state ?? '').toLowerCase();
    if (state === 'merged' || (json.mergedAt ?? null) !== null)
      return { kind: 'ok', state: 'merged' };
    if (state === 'open' || state === 'closed') return { kind: 'ok', state };
  } catch {
    // 아래 error로 떨어진다
  }
  return { kind: 'error', detail: 'gh 응답을 해석하지 못했다' };
}

export function forwardSearch(input: ForwardSearchInput): ForwardSearchResult {
  const { ownRepo, files } = input;
  const others = (input.otherRepos ?? []).filter((r) => r.repo !== ownRepo.repo);
  const allRepos = [ownRepo, ...others];
  const gh = input.gh ?? runGh;
  const ownSlug = ownRepo.repo.includes('/') ? ownRepo.repo : null;

  const candidates: ReferenceCandidate[] = [];
  const limitations = [...FORWARD_SEARCH_LIMITATIONS];
  const seenKeys = new Set<string>();
  let blocked: ForwardSearchBlocked | undefined;

  const push = (c: ReferenceCandidate) => {
    const key = `${c.sourceFile}:${c.sourceLine}:${c.targetRepo}:${c.targetPath}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    candidates.push(c);
  };

  const docs: DocContext[] = [];
  for (const file of files) {
    const abs = join(ownRepo.dir, file);
    if (!existsSync(abs)) continue;
    docs.push({ file, lines: readFileSync(abs, 'utf-8').split('\n') });
  }

  const placeholders = resolvePlaceholders({ ownRepo, otherRepos: others, files });
  const prStatus = new Map<string, PrStatus>();
  const skippedPr: string[] = [];
  let unresolvedOwnerless = 0;

  for (const doc of docs) {
    const code = stripFences(doc.lines);
    const headingCache = new Map<string, Set<string>>();
    const headingsOf = (repoDir: string, relPath: string): Set<string> | null => {
      const abs = join(repoDir, relPath);
      const cached = headingCache.get(abs);
      if (cached) return cached;
      if (!existsSync(abs) || !/\.mdx?$/.test(relPath)) return null;
      const slugs = extractHeadingSlugs(readFileSync(abs, 'utf-8'));
      headingCache.set(abs, slugs);
      return slugs;
    };

    // 자리표시자: 해석은 task-9가 했고 여기서는 판정 대상만 후보로 옮긴다
    for (const ph of placeholders) {
      if (ph.definingFile !== doc.file || !ph.needsLlmJudgment || ph.reason === 'noPath') continue;
      const line =
        extractPlaceholderRefs(code.join('\n')).find(
          (r) => r.token === ph.token && ph.paths.includes(r.path),
        )?.line ?? 1;
      push({
        kind: 'forwardRef',
        sourceFile: doc.file,
        sourceLine: line,
        targetRepo: ph.matchedRepos.join(','),
        targetPath: ph.paths.join(','),
        matchedText: `${ph.token}/${ph.paths.join(', ')}`,
        contextLines: contextOf(doc.lines, line - 1),
        needsLlmJudgment: true,
      });
    }

    for (let i = 0; i < code.length; i++) {
      const line = code[i]!;
      if (!line) continue;
      const lineNo = i + 1;

      // 같은 문서 안 앵커: `](#slug)` 꼴만 본다. 맨몸의 #태그는 앵커가 아니다
      for (const m of line.matchAll(MD_LINK)) {
        const target = m[1]!;
        if (!target.startsWith('#') || /^#\d+$/.test(target) || target.length < 2) continue;
        const slugs = headingsOf(ownRepo.dir, doc.file);
        const anchor = decodeURIComponent(target.slice(1)).toLowerCase();
        if (slugs && !slugs.has(anchor)) {
          push({
            kind: 'forwardRef',
            sourceFile: doc.file,
            sourceLine: lineNo,
            targetRepo: ownRepo.repo,
            targetPath: `${doc.file}${target}`,
            matchedText: target,
            contextLines: contextOf(doc.lines, i),
            needsLlmJudgment: false,
          });
        }
      }

      // GitHub 링크: 로컬 체크아웃이 있는 레포만 확인한다
      for (const m of line.matchAll(
        /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:blob|tree)\/([^/\s)#]+)\/([^\s)#`]+)(#[^\s)`]*)?/g,
      )) {
        const [, slug, ref, path] = m;
        const repo = allRepos.find((r) => repoMatches(slug!, r));
        if (!repo || isIgnoredPath(path!)) continue;
        const cleanPath = path!.replace(/[.,;:]+$/, '');
        if (!existsSync(join(repo.dir, cleanPath))) {
          push({
            kind: 'forwardRef',
            sourceFile: doc.file,
            sourceLine: lineNo,
            targetRepo: repo.repo,
            targetPath: cleanPath,
            matchedText: m[0],
            contextLines: contextOf(doc.lines, i),
            needsLlmJudgment: !/^(main|master|HEAD)$/.test(ref!),
          });
          continue;
        }
        const anchor = m[4];
        if (anchor && !/^#L\d/.test(anchor) && /\.mdx?$/.test(cleanPath)) {
          const slugs = headingsOf(repo.dir, cleanPath);
          if (slugs && !slugs.has(decodeURIComponent(anchor.slice(1)).toLowerCase())) {
            push({
              kind: 'forwardRef',
              sourceFile: doc.file,
              sourceLine: lineNo,
              targetRepo: repo.repo,
              targetPath: `${cleanPath}${anchor}`,
              matchedText: m[0],
              contextLines: contextOf(doc.lines, i),
              needsLlmJudgment: !/^(main|master|HEAD)$/.test(ref!),
            });
          }
        }
      }

      // 경로와 경로#앵커
      const bare = line
        .replace(URL_RE, ' ')
        .replace(/\{[A-Z][A-Z0-9_]*_ROOT\}|\$\{?[A-Z][A-Z0-9_]*_ROOT\}?/g, ' ');
      for (const cm of bare.matchAll(CHUNK)) {
        const chunk = cm[0].replace(/[.:]+$/, '');
        const hashAt = chunk.indexOf('#');
        const path = hashAt === -1 ? chunk : chunk.slice(0, hashAt);
        const anchor = hashAt === -1 ? '' : chunk.slice(hashAt + 1);
        if (!path || !FILE_PATH.test(path) || !path.includes('/') || isIgnoredPath(path)) continue;

        const found = existsFromDoc(ownRepo.dir, doc.file, path);
        if (!found) {
          if (existsInRepos(others, path)) continue;
          push({
            kind: 'forwardRef',
            sourceFile: doc.file,
            sourceLine: lineNo,
            targetRepo: ownRepo.repo,
            targetPath: path.replace(/^\.\//, ''),
            matchedText: chunk,
            contextLines: contextOf(doc.lines, i),
            needsLlmJudgment: CREATION_CUE.test(line),
          });
          continue;
        }
        if (anchor && !/^L\d/.test(anchor) && /\.mdx?$/.test(path)) {
          const resolved = posix.normalize(join(dirname(doc.file), path));
          const rel = existsSync(join(ownRepo.dir, resolved))
            ? resolved
            : path.replace(/^\.\//, '');
          const slugs = headingsOf(ownRepo.dir, rel);
          if (slugs && !slugs.has(decodeURIComponent(anchor).toLowerCase())) {
            push({
              kind: 'forwardRef',
              sourceFile: doc.file,
              sourceLine: lineNo,
              targetRepo: ownRepo.repo,
              targetPath: `${rel}#${anchor}`,
              matchedText: chunk,
              contextLines: contextOf(doc.lines, i),
              needsLlmJudgment: false,
            });
          }
        }
      }

      // PR 번호와 그 상태를 말하는 문장의 대조
      for (const ref of findPrRefs(line, lineNo, ownSlug)) {
        if (!ref.repo) {
          unresolvedOwnerless++;
          continue;
        }
        const key = `${ref.repo}#${ref.number}`;
        let status = prStatus.get(key);
        if (!status) {
          if (blocked) continue;
          if (prStatus.size >= MAX_PR_LOOKUPS) {
            skippedPr.push(key);
            continue;
          }
          status = lookupPr(gh, ref.repo, ref.number);
          prStatus.set(key, status);
        }
        if (status.kind === 'blocked') {
          blocked ??= { reason: status.reason, detail: status.detail };
          continue;
        }
        const base = {
          kind: 'forwardRef' as const,
          sourceFile: doc.file,
          sourceLine: ref.line,
          targetRepo: ref.repo,
          targetPath: `pull/${ref.number}`,
          matchedText: line.trim().slice(0, 200),
          contextLines: contextOf(doc.lines, i),
        };
        if (status.kind === 'notFound') {
          // 이슈 번호일 수 있어 PR이 없다는 사실만으로는 결함이 아니다
          push({ ...base, needsLlmJudgment: true });
        } else if (status.kind === 'ok') {
          const pending = PENDING_CLAIM.test(line);
          const merged = MERGED_CLAIM.test(line);
          if (pending && !merged && status.state === 'merged') {
            push({ ...base, needsLlmJudgment: false });
          } else if (merged && !pending && status.state !== 'merged') {
            push({ ...base, needsLlmJudgment: false });
          }
        }
      }
    }
  }

  if (blocked) {
    limitations.push(
      `gh 조회가 막혀(${blocked.reason}) PR 번호 상태는 확인하지 못했다. 경로와 헤딩 검사만 끝났다`,
    );
  }
  if (skippedPr.length > 0) {
    limitations.push(`PR 조회 상한(${MAX_PR_LOOKUPS}건)을 넘어 ${skippedPr.length}건은 건너뛰었다`);
  }
  if (unresolvedOwnerless > 0) {
    limitations.push(
      `레포 owner를 몰라 #번호 형태의 PR 참조 ${unresolvedOwnerless}건은 조회하지 못했다`,
    );
  }
  const errors = [...prStatus.values()].filter((s) => s.kind === 'error').length;
  if (errors > 0) limitations.push(`gh 조회 오류로 확인하지 못한 PR 참조가 ${errors}건 있다`);

  return { candidates, limitations, ...(blocked ? { blocked } : {}) };
}
