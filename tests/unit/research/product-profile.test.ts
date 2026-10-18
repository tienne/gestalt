import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { researchInputSchema } from '../../../src/mcp/schemas.js';
import { handleResearchPassthrough } from '../../../src/mcp/tools/research-passthrough.js';
import { productProfileSchema, profilePath } from '../../../src/research/product-profile.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRepo(): string {
  const dir = resolve('.gestalt-test', `profile-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

const sample = (over: Record<string, unknown> = {}) => ({
  product: 'my-app',
  repo: process.cwd(),
  commit: head,
  scannedAt: '2026-10-18',
  sdk: '@amplitude/analytics-browser 2.x',
  keyLocation: 'src/lib/analytics.ts',
  events: [
    {
      name: 'payment_complete',
      screen: '결제 완료',
      action: '결제를 마침',
      file: 'src/pages/pay/done.tsx',
    },
  ],
  ...over,
});

async function run(params: Record<string, unknown>, repoRoot: string) {
  const input = researchInputSchema.parse({ action: 'profile', repoRoot, ...params });
  return (await handleResearchPassthrough(input, repoRoot, {
    builtinDir: resolve('plugin/research-sources'),
  })) as Record<string, any>;
}

describe('제품 프로필 스키마', () => {
  it('키처럼 보이는 값은 어느 칸에 있든 막는다', () => {
    const key = '0123456789abcdef0123456789abcdef';
    const r = productProfileSchema.safeParse(sample({ keyLocation: key }));
    expect(r.success).toBe(false);
    const inEvent = productProfileSchema.safeParse(
      sample({
        events: [{ name: 'x', screen: 's', action: 'a', file: 'f', properties: [key] }],
      }),
    );
    expect(inEvent.success).toBe(false);
  });

  it('40자 커밋 해시는 키로 보지 않는다', () => {
    expect(productProfileSchema.safeParse(sample()).success).toBe(true);
  });

  it('이벤트를 못 찾았으면 저장하지 않는다', () => {
    expect(productProfileSchema.safeParse(sample({ events: [] })).success).toBe(false);
  });

  it('제품 이름은 slug 규칙을 따른다', () => {
    expect(productProfileSchema.safeParse(sample({ product: '../x' })).success).toBe(false);
    expect(() => profilePath('/tmp', '_x')).toThrow();
  });
});

describe('ges_research action=profile', () => {
  it('저장하고 목록에 띄우고 다시 읽는다', async () => {
    const repo = tmpRepo();
    const saved = await run({ profile: sample() }, repo);
    expect(saved.ok).toBe(true);
    expect(saved.path).toContain('.gestalt/research/_products/my-app.json');

    const list = await run({}, repo);
    expect(list.products).toEqual(['my-app']);

    const got = await run({ product: 'my-app' }, repo);
    expect(got.profile.events).toHaveLength(1);
    expect(got.stale).toBe(false);
  });

  it('저장한 커밋이 HEAD와 다르면 알린다', async () => {
    const repo = tmpRepo();
    await run({ profile: sample({ commit: 'deadbee' }) }, repo);
    const got = await run({ product: 'my-app' }, repo);
    expect(got.stale).toBe(true);
    expect(got.notice).toContain('이벤트가 바뀌었을 수 있다');
  });

  it('제품 코드가 git이 아니면 HEAD를 못 읽었다고 알린다', async () => {
    const repo = tmpRepo();
    // .gestalt-test는 이 레포 안이라 git이 상위 HEAD를 찾는다. 레포 밖에 만든다
    const notGit = mkdtempSync(join(tmpdir(), 'ges-profile-'));
    tmpDirs.push(notGit);
    await run({ profile: sample({ repo: notGit }) }, repo);
    const got = await run({ product: 'my-app' }, repo);
    expect(got.stale).toBeNull();
    expect(got.notice).toContain('HEAD를 못 읽었다');
  });

  it('없는 제품과 잘못된 프로필은 거절한다', async () => {
    const repo = tmpRepo();
    expect((await run({ product: 'nope' }, repo)).errors[0].code).toBe('PROFILE_NOT_FOUND');
    expect((await run({ product: '../x' }, repo)).errors[0].code).toBe('INVALID_PRODUCT');
    const bad = await run({ profile: sample({ keyLocation: 'a'.repeat(32) }) }, repo);
    expect(bad.errors[0].code).toBe('INVALID_PROFILE');
    expect(bad.errors[0].message).toContain('keyLocation');
  });
});
