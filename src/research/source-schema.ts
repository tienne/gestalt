import matter from 'gray-matter';
import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';

export const SOURCE_STAGES = [
  'product-discovery',
  'scale',
  'screen-map',
  'evidence',
  'baseline',
] as const;
export const SOURCE_ACCESS_KINDS = ['mcp', 'browser', 'http', 'env'] as const;
export const SOURCE_EVIDENCE = [
  'observation',
  'company-statement',
  'interpretation',
  'estimate',
] as const;
export const SOURCE_AXES = ['same-market', 'same-problem'] as const;

export type SourceStage = (typeof SOURCE_STAGES)[number];
export type SourceAccessKind = (typeof SOURCE_ACCESS_KINDS)[number];

/** 파일 하나의 크기 상한. 개인 디렉토리라도 통째로 읽으므로 막아둔다 */
export const SOURCE_MAX_BYTES = 64 * 1024;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
/** `claude.ai Amplitude`처럼 커넥터 이름에 공백이 들어간다. 연속 공백과 끝 공백은 막는다 */
const MCP_SERVER_PATTERN = /^(?!.* {2})(?!.* $)[A-Za-z0-9][A-Za-z0-9_.: -]{0,63}$/;
const MCP_TOOL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const PRIVATE_HOST_SUFFIXES = [
  '.local',
  '.internal',
  '.localhost',
  '.lan',
  '.corp',
  '.home',
  '.intranet',
];

/** 사설 주소로 가는 길을 막는다. 숫자 주소와 점 없는 이름은 정규식에서 이미 걸러진다 */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase();
  return HOST_PATTERN.test(h) && !PRIVATE_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'API 키로 보이는 문자열'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/, 'GitHub 토큰으로 보이는 문자열'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack 토큰으로 보이는 문자열'],
  [/\bAKIA[0-9A-Z]{12,}/, 'AWS 키로 보이는 문자열'],
  [/\bAIza[0-9A-Za-z_-]{20,}/, 'Google API 키로 보이는 문자열'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i, 'Bearer 토큰'],
  [/https?:\/\/[^\s/:@]+:[^\s/@]+@/, '주소에 박힌 계정과 비밀번호'],
  [
    /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/=._-]{12,}/i,
    '비밀번호나 키 값',
  ],
];

/** 비밀번호나 키가 SOURCE.md에 들어가는 걸 막는다. 환경변수 이름만 적는다 */
export function findSecret(text: string): string | undefined {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

const hostSchema = z
  .string()
  .transform((s) => s.toLowerCase())
  .refine(isPublicHostname, '공개 호스트 이름만 쓴다 (IP 주소, localhost, 사내 이름 불가)');

const accessEntrySchema = z.unknown().transform((raw, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('access 항목은 `mcp: {...}` 같은 한 키짜리 객체다');
  }
  const keys = Object.keys(raw);
  const kind = keys[0];
  if (keys.length !== 1 || !kind || !(SOURCE_ACCESS_KINDS as readonly string[]).includes(kind)) {
    return fail(
      `access 방법은 ${SOURCE_ACCESS_KINDS.join(', ')}만 쓴다 (받은 키: ${keys.join(', ') || '없음'})`,
    );
  }
  const value = (raw as Record<string, unknown>)[kind];
  const parse = <T>(schema: z.ZodType<T>): T => {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    for (const issue of r.error.issues) {
      ctx.addIssue({ ...issue, path: [kind, ...issue.path] });
    }
    return z.NEVER;
  };
  switch (kind) {
    case 'mcp':
      return {
        kind: 'mcp' as const,
        ...parse(
          z
            .object({
              server: z
                .string()
                .regex(MCP_SERVER_PATTERN, 'MCP 서버 이름 형식이 아니다')
                .optional(),
              /** 서버 이름은 사람마다 달라서 도구 이름으로 알아본다. 하나라도 세션에 있으면 연결된 걸로 본다 */
              tools: z
                .array(z.string().regex(MCP_TOOL_PATTERN, 'MCP 도구 이름 형식이 아니다'))
                .min(1)
                .optional(),
            })
            .strict()
            .refine((m) => m.server || m.tools, 'MCP는 server나 tools 중 하나는 적는다'),
        ),
      };
    case 'browser':
      return {
        kind: 'browser' as const,
        ...parse(
          z
            .object({ site: hostSchema, login: z.enum(['human', 'none']).default('human') })
            .strict(),
        ),
      };
    case 'http':
      return {
        kind: 'http' as const,
        ...parse(z.object({ host: hostSchema, probe: z.string().url().optional() }).strict()),
      };
    default:
      return {
        kind: 'env' as const,
        name: parse(z.string().regex(ENV_NAME_PATTERN, '환경변수 이름은 대문자와 _만 쓴다')),
      };
  }
});

const toArray = (v: unknown): unknown => (v === undefined || Array.isArray(v) ? v : [v]);

export const sourceFrontmatterSchema = z
  .object({
    name: z.string().regex(NAME_PATTERN, '이름은 소문자, 숫자, -만 쓴다 (40자까지)'),
    description: z.string().min(1),
    stage: z.preprocess(toArray, z.array(z.enum(SOURCE_STAGES)).min(1)),
    axis: z.preprocess(toArray, z.array(z.enum(SOURCE_AXES)).default([])),
    access: z.array(accessEntrySchema).min(1),
    requires: z
      .object({
        mcpServer: z.string().regex(MCP_SERVER_PATTERN).optional(),
        env: z.preprocess(toArray, z.array(z.string().regex(ENV_NAME_PATTERN)).default([])),
        browserLogin: hostSchema.optional(),
      })
      .strict()
      .default({}),
    /** estimate는 제3자 추정치라 근거 상태에서는 해석으로 받는다 */
    evidence: z
      .enum(SOURCE_EVIDENCE)
      .default('observation')
      .transform((e) => (e === 'estimate' ? ('interpretation' as const) : e)),
    limits: z.string().optional(),
    /** 이 출처를 못 쓸 때 대신 쓰는 방법. 0번 전제의 근거 한계 문장에 들어간다 */
    fallback: z.string().optional(),
  })
  .superRefine((fm, ctx) => {
    fm.access.forEach((a, i) => {
      if (a.kind !== 'http' || !a.probe) return;
      let url: URL;
      try {
        url = new URL(a.probe);
      } catch {
        return;
      }
      const hostOk = url.hostname === a.host || url.hostname.endsWith(`.${a.host}`);
      if (url.protocol !== 'https:' || url.username || url.password || !hostOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['access', i, 'http', 'probe'],
          message: 'probe는 같은 호스트의 https 주소만 쓴다 (계정 정보 불가)',
        });
      }
    });
  });

export type SourceFrontmatter = z.infer<typeof sourceFrontmatterSchema>;
export type SourceAccess = SourceFrontmatter['access'][number];

export interface SourceDefinition {
  frontmatter: SourceFrontmatter;
  body: string;
}

const REQUIRED_SECTIONS = ['찾는 법', '멈추는 곳'] as const;

/** gray-matter의 js 엔진은 frontmatter를 코드로 실행한다. 개인 디렉토리 파일이라도 막는다 */
const SAFE_MATTER_OPTIONS = {
  engines: {
    js: () => {
      throw new Error('js frontmatter는 쓰지 않는다');
    },
    javascript: () => {
      throw new Error('js frontmatter는 쓰지 않는다');
    },
  },
};

export function parseSourceMd(content: string): Result<SourceDefinition, ValidationError> {
  if (Buffer.byteLength(content, 'utf-8') > SOURCE_MAX_BYTES) {
    return err(new ValidationError('SOURCE.md가 너무 크다 (64KB 상한)', []));
  }
  const secret = findSecret(content);
  if (secret) {
    return err(
      new ValidationError(
        `SOURCE.md에 ${secret}이 들어 있다. 비밀번호와 키는 적지 않고 환경변수 이름이나 MCP 서버 이름만 적는다`,
        [secret],
      ),
    );
  }
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content, SAFE_MATTER_OPTIONS);
    data = parsed.data;
    body = parsed.content.trim();
  } catch (e) {
    return err(
      new ValidationError(
        `frontmatter를 읽지 못했다: ${e instanceof Error ? e.message : String(e)}`,
        [],
      ),
    );
  }
  const fm = sourceFrontmatterSchema.safeParse(data);
  if (!fm.success) {
    const issues = fm.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return err(new ValidationError(`SOURCE.md frontmatter 오류: ${issues.join('; ')}`, issues));
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !new RegExp(`^##\\s+${s}\\s*$`, 'm').test(body));
  if (missing.length > 0) {
    return err(
      new ValidationError(
        `본문에 절이 빠졌다: ${missing.map((s) => `## ${s}`).join(', ')}`,
        missing,
      ),
    );
  }
  return ok({ frontmatter: fm.data, body });
}
