/**
 * 디자인 시스템에 이미 있는 것을 다시 만든 자리를 찾는다.
 *
 * 타입도 린트도 이걸 못 잡는다. 문법이 멀쩡하기 때문이다. 그래서 사람이 리뷰에서
 * 알아채지 못하면 그대로 남는다. 같은 컴포넌트가 팀 수만큼 생긴다.
 *
 * 이름만으로 판정하면 오탐이 난다 — 같은 이름이어도 디자인 시스템 것을 감싸 쓰는
 * 래퍼는 중복이 아니다. 그래서 이름이 겹치는 것 중 **시스템을 안 쓰는 것**만 센다.
 */
import { componentNameOf, nameSet, normalizeName } from './tokens.js';

export interface DuplicateHit {
  /** 소비 레포가 만든 파일 */
  filePath: string;
  /** 그 파일의 컴포넌트 이름 */
  name: string;
  /** 같은 이름으로 디자인 시스템이 제공하는 것 */
  provided: string;
  /** 같은 이름의 사본이 레포 안에 몇 개인지. 2 이상이면 팀별로 하나씩 만든 꼴이다 */
  siblings: number;
}

export interface DuplicateInput {
  filePath: string;
  /** 이 파일이 디자인 시스템을 쓰는가. 쓰면 래퍼일 수 있어 중복으로 안 센다 */
  usesDesignSystem: boolean;
}

/**
 * 제공 목록과 소비 레포 파일을 대조한다.
 *
 * `provided`는 디자인 시스템이 주는 컴포넌트 이름이고 `files`는 소비 레포가 만든 것이다.
 * 둘 다 정규화해서 비교한다 — 한쪽은 `bottom-sheet`, 다른 쪽은 `BottomSheet.tsx`다.
 */
export function findDuplicates(
  provided: readonly string[],
  files: readonly DuplicateInput[],
): DuplicateHit[] {
  const providedSet = nameSet(provided);
  const providedBy = new Map<string, string>();
  for (const p of provided) providedBy.set(normalizeName(p), p);

  const candidates: { filePath: string; name: string; key: string }[] = [];
  for (const f of files) {
    // 시스템을 쓰는 파일은 래퍼일 수 있다. 래퍼는 토큰과 동작을 그대로 물려받으므로
    // 중복이 아니라 조합이다
    if (f.usesDesignSystem) continue;
    const name = componentNameOf(f.filePath);
    if (!name) continue;
    const key = normalizeName(name);
    if (!providedSet.has(key)) continue;
    candidates.push({ filePath: f.filePath, name, key });
  }

  const countByKey = new Map<string, number>();
  for (const c of candidates) countByKey.set(c.key, (countByKey.get(c.key) ?? 0) + 1);

  return candidates
    .map((c) => ({
      filePath: c.filePath,
      name: c.name,
      provided: providedBy.get(c.key) ?? c.name,
      siblings: countByKey.get(c.key) ?? 1,
    }))
    .sort((a, b) => b.siblings - a.siblings || a.filePath.localeCompare(b.filePath));
}
