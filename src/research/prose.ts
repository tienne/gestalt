import { createHash } from 'node:crypto';
import type { Research } from './schema.js';

/** wowPain 불릿은 해요체, 나머지 섹션 본문은 평서체로 쓴다 */
export type ProseRegister = 'chat' | 'report';

export interface ProseItem {
  path: string;
  register: ProseRegister;
  text: string;
  /** 원문 sha256 앞 12자. apply가 extract 이후 원문이 바뀌었는지 이걸로 본다 */
  hash: string;
}

export interface ProseEntry extends ProseItem {
  set(text: string): void;
}

export interface ProseCounts {
  chat: number;
  report: number;
  /** 길이가 짧은 비교표 칸이나 회사 발언이라 뺀 개수 */
  skipped: number;
}

export interface ProseExtract {
  items: ProseItem[];
  counts: ProseCounts;
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
  research: Research;
  applied: number;
  unchanged: number;
  warnings: ProseWarning[];
}

/** 이보다 짧은 비교표 칸은 "있음", "없음" 같은 단답이라 다듬을 게 없다 */
export const MIN_CELL_PROSE_LENGTH = 12;

export function proseHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

const BULLET_KEYS = ['userWow', 'userPain', 'bizWow', 'bizPain'] as const;

/**
 * 윤문 대상 필드만 setter와 함께 모은다. path는 안정적이라 apply가 같은 path로 찾아 넣는다.
 * 회사 발언은 인용이라 고치면 안 되므로 어느 섹션에서든 뺀다.
 */
function walkProse(r: Research): { entries: ProseEntry[]; skipped: number } {
  const entries: ProseEntry[] = [];
  let skipped = 0;
  const add = (
    path: string,
    register: ProseRegister,
    text: string | undefined,
    set: (text: string) => void,
  ): void => {
    if (text === undefined || !text.trim()) return;
    entries.push({ path, register, text, hash: proseHash(text), set });
  };

  r.references.forEach((ref, i) => {
    add(`references[${i}].reason`, 'report', ref.reason, (t) => (ref.reason = t));
  });

  r.comparison.forEach((row, i) => {
    row.cells.forEach((cell, j) => {
      if (!cell.text.trim()) return;
      if (
        cell.basis === 'company-statement' ||
        Array.from(cell.text.trim()).length < MIN_CELL_PROSE_LENGTH
      ) {
        skipped++;
        return;
      }
      add(`comparison[${i}].cells[${j}].text`, 'report', cell.text, (t) => (cell.text = t));
    });
  });

  r.wowPain.items.forEach((item, i) => {
    for (const key of BULLET_KEYS) {
      const list = item[key];
      list.forEach((text, j) => {
        add(`wowPain.items[${i}].${key}[${j}]`, 'chat', text, (t) => (list[j] = t));
      });
    }
  });
  r.wowPain.findings.forEach((f, i) => {
    if (f.basis === 'company-statement') {
      skipped++;
      return;
    }
    add(`wowPain.findings[${i}].text`, 'chat', f.text, (t) => (f.text = t));
  });

  r.reasons.forEach((reason, i) => {
    add(`reasons[${i}].business`, 'report', reason.business, (t) => (reason.business = t));
    add(`reasons[${i}].screens`, 'report', reason.screens, (t) => (reason.screens = t));
    add(`reasons[${i}].difference`, 'report', reason.difference, (t) => (reason.difference = t));
    reason.take.forEach((text, j) => {
      add(`reasons[${i}].take[${j}]`, 'report', text, (t) => (reason.take[j] = t));
    });
    reason.skip.forEach((text, j) => {
      add(`reasons[${i}].skip[${j}]`, 'report', text, (t) => (reason.skip[j] = t));
    });
  });

  r.judgment.forEach((j, i) => {
    add(`judgment[${i}].conclusion`, 'report', j.conclusion, (t) => (j.conclusion = t));
    add(`judgment[${i}].rationale`, 'report', j.rationale, (t) => (j.rationale = t));
    add(`judgment[${i}].holdUntil`, 'report', j.holdUntil, (t) => (j.holdUntil = t));
    add(`judgment[${i}].todo`, 'report', j.todo, (t) => (j.todo = t));
  });

  r.verification.forEach((v, i) => {
    add(`verification[${i}].hypothesis`, 'report', v.hypothesis, (t) => (v.hypothesis = t));
    add(`verification[${i}].caveat`, 'report', v.caveat, (t) => (v.caveat = t));
  });

  const oq = r.openQuestions;
  if (oq) {
    add('openQuestions.intro', 'report', oq.intro, (t) => (oq.intro = t));
    oq.items.forEach((q, i) => {
      add(`openQuestions.items[${i}].question`, 'report', q.question, (t) => (q.question = t));
      add(`openQuestions.items[${i}].temporary`, 'report', q.temporary, (t) => (q.temporary = t));
      add(`openQuestions.items[${i}].affects`, 'report', q.affects, (t) => (q.affects = t));
    });
  }

  r.video?.findings.forEach((f, i) => {
    if (f.evidence === 'company-statement') {
      skipped++;
      return;
    }
    add(`video.findings[${i}].text`, 'report', f.text, (t) => (f.text = t));
  });

  return { entries, skipped };
}

/** setter가 넘겨받은 객체를 직접 고친다. 원본을 지키려면 복제본을 넘긴다 */
export function collectProse(r: Research): ProseEntry[] {
  return walkProse(r).entries;
}

export function extractProse(r: Research): ProseExtract {
  const { entries, skipped } = walkProse(r);
  const items = entries.map(({ path, register, text, hash }) => ({ path, register, text, hash }));
  return {
    items,
    counts: {
      chat: items.filter((i) => i.register === 'chat').length,
      report: items.filter((i) => i.register === 'report').length,
      skipped,
    },
  };
}

type MarkerKind = '링크' | '태그' | '출처' | '위치' | '기호' | '수치';

/**
 * 앞 단계가 잡은 구간은 지우고 다음 단계로 넘긴다. 출처 괄호 속 날짜나 URL 속 숫자가
 * 수치로 한 번 더 세어지지 않게 하려는 순서다.
 */
const MARKER_PATTERNS: ReadonlyArray<readonly [MarkerKind, RegExp]> = [
  ['링크', /https?:\/\/[^\s)）]+/g],
  ['태그', /\(해석\)/g],
  ['출처', /\([^()]*\d{4}-\d{2}(?:-\d{2})?[^()]*\)/g],
  ['위치', /\((?:프레임|영상|화면)\s*[\d.]+[^()]*\)/g],
  ['기호', /[◎○△]/g],
  // 끝자리를 숫자로 묶어서 "3, 4"의 쉼표가 숫자에 붙지 않게 한다
  ['수치', /\d(?:[\d,]*\d)?(?:\.\d+)?(?:%p|pp|%)?/g],
];

/** 윤문 전후로 그대로 남아야 하는 표식. 값은 `종류:원문` 꼴이다 */
export function extractMarkers(text: string): string[] {
  const markers: string[] = [];
  let rest = text;
  for (const [kind, pattern] of MARKER_PATTERNS) {
    rest = rest.replace(pattern, (m) => {
      markers.push(`${kind}:${m}`);
      return ' ';
    });
  }
  return markers;
}

function countOf(list: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of list) counts.set(m, (counts.get(m) ?? 0) + 1);
  return counts;
}

/** 위치는 보지 않고 종류별 개수만 맞춘다. 같으면 null */
export function diffMarkers(
  before: string,
  after: string,
): { missing: string[]; added: string[] } | null {
  const a = countOf(extractMarkers(before));
  const b = countOf(extractMarkers(after));
  const missing: string[] = [];
  const added: string[] = [];
  for (const [m, n] of a) {
    for (let k = b.get(m) ?? 0; k < n; k++) missing.push(m);
  }
  for (const [m, n] of b) {
    for (let k = a.get(m) ?? 0; k < n; k++) added.push(m);
  }
  return missing.length || added.length ? { missing, added } : null;
}

/**
 * 윤문된 문장을 path로 되돌려 넣는다. 검사에 걸린 항목은 원문을 두고 경고만 남긴다.
 * 넘겨받은 research는 건드리지 않고 복제본을 고쳐 돌려준다.
 */
export function applyProse(r: Research, edits: ProseEdit[]): ProseApplyResult {
  const research = structuredClone(r);
  const entries = new Map(collectProse(research).map((e) => [e.path, e]));
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
    const entry = entries.get(path);
    if (!entry) {
      warnings.push({ path, code: 'UNKNOWN_PATH' });
      continue;
    }
    if (entry.hash !== edit.hash) {
      warnings.push({ path, code: 'STALE' });
      continue;
    }
    if (!edit.text.trim()) {
      warnings.push({ path, code: 'EMPTY' });
      continue;
    }
    const diff = diffMarkers(entry.text, edit.text);
    if (diff) {
      warnings.push({ path, code: 'MARKER_MISMATCH', ...diff });
      continue;
    }
    if (edit.text === entry.text) {
      unchanged++;
      continue;
    }
    entry.set(edit.text);
    applied++;
  }

  return { research, applied, unchanged, warnings };
}
