/** 스킬이나 에이전트 문서에서 찾은 MCP 도구 호출 하나 */
export interface SkillToolCall {
  id: string;
  /** 문서가 서버를 밝혔을 때만. 클라이언트 접두(mcp__서버__도구)에서 뽑아도 된다 */
  server?: string;
  tool: string;
  action?: string;
}

/** MCP 서버 코드에서 찾은 도구 등록 하나 */
export interface ServerTool {
  id: string;
  server: string;
  tool: string;
  /** action 인자를 enum으로 받는 도구의 값 목록. 없으면 action을 안 가린다 */
  actions?: string[];
}

export interface MatchMcpToolsInput {
  skillToolCalls: SkillToolCall[];
  serverTools: ServerTool[];
}

export interface McpToolMatch {
  callId: string;
  toolId: string;
  action: string | null;
}

export type McpUnmatchedReason = 'no_tool' | 'multiple_tools' | 'unknown_action';

export interface UnmatchedToolCall {
  callId: string;
  reason: McpUnmatchedReason;
  candidates: string[];
}

export interface MatchMcpToolsResult {
  matches: McpToolMatch[];
  unmatched: UnmatchedToolCall[];
}

/**
 * 클라이언트가 붙이는 접두를 걷는다. Claude Code는 `mcp__<서버>__<도구>`로 부르고
 * 플러그인으로 깔리면 서버 자리가 `plugin_<플러그인>_<서버>`가 된다
 */
export function splitClientToolName(name: string): { server?: string; tool: string } {
  const parts = name.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return { tool: name };
  return { server: parts[1]!, tool: parts.slice(2).join('__') };
}

function serverMatches(hint: string, server: string): boolean {
  return hint === server || hint.endsWith(`_${server}`);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 도구 이름은 정확히 같아야 잇는다. 이름이 비슷하다고 잇지 않는 건 HTTP 경로 매칭과 같은 이유다 —
 * 틀린 실선 하나가 빈 칸보다 그림을 더 망친다
 */
export function matchMcpTools(input: MatchMcpToolsInput): MatchMcpToolsResult {
  const matches: McpToolMatch[] = [];
  const unmatched: UnmatchedToolCall[] = [];
  for (const call of input.skillToolCalls) {
    const split = splitClientToolName(call.tool);
    const server = call.server ?? split.server;
    const found = input.serverTools.filter(
      (t) => t.tool === split.tool && (server === undefined || serverMatches(server, t.server)),
    );
    if (found.length === 0) {
      unmatched.push({ callId: call.id, reason: 'no_tool', candidates: [] });
      continue;
    }
    if (found.length > 1) {
      unmatched.push({
        callId: call.id,
        reason: 'multiple_tools',
        candidates: found.map((t) => t.id).sort(byText),
      });
      continue;
    }
    const tool = found[0]!;
    if (call.action !== undefined && tool.actions !== undefined) {
      if (!tool.actions.includes(call.action)) {
        unmatched.push({ callId: call.id, reason: 'unknown_action', candidates: [tool.id] });
        continue;
      }
    }
    matches.push({ callId: call.id, toolId: tool.id, action: call.action ?? null });
  }
  matches.sort((a, b) => byText(a.callId, b.callId));
  unmatched.sort((a, b) => byText(a.callId, b.callId));
  return { matches, unmatched };
}
