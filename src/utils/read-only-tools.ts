export const READ_ONLY_ALLOW_WORDS = ['search', 'get', 'read', 'list', 'query', 'fetch'] as const;

export const READ_ONLY_DENY_WORDS = [
  'send',
  'create',
  'update',
  'delete',
  'post',
  'put',
  'patch',
  'dml',
  'ddl',
] as const;

type Classification = 'allow' | 'deny' | 'ambiguous';

function tokenize(name: string): string[] {
  if (!name) return [];

  // camelCase 경계 분리: 대문자 앞에 공백 삽입
  const withSpaces = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // _ - . : / 로 분리
  const tokens = withSpaces.split(/[\s_\-.:/]+/);

  return tokens.filter((t) => t.length > 0).map((t) => t.toLowerCase());
}

export function classifyToolName(name: string): Classification {
  const tokens = tokenize(name);

  if (tokens.length === 0) return 'ambiguous';

  const allowWords = new Set<string>(READ_ONLY_ALLOW_WORDS);
  const denyWords = new Set<string>(READ_ONLY_DENY_WORDS);

  let hasAllow = false;
  let hasDeny = false;

  for (const token of tokens) {
    if (denyWords.has(token)) {
      hasDeny = true;
    }
    if (allowWords.has(token)) {
      hasAllow = true;
    }
  }

  if (hasDeny) return 'deny';
  if (hasAllow) return 'allow';
  return 'ambiguous';
}

export interface FilteredTools {
  allowed: string[];
  denied: string[];
  ambiguous: string[];
}

export function filterReadOnlyTools(names: string[]): FilteredTools {
  const allowed: string[] = [];
  const denied: string[] = [];
  const ambiguous: string[] = [];

  for (const name of names) {
    const classification = classifyToolName(name);
    if (classification === 'allow') {
      allowed.push(name);
    } else if (classification === 'deny') {
      denied.push(name);
    } else {
      ambiguous.push(name);
    }
  }

  return { allowed, denied, ambiguous };
}
