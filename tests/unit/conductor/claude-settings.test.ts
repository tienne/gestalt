import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSettingsFiles,
  readAutoCompactWindow,
} from '../../../src/conductor/claude-settings.js';

let base: string;
let cwd: string;
let home: string;

beforeEach(() => {
  base = resolve('.gestalt-test', `claude-settings-${randomUUID()}`);
  cwd = join(base, 'repo');
  home = join(base, 'home');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(file: string, json: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
}

const lookup = (env: NodeJS.ProcessEnv = {}) => ({ cwd, home, env, platform: 'win32' as const });

describe('readAutoCompactWindow', () => {
  it('사용자 ~/.claude/settings.json에서 읽는다', () => {
    write(join(home, '.claude', 'settings.json'), { autoCompactWindow: 250_000 });
    expect(readAutoCompactWindow(lookup())).toBe(250_000);
  });

  it('CLAUDE_CONFIG_DIR가 있으면 ~/.claude 대신 그 아래 settings.json을 읽는다', () => {
    write(join(home, '.claude', 'settings.json'), { autoCompactWindow: 250_000 });
    const dir = join(base, 'profile');
    expect(readAutoCompactWindow(lookup({ CLAUDE_CONFIG_DIR: dir }))).toBeUndefined();
    write(join(dir, 'settings.json'), { autoCompactWindow: 300_000 });
    expect(readAutoCompactWindow(lookup({ CLAUDE_CONFIG_DIR: dir }))).toBe(300_000);
  });

  it('프로젝트 로컬, 프로젝트, 사용자 순으로 앞에 적힌 값이 이긴다', () => {
    write(join(home, '.claude', 'settings.json'), { autoCompactWindow: 250_000 });
    write(join(cwd, '.claude', 'settings.json'), { autoCompactWindow: 180_000 });
    expect(readAutoCompactWindow(lookup())).toBe(180_000);
    write(join(cwd, '.claude', 'settings.local.json'), { autoCompactWindow: 120_000 });
    expect(readAutoCompactWindow(lookup())).toBe(120_000);
  });

  it('깨진 파일이나 숫자가 아닌 값은 건너뛰고 다음 파일을 본다', () => {
    write(join(cwd, '.claude', 'settings.local.json'), '{ not json');
    write(join(cwd, '.claude', 'settings.json'), { autoCompactWindow: '250000' });
    write(join(home, '.claude', 'settings.json'), { autoCompactWindow: 250_000 });
    expect(readAutoCompactWindow(lookup())).toBe(250_000);
  });

  it('어디에도 없으면 undefined', () => {
    expect(readAutoCompactWindow(lookup())).toBeUndefined();
  });

  it('macOS와 리눅스는 관리 설정 파일을 맨 앞에 둔다', () => {
    expect(claudeSettingsFiles({ cwd, home, env: {}, platform: 'darwin' })[0]).toBe(
      '/Library/Application Support/ClaudeCode/managed-settings.json',
    );
    expect(claudeSettingsFiles({ cwd, home, env: {}, platform: 'linux' })[0]).toBe(
      '/etc/claude-code/managed-settings.json',
    );
  });
});
