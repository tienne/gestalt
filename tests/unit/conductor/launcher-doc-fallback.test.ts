import { afterEach, describe, expect, it, vi } from 'vitest';
import { order, worker } from './fixtures.js';

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
          String(p).endsWith('.md') ? false : actual.existsSync(p),
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
