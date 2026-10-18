import type { LoadedSource } from './source-registry.js';
import type { SourceAccess, SourceStage } from './source-schema.js';

/** 같은 세션의 다른 MCP 연결과 브라우저 로그인은 ges 서버가 못 본다. 세션이 알려준다 */
export interface SessionAvailability {
  mcpServers?: string[];
  /** 세션의 MCP 도구 이름(`mcp__<서버>__<도구>`). 서버 이름이 사람마다 달라서 도구 이름으로 출처를 알아본다 */
  mcpTools?: string[];
  browserLogins?: string[];
}

export type SourceStatus = 'usable' | 'fallback' | 'skipped';

export interface SourceEvaluation {
  status: SourceStatus;
  /** 실제로 쓰게 될 접근 방법. 건너뛰면 없다 */
  via?: SourceAccess['kind'];
  /** MCP로 쓸 때 이 세션에서 부를 서버. 도구 이름으로 찾았으면 그 도구의 접두어에서 뽑는다 */
  mcpServer?: string;
  note: string;
}

type McpAccess = Extract<SourceAccess, { kind: 'mcp' }>;

/** 세션에서 이 MCP 출처를 맡는 서버. 없으면 undefined */
function findMcpServer(access: McpAccess, avail: SessionAvailability): string | undefined {
  if (access.server && avail.mcpServers?.includes(access.server)) return access.server;
  for (const full of avail.mcpTools ?? []) {
    const m = /^mcp__(.+)__([^_].*)$/.exec(full);
    const [server, tool] = m ? [m[1]!, m[2]!] : [undefined, full];
    if (access.tools?.includes(tool)) return server ?? access.server ?? '';
  }
  return undefined;
}

const mcpLabel = (access: McpAccess): string => access.server ?? access.tools?.join(', ') ?? '';

const VIA_LABEL: Record<SourceAccess['kind'], string> = {
  mcp: 'MCP',
  browser: '브라우저',
  http: '공개 API',
  env: 'API 키',
};

function unmetReason(
  access: SourceAccess,
  avail: SessionAvailability,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (access.kind) {
    case 'mcp':
      return findMcpServer(access, avail) === undefined
        ? `MCP(${mcpLabel(access)}) 미연결`
        : undefined;
    case 'browser':
      if (access.login === 'none') return undefined;
      return avail.browserLogins?.includes(access.site) ? undefined : `${access.site} 로그인 안 됨`;
    case 'http':
      return undefined;
    case 'env':
      return env[access.name] ? undefined : `환경변수 ${access.name} 없음`;
  }
}

function unmetRequirement(
  source: LoadedSource,
  avail: SessionAvailability,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const req = source.frontmatter.requires;
  if (req.mcpServer && !avail.mcpServers?.includes(req.mcpServer)) {
    return `MCP(${req.mcpServer}) 미연결`;
  }
  const missingEnv = req.env.find((name) => !env[name]);
  if (missingEnv) return `환경변수 ${missingEnv} 없음`;
  if (req.browserLogin && !avail.browserLogins?.includes(req.browserLogin)) {
    return `${req.browserLogin} 로그인 안 됨`;
  }
  return undefined;
}

/** access를 위에서부터 시도해 첫 번째로 되는 방법을 고른다 */
export function evaluateSource(
  source: LoadedSource,
  avail: SessionAvailability,
  env: NodeJS.ProcessEnv = process.env,
): SourceEvaluation {
  const requirement = unmetRequirement(source, avail, env);
  if (requirement) return { status: 'skipped', note: `${requirement}이라 건너뜀` };

  // 같은 종류끼리는 연결 이름만 다른 같은 경로라(예: 커넥터 MCP와 직접 띄운 MCP) 대체로 치지 않는다
  const reasons: { kind: SourceAccess['kind']; reason: string }[] = [];
  for (const access of source.frontmatter.access) {
    const reason = unmetReason(access, avail, env);
    if (!reason) {
      const other = reasons.find((r) => r.kind !== access.kind);
      const server = access.kind === 'mcp' ? findMcpServer(access, avail) : undefined;
      const mcp = server ? { mcpServer: server } : {};
      return !other
        ? { status: 'usable', via: access.kind, ...mcp, note: '사용 가능' }
        : {
            status: 'fallback',
            via: access.kind,
            ...mcp,
            note: `${other.reason}이라 ${VIA_LABEL[access.kind]}로`,
          };
    }
    reasons.push({ kind: access.kind, reason });
  }
  return { status: 'skipped', note: `${reasons[0]!.reason}이라 건너뜀` };
}

export interface SourceReportRow {
  name: string;
  description: string;
  stage: SourceStage[];
  origin: LoadedSource['origin'];
  overridden: boolean;
  evidence: LoadedSource['frontmatter']['evidence'];
  status: SourceStatus;
  via?: SourceAccess['kind'];
  mcpServer?: string;
  note: string;
  limits?: string;
}

export interface SourceReport {
  sources: SourceReportRow[];
  /** 0번 전제의 근거 한계에 그대로 옮겨 적는 문장 */
  evidenceLimits: string[];
}

export function buildSourceReport(
  sources: LoadedSource[],
  avail: SessionAvailability,
  env: NodeJS.ProcessEnv = process.env,
  stageFilter?: SourceStage,
): SourceReport {
  const rows: SourceReportRow[] = [];
  const evidenceLimits: string[] = [];
  for (const s of sources) {
    const fm = s.frontmatter;
    if (stageFilter && !fm.stage.includes(stageFilter)) continue;
    const ev = evaluateSource(s, avail, env);
    rows.push({
      name: fm.name,
      description: fm.description,
      stage: fm.stage,
      origin: s.origin,
      overridden: s.overridden,
      evidence: fm.evidence,
      status: ev.status,
      ...(ev.via ? { via: ev.via } : {}),
      ...(ev.mcpServer ? { mcpServer: ev.mcpServer } : {}),
      note: ev.note,
      ...(fm.limits ? { limits: fm.limits } : {}),
    });
    if (ev.status === 'skipped') {
      const tail = fm.fallback ? `${fm.fallback}` : '이 출처가 맡던 부분은 못 채웠다';
      evidenceLimits.push(
        `${fm.name}: ${ev.note.replace(/이라 건너뜀$/, '')}이라 쓰지 못했다. ${tail}`,
      );
    } else {
      if (ev.status === 'fallback') evidenceLimits.push(`${fm.name}: ${ev.note}`);
      if (fm.limits) evidenceLimits.push(`${fm.name}: ${fm.limits}`);
    }
  }
  return { sources: rows, evidenceLimits };
}
