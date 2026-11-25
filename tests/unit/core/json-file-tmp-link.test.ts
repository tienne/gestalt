import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => 'fixed-uuid',
}));

const { writeJsonAtomic } = await import('../../../src/core/json-file.js');

describe('writeJsonAtomic 임시 파일', () => {
  const dir = join('.gestalt-test', `json-tmp-link-${process.pid}-${Date.now()}`);
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('임시 파일 자리에 미리 만든 링크가 있으면 따라가지 않고 실패한다', () => {
    mkdirSync(dir, { recursive: true });
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'original');
    const target = join(dir, 'policy.json');
    symlinkSync('victim.txt', `${target}.${process.pid}.fixed-uuid.tmp`);

    expect(() => writeJsonAtomic(target, { a: 1 })).toThrow(/EEXIST/);
    expect(readFileSync(victim, 'utf8')).toBe('original');
  });
});
