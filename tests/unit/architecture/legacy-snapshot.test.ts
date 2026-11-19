import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskIrSecrets } from '../../../src/architecture/secret-mask.js';
import { ArchitectureStore } from '../../../src/architecture/store.js';
import { LEGACY_IRS, renderBoth, sha256 } from '../../fixtures/architecture-legacy/render.js';

// 팩 구조로 옮기기 전 렌더러로 뽑은 해시다. 어휘를 팩으로 옮기거나 새 팩과 모양을 더해도 옛 그림은 바이트까지 같아야 한다.
// 이 테스트가 깨지면 해시를 고치기 전에 무엇이 왜 달라졌는지부터 확인한다.
// 마지막 갱신: CSP meta 한 줄, 데이터 블록의 <, >, & 이스케이프, 클라이언트 스크립트의 bidi 표식만 달라진 것을 확인하고 고쳤다
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
