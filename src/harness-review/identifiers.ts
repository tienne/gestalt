import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import type { ChangeType, ExtractedByType, Identifier, IdentifierKind } from './types.js';

// ─── diff 파싱 ───────────────────────────────────────────────

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffLine {
  type: 'context' | 'removed' | 'added';
  text: string;
  /** removed와 context는 옛 파일 줄 번호, added는 새 파일 줄 번호 */
  lineNumber: number;
}

export interface DiffHunk {
  /** hunk 헤더의 옛 파일 시작 줄 */
  oldStart: number;
  /** hunk 헤더의 새 파일 시작 줄. 파일이 지워졌으면 0 */
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  hunks: DiffHunk[];
}

function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf-8'));
      continue;
    }
    const next = body[i + 1]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
      bytes.push(...Buffer.from(map[next] ?? next, 'utf-8'));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

function stripPrefix(p: string): string | null {
  const unq = unquoteGitPath(p.trim());
  if (unq === '/dev/null') return null;
  return unq.replace(/^[ab]\//, '');
}

/** `git diff` 출력(unified diff)을 파일 단위로 나눈다. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (".*?"|a\/\S+) (".*?"|b\/\S+)$/.exec(line);
      cur = {
        oldPath: m ? stripPrefix(m[1]!) : null,
        newPath: m ? stripPrefix(m[2]!) : null,
        status: 'modified',
        hunks: [],
      };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;

    if (!hunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        cur.status = 'renamed';
        cur.oldPath = unquoteGitPath(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        cur.status = 'renamed';
        cur.newPath = unquoteGitPath(line.slice('rename to '.length));
      } else if (line.startsWith('--- ')) {
        cur.oldPath = stripPrefix(line.slice(4));
        if (cur.oldPath === null) cur.status = 'added';
        continue;
      } else if (line.startsWith('+++ ')) {
        cur.newPath = stripPrefix(line.slice(4));
        if (cur.newPath === null) cur.status = 'deleted';
        continue;
      }
    }

    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLine = Number(h[1]!);
      newLine = Number(h[2]!);
      hunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('-')) {
      hunk.lines.push({ type: 'removed', text: line.slice(1), lineNumber: oldLine++ });
    } else if (line.startsWith('+')) {
      hunk.lines.push({ type: 'added', text: line.slice(1), lineNumber: newLine++ });
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'context', text: line.slice(1), lineNumber: oldLine });
      oldLine++;
      newLine++;
    }
  }

  for (const f of files) {
    if (f.status === 'deleted') f.newPath = null;
    if (f.status === 'added') f.oldPath = null;
  }
  return files;
}

// ─── 경로 판정 ───────────────────────────────────────────────

function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

function hasSegmentSeq(segs: string[], seq: string[]): boolean {
  // 마지막 세그먼트는 파일 이름이라 디렉토리 매칭에서 뺀다
  for (let i = 0; i + seq.length <= segs.length - 1; i++) {
    if (seq.every((s, j) => segs[i + j] === s)) return true;
  }
  return false;
}

const HARNESS_DOC_NAMES = new Set(['SKILL.md', 'AGENT.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);
const PLUGIN_MANIFEST_NAMES = new Set(['plugin.json', 'marketplace.json']);
const RULE_DOC_NAMES = new Set([...HARNESS_DOC_NAMES, '.cursorrules', '.windsurfrules']);

/** 플러그인 매니페스트(plugin.json, marketplace.json)인가. */
export function isPluginManifestPath(path: string): boolean {
  return PLUGIN_MANIFEST_NAMES.has(posix.basename(path.replace(/\\/g, '/')));
}

// 이 디렉토리들은 하네스 말고는 쓰임이 없어 안에 든 파일은 확장자와 상관없이 하네스로 본다
const HARNESS_ONLY_DIRS = new Set([
  '.claude',
  '.agents',
  '.claude-plugin',
  '.codex-plugin',
  '.grok-plugin',
]);
// skills/, plugins/는 코드 디렉토리 이름과 겹친다(src/skills/index.ts). 그래서 문서꼴 파일만 하네스로 본다
const SHARED_NAME_DIRS = new Set(['skills', 'plugins']);
const HARNESS_TEXT_EXT_RE = /\.(md|mdc|json|toml|ya?ml|txt)$/i;

/**
 * 다른 레포가 하네스로 읽는 경로인가. 역방향 검색 결과를 거르고 관련 레포 탐지가 읽을 문서를 고를 때 쓴다.
 * SKILL.md, AGENT.md, CLAUDE.md, AGENTS.md, GEMINI.md, .mcp.json, 플러그인 매니페스트,
 * .claude/, .agents/, .cursor/rules/, 플러그인 매니페스트 디렉토리 아래 파일,
 * skills/와 plugins/ 아래 문서꼴 파일(md, mdc, json, toml, yaml, txt)이 해당한다.
 */
export function isHarnessPath(path: string): boolean {
  const segs = segmentsOf(path);
  const base = segs[segs.length - 1];
  if (!base) return false;
  if (HARNESS_DOC_NAMES.has(base) || base === '.mcp.json' || PLUGIN_MANIFEST_NAMES.has(base)) {
    return true;
  }
  const dirs = segs.slice(0, -1);
  if (dirs.some((d) => HARNESS_ONLY_DIRS.has(d))) return true;
  if (hasSegmentSeq(segs, ['.cursor', 'rules'])) return true;
  return HARNESS_TEXT_EXT_RE.test(base) && dirs.some((d) => SHARED_NAME_DIRS.has(d));
}

/**
 * review 스킬 1단계가 이름만으로 ruleDocs에 넣는 경로인가.
 * SKILL.md, AGENT.md, CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules, .windsurfrules,
 * .claude/ 아래 .md, .cursor/rules/ 아래 파일.
 */
export function isRuleDocPath(path: string): boolean {
  const segs = segmentsOf(path);
  const base = segs[segs.length - 1];
  if (!base) return false;
  if (RULE_DOC_NAMES.has(base)) return true;
  if (segs.slice(0, -1).includes('.claude') && base.endsWith('.md')) return true;
  return hasSegmentSeq(segs, ['.cursor', 'rules']);
}

// ─── 패키지와 MCP 등록부 판정 ────────────────────────────────

export const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';

function parseJson(content: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** private가 아니고 name이 있는 package.json인가. 다른 레포가 이 이름으로 설치하거나 부른다. */
export function isPublicPackageJson(path: string, content: string): boolean {
  if (posix.basename(path.replace(/\\/g, '/')) !== 'package.json') return false;
  const pkg = parseJson(content);
  return !!pkg && typeof pkg.name === 'string' && pkg.name.length > 0 && pkg.private !== true;
}

/** package.json이 MCP SDK에 의존하는가. */
export function dependsOnMcpSdk(packageJsonContent: string): boolean {
  const pkg = parseJson(packageJsonContent);
  if (!pkg) return false;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[key];
    if (deps && typeof deps === 'object' && MCP_SDK_PACKAGE in deps) return true;
  }
  return false;
}

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

// server.tool('x'), server.registerTool('x'), 감싼 헬퍼 guardedTool('x') 같은 꼴
const TOOL_CALL_RE = /(?:\.tool|\b[a-z]\w*Tool)\s*\(\s*(['"`])([\w.:/-]+)\1/g;
const TOOL_NAME_FIELD_RE = /\bname\s*:\s*(['"`])([a-z][\w.:-]*)\1/g;
const REGISTRY_HINT_RE =
  /(?:\.tool\s*\(|\bregisterTool\s*\(|ListToolsRequestSchema|CallToolRequestSchema)/;
const TOOLISH_LINE_RE = /tool|inputSchema|outputSchema|description\s*:/i;

/** 파일 내용에 MCP 도구 등록부 꼴(server.tool, registerTool, ListTools 핸들러)이 있는가. */
export function isMcpToolRegistry(content: string): boolean {
  return REGISTRY_HINT_RE.test(content);
}

function toolNamesInLine(text: string, prevText: string | undefined, registry: boolean): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(TOOL_CALL_RE)) names.push(m[2]!);
  // name: 필드는 ListTools 응답에서 도구 이름이지만 서버 생성자의 name과 헷갈린다
  if (registry && !/Server\s*\(/.test(text) && !(prevText && /Server\s*\(/.test(prevText))) {
    for (const m of text.matchAll(TOOL_NAME_FIELD_RE)) names.push(m[2]!);
  }
  return names;
}

/** 소스에서 패턴으로 잡히는 MCP 도구 이름을 전부 뽑는다. 등록부가 아니면 name: 필드는 안 본다. */
export function extractMcpToolNames(content: string): string[] {
  const registry = isMcpToolRegistry(content);
  const lines = content.split('\n');
  const out = new Set<string>();
  lines.forEach((l, i) => {
    for (const n of toolNamesInLine(l, lines[i - 1], registry)) out.add(n);
  });
  return [...out];
}

export type ReadFileFn = (relPath: string) => string | undefined;

function importsMcpSdk(text: string): boolean {
  return text.includes(MCP_SDK_PACKAGE);
}

function nearestPackageDependsOnSdk(path: string, readFile: ReadFileFn | undefined): boolean {
  if (!readFile) return false;
  let dir = posix.dirname(path);
  for (;;) {
    const pkgPath = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const content = readFile(pkgPath);
    if (content !== undefined) return dependsOnMcpSdk(content);
    if (dir === '.' || dir === '/' || dir === '') return false;
    dir = posix.dirname(dir);
  }
}

export type HarnessTargetReason = 'ruleDoc' | 'mcpToolRegistry' | 'publicPackage';

/**
 * 변경 파일이 하네스 대상인지 판정한다. ruleDocs 꼴 문서이거나, 다른 레포가 이름으로 부르는
 * 코드(MCP SDK에 의존하는 도구 등록부, private 아닌 package.json)면 그 이유를 돌려준다.
 * content는 판정할 파일의 내용이다. readFile을 주면 가장 가까운 package.json의 의존성도 본다.
 */
export function classifyHarnessTarget(
  path: string,
  content?: string,
  readFile?: ReadFileFn,
): HarnessTargetReason | null {
  if (isRuleDocPath(path)) return 'ruleDoc';
  if (content === undefined) return null;
  if (isPublicPackageJson(path, content)) return 'publicPackage';
  if (
    CODE_EXT_RE.test(path) &&
    isMcpToolRegistry(content) &&
    (importsMcpSdk(content) || nearestPackageDependsOnSdk(path, readFile))
  ) {
    return 'mcpToolRegistry';
  }
  return null;
}

// ─── 식별자 추출 ─────────────────────────────────────────────

export interface ExtractIdentifiersOptions {
  /** base 쪽 트리의 파일 목록. 레포에 하나뿐인 파일 이름을 판정할 때 쓴다. 없으면 uniqueFileName을 안 뽑는다. */
  baseFiles?: string[];
  /** 파일 내용을 읽는다. head에 없으면 base 내용을 돌려줘도 된다. */
  readFile?: ReadFileFn;
}

// 흔한 이름이라 검색하면 온 조직이 걸린다. 레포에 하나뿐이어도 식별자로 쓰지 않는다
const GENERIC_FILE_NAMES = new Set([
  ...RULE_DOC_NAMES,
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.md',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  '.mcp.json',
  'mcp.json',
  '.gitignore',
  ...PLUGIN_MANIFEST_NAMES,
]);

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FRONTMATTER_NAME_RE = /^name:\s*['"]?([^'"#\s][^'"#]*?)['"]?\s*$/;
const JSON_NAME_RE = /^(\s*)"name"\s*:\s*"([^"]+)"/;
const FRONTMATTER_MAX_LINE = 30;

class IdentifierSet {
  private readonly map = new Map<string, Identifier>();
  private static rank: Record<ChangeType, number> = { removed: 3, renamed: 2, modified: 1 };

  add(kind: IdentifierKind, value: string, changeType: ChangeType, extractedBy: ExtractedByType) {
    const v = value.trim();
    if (!v) return;
    const key = `${kind}\u0000${v}\u0000${extractedBy}`;
    const prev = this.map.get(key);
    if (!prev || IdentifierSet.rank[changeType] > IdentifierSet.rank[prev.changeType]) {
      this.map.set(key, { kind, value: v, changeType, extractedBy });
    }
  }

  list(): Identifier[] {
    return [...this.map.values()];
  }
}

function linesOf(file: DiffFile, type: DiffLine['type']): DiffLine[] {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.type === type));
}

function fileChangeType(file: DiffFile): ChangeType {
  if (file.status === 'deleted') return 'removed';
  if (file.status === 'renamed') return 'renamed';
  return 'modified';
}

/** 지워진 값 가운데 다시 안 나온 것. 새로 생긴 값이 있으면 이름이 바뀐 것으로 본다. */
function diffValues(
  removed: string[],
  added: string[],
): { value: string; changeType: ChangeType }[] {
  const addedSet = new Set(added);
  const removedSet = new Set(removed);
  const renamedTo = added.some((a) => !removedSet.has(a));
  return [...removedSet]
    .filter((r) => !addedSet.has(r))
    .map((value) => ({ value, changeType: renamedTo ? 'renamed' : 'removed' }));
}

function isMarkdown(path: string): boolean {
  return /\.mdc?$/i.test(path);
}

function extractPathIds(file: DiffFile, opts: ExtractIdentifiersOptions, out: IdentifierSet) {
  const old = file.oldPath;
  if (!old) return;
  const changeType = fileChangeType(file);
  if (changeType === 'modified' && !isHarnessPath(old) && !isMarkdown(old)) return;

  out.add('path', old, changeType, 'pattern');

  const base = posix.basename(old);
  if (!opts.baseFiles || GENERIC_FILE_NAMES.has(base)) return;
  if (file.status === 'renamed' && file.newPath && posix.basename(file.newPath) === base) return;
  const same = opts.baseFiles.filter((f) => posix.basename(f) === base).length;
  if (same === 1) out.add('uniqueFileName', base, changeType, 'pattern');
}

function extractHeadings(file: DiffFile, out: IdentifierSet) {
  const path = file.oldPath ?? file.newPath ?? '';
  if (!isMarkdown(path) || !file.oldPath) return;

  const side = (types: DiffLine['type'][]) => {
    const found: { text: string; type: DiffLine['type'] }[] = [];
    for (const h of file.hunks) {
      let inFence = false;
      for (const l of h.lines) {
        if (!types.includes(l.type)) continue;
        if (/^\s*(```|~~~)/.test(l.text)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const m = HEADING_RE.exec(l.text);
        if (m) found.push({ text: m[2]!, type: l.type });
      }
    }
    return found;
  };

  const removed = side(['context', 'removed'])
    .filter((x) => x.type === 'removed')
    .map((x) => x.text);
  const added = side(['context', 'added'])
    .filter((x) => x.type === 'added')
    .map((x) => x.text);
  for (const { value, changeType } of diffValues(removed, added)) {
    out.add('heading', value, file.status === 'deleted' ? 'removed' : changeType, 'pattern');
  }
}

/** 룰 문서에서 룰을 정의하는 줄이면 그 ID를 돌려준다. 규칙을 언급만 하는 줄은 정의로 안 본다 */
export function ruleIdOfDefinitionLine(text: string): string | null {
  const lead = /^\s*(?:[#>*|+-]+\s*)*(?:\*\*|`)?\[?([A-Z]{1,2}-\d{1,3})(?![\w-])/.exec(text);
  return lead ? lead[1]! : null;
}

function ruleIdDefinitions(lines: DiffLine[]): string[] {
  const ids: string[] = [];
  for (const l of lines) {
    const id = ruleIdOfDefinitionLine(l.text);
    if (id) ids.push(id);
  }
  return ids;
}

function extractRuleIds(files: DiffFile[], out: IdentifierSet) {
  const mdFiles = files.filter((f) => isMarkdown(f.oldPath ?? f.newPath ?? ''));
  const removedDefs = mdFiles.flatMap((f) => ruleIdDefinitions(linesOf(f, 'removed')));
  const addedDefs = new Set(mdFiles.flatMap((f) => ruleIdDefinitions(linesOf(f, 'added'))));
  for (const id of new Set(removedDefs)) {
    out.add('ruleId', id, addedDefs.has(id) ? 'modified' : 'removed', 'pattern');
  }
}

function nameKindOf(path: string): 'skillName' | 'agentName' | null {
  const segs = segmentsOf(path);
  const base = segs[segs.length - 1] ?? '';
  if (base === 'SKILL.md') return 'skillName';
  if (base === 'AGENT.md') return 'agentName';
  if (base.endsWith('.md') && segs.slice(0, -1).includes('agents')) return 'agentName';
  return null;
}

function nameFromPath(path: string, kind: 'skillName' | 'agentName'): string {
  const base = posix.basename(path);
  if (kind === 'skillName' || base === 'AGENT.md') return posix.basename(posix.dirname(path));
  return base.replace(/\.md$/, '');
}

function extractFrontmatterNames(file: DiffFile, out: IdentifierSet) {
  const old = file.oldPath;
  if (!old) return;
  const kind = nameKindOf(old);
  if (!kind) return;

  const pick = (type: DiffLine['type']) =>
    linesOf(file, type)
      .filter((l) => l.lineNumber <= FRONTMATTER_MAX_LINE)
      .map((l) => FRONTMATTER_NAME_RE.exec(l.text)?.[1])
      .filter((v): v is string => !!v);

  const removed = pick('removed');
  const found = diffValues(removed, pick('added'));
  for (const { value, changeType } of found) {
    out.add(kind, value, file.status === 'deleted' ? 'removed' : changeType, 'pattern');
  }

  // frontmatter를 안 건드린 채 디렉토리만 옮기거나 지우면 이름 줄이 diff에 없다
  if (removed.length === 0 && (file.status === 'deleted' || file.status === 'renamed')) {
    const oldName = nameFromPath(old, kind);
    const newName = file.newPath ? nameFromPath(file.newPath, kind) : null;
    if (oldName && oldName !== newName) out.add(kind, oldName, fileChangeType(file), 'pattern');
  }
}

function sideLines(file: DiffFile, type: 'removed' | 'added'): DiffLine[] {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'context' || l.type === type));
}

/** 바뀐 줄의 "name" 값. 부모 키를 알려고 context 줄도 함께 훑는다. */
function namesOnChangedLines(
  file: DiffFile,
  type: 'removed' | 'added',
  maxIndent: number | null,
): string[] {
  const names: string[] = [];
  for (const h of file.hunks) {
    let parentKey: string | null = null;
    for (const l of h.lines) {
      if (l.type !== 'context' && l.type !== type) continue;
      const open = /"([^"]+)"\s*:\s*\{\s*$/.exec(l.text);
      if (open) parentKey = open[1]!;
      else if (/^\s*\}/.test(l.text)) parentKey = null;
      if (l.type !== type) continue;
      const m = JSON_NAME_RE.exec(l.text);
      if (!m) continue;
      if (maxIndent !== null && m[1]!.replace(/\t/g, '  ').length > maxIndent) continue;
      // owner.name, author.name은 사람 이름이다
      if (parentKey === 'owner' || parentKey === 'author') continue;
      names.push(m[2]!);
    }
  }
  return names;
}

function extractPluginNames(file: DiffFile, out: IdentifierSet) {
  const path = file.oldPath;
  if (!path || !isPluginManifestPath(path)) return;
  const removed = namesOnChangedLines(file, 'removed', null);
  const added = namesOnChangedLines(file, 'added', null);
  for (const { value, changeType } of diffValues(removed, added)) {
    out.add('pluginName', value, file.status === 'deleted' ? 'removed' : changeType, 'pattern');
  }
}

function isPrivatePackage(file: DiffFile, opts: ExtractIdentifiersOptions): boolean {
  const content = opts.readFile?.(file.newPath ?? file.oldPath ?? '');
  if (content !== undefined) {
    const pkg = parseJson(content);
    if (pkg) return pkg.private === true;
  }
  const side = file.status === 'deleted' ? 'removed' : 'added';
  return sideLines(file, side).some((l) => /"private"\s*:\s*true/.test(l.text));
}

function extractPackageNames(file: DiffFile, opts: ExtractIdentifiersOptions, out: IdentifierSet) {
  const path = file.oldPath;
  if (!path || posix.basename(path) !== 'package.json') return;
  if (isPrivatePackage(file, opts)) return;
  // 최상위 name만. dependencies 안의 키나 workspaces 설정은 들여쓰기가 더 깊다
  const removed = namesOnChangedLines(file, 'removed', 2);
  const added = namesOnChangedLines(file, 'added', 2);
  for (const { value, changeType } of diffValues(removed, added)) {
    out.add('packageName', value, file.status === 'deleted' ? 'removed' : changeType, 'pattern');
  }
}

// ─── MCP 도구 이름과 응답 필드 ───────────────────────────────

const RESPONSE_START_RE = /(?:JSON\.stringify\s*\(\s*|structuredContent\s*:\s*)\{/;

interface ScanState {
  depth: number;
}

/** 응답 객체(JSON.stringify({...}), structuredContent: {...})의 최상위 키를 줄마다 뽑는다. */
function responseKeysPerLine(lines: DiffLine[]): Map<DiffLine, string[]> {
  const result = new Map<DiffLine, string[]>();
  const state: ScanState = { depth: 0 };
  for (const l of lines) {
    let text = l.text;
    if (state.depth === 0) {
      const m = RESPONSE_START_RE.exec(text);
      if (!m) continue;
      text = text.slice(m.index + m[0].length - 1);
    }
    const keys: string[] = [];
    let segment = '';
    let quote: string | null = null;
    const flush = () => {
      const k = /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|$)/.exec(segment);
      if (k && !segment.trim().startsWith('...')) keys.push(k[1]!);
      segment = '';
    };
    for (const ch of text) {
      if (quote) {
        if (ch === quote) quote = null;
        if (state.depth === 1) segment += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        if (state.depth === 1) segment += ch;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') {
        state.depth++;
        if (state.depth === 1) segment = '';
        else if (state.depth === 2) segment += ch;
        continue;
      }
      if (ch === '}' || ch === ']' || ch === ')') {
        if (state.depth === 1) flush();
        state.depth = Math.max(0, state.depth - 1);
        if (state.depth === 0) break;
        continue;
      }
      if (state.depth === 1 && ch === ',') {
        flush();
        continue;
      }
      if (state.depth === 1) segment += ch;
    }
    if (state.depth === 1) flush();
    if (keys.length) result.set(l, keys);
  }
  return result;
}

function extractMcp(file: DiffFile, opts: ExtractIdentifiersOptions, out: IdentifierSet) {
  const path = file.newPath ?? file.oldPath;
  if (!path || !CODE_EXT_RE.test(path)) return;

  const content = opts.readFile?.(path);
  const diffText = file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join('\n');
  const fullText = `${content ?? ''}\n${diffText}`;
  const isMcpFile = importsMcpSdk(fullText) || nearestPackageDependsOnSdk(path, opts.readFile);
  if (!isMcpFile) return;

  const registry = isMcpToolRegistry(fullText);
  const changeTypeOfFile = fileChangeType(file);

  const namesOn = (type: 'removed' | 'added') => {
    const names: string[] = [];
    for (const h of file.hunks) {
      h.lines.forEach((l, i) => {
        if (l.type === type) names.push(...toolNamesInLine(l.text, h.lines[i - 1]?.text, registry));
      });
    }
    return names;
  };
  const removedTools = namesOn('removed');
  const addedTools = namesOn('added');

  const keysOn = (type: 'removed' | 'added') => {
    const keys: string[] = [];
    for (const h of file.hunks) {
      const side = h.lines.filter((l) => l.type === 'context' || l.type === type);
      for (const [line, ks] of responseKeysPerLine(side)) if (line.type === type) keys.push(...ks);
    }
    return keys;
  };
  const removedKeys = keysOn('removed');
  const addedKeys = keysOn('added');

  for (const { value, changeType } of diffValues(removedTools, addedTools)) {
    out.add('mcpToolName', value, file.status === 'deleted' ? 'removed' : changeType, 'pattern');
  }
  for (const { value, changeType } of diffValues(removedKeys, addedKeys)) {
    out.add('responseField', value, file.status === 'deleted' ? 'removed' : changeType, 'pattern');
  }

  // 등록부 꼴이 바뀌었는데 패턴으로 이름을 못 잡았다. 파일 경로를 값으로 넘겨 LLM이 읽게 한다
  const touched = [...linesOf(file, 'removed'), ...linesOf(file, 'added')];
  const nothingCaught =
    removedTools.length + addedTools.length + removedKeys.length + addedKeys.length === 0;
  if (nothingCaught && touched.some((l) => TOOLISH_LINE_RE.test(l.text))) {
    out.add('mcpToolName', file.oldPath ?? path, changeTypeOfFile, 'llm');
  }
}

/**
 * diff에서 지워지거나 바뀐 식별자를 뽑는다. 역방향 검색이 이 값으로 관련 레포를 찾는다.
 * 하네스 문서 PR이 아니어도 MCP 도구 정의나 패키지 이름이 바뀌면 그 식별자가 나온다.
 * 패턴으로 도구 이름을 못 잡은 MCP 등록부 변경은 value에 파일 경로를 담고 extractedBy=llm으로 표시한다.
 */
export function extractIdentifiers(
  diff: string,
  opts: ExtractIdentifiersOptions = {},
): Identifier[] {
  const files = parseUnifiedDiff(diff);
  const out = new IdentifierSet();
  for (const f of files) {
    extractPathIds(f, opts, out);
    extractHeadings(f, out);
    extractFrontmatterNames(f, out);
    extractPluginNames(f, out);
    extractPackageNames(f, opts, out);
    extractMcp(f, opts, out);
  }
  extractRuleIds(files, out);
  return out.list();
}

/**
 * git 레포의 두 ref 사이 diff에서 식별자를 뽑는다. base 트리 파일 목록으로 하나뿐인 파일 이름을 판정하고
 * 파일 내용은 head에서 먼저 읽고 없으면 base에서 읽는다.
 */
export function extractIdentifiersFromGit(
  repoRoot: string,
  baseRef: string,
  headRef: string,
): Identifier[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const show = (ref: string, p: string): string | undefined => {
    try {
      return git('show', `${ref}:${p}`);
    } catch {
      return undefined;
    }
  };
  const diff = git('diff', '--no-color', '-M', `${baseRef}..${headRef}`);
  const baseFiles = git('ls-tree', '-r', '--name-only', baseRef).split('\n').filter(Boolean);
  const cache = new Map<string, string | undefined>();
  const readFile: ReadFileFn = (p) => {
    if (!cache.has(p)) cache.set(p, show(headRef, p) ?? show(baseRef, p));
    return cache.get(p);
  };
  return extractIdentifiers(diff, { baseFiles, readFile });
}
