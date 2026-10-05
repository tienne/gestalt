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

/** CLI 하위 명령이 이 동사로 시작해야 읽기 전용으로 본다. 도구 이름 규칙과 같은 원리다 */
export const READ_ONLY_CLI_VERBS = ['list', 'get', 'describe'] as const;

// 이름은 읽기지만 비밀값이나 임시 자격증명을 내주거나 로컬에 파일을 쓰는 동작이다
const CLI_SENSITIVE_WORDS = ['secret', 'password', 'token', 'credential', 'credentials'];
const CLI_DENY_OPERATIONS = new Set(['get-object', 'get-object-torrent']);
const CLI_DENY_FLAGS = new Set(['--with-decryption']);
// 셸 연결이나 치환, 리다이렉션이 섞이면 뒤에 무엇이 붙었는지 이 함수로는 알 수 없다
const SHELL_META_RE = /[;&|`<>\n\r]|\$\(/;
// aws 전역 옵션 중 값을 받지 않는 것. 나머지 --옵션은 다음 토큰을 값으로 먹는다
const AWS_FLAG_ONLY_OPTIONS = new Set([
  '--debug',
  '--no-verify-ssl',
  '--no-paginate',
  '--no-sign-request',
  '--no-cli-pager',
  '--cli-auto-prompt',
  '--no-cli-auto-prompt',
]);

function awsPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (!a.includes('=') && !AWS_FLAG_ONLY_OPTIONS.has(a)) i += 1;
      continue;
    }
    out.push(a);
    if (out.length === 2) break;
  }
  return out;
}

function classifyAwsOperation(service: string, operation: string): Classification {
  if (service === 'configure') return operation === 'list-profiles' ? 'allow' : 'deny';
  if (CLI_DENY_OPERATIONS.has(operation)) return 'deny';
  const words = operation.split('-');
  if (words.some((w) => CLI_SENSITIVE_WORDS.includes(w))) return 'deny';
  const verb = words[0]!;
  if ((READ_ONLY_CLI_VERBS as readonly string[]).includes(verb)) return 'allow';
  return 'deny';
}

/**
 * 셸 명령 한 줄이 읽기 전용 클라우드 조회인지 본다. 지금은 aws CLI와 aws-vault list만 판정하고 나머지는 ambiguous다.
 * 하위 명령이 list, get, describe로 시작해야 allow이고 비밀값이나 자격증명을 내주는 동작은 이름이 get이어도 deny다.
 */
export function classifyCliCommand(command: string): Classification {
  const trimmed = command.trim();
  if (trimmed === '') return 'ambiguous';
  if (SHELL_META_RE.test(trimmed)) return 'deny';
  const tokens = trimmed.split(/\s+/);
  const program = tokens[0]!;
  const args = tokens.slice(1);
  if (args.some((a) => CLI_DENY_FLAGS.has(a.split('=')[0]!))) return 'deny';
  if (program === 'aws-vault') return args[0] === 'list' ? 'allow' : 'deny';
  if (program !== 'aws') return 'ambiguous';
  const [service, operation] = awsPositionals(args);
  if (service === undefined || operation === undefined) return 'ambiguous';
  return classifyAwsOperation(service, operation);
}
