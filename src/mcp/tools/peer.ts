import { execFileSync } from 'node:child_process';
import { DaemonUnavailableError, request } from '../../peer/client.js';
import { claudeConfigDir, findSessionByPid } from '../../peer/locate.js';
import { peerRoot, socketPath } from '../../peer/paths.js';
import type { AskResult } from '../../peer/protocol.js';
import type { PeerInput } from '../schemas.js';

/**
 * `ges_peer` 핸들러. action은 ask_user 하나다.
 *
 * MCP 서버는 세션의 자식이라 부모 pid로 `sessions/<pid>.json`을 찾아 지금 세션 id를 안다. 세션 id는
 * `/clear`나 다시 이어 받기로 바뀔 수 있어서 부를 때마다 다시 읽는다. 질문은 보내고 바로 돌아온다 —
 * 답을 기다리며 도구 호출을 붙잡으면 그동안 세션이 멈춘다.
 */

export interface PeerDeps {
  /** 세션을 찾을 pid 후보. 테스트가 넣는다 */
  pids?: number[];
  configDir?: string;
  socket?: string;
}

/**
 * 세션을 찾을 pid 후보. 부모가 먼저고 `npx`처럼 사이에 프로세스가 하나 끼면 그 부모까지 본다.
 * Claude Code가 자식에게 주는 `CLAUDE_PID`가 있으면 그걸 맨 앞에 둔다.
 */
export function sessionPids(env: NodeJS.ProcessEnv = process.env): number[] {
  const pids: number[] = [];
  const fromEnv = Number(env['CLAUDE_PID']);
  if (Number.isInteger(fromEnv) && fromEnv > 0) pids.push(fromEnv);
  pids.push(process.ppid);
  const grand = parentOf(process.ppid);
  if (grand !== undefined) pids.push(grand);
  return [...new Set(pids)];
}

function parentOf(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    const n = Number(out.trim());
    return Number.isInteger(n) && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function handlePeer(input: PeerInput, deps: PeerDeps = {}): Promise<string> {
  const configDir = deps.configDir ?? claudeConfigDir();
  const pids = deps.pids ?? sessionPids();
  const session = pids.map((pid) => findSessionByPid(pid, configDir)).find((s) => s !== null);
  if (!session) {
    return JSON.stringify({
      error: 'Claude Code 세션 안에서만 쓸 수 있어요. 이 MCP 서버의 부모 세션을 못 찾았어요',
      configDir,
    });
  }
  let sock: string;
  try {
    sock = deps.socket ?? socketPath(peerRoot());
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
  try {
    const res = await request<AskResult>(sock, {
      op: 'ask',
      sessionId: session.sessionId,
      question: input.question,
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.timeoutSecs !== undefined ? { timeoutSecs: input.timeoutSecs } : {}),
    });
    if (!res.ok) return JSON.stringify({ error: res.error });
    return JSON.stringify({
      ...res.result,
      note: '질문을 보냈다. 답은 기다리지 말고 하던 일을 이어 간다. 답은 <peer-answer from=… question=… verified> 메시지로 이 세션에 들어온다. expiresAt이 지나면 더 안 온다.',
    });
  } catch (err) {
    if (err instanceof DaemonUnavailableError) return JSON.stringify({ error: err.message });
    return JSON.stringify({ error: (err as Error).message });
  }
}
