import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGACY_IRS, renderBoth, sha256 } from '../../fixtures/architecture-legacy/render.js';

// 팩 구조로 옮기기 전 렌더러로 뽑은 해시다. 어휘를 팩으로 옮기거나 새 팩과 모양을 더해도 옛 그림은 바이트까지 같아야 한다.
// 이 테스트가 깨지면 해시를 고치기 전에 무엇이 왜 달라졌는지부터 확인한다
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
