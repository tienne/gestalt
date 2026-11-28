import { CATALOG, catalogById } from './catalog.js';
import { ACCENT_PRESETS, BACKGROUND_PRESETS, STATUS_CUES } from './color.js';
import { checkAllThemes } from './contrast.js';
import { buildDocsSite } from './docs-site.js';
import { examplesFor } from './examples.js';
import { SCREENS, SURVEY, type ScreenEntry } from './inventory.js';
import { MOTIONS } from './motion.js';

/**
 * 공통 시스템 전수 검사. 제품 전환에 들어가기 전에 이 결과의 problems가 비어 있어야 한다.
 * 문서 사이트 HTML을 실제로 만든 뒤 그 안에서 찾으므로 "정의는 있는데 문서에 안 나온" 항목도 걸린다.
 */

export interface VerifyReport {
  catalog: number;
  examples: number;
  pages: number;
  themes: number;
  contrastChecks: number;
  contrastFailures: number;
  motions: number;
  screens: number;
  problems: string[];
}

// CSS 규칙에도 클래스 이름이 들어 있어서 문자열만 찾으면 배지를 안 그려도 통과한다. 마크업 속성으로 찾는다
export function statusBadgeProblems(html: string): string[] {
  return Object.keys(STATUS_CUES)
    .filter((k) => !html.includes(`class="vs-badge vs-badge-${k}"`))
    .map((k) => `상태 ${k}가 문서에 안 보임`);
}

export function verifyVisualSystem(): VerifyReport {
  const problems: string[] = [];
  const site = buildDocsSite();
  const rendered = new Set(site.renderedIds);
  let exampleCount = 0;

  for (const c of CATALOG) {
    const exs = examplesFor(c.id);
    exampleCount += exs.length;
    if (!exs.length) problems.push(`${c.id}: 예제 없음`);
    for (const e of exs) if (!e.html.trim()) problems.push(`${c.id}: 빈 예제 "${e.title}"`);
    if (!rendered.has(c.id)) problems.push(`${c.id}: 문서 페이지 없음`);
    for (const b of c.basedOn ?? [])
      if (!catalogById(b)) problems.push(`${c.id}: 기반 요소 ${b} 없음`);
    for (const m of c.motions)
      if (!MOTIONS.some((x) => x.id === m)) problems.push(`${c.id}: 모션 ${m} 정의 없음`);
    if (!c.purpose || !c.data.length) problems.push(`${c.id}: 목적이나 데이터 필드 비어 있음`);
  }
  for (const id of ['overview', 'color', 'motion', 'migration'])
    if (!rendered.has(id)) problems.push(`문서 ${id} 페이지 없음`);

  for (const m of MOTIONS) {
    if (!catalogById(m.id)) problems.push(`${m.id}: 카탈로그 항목 없음`);
    if (!m.reduced || !m.end || !m.keep.length)
      problems.push(`${m.id}: 최종 상태, 유지 요소, 모션 줄이기 규칙 중 빈 칸`);
  }

  const contrast = checkAllThemes();
  if (contrast.themes !== BACKGROUND_PRESETS.length * ACCENT_PRESETS.length)
    problems.push(`테마 수 ${contrast.themes}`);
  for (const f of contrast.failures.slice(0, 20))
    problems.push(`대비 실패 ${f.id} ${f.role}/${f.on} ${f.ratio.toFixed(2)} < ${f.min}`);

  problems.push(...statusBadgeProblems(site.html));

  const surveyIds = new Set(SURVEY.map((s) => s.id));
  for (const s of SCREENS) {
    if (!surveyIds.has(s.survey)) problems.push(`${s.id}: 조사 항목 ${s.survey} 없음`);
    // 범위 밖 화면은 지워졌거나 손대지 않는 화면이라 지킬 값이 없다
    if (
      s.status !== 'out-of-scope' &&
      (!s.baseline.preserve.length || !s.baseline.operations.length)
    )
      problems.push(`${s.id}: 보존 값이나 핵심 조작 비어 있음`);
    for (const v of s.visuals)
      if (!catalogById(v)) problems.push(`${s.id}: 시각화 ${v}가 카탈로그에 없음`);
  }
  problems.push(...screenProgressProblems(SCREENS));

  return {
    catalog: CATALOG.length,
    examples: exampleCount,
    pages: site.renderedIds.length,
    themes: contrast.themes,
    contrastChecks: contrast.checks,
    contrastFailures: contrast.failures.length,
    motions: MOTIONS.length,
    screens: SCREENS.length,
    problems,
  };
}

const STARTED = new Set(['in-progress', 'applied', 'verified']);

/**
 * 이행 순서 검사. 앞 단계 화면이 전부 검증된 뒤에만 다음 단계를 연다.
 * 검증 상태는 근거와 호스트 제약 기록이 있어야 하고 화면이 쓰는 모션은 모션 규칙에 있어야 한다.
 */
export function screenProgressProblems(screens: readonly ScreenEntry[]): string[] {
  const problems: string[] = [];
  for (const s of screens) {
    if (s.status === 'verified' && !s.evidence.length)
      problems.push(`${s.id}: 검증 근거 없이 verified`);
    if (s.status === 'verified' && !s.constraints.length)
      problems.push(`${s.id}: 호스트 제약 기록 없이 verified`);
    for (const m of s.motions)
      if (!MOTIONS.some((x) => x.id === m)) problems.push(`${s.id}: 모션 ${m} 정의 없음`);
  }
  for (const s of screens) {
    if (!STARTED.has(s.status)) continue;
    const open = screens.filter(
      (p) => p.phase < s.phase && p.status !== 'verified' && p.status !== 'out-of-scope',
    );
    if (open.length)
      problems.push(
        `${s.id}: ${s.phase}차를 열었는데 앞 단계에 검증 안 된 화면 있음 (${open.map((p) => p.id).join(', ')})`,
      );
  }
  return problems;
}
