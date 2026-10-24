import { createHash } from 'node:crypto';
import { collectTextFields } from './lint.js';
import { boldPattern, keywordPattern, type Digest } from './schema.js';

export interface ProseItem {
  path: string;
  text: string;
  /** 원문 sha256 앞 12자. apply가 extract 이후 원문이 바뀌었는지 이걸로 본다 */
  hash: string;
}

export type ProseWarningCode =
  | 'UNKNOWN_PATH'
  | 'STALE'
  | 'MARKER_MISMATCH'
  | 'EMPTY'
  | 'DUPLICATE_PATH';

export interface ProseWarning {
  path: string;
  code: ProseWarningCode;
  missing?: string[];
  added?: string[];
}

export interface ProseEdit {
  path: string;
  text: string;
  hash: string;
}

export interface ProseApplyResult {
  digest: Digest;
  applied: number;
  unchanged: number;
  warnings: ProseWarning[];
}

export function proseHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** 제목은 목차와 미니맵에 그대로 쓰이는 이름이라 윤문 대상에서 뺀다 */
const isTitle = (path: string) => path.endsWith('.title');

/** 윤문할 문장. path는 lint가 쓰는 것과 같아서 경고와 짝을 맞춰 볼 수 있다 */
export function extractProse(digest: Digest): ProseItem[] {
  return collectTextFields(digest)
    .filter((f) => !isTitle(f.path) && f.text.trim())
    .map((f) => ({ path: f.path, text: f.text, hash: proseHash(f.text) }));
}

/**
 * 윤문 전후로 그대로 남아야 하는 표식. 키워드는 id만 본다. 표시 글자는 문장에 맞게 바뀌어도 된다.
 * 키워드 마커를 먼저 지워야 id 속 숫자가 수치로 한 번 더 세어지지 않는다.
 */
export function extractMarkers(text: string): string[] {
  const markers: string[] = [];
  let rest = text.replace(keywordPattern(), (_m, id: string, label: string) => {
    markers.push(`키워드:${id}`);
    return ` ${label} `;
  });
  rest = rest.replace(boldPattern(), (_m, inner: string) => {
    markers.push('굵게');
    return ` ${inner} `;
  });
  rest = rest.replace(/https?:\/\/[^\s)]+/g, (m) => {
    markers.push(`링크:${m}`);
    return ' ';
  });
  for (const m of rest.match(/\d(?:[\d,]*\d)?(?:\.\d+)?%?/g) ?? []) markers.push(`수치:${m}`);
  return markers;
}

function countOf(list: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of list) counts.set(m, (counts.get(m) ?? 0) + 1);
  return counts;
}

export function diffMarkers(
  before: string,
  after: string,
): { missing: string[]; added: string[] } | null {
  const a = countOf(extractMarkers(before));
  const b = countOf(extractMarkers(after));
  const missing: string[] = [];
  const added: string[] = [];
  for (const [m, n] of a) for (let k = b.get(m) ?? 0; k < n; k++) missing.push(m);
  for (const [m, n] of b) for (let k = a.get(m) ?? 0; k < n; k++) added.push(m);
  return missing.length || added.length ? { missing, added } : null;
}

/** `reports.0.sections.0.conclusion` 같은 path의 마지막 칸에 값을 넣는다 */
function setAt(root: unknown, path: string, value: string): void {
  const keys = path.split('.');
  let node = root as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
  node[keys[keys.length - 1]!] = value;
}

/**
 * 윤문된 문장을 path로 되돌려 넣는다. 검사에 걸린 항목은 원문을 두고 경고만 남긴다.
 * 넘겨받은 digest는 건드리지 않고 복제본을 고쳐 돌려준다.
 */
export function applyProse(input: Digest, edits: ProseEdit[]): ProseApplyResult {
  const digest = structuredClone(input);
  const current = new Map(extractProse(digest).map((i) => [i.path, i]));
  const pathCounts = countOf(edits.map((e) => e.path));
  const warnings: ProseWarning[] = [];
  const reported = new Set<string>();
  let applied = 0;
  let unchanged = 0;

  for (const edit of edits) {
    const { path } = edit;
    // 같은 path가 둘 이상이면 어느 쪽이 맞는지 모르니 전부 원문을 둔다
    if ((pathCounts.get(path) ?? 0) > 1) {
      if (!reported.has(path)) warnings.push({ path, code: 'DUPLICATE_PATH' });
      reported.add(path);
      continue;
    }
    const item = current.get(path);
    if (!item) {
      warnings.push({ path, code: 'UNKNOWN_PATH' });
      continue;
    }
    if (item.hash !== edit.hash) {
      warnings.push({ path, code: 'STALE' });
      continue;
    }
    if (!edit.text.trim()) {
      warnings.push({ path, code: 'EMPTY' });
      continue;
    }
    const diff = diffMarkers(item.text, edit.text);
    if (diff) {
      warnings.push({ path, code: 'MARKER_MISMATCH', ...diff });
      continue;
    }
    if (edit.text === item.text) {
      unchanged++;
      continue;
    }
    setAt(digest, path, edit.text);
    applied++;
  }

  return { digest, applied, unchanged, warnings };
}
