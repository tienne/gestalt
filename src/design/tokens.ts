/**
 * 디자인 시스템이 제공하는 것의 목록.
 *
 * 게슈탈트가 이 값을 소유하지 않는다. 디자인 시스템 쪽이 원본이고 여기는 읽어온 것을
 * 담기만 한다 — 베껴 두면 토큰이 늘거나 빠질 때 갈라진다. 어디서 읽어올지는
 * `gestalt.json`의 `ruleSources`가 정한다 (plugin/skills/_shared/rule-sources.md).
 */

/** 디자인 시스템에서 읽어온 목록. 못 읽었으면 `null`이지 빈 배열이 아니다 */
export interface DesignInventory {
  /**
   * 제공 컴포넌트 이름. 비교는 정규화해서 하므로 원본 표기 그대로 담는다
   * (`bottom-sheet`, `BottomSheet` 둘 다 받는다)
   */
  components: string[];
  /** 간격과 모서리 토큰 이름 (`md`, `xs2`, `full` 등) */
  scaleTokens: string[];
  /** 시맨틱 색상 토큰 이름 (`bgBrandNormal` 등) */
  colorTokens: string[];
  /** 어디서 읽었는지. 보고에 그대로 싣는다 */
  source: string;
}

/**
 * 이름을 비교 가능한 꼴로 만든다.
 *
 * 디자인 시스템은 디렉토리를 케밥으로 쓰고(`bottom-sheet`) 소비 레포는 파일을
 * 파스칼로 쓴다(`BottomSheet.tsx`). 둘이 같은 것을 가리키는데 문자열로는 안 맞는다.
 */
export function normalizeName(name: string): string {
  return name.replace(/[-_\s]/g, '').toLowerCase();
}

/** 컴포넌트 목록을 정규화한 집합으로. 대조는 전부 이걸 거친다 */
export function nameSet(names: readonly string[]): Set<string> {
  return new Set(names.map(normalizeName));
}

/**
 * 파일명에서 컴포넌트 이름을 뽑는다. 컴포넌트가 아닌 파일이면 `null`.
 *
 * `index`와 테스트, 스토리 파일은 컴포넌트 이름이 아니다. `index.tsx`를 세면 레포마다
 * 수백 개가 같은 이름으로 겹쳐 대조가 무의미해진다.
 */
export function componentNameOf(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? '';
  const stem = base.replace(/\.(tsx|jsx|ts|js)$/, '');
  if (!stem || stem === 'index') return null;
  if (/\.(test|spec|stories|e2e)$/.test(stem)) return null;
  // 컴포넌트는 대문자로 시작한다. 훅이나 유틸 파일까지 세면 대조가 흐려진다
  if (!/^[A-Z]/.test(stem)) return null;
  return stem;
}
