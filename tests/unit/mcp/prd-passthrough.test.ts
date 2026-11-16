import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRD_HTML_MARKER } from '../../../src/digest/prd-store.js';
import { handlePrdPassthrough } from '../../../src/mcp/tools/prd-passthrough.js';
import type { PrdInput } from '../../../src/mcp/schemas.js';
import { sampleView, writeSample } from '../digest/prd-fixture.js';

type Json = Record<string, any>;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function repo(): string {
  const d = resolve('.gestalt-test', `prd-pass-${randomUUID()}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
const call = (root: string, input: Omit<PrdInput, 'repoRoot'>) =>
  handlePrdPassthrough({ ...input, repoRoot: root } as PrdInput, root) as Json;

describe('ges_prd', () => {
  it('guide 예시는 예시 원문으로 validate를 통과한다', () => {
    const root = repo();
    const guide = call(root, { action: 'guide' });
    expect(guide.blocks.map((b: Json) => b.kind)).toContain('requirement');
    const { source, view } = guide.example;
    expect(JSON.stringify(view)).not.toContain('"audience"');
    mkdirSync(join(root, 'docs', 'reading-club'), { recursive: true });
    writeFileSync(join(root, view.meta.source), source);
    const viewPath = join(root, 'example.json');
    writeFileSync(viewPath, JSON.stringify(view));
    const r = call(root, { action: 'validate', viewPath });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.coverage.uncoveredLines).toBe(0);
  });

  it('source는 범위와 nextFrom, 추천 slug를 준다', () => {
    const root = repo();
    writeSample(root);
    const r = call(root, { action: 'source', sourcePath: 'docs/rental/PRD.md', from: 12, to: 15 });
    expect(r).toMatchObject({ ok: true, totalLines: 42, from: 12, to: 15, nextFrom: null });
    expect(r.text.split('\n')[0]).toBe('12: ## 문제');
    expect(r.suggestedSlug).toMatch(/^rental-[0-9a-f]{6}$/);
    expect(
      call(root, { action: 'source', sourcePath: 'docs/rental/PRD.md', from: 99 }).errors[0].code,
    ).toBe('RANGE_OUT_OF_BOUNDS');
    expect(call(root, { action: 'source' }).errors[0].code).toBe('SOURCE_REQUIRED');
  });

  it('validate는 slug 저장본과 meta.source로 검사한다', () => {
    const root = repo();
    writeSample(root);
    const r = call(root, { action: 'validate', slug: 'rental-reco' });
    expect(r).toMatchObject({ ok: true, slug: 'rental-reco', errors: [], warnings: [] });
    expect(r.coverage.contentLines).toBe(13);
    expect(r.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('잘못된 slug와 없는 뷰, 깨진 JSON, 스키마 오류를 코드로 돌려준다', () => {
    const root = repo();
    expect(call(root, { action: 'validate', slug: '../x' }).errors[0].code).toBe('INVALID_SLUG');
    expect(call(root, { action: 'validate', slug: 'none' }).errors[0].code).toBe('VIEW_NOT_FOUND');
    const { viewPath } = writeSample(root);
    writeFileSync(viewPath, '{');
    expect(call(root, { action: 'validate', slug: 'rental-reco' }).errors[0].code).toBe(
      'VIEW_NOT_JSON',
    );
    writeFileSync(viewPath, JSON.stringify({ ...sampleView(), sections: [] }));
    expect(call(root, { action: 'validate', slug: 'rental-reco' }).errors[0].code).toBe(
      'INVALID_PRD_VIEW',
    );
    writeSample(root);
    expect(
      call(root, { action: 'validate', slug: 'rental-reco', viewPath, sourcePath: 'none.md' })
        .errors[0].code,
    ).toBe('SOURCE_NOT_FOUND');
  });

  it('render는 기본 위치에 index.html을 쓴다', () => {
    const root = repo();
    writeSample(root);
    const r = call(root, { action: 'render', slug: 'rental-reco' });
    expect(r.ok).toBe(true);
    expect(r.htmlPath).toBe(join(root, '.gestalt', 'prd-view', 'rental-reco', 'index.html'));
    expect(readFileSync(r.htmlPath, 'utf8').startsWith(PRD_HTML_MARKER)).toBe(true);
    // 두 번째 렌더도 막히지 않는다
    expect(call(root, { action: 'render', slug: 'rental-reco' }).ok).toBe(true);
  });

  it('validate와 render 응답에 lint 경고와 따로 gaps를 싣는다', () => {
    const root = repo();
    writeSample(root);
    const v = call(root, { action: 'validate', slug: 'rental-reco' });
    expect(v.gaps.map((g: Json) => g.code)).toEqual([
      'BASELINE_NO_NUMBER',
      'ACCEPTANCE_MISSING',
      'ACCEPTANCE_MISSING',
      'SLOTS_INCOMPLETE',
      'SLOTS_INCOMPLETE',
      'REQUIREMENT_UNLINKED',
      'OPEN_CLAIMS',
    ]);
    expect(v.prose.every((g: Json) => g.severity === 'info')).toBe(true);
    expect(v.gaps.every((g: Json) => g.question.endsWith('요?'))).toBe(true);
    expect(v.warnings.map((w: Json) => w.code)).not.toContain('BASELINE_NO_NUMBER');
    const r = call(root, { action: 'render', slug: 'rental-reco' });
    expect(r.gaps).toEqual(v.gaps);
    expect(readFileSync(r.htmlPath, 'utf8')).toContain('id="gaps"');
  });

  it('lint 오류가 있으면 RENDER_BLOCKED이고 파일을 만들지 않는다', () => {
    const root = repo();
    const v = sampleView() as Json;
    v.sections[1].blocks[0].metrics = ['M9'];
    writeSample(root, v);
    const r = call(root, { action: 'render', slug: 'rental-reco', outDir: 'out' });
    expect(r.errors[0].code).toBe('RENDER_BLOCKED');
    expect(r.lintErrors[0].code).toBe('UNKNOWN_METRIC');
    expect(existsSync(join(root, '.gestalt', 'prd-view', 'rental-reco', 'index.html'))).toBe(false);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('outDir은 repoRoot 기준으로 풀고 남의 index.html은 지킨다', () => {
    const root = repo();
    writeSample(root);
    const r = call(root, { action: 'render', slug: 'rental-reco', outDir: 'site' });
    expect(r.htmlPath).toBe(join(root, 'site', 'index.html'));
    expect(r.jsonPath).toBe(join(root, '.gestalt', 'prd-view', 'rental-reco', 'prd-view.json'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', 'index.html'), '<html>앱</html>');
    expect(
      call(root, { action: 'render', slug: 'rental-reco', outDir: 'app' }).errors[0].code,
    ).toBe('OUT_FILE_EXISTS');
    expect(
      call(root, { action: 'render', slug: 'rental-reco', outDir: 'app', overwrite: true }).ok,
    ).toBe(true);
  });

  it('viewPath로 받은 뷰는 render 때 저장소로 옮겨 둔다', () => {
    const root = repo();
    writeSample(root);
    rmSync(join(root, '.gestalt'), { recursive: true });
    const viewPath = join(root, 'draft.json');
    writeFileSync(viewPath, JSON.stringify(sampleView()));
    const r = call(root, { action: 'render', viewPath });
    expect(r.ok).toBe(true);
    expect(existsSync(r.jsonPath)).toBe(true);
    expect(call(root, { action: 'validate', slug: 'rental-reco' }).ok).toBe(true);
    expect(call(root, { action: 'validate', slug: 'other', viewPath }).errors[0].code).toBe(
      'SLUG_MISMATCH',
    );
  });
});
