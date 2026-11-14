import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeSettingsLookup {
  /** 프로젝트 설정을 찾을 자리. 컨덕터 세션이 도는 디렉토리다 */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Claude Code가 설정을 겹쳐 읽는 파일. 앞에 있을수록 우선한다.
 * 관리 설정, 프로젝트 로컬, 프로젝트, 사용자 순이다. CLAUDE_CONFIG_DIR가 있으면 사용자 설정은
 * `~/.claude` 대신 그 아래 settings.json만 읽는다. Claude Code도 그 경우 `~/.claude`를 안 본다.
 */
export function claudeSettingsFiles(o: ClaudeSettingsLookup): string[] {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const userDir = env['CLAUDE_CONFIG_DIR'] || join(o.home ?? homedir(), '.claude');
  const managed =
    platform === 'darwin'
      ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
      : platform === 'linux'
        ? ['/etc/claude-code/managed-settings.json']
        : [];
  return [
    ...managed,
    join(o.cwd, '.claude', 'settings.local.json'),
    join(o.cwd, '.claude', 'settings.json'),
    join(userDir, 'settings.json'),
  ];
}

/**
 * 우선순위가 가장 높은 파일에 적힌 `autoCompactWindow`(토큰). 어디에도 없거나 양의 정수가 아니면 undefined.
 * 파일이 깨졌으면 그 파일만 건너뛴다. 설정 하나가 깨졌다고 인계 판정이 멈추면 안 돼서다.
 */
export function readAutoCompactWindow(o: ClaudeSettingsLookup): number | undefined {
  for (const file of claudeSettingsFiles(o)) {
    if (!existsSync(file)) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const value = (json as Record<string, unknown> | null)?.['autoCompactWindow'];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}
