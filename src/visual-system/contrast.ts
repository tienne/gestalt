import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  contrastRatio,
  resolveColorTheme,
  type ResolvedTheme,
} from './color.js';

/**
 * 색 역할마다 어느 표면 위에서 몇 대비를 넘어야 하는지. 글자는 4.5:1, 도형과 차트 계열은 3:1(WCAG 1.4.3, 1.4.11).
 * 경계선(border)은 장식용 구분이라 대비 기준을 두지 않고 구분이 필요한 자리는 표면 차이나 라벨로 잡는다.
 */
export interface ContrastRule {
  role: string;
  on: string[];
  min: number;
  kind: 'text' | 'graphic';
}

const STATUS = ['success', 'warning', 'danger', 'info'] as const;
const DIFF = ['added', 'removed', 'changed'] as const;

export const CONTRAST_RULES: ContrastRule[] = [
  { role: 'text', on: ['background', 'surface'], min: 4.5, kind: 'text' },
  { role: 'text-muted', on: ['background', 'surface'], min: 4.5, kind: 'text' },
  { role: 'accent-text', on: ['background', 'surface'], min: 4.5, kind: 'text' },
  { role: 'accent-fill', on: ['background', 'surface'], min: 3, kind: 'graphic' },
  { role: 'on-accent', on: ['accent-fill'], min: 4.5, kind: 'text' },
  { role: 'text', on: ['highlight'], min: 4.5, kind: 'text' },
  ...STATUS.flatMap((s): ContrastRule[] => [
    { role: `${s}-text`, on: ['background', 'surface'], min: 4.5, kind: 'text' },
    { role: `${s}-fill`, on: ['background', 'surface'], min: 3, kind: 'graphic' },
    { role: `on-${s}`, on: [`${s}-fill`], min: 4.5, kind: 'text' },
  ]),
  ...DIFF.flatMap((d): ContrastRule[] => [
    { role: 'text', on: [`diff-${d}-bg`], min: 4.5, kind: 'text' },
    { role: `diff-${d}-text`, on: [`diff-${d}-bg`], min: 3, kind: 'graphic' },
  ]),
  ...[1, 2, 3, 4, 5, 6].map(
    (n): ContrastRule => ({
      role: `series-${n}`,
      on: ['background', 'surface'],
      min: 3,
      kind: 'graphic',
    }),
  ),
];

export interface ContrastCheck {
  role: string;
  on: string;
  min: number;
  ratio: number;
  pass: boolean;
}

export interface ThemeContrastReport {
  id: string;
  tone: ResolvedTheme['tone'];
  checks: ContrastCheck[];
  failures: ContrastCheck[];
  adjusted: number;
}

export function checkThemeContrast(theme: ResolvedTheme): ThemeContrastReport {
  const checks: ContrastCheck[] = [];
  for (const rule of CONTRAST_RULES) {
    const fg = theme.colors[rule.role];
    for (const on of rule.on) {
      const bg = theme.colors[on];
      if (!fg || !bg) {
        checks.push({ role: rule.role, on, min: rule.min, ratio: 0, pass: false });
        continue;
      }
      const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
      checks.push({ role: rule.role, on, min: rule.min, ratio, pass: ratio >= rule.min });
    }
  }
  return {
    id: theme.id,
    tone: theme.tone,
    checks,
    failures: checks.filter((c) => !c.pass),
    adjusted: theme.adjustments.filter((a) => a.seed !== a.value).length,
  };
}

export interface CatalogContrastSummary {
  themes: number;
  checks: number;
  failures: { id: string; role: string; on: string; ratio: number; min: number }[];
  adjustedRoles: number;
}

/** 배경 6개 × 강조색 34개 전체를 해석하고 역할별 대비를 확인한다 */
export function checkAllThemes(): CatalogContrastSummary {
  const failures: CatalogContrastSummary['failures'] = [];
  let checks = 0;
  let adjustedRoles = 0;
  let themes = 0;
  for (const bg of BACKGROUND_PRESETS) {
    for (const ac of ACCENT_PRESETS) {
      const report = checkThemeContrast(resolveColorTheme({ background: bg.id, accent: ac.id }));
      themes++;
      checks += report.checks.length;
      adjustedRoles += report.adjusted;
      for (const f of report.failures)
        failures.push({ id: report.id, role: f.role, on: f.on, ratio: f.ratio, min: f.min });
    }
  }
  return { themes, checks, failures, adjustedRoles };
}
