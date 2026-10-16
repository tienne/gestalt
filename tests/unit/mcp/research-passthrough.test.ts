import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { researchInputSchema } from '../../../src/mcp/schemas.js';
import { handleResearchPassthrough } from '../../../src/mcp/tools/research-passthrough.js';

const BUILTIN = resolve('plugin/research-sources');
const tmpDirs: string[] = [];

function tmpHome(): string {
  const dir = resolve('.gestalt-test', `research-mcp-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(params: Record<string, unknown>, gestaltHome: string, env = {}) {
  const input = researchInputSchema.parse(params);
  return (await handleResearchPassthrough(input, process.cwd(), {
    builtinDir: BUILTIN,
    gestaltHome,
    env,
  })) as Record<string, any>;
}

describe('ges_research action=sources', () => {
  it('연결 정보를 받아 상태와 근거 한계를 돌려준다', async () => {
    const r = await run(
      { action: 'sources', available: { browserLogins: ['uibowl.io'] } },
      tmpHome(),
    );
    expect(r.ok).toBe(true);
    const uibowl = r.sources.find((s: { name: string }) => s.name === 'uibowl');
    expect(uibowl.status).toBe('fallback');
    expect(r.evidenceLimits.some((l: string) => l.includes('MCP(uibowl) 미연결'))).toBe(true);
  });

  it('개인 디렉토리의 출처를 읽고 같은 이름은 덮어쓴다', async () => {
    const home = tmpHome();
    mkdirSync(join(home, 'research-sources', 'web-search'), { recursive: true });
    writeFileSync(
      join(home, 'research-sources', 'web-search', 'SOURCE.md'),
      `---\nname: web-search\ndescription: 내 검색\nstage: [evidence]\naccess:\n  - http: { host: example.com }\n---\n\n## 찾는 법\n1. 본다\n\n## 멈추는 곳\n결제 화면\n`,
    );
    const r = await run({ action: 'sources' }, home);
    const row = r.sources.find((s: { name: string }) => s.name === 'web-search');
    expect(row.origin).toBe('personal');
    expect(row.overridden).toBe(true);
  });

  it('name을 주면 본문을 함께 돌려주고 없는 이름은 실패한다', async () => {
    const home = tmpHome();
    const ok = await run({ action: 'sources', name: 'app-store-search' }, home);
    expect(ok.detail.body).toContain('## 찾는 법');
    const missing = await run({ action: 'sources', name: 'nope' }, home);
    expect(missing.ok).toBe(false);
    expect(missing.errors[0].code).toBe('SOURCE_NOT_FOUND');
  });
});
