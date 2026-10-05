import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeownersRule {
  pattern: string;
  owners: string[];
  /** `*` 하나뿐인 규칙. 레포 전체에 기본 담당을 거는 줄이라 실제 담당과 따로 센다 */
  catchAll: boolean;
  re: RegExp;
}

export interface OwnerMatch {
  owners: string[];
  catchAll: boolean;
}

const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** GitHub CODEOWNERS 문법. 뒤에 나온 규칙이 이기고 담당이 빈 규칙은 담당을 지운다 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern: pattern!, owners, catchAll: pattern === '*', re: patternRe(pattern!) });
  }
  return rules;
}

function patternRe(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/');
  const dir = pattern.endsWith('/');
  const glob = pattern.replace(/^\//, '').replace(/\/$/, '');
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      // `a/**`는 그 아래 전부, `a/**/b`는 중간 폴더 몇 단이든
      const end = i + 2 === glob.length;
      body += end ? '.*' : '(?:.*/)?';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }
  const head = anchored ? '^' : '^(?:.*/)?';
  // 폴더 규칙은 그 아래 전부, 파일 규칙도 같은 이름 폴더면 그 아래까지 덮는다. `docs/*`는 바로 아래만 덮는다
  const tail = dir ? '/' : /(^|[^*])\*$/.test(pattern) && anchored ? '$' : '(?:/|$)';
  return new RegExp(`${head}${body}${tail}`);
}

export function ownersOf(rules: readonly CodeownersRule[], path: string): OwnerMatch | undefined {
  const p = path.replace(/^\.?\//, '');
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    if (r.re.test(p))
      return r.owners.length > 0 ? { owners: r.owners, catchAll: r.catchAll } : undefined;
  }
  return undefined;
}

export function readCodeowners(root: string): CodeownersRule[] {
  for (const loc of LOCATIONS) {
    const file = join(root, loc);
    if (existsSync(file)) return parseCodeowners(readFileSync(file, 'utf-8'));
  }
  return [];
}
