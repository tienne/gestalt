/**
 * 자기오염 검색기.
 *
 * 룰 문서가 금지한 표현을 다른 문서 본문에서 쓰면 그 문서를 읽는 에이전트의 산출물로 샌다.
 * diff에서 새로 추가된 금지어를 뽑고 룰북 표에 적힌 동의어와 영어 원어까지 넓혀 레포 전체 md에서 찾는다.
 * 동의어 사전은 코드에 두지 않는다. 룰북 표를 읽어 쓰므로 룰북이 바뀌면 검색어도 따라 바뀐다.
 *
 * 걸러내는 기준은 scripts/verify-rule-refs.ts의 SELF_CONTAMINATION 검사와 같다.
 * 따옴표, 백틱, 괄호 안은 예시 인용이라 산문으로 안 본다.
 *
 * 코드 파일은 보지 않는다. 코드 속 룰 목록 사본이 어긋날 때는 금지어가 남는 게 아니라
 * 룰 ID가 목록에서 빠지는 꼴이다. 금지어 grep으로는 안 잡히고 주석의 흔한 말만 걸린다.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { ReferenceCandidate } from './types.js';

export type TermKind = 'ko' | 'en';

/**
 * literal은 diff에 실제로 적힌 금지어, synonym은 룰북 표에서 넓힌 말이다.
 * phraseRoot는 자리표시자가 든 금지 예 구절("A가 원조다")에서 조사를 떼고 남긴 어근이다.
 */
export type TermOrigin = 'literal' | 'synonym' | 'phraseRoot';

export interface SearchTerm {
  text: string;
  kind: TermKind;
  origin: TermOrigin;
  /** 룰의 뜻이 조건부거나 정의뿐이라 문맥을 읽어야 판정되는 검색어 */
  needsLlmJudgment: boolean;
}

export interface AddedRule {
  file: string;
  line: number;
  ruleId?: string;
  text: string;
  terms: SearchTerm[];
  /** 검색어가 하나도 없는 룰. grep으로는 확정할 수 없다 */
  definitionOnly: boolean;
}

export interface SelfContaminationCandidate extends ReferenceCandidate {
  kind: 'selfContamination';
  targetLine: number;
  searchTerm: string;
  termOrigin: TermOrigin | 'definition';
}

export interface SelfContaminationInput {
  repoRoot: string;
  diff: string;
  repoName?: string;
  /** 후보 줄 앞뒤로 함께 돌려줄 줄 수 */
  contextLines?: number;
  /** 동의어를 읽을 룰북 경로(repoRoot 기준). 없으면 이름으로 찾는다 */
  rulebookPaths?: string[];
}

const DEFAULT_CONTEXT = 2;
const RULEBOOK_NAMES = ['ai-tell-quick-rules.md', 'style-guide.md'];
// 변경 이력은 지난 표현을 그대로 옮겨 적는 자리라 지시문이 아니다. 라벨링한 27건이 전부 오염이 아니었다
const CHANGE_LOG_NAME = /^CHANGELOG\.md$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.gestalt', '.gestalt-test', 'dist']);

// 룰 ID 칸이면 패턴 칸만, 그 밖의 표는 헤더 이름으로 처방 칸을 뺀다.
// "허용 | 금지" 표의 허용 칸도 처방이다. 안 빼면 허용 예시의 토큰 이름이 금지어가 된다
const NON_SEARCH_HEADER = /처방|이렇게|쓰는 말|대체|심각도|가리키는|허용|권장|^id$|^after$|^allow/i;
// 룰 ID가 없는 표는 헤더에 금지 칸이 있어야 룰 표다. 없으면 파일 목록이나 설정 표라 칸 내용이 금지어가 아니다.
// 이 조건 없이 칸을 전부 검색어로 쓰면 CLAUDE.md의 경로 표에서 "kit", "md" 같은 말이 금지어가 된다
const BANNED_HEADER = /쓰지 말|금지|피할|before|avoid|don'?t/i;
const RULE_ID_CELL = /^[A-Z]-\d{1,2}$/;
const CONDITIONAL_MARKER = /때만|경우에만|\d회\+|이상 반복|대상이 아니|예외/;
const PLACEHOLDER_LETTER = /(^|[^A-Za-z])[A-Z](?![A-Za-z])/;

// 어절 끝의 조사와 서술격 조사. $에 붙인 교대라 가장 왼쪽 자리부터 맞아 긴 꼬리가 먼저 떨어진다
const KO_PARTICLE_TAIL =
  /(?:입니다|이에요|이다|이며|이고|에서|으로|예요|은|는|이|가|을|를|의|에|로|도|만|다)$/;
// 한 글자 어근은 다른 낱말 속에 흔히 박혀 있어 grep하면 레포 대부분이 걸린다
const MIN_ROOT_LENGTH = 2;
// 금지 예 구절의 뼈대로 끼는 말이라 금지어가 아니다. 이걸로 찾으면 후보가 판정할 수 없을 만큼 쏟아진다
const COMMON_ROOTS = new Set([
  '이것',
  '그것',
  '저것',
  '여기',
  '거기',
  '파일',
  '문서',
  '사용',
  '경우',
  '때문',
  '하나',
  '우리',
]);

// 파일 경로는 diff 헤더에서만 뽑는다. 삭제된 파일(/dev/null)은 추가 줄이 없다
export function parseAddedLines(diff: string): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>();
  let current: Map<number, string> | null = null;
  let lineNo = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      if (path === '/dev/null') {
        current = null;
      } else {
        const name = path.replace(/^b\//, '');
        current = files.get(name) ?? new Map();
        files.set(name, current);
      }
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNo = Number(hunk[1]!);
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('+')) {
      current.set(lineNo, raw.slice(1));
      lineNo += 1;
    } else if (raw.startsWith(' ')) {
      lineNo += 1;
    }
  }
  return files;
}

/** 파일별로 diff에서 지워진 줄. 고친 표 행의 옛 모습을 찾는 데만 쓴다 */
export function parseRemovedLines(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ')) {
      const path = raw.slice(4).trim();
      if (path === '/dev/null') {
        current = null;
      } else {
        const name = path.replace(/^a\//, '');
        current = files.get(name) ?? [];
        files.set(name, current);
      }
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('diff --git')) continue;
    if (current && raw.startsWith('-')) current.push(raw.slice(1));
  }
  return files;
}

/** 따옴표, 백틱, 괄호 안은 인용이다. verify-rule-refs의 bareProse와 같은 기준 */
export function stripQuoted(line: string): string {
  return line
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, ' ')
    .replace(/\([^)\n]*\)/g, ' ');
}

function termKind(text: string): TermKind {
  return /[가-힣]/.test(text) ? 'ko' : 'en';
}

function cleanTerm(raw: string): string | null {
  const text = raw.replace(/\*\*/g, '').trim();
  if (text.length < 2 || text.length > 40) return null;
  if (RULE_ID_CELL.test(text)) return null;
  if (PLACEHOLDER_LETTER.test(text)) return null;
  return text;
}

function splitSlash(quoted: string): string[] {
  return quoted.split('/').map((part) => part.trim());
}

/**
 * 자리표시자가 든 금지 예 구절에서 한국어 금지어 어근을 뽑는다.
 * "A가 원조다"는 통째로는 어디에도 안 나오지만 "원조"는 다른 문서 산문에 그대로 남는다.
 * 자리표시자 없는 구절은 extractCellTerms가 통째로 쓰므로 여기서는 빈 배열이다.
 */
export function extractPhraseRoots(cell: string): string[] {
  const out: string[] = [];
  for (const m of cell.matchAll(/`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/g)) {
    for (const phrase of splitSlash(m[1] ?? m[2] ?? m[3]!)) {
      if (!PLACEHOLDER_LETTER.test(phrase)) continue;
      for (const eojeol of phrase.split(/\s+/)) {
        // 자리표시자에 붙은 조사("A가")나 영어가 섞인 어절은 한국어 어근이 아니다
        if (/[A-Za-z]/.test(eojeol)) continue;
        const root = eojeol.replace(/[^가-힣]/g, '').replace(KO_PARTICLE_TAIL, '');
        if (root.length < MIN_ROOT_LENGTH || COMMON_ROOTS.has(root)) continue;
        if (!out.includes(root)) out.push(root);
      }
    }
  }
  return out;
}

/** 셀 하나에서 금지어 후보를 뽑는다. 따옴표와 백틱, 괄호 안 나열, 화살표 앞 영어 원어 */
export function extractCellTerms(cell: string, plainFallback: boolean): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const text = cleanTerm(raw);
    if (text) out.push(text);
  };

  for (const m of cell.matchAll(/`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/g)) {
    for (const part of splitSlash(m[1] ?? m[2] ?? m[3]!)) push(part);
  }

  // 괄호 안에 가운뎃점으로 이어 적은 예시 나열
  for (const m of cell.matchAll(/\(([^)\n]+)\)/g)) {
    const inner = m[1]!;
    if (!inner.includes('·')) continue;
    for (const part of inner.split('·')) push(part.replace(/[`"“”]/g, ''));
  }

  // "영어 → 번역어" 꼴에서 화살표 앞에 놓인 영어 원어
  for (const m of cell.matchAll(/([A-Za-z][A-Za-z ]*?)\s*→/g)) push(m[1]!);

  if (out.length === 0 && plainFallback) {
    const bare = cell.replace(/\*\*/g, '').replace(/\([^)]*\)/g, ' ');
    for (const part of bare.split(/\s\/\s|,\s*/)) push(part);
  }
  return out;
}

interface TableRow {
  line: number;
  ruleId?: string;
  /** 검색어를 뽑는 칸만 이은 글. 정의 줄 판별에 쓴다 */
  searchText: string;
  fullText: string;
  terms: string[];
  /** 금지 예 구절에서 뽑은 어근. terms와 겹치는 말은 뺀다 */
  roots: string[];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|?\s*$/.test(line.trim()) && line.includes('-');
}

export function parseRuleTables(markdown: string): TableRow[] {
  const lines = markdown.split('\n');
  const rows: TableRow[] = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i]!.trim().startsWith('|') || !isSeparator(lines[i + 1]!)) continue;

    const header = splitRow(lines[i]!);
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trim().startsWith('|'); j += 1) {
      const cells = splitRow(lines[j]!);
      const ruleId = RULE_ID_CELL.test(cells[0] ?? '') ? cells[0] : undefined;

      const bannedTable = header.some((h) => BANNED_HEADER.test(h));
      const searchCells = ruleId
        ? [cells[1] ?? '']
        : bannedTable
          ? cells.filter((_, idx) => !NON_SEARCH_HEADER.test(header[idx] ?? ''))
          : [];

      const terms = [
        ...new Set(searchCells.flatMap((cell) => extractCellTerms(cell, ruleId === undefined))),
      ];
      const roots = [...new Set(searchCells.flatMap(extractPhraseRoots))].filter(
        (root) => !terms.includes(root),
      );
      rows.push({
        line: j + 1,
        ruleId,
        searchText: searchCells.join(' '),
        fullText: cells.join(' | '),
        terms,
        roots,
      });
    }
    i = j - 1;
  }
  return rows;
}

/** 룰 ID 행은 정의 문장만 있을 때 뜻으로 정의된 룰로 본다 */
function isConditional(row: TableRow): boolean {
  return CONDITIONAL_MARKER.test(row.fullText);
}

/**
 * 고친 행에서 옛 행에도 있던 말을 뺀다. 행을 고쳤다고 행에 원래 있던 금지어까지 새로 금지한 건 아니다.
 * 옛 행은 첫 칸(룰 ID나 원어)이 같은 지워진 줄로 찾고 못 찾으면 새로 더한 행으로 본다.
 */
function newTermsOnly(
  row: TableRow,
  markdown: string,
  removed: string[] | undefined,
): TableRow | null {
  const key = splitRow(markdown.split('\n')[row.line - 1] ?? '')[0];
  const before = removed?.find((l) => l.trim().startsWith('|') && splitRow(l)[0] === key);
  if (before === undefined) return row;
  const lines = markdown.split('\n');
  lines[row.line - 1] = before;
  const old = parseRuleTables(lines.join('\n')).find((r) => r.line === row.line);
  if (!old) return row;
  const had = new Set([...old.terms, ...old.roots].map(normalize));
  const terms = row.terms.filter((t) => !had.has(normalize(t)));
  const roots = row.roots.filter((t) => !had.has(normalize(t)));
  // 원래 금지어가 있던 행인데 새로 더한 말이 없으면 처방이나 문구만 고친 것이다
  if (terms.length === 0 && roots.length === 0 && had.size > 0) return null;
  return { ...row, terms, roots };
}

export function extractAddedRules(
  repoRoot: string,
  added: Map<string, Map<number, string>>,
  removed?: Map<string, string[]>,
): AddedRule[] {
  const rules: AddedRule[] = [];

  for (const [file, addedLines] of added) {
    if (!file.endsWith('.md')) continue;
    let markdown: string;
    try {
      markdown = readFileSync(join(repoRoot, file), 'utf-8');
    } catch {
      continue;
    }

    for (const parsed of parseRuleTables(markdown)) {
      if (!addedLines.has(parsed.line)) continue;
      const row = newTermsOnly(parsed, markdown, removed?.get(file));
      if (!row) continue;
      // 설명 표(파일 목록 등)와 룰 표를 가르는 신호가 룰 ID나 헤더 매핑인데,
      // 뒤쪽은 검색어가 뽑힌 행만 룰로 본다
      if (!row.ruleId && row.terms.length === 0 && row.roots.length === 0) continue;

      const conditional = isConditional(row);
      // 같은 행에 한글 금지어가 있으면 영어 칸은 원어 짝이다. 영어는 첫 등장 병기처럼 정당하게 나올 수 있다
      const hasKo = row.roots.length > 0 || row.terms.some((t) => termKind(t) === 'ko');
      rules.push({
        file,
        line: row.line,
        ruleId: row.ruleId,
        text: row.fullText,
        definitionOnly: row.terms.length === 0 && row.roots.length === 0,
        terms: [
          ...row.terms.map(
            (text): SearchTerm => ({
              text,
              kind: termKind(text),
              origin: hasKo && termKind(text) === 'en' ? 'synonym' : 'literal',
              needsLlmJudgment: conditional || (hasKo && termKind(text) === 'en'),
            }),
          ),
          // 어근은 "원본 이미지"처럼 금지 뜻이 아닌 자리에도 나오므로 늘 문맥 판정으로 넘긴다
          ...row.roots.map(
            (text): SearchTerm => ({
              text,
              kind: 'ko',
              origin: 'phraseRoot',
              needsLlmJudgment: true,
            }),
          ),
        ],
      });
    }
  }
  return rules;
}

function normalize(term: string): string {
  return term.toLowerCase().replace(/\s+/g, '');
}

function discoverRulebooks(repoRoot: string, explicit?: string[]): string[] {
  if (explicit) return explicit.map((p) => join(repoRoot, p));
  return readdirSync(repoRoot, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && RULEBOOK_NAMES.includes(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter(
      (abs) =>
        !relative(repoRoot, abs)
          .split('/')
          .some((seg) => SKIP_DIRS.has(seg)),
    );
}

/**
 * 룰북 표에서 같은 행에 놓인 다른 언어의 말을 동의어로 넓힌다.
 * 한글 금지어면 영어 원어를, 영어 원어면 그 한글 직역형을 더한다.
 * 같은 행 안의 형제 금지어는 넣지 않는다. 다른 룰의 말까지 끌려온다.
 */
export function expandSearchTerms(rules: AddedRule[], rulebookFiles: string[]): SearchTerm[] {
  const rulebookRows: TableRow[] = [];
  for (const abs of rulebookFiles) {
    try {
      rulebookRows.push(...parseRuleTables(readFileSync(abs, 'utf-8')));
    } catch {
      continue;
    }
  }
  // 이번 diff의 행도 룰북 행이다. 파일이 룰북 이름이 아니어도 원어 짝을 쓸 수 있다
  const ownRows: TableRow[] = rules.map((r) => ({
    line: r.line,
    ruleId: r.ruleId,
    searchText: '',
    fullText: r.text,
    terms: r.terms.map((t) => t.text),
    roots: [],
  }));

  const out = new Map<string, SearchTerm>();
  const add = (term: SearchTerm): void => {
    const key = normalize(term.text);
    const existing = out.get(key);
    // 같은 말이 literal로도 나오면 literal이 우선한다
    if (!existing || (existing.origin !== 'literal' && term.origin === 'literal')) {
      out.set(key, term);
    }
  };

  for (const rule of rules) for (const t of rule.terms) add(t);

  for (const rule of rules) {
    for (const literal of rule.terms) {
      const key = normalize(literal.text);
      for (const row of [...rulebookRows, ...ownRows]) {
        const rowTerms = [...row.terms, ...row.roots];
        if (!rowTerms.some((t) => normalize(t) === key)) continue;
        // 한 행에 "원어 → 번역어" 짝을 여럿 적은 룰이면 짝끼리만 동의어다. 행 전체를 넓히면 같은 룰의
        // 다른 예시 원어(close, branch 같은 흔한 영어 낱말)가 딸려와 후보가 쏟아진다
        const partners = arrowPartners(row.searchText || row.fullText, key);
        for (const other of partners ?? rowTerms) {
          if (termKind(other) === literal.kind) continue;
          // 영어 원어는 첫 등장 병기처럼 정당하게 나올 수 있어 문맥 판정으로 넘긴다
          add({
            text: other,
            kind: termKind(other),
            origin: 'synonym',
            needsLlmJudgment: true,
          });
        }
      }
    }
  }
  return [...out.values()];
}

const ARROW_PAIR_RE = /([A-Za-z][A-Za-z ]*?)\s*→\s*[`"“]([^`"”\n]+)[`"”]/g;

/** 행의 화살표 짝 중 key가 든 짝의 상대편. key가 어느 짝에도 없으면 null */
export function arrowPartners(text: string, key: string): string[] | null {
  const out: string[] = [];
  for (const m of text.matchAll(ARROW_PAIR_RE)) {
    const en = cleanTerm(m[1]!);
    const ko = cleanTerm(m[2]!);
    if (!en || !ko) continue;
    if (normalize(en) === key) out.push(ko);
    else if (normalize(ko) === key) out.push(en);
  }
  return out.length > 0 ? out : null;
}

const KO_VERB_TAIL = /(?:한다|하다|했다|합니다|이다)$/;

/** 띄어쓰기 변형과 영어의 구분자 변형을 잡는 정규식. 한글 어간은 별도 변형으로 만든다 */
export function termPatterns(term: SearchTerm): Array<{ regex: RegExp; exact: boolean }> {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokens = term.text.split(/[\s_-]+/).filter(Boolean);

  if (term.kind === 'en') {
    const body = tokens.map(escape).join('[\\s_-]*');
    return [{ regex: new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i'), exact: true }];
  }

  // 한글은 글자 사이에 공백이 끼어도 같은 말로 본다 ("물질 화한다"). 세 글자 미만은 오탐이 커서 그대로 둔다
  const spaced = (text: string): string => {
    const chars = [...text.replace(/\s+/g, '')].map(escape);
    return chars.length >= 3 ? chars.join('\\s?') : chars.join('');
  };
  const patterns = [{ regex: new RegExp(spaced(term.text)), exact: true }];
  const stem = term.text.replace(KO_VERB_TAIL, '');
  if (stem !== term.text && stem.length >= 3) {
    patterns.push({ regex: new RegExp(spaced(stem)), exact: false });
  }
  return patterns;
}

// 재귀 readdir은 디렉토리 심링크(루트 skills → plugin/skills) 안까지 내려가 같은 파일을 두 번 센다.
// 실제 경로로 한 번만 남긴다. 정렬 뒤에 거르므로 앞선 경로 쪽이 남는다
function markdownFiles(repoRoot: string): string[] {
  const seen = new Set<string>();
  return readdirSync(repoRoot, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !CHANGE_LOG_NAME.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter(
      (abs) =>
        !relative(repoRoot, abs)
          .split('/')
          .some((seg) => SKIP_DIRS.has(seg)),
    )
    .sort()
    .filter((abs) => {
      const real = realpathSync(abs);
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    });
}

function contextAround(lines: string[], index: number, n: number): string[] {
  return lines.slice(Math.max(0, index - n), Math.min(lines.length, index + n + 1));
}

/**
 * 추가된 금지어와 룰 문장으로 레포 전체 md를 grep해 후보를 낸다.
 * 뜻으로만 정의된 룰과 조건부 룰, 동의어 일치는 needsLlmJudgment=true로 두고 확정하지 않는다.
 */
export function findSelfContamination(input: SelfContaminationInput): SelfContaminationCandidate[] {
  const { repoRoot, diff } = input;
  const n = input.contextLines ?? DEFAULT_CONTEXT;
  const repoName = input.repoName ?? basename(repoRoot);

  const added = parseAddedLines(diff);
  const rules = extractAddedRules(repoRoot, added, parseRemovedLines(diff));
  if (rules.length === 0) return [];

  const searchable = rules.filter((r) => !r.definitionOnly);
  const terms = expandSearchTerms(searchable, discoverRulebooks(repoRoot, input.rulebookPaths));
  const compiled = terms.flatMap((term) =>
    termPatterns(term).map((p) => ({ term, regex: p.regex, exact: p.exact })),
  );

  // 검색어를 낳은 룰을 후보에 붙이려면 어느 룰의 말인지 알아야 한다
  const owner = (term: SearchTerm): AddedRule =>
    searchable.find((r) => r.terms.some((t) => normalize(t.text) === normalize(term.text))) ??
    searchable.find((r) => r.terms.some((t) => t.kind !== term.kind)) ??
    searchable[0]!;

  const candidates: SelfContaminationCandidate[] = [];
  const seen = new Set<string>();

  for (const abs of markdownFiles(repoRoot)) {
    const rel = relative(repoRoot, abs);
    const lines = readFileSync(abs, 'utf-8').split('\n');
    const addedHere = added.get(rel);
    const definitionRows = new Map(parseRuleTables(lines.join('\n')).map((r) => [r.line, r]));

    lines.forEach((text, index) => {
      const lineNo = index + 1;
      // diff에 든 줄은 1단계가 이미 읽었다. diff 밖만 후보로 낸다
      if (addedHere?.has(lineNo)) return;

      const bare = stripQuoted(text);
      for (const { term, regex, exact } of compiled) {
        if (!regex.test(bare)) continue;

        // 금지어를 정의하는 표 행 자체는 오염이 아니다
        const row = definitionRows.get(lineNo);
        if (row && regex.test(row.searchText)) continue;

        const key = `${rel}:${lineNo}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const source = owner(term);
        candidates.push({
          kind: 'selfContamination',
          sourceFile: source.file,
          sourceLine: source.line,
          targetRepo: repoName,
          targetPath: rel,
          targetLine: lineNo,
          searchTerm: term.text,
          termOrigin: term.origin,
          matchedText: text.trim(),
          contextLines: contextAround(lines, index, n),
          needsLlmJudgment: term.needsLlmJudgment || !exact,
        });
        break;
      }
    });
  }

  candidates.push(...definitionCandidates(rules, repoRoot, repoName, added, n));
  return candidates;
}

/**
 * 예시 없이 뜻으로만 정의된 룰은 grep 대상이 없다.
 * 룰 ID를 인용한 문서와 정의 줄 자체를 판정 후보로 낸다.
 */
function definitionCandidates(
  rules: AddedRule[],
  repoRoot: string,
  repoName: string,
  added: Map<string, Map<number, string>>,
  n: number,
): SelfContaminationCandidate[] {
  const out: SelfContaminationCandidate[] = [];

  for (const rule of rules.filter((r) => r.definitionOnly)) {
    const label = rule.ruleId ?? rule.text.slice(0, 30);
    const defLines = readFileSync(join(repoRoot, rule.file), 'utf-8').split('\n');

    out.push({
      kind: 'selfContamination',
      sourceFile: rule.file,
      sourceLine: rule.line,
      targetRepo: repoName,
      targetPath: rule.file,
      targetLine: rule.line,
      searchTerm: label,
      termOrigin: 'definition',
      matchedText: rule.text,
      contextLines: contextAround(defLines, rule.line - 1, n),
      needsLlmJudgment: true,
    });

    if (!rule.ruleId) continue;
    const idPattern = new RegExp(`(?<![A-Z0-9-])${rule.ruleId}(?![0-9])`);

    for (const abs of markdownFiles(repoRoot)) {
      const rel = relative(repoRoot, abs);
      const lines = readFileSync(abs, 'utf-8').split('\n');
      lines.forEach((text, index) => {
        const lineNo = index + 1;
        if (added.get(rel)?.has(lineNo)) return;
        if (!idPattern.test(text)) return;
        out.push({
          kind: 'selfContamination',
          sourceFile: rule.file,
          sourceLine: rule.line,
          targetRepo: repoName,
          targetPath: rel,
          targetLine: lineNo,
          searchTerm: rule.ruleId!,
          termOrigin: 'definition',
          matchedText: text.trim(),
          contextLines: contextAround(lines, index, n),
          needsLlmJudgment: true,
        });
      });
    }
  }
  return out;
}
