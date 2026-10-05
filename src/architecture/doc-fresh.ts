import { execFileSync } from 'node:child_process';

/** 마지막 손댄 날이 이보다 오래되면 오래된 문서로 본다 */
export const DEFAULT_AGED_DAYS = 180;
/** 머리줄 수정일이 커밋보다 이만큼 뒤처지면 머리줄을 안 고치고 내용만 바꾼 문서로 본다 */
const HEADER_BEHIND_DAYS = 30;
const DAY_MS = 86_400_000;

interface Dated {
  repoId: string;
  path: string;
  updatedAt?: string;
  committedAt?: string;
}

export interface FreshnessSummary {
  dated: number;
  undated: number;
  agedDays: number;
  aged: number;
  /** 머리줄 수정일이 마지막 커밋보다 한참 앞선 문서 수 */
  headerBehind: number;
  /** 마지막 손댄 달별 문서 수. 키는 `YYYY-MM` */
  byMonth: Record<string, number>;
  /** 오래된 순 앞쪽 몇 개. `<repoId>/<path>` */
  oldest: { doc: string; date: string }[];
}

/** 레포 안 파일마다 마지막 커밋 날짜(`YYYY-MM-DD`). 키는 root 기준 경로다. git 레포가 아니면 비운다 */
export function docCommitDates(root: string): Map<string, string> {
  const out = new Map<string, string>();
  let log: string;
  try {
    log = execFileSync(
      'git',
      [
        '-C',
        root,
        // 끄지 않으면 한글 파일 이름이 8진수 이스케이프로 나와 스캔 경로와 안 맞는다
        '-c',
        'core.quotepath=off',
        'log',
        // 이름 바꾸기 감지가 내용을 비교하느라 blob 없이 받은 레포에서는 blob을 하나씩 받아와 분 단위로 늘어진다
        '--no-renames',
        '--format=%x00%cs',
        '--name-only',
        '--relative',
        '--',
        '*.md',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 },
    );
  } catch {
    return out;
  }
  // 최신 커밋부터 나오므로 처음 본 날짜가 마지막 커밋이다
  let date = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('\0')) date = line.slice(1);
    else if (line !== '' && !out.has(line)) out.set(line, date);
  }
  return out;
}

/** 머리줄 수정일과 커밋 날짜 중 늦은 쪽. 형식만 고친 커밋이 있어도 오래됐다고 잘못 몰지 않으려고 늦은 쪽을 본다 */
export function lastTouched(d: Dated): string | undefined {
  if (d.updatedAt === undefined) return d.committedAt;
  if (d.committedAt === undefined) return d.updatedAt;
  return d.updatedAt > d.committedAt ? d.updatedAt : d.committedAt;
}

export function isAged(d: Dated, now: string, days = DEFAULT_AGED_DAYS): boolean {
  const last = lastTouched(d);
  if (last === undefined) return false;
  return Date.parse(now) - Date.parse(last) > days * DAY_MS;
}

export function summarizeFreshness(
  docs: readonly Dated[],
  now: string,
  days = DEFAULT_AGED_DAYS,
): FreshnessSummary {
  const byMonth: Record<string, number> = {};
  const dated: { doc: string; date: string }[] = [];
  let aged = 0;
  let headerBehind = 0;
  for (const d of docs) {
    const last = lastTouched(d);
    if (last === undefined) continue;
    dated.push({ doc: `${d.repoId}/${d.path}`, date: last });
    byMonth[last.slice(0, 7)] = (byMonth[last.slice(0, 7)] ?? 0) + 1;
    if (isAged(d, now, days)) aged++;
    if (
      d.updatedAt !== undefined &&
      d.committedAt !== undefined &&
      Date.parse(d.committedAt) - Date.parse(d.updatedAt) > HEADER_BEHIND_DAYS * DAY_MS
    )
      headerBehind++;
  }
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.doc < b.doc ? -1 : 1));
  return {
    dated: dated.length,
    undated: docs.length - dated.length,
    agedDays: days,
    aged,
    headerBehind,
    byMonth: Object.fromEntries(Object.entries(byMonth).sort(([a], [b]) => (a < b ? -1 : 1))),
    oldest: dated.slice(0, 10),
  };
}
