import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../src/core/config.js';
import { ensureGestaltHome, gestaltHome, gestaltPath } from '../../../src/core/home.js';

/**
 * 홈 해석은 여기 한 군데다. 이 아래에 인증 없는 웹 UI가 열어 줄 레포 목록이 있으므로
 * `GESTALT_HOME`이 어디를 가리키는지가 곧 그 서버가 무엇을 열지다.
 */
describe('gestalt 홈', () => {
  const saved = process.env['GESTALT_HOME'];
  const made: string[] = [];

  beforeEach(() => {
    delete process.env['GESTALT_HOME'];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['GESTALT_HOME'];
    else process.env['GESTALT_HOME'] = saved;
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('환경변수가 없으면 진짜 홈 아래다', () => {
    expect(gestaltHome()).toBe(join(homedir(), '.gestalt'));
  });

  it('절대경로를 주면 그 아래를 쓴다', () => {
    const dir = mkdtempSync(join(tmpdir(), `gestalt-home-${randomUUID().slice(0, 8)}-`));
    made.push(dir);
    process.env['GESTALT_HOME'] = dir;

    expect(gestaltPath('repos.json')).toBe(join(dir, '.gestalt', 'repos.json'));
  });

  it('상대경로는 무시하고 알린다', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // cwd 기준으로 풀리면 프로세스가 어디서 떴는지에 따라 다른 레포 목록을 연다
    process.env['GESTALT_HOME'] = `relative-${randomUUID().slice(0, 8)}`;

    try {
      expect(gestaltHome()).toBe(join(homedir(), '.gestalt'));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('빈 값도 진짜 홈으로 돌아간다', () => {
    process.env['GESTALT_HOME'] = '';
    expect(gestaltHome()).toBe(join(homedir(), '.gestalt'));
  });

  it('전역 이벤트 DB도 같은 홈을 따른다', () => {
    const dir = mkdtempSync(join(tmpdir(), `gestalt-home-${randomUUID().slice(0, 8)}-`));
    made.push(dir);
    process.env['GESTALT_HOME'] = dir;

    // 모듈 로드 시점에 굳힌 상수면 여기서 세운 값이 안 먹고 진짜 홈을 가리킨다
    const config = loadConfig({}, { skipDotEnv: true, skipGestaltJson: true });
    expect(config.dbPath).toBe(join(dir, '.gestalt', 'events.db'));
  });

  it('새로 만드는 홈은 주인만 읽는다', () => {
    const dir = mkdtempSync(join(tmpdir(), `gestalt-home-${randomUUID().slice(0, 8)}-`));
    made.push(dir);
    process.env['GESTALT_HOME'] = dir;

    // 여기에는 사용자가 작업하는 비공개 레포의 절대 경로와 프로필이 모인다
    expect(statSync(ensureGestaltHome()).mode & 0o777).toBe(0o700);
  });
});
