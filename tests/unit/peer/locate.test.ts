import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeConfigDir,
  cwdSlug,
  findSessionByPid,
  locateTranscript,
} from '../../../src/peer/locate.js';

describe('cwdSlug', () => {
  it('실제 projects 디렉토리 이름 규칙을 따른다', () => {
    expect(cwdSlug('/Users/a/dev/gestalt')).toBe('-Users-a-dev-gestalt');
    expect(cwdSlug('/Users/a/.mockup/x_y')).toBe('-Users-a--mockup-x-y');
    expect(cwdSlug('/Users/a/LNB한글')).toBe('-Users-a-LNB--');
  });
});

describe('claudeConfigDir', () => {
  it('CLAUDE_CONFIG_DIR가 절대경로면 그걸 쓴다', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/cfg' })).toBe('/tmp/cfg');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'rel' })).toMatch(/\.claude$/);
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });
});

describe('locateTranscript', () => {
  let config: string;
  const sid = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'peer-cfg-'));
    mkdirSync(join(config, 'sessions'));
    mkdirSync(join(config, 'projects'));
  });

  afterEach(() => {
    rmSync(config, { recursive: true, force: true });
  });

  it('sessions/<pid>.json의 cwd로 슬러그 경로를 만든다', () => {
    writeFileSync(
      join(config, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: sid, cwd: '/Users/x/dev/app' }),
    );
    const dir = join(config, 'projects', '-Users-x-dev-app');
    mkdirSync(dir);
    writeFileSync(join(dir, `${sid}.jsonl`), '');

    expect(locateTranscript(sid, config)).toEqual({
      ok: true,
      path: join(dir, `${sid}.jsonl`),
      sessionId: sid,
      configDir: config,
      cwd: '/Users/x/dev/app',
    });
    expect(findSessionByPid(4242, config)).toEqual({
      pid: 4242,
      sessionId: sid,
      cwd: '/Users/x/dev/app',
    });
  });

  it('슬러그로 못 찾으면 projects/*를 훑는다', () => {
    const dir = join(config, 'projects', 'some-other-slug');
    mkdirSync(dir);
    writeFileSync(join(dir, `${sid}.jsonl`), '');
    const result = locateTranscript(sid, config);
    expect(result).toMatchObject({ ok: true, path: join(dir, `${sid}.jsonl`) });
  });

  it('형식이 다른 세션 파일은 던지지 않고 건너뛴다', () => {
    writeFileSync(join(config, 'sessions', '1.json'), '{not json');
    writeFileSync(join(config, 'sessions', '2.json'), JSON.stringify({ id: sid }));
    const result = locateTranscript(sid, config);
    expect(result).toMatchObject({ ok: false, configDir: config, sessionId: sid });
    if (!result.ok) expect(result.reason).toContain('못 찾았어요');
  });

  it('경로 조각이 될 수 없는 sessionId는 거절한다', () => {
    expect(locateTranscript('../../etc/passwd', config)).toMatchObject({ ok: false });
  });

  it('설정 디렉토리가 없으면 이유를 돌려준다', () => {
    const result = locateTranscript(sid, join(config, 'nope'));
    expect(result).toMatchObject({ ok: false, reason: '설정 디렉토리가 없어요' });
  });
});
