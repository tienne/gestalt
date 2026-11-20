import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskIrSecrets } from '../../../src/architecture/secret-mask.js';
import { ArchitectureStore } from '../../../src/architecture/store.js';
import { findUnknownFields } from '../../../src/architecture/ir-schema.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';
import { architectureInputSchema } from '../../../src/mcp/schemas.js';
import { LEGACY_IRS, renderBoth, sha256 } from '../../fixtures/architecture-legacy/render.js';

// 팩 구조로 옮기기 전 렌더러로 뽑은 해시다. 어휘를 팩으로 옮기거나 새 팩과 모양을 더해도 옛 그림은 바이트까지 같아야 한다.
// 이 테스트가 깨지면 해시를 고치기 전에 무엇이 왜 달라졌는지부터 확인한다.
// 마지막 갱신: PR8 무채색 테마. 다섯 그림 모두 <style> 내용과 그에 따른 CSP 스타일 해시만 달라졌고 마크업과 스크립트는 바이트까지 같은 것을 확인하고 고쳤다
const EXPECTED = JSON.parse(
  readFileSync(
    new URL('../../fixtures/architecture-legacy/html-hashes.json', import.meta.url),
    'utf8',
  ),
) as Record<string, { private: string; shared: string }>;

describe('팩 이전 전 그림의 바이트 동일', () => {
  for (const [name, build] of Object.entries(LEGACY_IRS)) {
    it(`${name} 그림의 private과 shared HTML이 기준 해시와 같다`, async () => {
      const html = await renderBoth(build());
      expect({ private: sha256(html.private), shared: sha256(html.shared) }).toEqual(
        EXPECTED[name],
      );
    });
  }

  it('기준 해시가 다섯 그림 전부에 있다', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(LEGACY_IRS).sort());
  });
});

describe('비밀값 가림 이전에 저장된 IR', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  for (const [name, build] of Object.entries(LEGACY_IRS)) {
    it(`${name} IR은 그대로 읽히고 가릴 게 없으며 그려진다`, async () => {
      const ir = build();
      const root = resolve('.gestalt-test', `legacy-ir-${randomUUID()}`);
      roots.push(root);
      // 새 칸 없이 예전 꼴 그대로 디스크에 둔다. save를 거치면 가림이 먼저 돌아 예전 파일이 아니게 된다
      mkdirSync(join(root, '.gestalt', 'architecture'), { recursive: true });
      writeFileSync(
        join(root, '.gestalt', 'architecture', `${ir.view}.json`),
        JSON.stringify(ir, null, 2),
      );
      const loaded = new ArchitectureStore(root).load(ir.view);
      expect(loaded).not.toBeNull();

      const masked = maskIrSecrets(loaded!);
      expect(masked.hits).toEqual([]);
      expect(masked.ir).toEqual(loaded);

      const html = await renderBoth(masked.ir);
      expect(html.private).toContain('<meta http-equiv="Content-Security-Policy"');
      expect(html.shared).toContain("connect-src 'none'");
    });
  }
});

describe('커밋 해시 이전에 저장된 IR', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const call = async (repoRoot: string, args: Record<string, unknown>) =>
    (await handleArchitecturePassthrough(
      architectureInputSchema.parse({ repoRoot, ...args }),
      process.cwd(),
      {
        // gh를 부르지 않는다
        resolveVisibility: () => ({ verdict: 'private', source: 'gh', visibility: 'PRIVATE' }),
      },
    )) as Record<string, unknown>;

  for (const [name, build] of Object.entries(LEGACY_IRS)) {
    it(`${name} IR은 strict 입력을 통과하고 status는 unknown, render까지 된다`, async () => {
      const ir = build();
      expect(ir.repos.every((r) => r.head === undefined)).toBe(true);
      expect(findUnknownFields(ir)).toEqual([]);

      const root = resolve('.gestalt-test', `legacy-head-${randomUUID()}`);
      roots.push(root);
      mkdirSync(join(root, '.gestalt', 'architecture'), { recursive: true });
      writeFileSync(
        join(root, '.gestalt', 'architecture', `${ir.view}.json`),
        JSON.stringify(ir, null, 2),
      );

      const status = await call(root, { action: 'status' });
      const view = (status['views'] as Record<string, { freshness: unknown } | null>)[ir.view];
      expect(view!.freshness).toMatchObject({
        status: 'unknown',
        staleEvidenceFiles: [],
        repos: ir.repos.map((r) => ({ repo: r.id, status: 'unknown', reason: 'no_head' })),
      });

      // 근거 파일은 픽스처에 없으므로 파일 대조만 끈다
      const validated = await call(root, { action: 'validate', ir, checkFiles: false });
      expect(validated['errors']).toEqual([]);
      const rendered = await call(root, { action: 'render', ir, checkFiles: false });
      expect(rendered['ok']).toBe(true);
    });
  }
});
