// src/visual-system/color.ts의 STATUS_PALETTES를 옮겨 둔 값이다. 플러그인은 레포 코드를 못 불러와서
// 복사해 두고 레포 테스트(orca-plugin-protocol)가 두 표를 비교한다.
export const STATUS_COLORS = {
  success: { dark: '#79C98F', light: '#21643A' },
  warning: { dark: '#F1C06B', light: '#795100' },
  danger: { dark: '#FF8295', light: '#A52244' },
  info: { dark: '#8DB6F5', light: '#254D96' },
} as const

export type StatusColor = keyof typeof STATUS_COLORS

/** 상태색 변수 선언문. prefix 뒤에 success, warning, danger, info를 붙인다 */
export function statusVars(prefix: string, mode: 'dark' | 'light'): string {
  return (Object.keys(STATUS_COLORS) as StatusColor[]).map((k) => `${prefix}${k}: ${STATUS_COLORS[k][mode]};`).join(' ')
}
