import { describe, expect, it } from 'vitest';
import { ownersOf, parseCodeowners } from '../../../src/architecture/codeowners.js';

const RULES = parseCodeowners(`
# 기본 담당
*                       @acme/maintainers
docs/                   @acme/writers
/apps/web/              @acme/web   # 웹 앱
apps/web/legacy/
*.sql                   @acme/data
/config/*               @acme/ops
/packages/**/test       @acme/qa
`);

describe('CODEOWNERS', () => {
  it('뒤에 나온 규칙이 이기고 기본 담당은 따로 표시한다', () => {
    expect(ownersOf(RULES, 'README.md')).toEqual({ owners: ['@acme/maintainers'], catchAll: true });
    expect(ownersOf(RULES, 'apps/web/src/main.tsx')).toEqual({
      owners: ['@acme/web'],
      catchAll: false,
    });
    expect(ownersOf(RULES, 'docs/guide/intro.md')?.owners).toEqual(['@acme/writers']);
  });

  it('담당이 빈 규칙은 담당을 지운다', () => {
    expect(ownersOf(RULES, 'apps/web/legacy/old.ts')).toBeUndefined();
  });

  it('슬래시 없는 패턴은 어느 깊이에서나, 끝이 *인 고정 패턴은 바로 아래만 덮는다', () => {
    expect(ownersOf(RULES, 'apps/web/db/schema.sql')?.owners).toEqual(['@acme/data']);
    expect(ownersOf(RULES, 'config/app.yml')?.owners).toEqual(['@acme/ops']);
    expect(ownersOf(RULES, 'config/env/prod.yml')?.owners).toEqual(['@acme/maintainers']);
    expect(ownersOf(RULES, 'packages/a/b/test/x.ts')?.owners).toEqual(['@acme/qa']);
  });
});
