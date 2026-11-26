import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { order, worker } from './fixtures.js';

// mock factory 안에서 launcher를 import하면 순환이라 같은 절대 경로를 여기서 따로 만든다
const SHARED = resolve(import.meta.dirname, '../../../plugin/skills/_shared');
const DOCS = new Set([
  resolve(SHARED, 'before-screenshot.md'),
  resolve(SHARED, 'screen-change.md'),
]);

describe('워커 지시서 문서 경로 폴백', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('플러그인 문서가 안 풀리면 두 문서 모두 파일 이름이 들어간 폴백 문구로 싣는다', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
          DOCS.has(String(p)) ? false : actual.existsSync(p),
      };
    });
    const { buildWorkerPrompt } = await import('../../../src/conductor/launcher.js');
    const prompt = buildWorkerPrompt(
      order({ id: 'ord-1', skillChain: ['ship'] }),
      worker('ord-1', { id: 'wrk-1' }),
    );
    expect(prompt).toContain('`gestalt 플러그인의 plugin/skills/_shared/before-screenshot.md`대로');
    expect(prompt).toContain(
      '`gestalt 플러그인의 plugin/skills/_shared/screen-change.md`의 후보 기준',
    );
  });
});
