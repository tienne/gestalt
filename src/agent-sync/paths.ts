import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

/** 테스트와 수동 시험이 `HOME`을 임시 폴더로 돌리면 그쪽을 본다 */
export function userHome(): string {
  const raw = process.env['HOME'];
  return raw && isAbsolute(raw) ? raw : homedir();
}

export interface SourcePaths {
  root: string;
  rulesFile: string;
  skillsDir: string;
}

export function sourcePaths(home: string): SourcePaths {
  const root = join(home, '.agents');
  return { root, rulesFile: join(root, 'AGENTS.md'), skillsDir: join(root, 'skills') };
}

/** `~/.claude/CLAUDE.md`가 공용 규칙을 가져오는 줄 */
export const SOURCE_IMPORT_LINE = '@~/.agents/AGENTS.md';
/** 계정 홈의 CLAUDE.md가 시스템 CLAUDE.md를 가져오는 줄 */
export const SYSTEM_CLAUDE_IMPORT_LINE = '@~/.claude/CLAUDE.md';

/**
 * `child`가 `parent`와 같거나 그 아래인지. `..cache`처럼 점 두 개로 시작하는 이름은 안쪽이다.
 * 경로 문자열만 보고 링크는 따라가지 않는다.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** 홈 아래면 `~/...`로 줄여 출력에 실제 사용자명이 덜 찍히게 한다 */
export function tildify(path: string, home: string): string {
  if (!isInside(home, path)) return path;
  const rel = relative(home, path);
  return rel === '' ? '~' : `~${sep}${rel}`;
}
