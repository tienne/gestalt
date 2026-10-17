import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { ValidationError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import {
  parseSourceMd,
  SOURCE_AXES,
  SOURCE_EVIDENCE,
  SOURCE_STAGES,
  type SourceDefinition,
} from './source-schema.js';

/** create_source가 받는 입력. SOURCE.md의 frontmatter에 본문(찾는 법, 멈추는 곳)을 붙인 꼴이다 */
export const createSourceInputSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    stage: z.array(z.string()).min(1),
    axis: z.array(z.string()).optional(),
    access: z.array(z.record(z.unknown())).min(1),
    requires: z.record(z.unknown()).optional(),
    evidence: z.string().optional(),
    limits: z.string().optional(),
    fallback: z.string().optional(),
    steps: z.array(z.string()).min(1),
    stops: z.array(z.string()).min(1),
  })
  .strict();

export type CreateSourceInput = z.infer<typeof createSourceInputSchema>;

export interface SourceQuestion {
  key: string;
  ask: string;
  required: boolean;
}

/** 입력이 없을 때 돌려주는 질문. ges_create_agent처럼 사람에게 물을 것을 먼저 알려준다 */
export const SOURCE_QUESTIONS: SourceQuestion[] = [
  { key: 'name', ask: '출처 이름(소문자, 숫자, -만. 예: my-review-site)', required: true },
  { key: 'description', ask: '이 출처로 무엇을 찾는지 한 줄', required: true },
  {
    key: 'stage',
    ask: `어느 단계에 쓰는지(${SOURCE_STAGES.join(', ')} 중 하나 이상)`,
    required: true,
  },
  {
    key: 'axis',
    ask: `찾는 제품이 어느 축인지(${SOURCE_AXES.join(', ')}). 모르면 비운다`,
    required: false,
  },
  {
    key: 'access',
    ask: '접근 방법. 사이트 주소와 로그인 방법(사람이 하는지, 필요 없는지), 공개 API 호스트, MCP 서버 이름, 환경변수 이름 중에서. 비밀번호와 키 값은 적지 않는다',
    required: true,
  },
  {
    key: 'evidence',
    ask: `여기서 얻은 것이 어떤 근거인지(${SOURCE_EVIDENCE.join(', ')})`,
    required: false,
  },
  { key: 'steps', ask: '찾는 법. 순서대로 한 줄씩', required: true },
  {
    key: 'stops',
    ask: '멈춰야 하는 화면과 조건(결제, 약관 동의, 로그인 요구 등)',
    required: true,
  },
  { key: 'limits', ask: '이 출처로 못 보는 것이나 믿으면 안 되는 부분', required: false },
  { key: 'fallback', ask: '이 출처를 못 쓸 때 대신 쓸 방법', required: false },
];

export const SOURCE_EXAMPLE: CreateSourceInput = {
  name: 'example-review-site',
  description: '서비스 리뷰 사이트에서 사용자 불만과 칭찬을 찾는다',
  stage: ['evidence'],
  axis: ['same-market'],
  access: [{ browser: { site: 'reviews.example.com', login: 'human' } }],
  requires: { browserLogin: 'reviews.example.com' },
  evidence: 'observation',
  limits: '작성자가 직접 고른 리뷰만 보인다',
  fallback: '스토어 리뷰로 대신한다',
  steps: ['서비스 이름으로 검색해 상세 페이지를 연다.', '최근 리뷰를 별점별로 읽는다.'],
  stops: ['로그인이나 결제를 요구하는 화면에서는 멈추고 사람에게 넘긴다.'],
};

const LINE_BREAKS = `\\r\\n${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`;
const ONE_LINE = new RegExp(`\\s*[${LINE_BREAKS}]+\\s*`, 'g');
const LEADING_NUMBER = /^\s*(?:\d+[.)]|[-*])\s+/;

function cleanItems(items: string[]): string[] {
  return items
    .map((s) => s.replace(ONE_LINE, ' ').replace(LEADING_NUMBER, '').trim())
    .filter((s) => s.length > 0);
}

/** 한 줄 필드에 줄바꿈이 들어와 frontmatter나 본문 구조를 깨는 걸 막는다 */
function oneLine(s: string | undefined): string | undefined {
  const t = s?.replace(ONE_LINE, ' ').trim();
  return t ? t : undefined;
}

export interface BuiltSource {
  content: string;
  definition: SourceDefinition;
}

/** 입력으로 SOURCE.md 문자열을 만든 뒤 읽는 쪽과 같은 검사기(parseSourceMd)로 다시 읽어 확인한다 */
export function buildSourceMd(input: CreateSourceInput): Result<BuiltSource, ValidationError> {
  const steps = cleanItems(input.steps);
  const stops = cleanItems(input.stops);
  if (steps.length === 0) return err(new ValidationError('찾는 법이 비어 있다', ['steps']));
  if (stops.length === 0) return err(new ValidationError('멈추는 곳이 비어 있다', ['stops']));

  const data: Record<string, unknown> = {
    name: input.name,
    description: oneLine(input.description) ?? '',
    stage: input.stage,
    ...(input.axis && input.axis.length > 0 ? { axis: input.axis } : {}),
    access: input.access,
    ...(input.requires && Object.keys(input.requires).length > 0
      ? { requires: input.requires }
      : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(oneLine(input.limits) ? { limits: oneLine(input.limits) } : {}),
    ...(oneLine(input.fallback) ? { fallback: oneLine(input.fallback) } : {}),
  };
  const body = [
    '## 찾는 법',
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## 멈추는 곳',
    '',
    ...stops.map((s) => `- ${s}`),
    '',
  ].join('\n');

  let content: string;
  try {
    content = matter.stringify(body, data);
  } catch (e) {
    return err(
      new ValidationError(
        `SOURCE.md를 만들지 못했다: ${e instanceof Error ? e.message : String(e)}`,
        [],
      ),
    );
  }
  const parsed = parseSourceMd(content);
  if (!parsed.ok) return parsed;
  return ok({ content, definition: parsed.value });
}

/** 개인 디렉토리 안에서만 쓴다. 이름 정규식이 이미 경로 구분자를 막지만 한 번 더 확인한다 */
export function writeSourceMd(
  personalDir: string,
  name: string,
  content: string,
): Result<string, ValidationError> {
  const root = resolve(personalDir);
  const dir = resolve(root, name);
  if (!dir.startsWith(root + sep)) {
    return err(new ValidationError('출처 이름이 개인 디렉토리 밖을 가리킨다', [name]));
  }
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'SOURCE.md');
    const tmp = join(dir, `.SOURCE.md.${process.pid}.tmp`);
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, target);
    return ok(target);
  } catch (e) {
    return err(
      new ValidationError(
        `SOURCE.md를 쓰지 못했다: ${e instanceof Error ? e.message : String(e)}`,
        [name],
      ),
    );
  }
}

export function personalSourceExists(personalDir: string, name: string): boolean {
  return existsSync(join(resolve(personalDir), name, 'SOURCE.md'));
}

// ─── 시험 호출 ────────────────────────────────────────────────

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** 사설, 루프백, 링크 로컬 주소인지. 읽지 못하면 막는 쪽으로 답한다 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    return ipv4Private(parts[0]!, parts[1]!);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower)
    );
  }
  return true;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  status?: number;
  note: string;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

const defaultLookup = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true })).map((r) => r.address);

/**
 * probe 주소를 한 번 GET한다. https만 부르고 호스트가 사설 주소로 풀리면 막는다. 리다이렉트는 따라가지 않는다.
 * 본문은 읽지 않고 상태 코드만 본다.
 */
export async function probeSource(url: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, ok: false, note: '주소 형식이 아니다' };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return { url, ok: false, note: 'https 주소만 시험한다' };
  }
  try {
    const addresses = await (deps.lookup ?? defaultLookup)(parsed.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      return { url, ok: false, note: '사설 주소로 풀리는 호스트라 시험하지 않았다' };
    }
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      headers: { accept: 'application/json, text/html;q=0.8' },
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) {
      return {
        url,
        ok: false,
        status: res.status,
        note: '다른 주소로 넘어간다. 리다이렉트는 따라가지 않으니 probe를 최종 주소로 바꾼다',
      };
    }
    return res.status >= 200 && res.status < 300
      ? { url, ok: true, status: res.status, note: '응답 확인' }
      : { url, ok: false, status: res.status, note: `응답 코드 ${res.status}` };
  } catch (e) {
    return { url, ok: false, note: `호출 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}
