import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inferImportPattern } from '../../../src/design/import-pattern.js';

describe('inferImportPattern', () => {
  let dir: string;

  beforeEach(() => {
    dir = join('.gestalt-test', `pat-${randomUUID()}`);
    mkdirSync(join(dir, 'ds', 'recipe', 'src', 'lib', 'components'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function pkg(at: string, name: string): void {
    writeFileSync(join(dir, at, 'package.json'), JSON.stringify({ name }));
  }

  it('ref에서 위로 올라가 가장 가까운 package.json 이름을 쓴다', () => {
    pkg('ds/recipe', '@acme/design');
    const r = inferImportPattern('ds/recipe/src/lib/components', dir);
    expect(r).not.toBeNull();
    expect(r!.pattern.test(`import { Box } from '@acme/design';`)).toBe(true);
    expect(r!.reason).toContain('@acme/design');
  });

  // 한 디자인 시스템이 패키지를 여럿으로 쪼개 배포하는 경우가 흔하다.
  // 찾은 이름만 잡으면 나머지를 쓰는 파일이 시스템 바깥으로 빠진다
  it('하이픈 뒤를 떼어 자매 패키지까지 받는다', () => {
    pkg('ds/recipe', '@acme/plate-recipe');
    const r = inferImportPattern('ds/recipe/src/lib/components', dir);
    expect(r!.pattern.test(`from '@acme/plate-recipe'`)).toBe(true);
    expect(r!.pattern.test(`from '@acme/plate-sauce'`)).toBe(true);
    expect(r!.reason).toContain('넓힘');
  });

  // 스코프만 남으면 남의 패키지까지 걸린다
  it('접두사가 스코프뿐이면 넓히지 않는다', () => {
    pkg('ds/recipe', '@acme/design');
    const r = inferImportPattern('ds/recipe/src/lib/components', dir);
    expect(r!.pattern.test(`from '@acme/analytics'`)).toBe(false);
  });

  it('정규식 특수문자가 든 이름도 그대로 찾는다', () => {
    pkg('ds/recipe', '@acme/ui.core');
    const r = inferImportPattern('ds/recipe/src/lib/components', dir);
    expect(r!.pattern.test(`from '@acme/ui.core'`)).toBe(true);
    expect(r!.pattern.test(`from '@acme/uixcore'`)).toBe(false);
  });

  it('이름 없는 package.json은 건너뛰고 위로 올라간다', () => {
    writeFileSync(join(dir, 'ds', 'recipe', 'package.json'), JSON.stringify({ private: true }));
    pkg('ds', '@acme/design');
    const r = inferImportPattern('ds/recipe/src/lib/components', dir);
    expect(r!.reason).toContain('@acme/design');
  });

  // ref에 package.json이 없으면 위로 올라가다 검사 대상 레포 루트를 집는다.
  // 그 이름으로 패턴을 만들면 자기 소스를 디자인 시스템으로 보게 된다
  it('검사 대상 레포 루트를 넘어 올라가지 않는다', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/the-app' }));
    mkdirSync(join(dir, 'tokens'), { recursive: true });
    expect(inferImportPattern('tokens', dir)).toBeNull();
  });

  it('모노레포 안의 다른 패키지는 루트에 닿기 전에 찾는다', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/the-app' }));
    pkg('ds/recipe', '@acme/design');
    const r = inferImportPattern('ds/recipe/src/lib/components', dir);
    expect(r!.reason).toContain('@acme/design');
  });

  it('경로가 없으면 추론하지 않는다', () => {
    expect(inferImportPattern('nope', dir)).toBeNull();
  });

  it('package.json이 없으면 추론하지 않는다', () => {
    expect(inferImportPattern('ds/recipe/src/lib/components', dir)).toBeNull();
  });
});
