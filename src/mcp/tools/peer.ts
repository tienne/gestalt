import { execFileSync } from 'node:child_process';
import { request } from '../../peer/client.js';
import { errMessage } from '../../peer/errors.js';
import { claudeConfigDir, findSessionByPid } from '../../peer/locate.js';
import { plainLabel } from '../../peer/message.js';
import { peerRoot, socketPath } from '../../peer/paths.js';
import type {
  AgentSendResult,
  AskResult,
  DaemonStatus,
  PeekResult,
  PeerRequest,
  ShareInfo,
  WatchListItem,
} from '../../peer/protocol.js';
import { isPersonName, isShareId } from '../../peer/roster.js';
import type { PeerInput } from '../schemas.js';

/**
 * `ges_peer` 핸들러. action은 ask_user, peek, send, status, list다. 공유를 열고 닫거나 사람을 받고 끊는
 * action은 없다. 그런 일은 사람이 부른 /gestalt:share 스킬이 CLI로 한다.
 *
 * ask_user: MCP 서버는 세션의 자식이라 부모 pid로 `sessions/<pid>.json`을 찾아 지금 세션 id를 안다. 세션
 * id는 `/clear`나 다시 이어 받기로 바뀔 수 있어서 부를 때마다 다시 읽는다. 질문은 보내고 바로 돌아온다 —
 * 답을 기다리며 도구 호출을 붙잡으면 그동안 세션이 멈춘다.
 *
 * peek: 이 세션이 아니라 이 머신의 데몬이 보고 있는 원격 공유의 요약을 받는다. 세션 id는 안 쓴다. 답은
 * 틀로 감싼 글자 그대로 돌려준다. 모델은 그 틀 문구로 요약이 남의 세션 글자라는 걸 안다.
 *
 * send: 보고 있는 원격 공유의 주인 세션에 `origin="agent"` 메시지를 넣는다. 답은 주인 세션 대화 기록에
 * 남으므로 기다리지 않고 다음 peek의 replies로 본다.
 *
 * status, list: 읽기만 한다. 원격에서 온 글자(사람 이름, 세션 제목)는 모델 컨텍스트로 들어가므로 한 줄
 * 라벨로 정리해 싣는다. 뷰어 주소와 링크는 싣지 않는다. 링크의 공유 키와 뷰어 토큰은 비밀값이라서
 * 모델이 알면 남에게 옮길 수 있다.
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
  if (input.action === 'peek') return handlePeek(input, deps);
  if (input.action === 'send') return handleSend(input, deps);
  if (input.action === 'status') return handleStatus(deps);
  if (input.action === 'list') return handleList(input, deps);
  if (input.question === undefined)
    return JSON.stringify({ error: 'ask_user는 question이 필요해요' });
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
    return JSON.stringify({ error: errMessage(err) });
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
    return JSON.stringify({ error: errMessage(err) });
  }
}

async function handlePeek(input: PeerInput, deps: PeerDeps): Promise<string> {
  if (input.share === undefined) {
    return JSON.stringify({
      error: 'peek은 share가 필요해요. 링크의 공유 id나 사용자가 알려 준 공유 id를 넣어 주세요',
    });
  }
  let sock: string;
  try {
    sock = deps.socket ?? socketPath(peerRoot());
  } catch (err) {
    return JSON.stringify({ error: errMessage(err) });
  }
  try {
    // 주인 데몬이 답하길 기다린다. 데몬 쪽 시한(10초)보다 넉넉하게 둔다
    const res = await request<PeekResult>(
      sock,
      {
        op: 'peek',
        share: input.share,
        ...(input.since !== undefined ? { since: input.since } : {}),
      },
      15_000,
    );
    if (!res.ok) return JSON.stringify({ error: res.error });
    return res.result.text;
  } catch (err) {
    return JSON.stringify({ error: errMessage(err) });
  }
}

/**
 * 데몬에 한 번 묻는다. 실패는 던지지 않고 오류 글자로 돌려준다. 오류에는 릴레이나 주인 데몬이 보낸
 * 글자가 섞일 수 있어서(릴레이가 전달 실패에 실은 이유 같은) 한 줄 라벨로 정리한다
 */
async function ask<T>(
  deps: PeerDeps,
  req: PeerRequest,
  timeoutMs?: number,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const sock = deps.socket ?? socketPath(peerRoot());
    const res = await request<T>(sock, req, timeoutMs);
    return res.ok ? res : { ok: false, error: plainLabel(res.error, 300) ?? '데몬이 실패했어요' };
  } catch (err) {
    return { ok: false, error: plainLabel(errMessage(err), 300) ?? '데몬에 묻지 못했어요' };
  }
}

async function handleSend(input: PeerInput, deps: PeerDeps): Promise<string> {
  if (input.share === undefined || input.body === undefined) {
    return JSON.stringify({
      error: 'send는 share와 body가 필요해요. share는 list나 status의 watches에 있는 공유 id예요',
    });
  }
  // 릴레이가 넘기거나 들고 있을 때까지 기다린다. 주인 데몬이 받았는지는 기다리지 않는다
  const res = await ask<AgentSendResult>(
    deps,
    { op: 'agent_send', share: input.share, body: input.body },
    15_000,
  );
  if (!res.ok) return JSON.stringify({ error: res.error });
  const r = res.result;
  const owner = plainLabel(r.owner, 32) ?? '?';
  const reply =
    r.agentPeek === true
      ? `주인 세션 모델이 답하면 그 답이 다음 peek(share: "${r.share}")의 replies에 보인다. 앞 peek의 cursor를 since로 넘기면 그 뒤 것만 온다.`
      : r.agentPeek === false
        ? '주인이 요약(--agent-peek)을 허락하지 않은 공유라 답을 peek으로 못 본다. 답은 사용자가 뷰어에서 본다.'
        : '주인 데몬이 요약 허용 여부를 알려 주지 않았다(이전 버전). peek이 실패하면 답은 사용자가 뷰어에서 본다.';
  return JSON.stringify({
    id: r.id,
    status: r.status,
    share: r.share,
    owner,
    ...(r.agentPeek !== undefined ? { agentPeek: r.agentPeek } : {}),
    note: `${owner} 님 세션에 "팀원의 에이전트가 보낸 메시지"로 넣었다. status가 queued면 주인 데몬이 오프라인이라 릴레이가 들고 있다. 답은 기다리지 말고 하던 일을 이어 간다. ${reply}`,
  });
}

/** 원격에서 온 이름 목록. 한 줄 라벨로 정리한다 */
function labels(list: string[]): string[] {
  return list.map((n) => plainLabel(n, 32) ?? '?');
}

/** 내가 보고 있는 공유 한 줄. 공유 id 꼴이 아니면 싣지 않는다 */
function watchLine(w: WatchListItem): Record<string, unknown> | null {
  if (!isShareId(w.share)) return null;
  return {
    share: w.share,
    owner: plainLabel(w.owner, 32) ?? '?',
    status: plainLabel(w.status, 32) ?? '?',
    ...(w.messages !== undefined ? { messages: w.messages } : {}),
    ...(w.agentPeek !== undefined ? { agentPeek: w.agentPeek } : {}),
    ...(w.closed !== undefined ? { closed: plainLabel(w.closed, 64) ?? '?' } : {}),
  };
}

function watchLines(list: WatchListItem[]): Record<string, unknown>[] {
  return list.map(watchLine).filter((w): w is Record<string, unknown> => w !== null);
}

async function handleStatus(deps: PeerDeps): Promise<string> {
  // 셋은 서로 기다릴 게 없어서 같이 묻는다. 오류는 status, shares, watches 순으로 본다
  const [status, shares, watches] = await Promise.all([
    ask<DaemonStatus>(deps, { op: 'status' }),
    ask<ShareInfo[]>(deps, { op: 'shares' }),
    ask<WatchListItem[]>(deps, { op: 'watches' }),
  ]);
  if (!status.ok) return JSON.stringify({ error: status.error });
  if (!shares.ok) return JSON.stringify({ error: shares.error });
  if (!watches.ok) return JSON.stringify({ error: watches.error });
  const t = status.result.team;
  return JSON.stringify({
    daemon: { pid: status.result.pid, startedAt: status.result.startedAt },
    team: t
      ? {
          person: plainLabel(t.person, 32) ?? '?',
          relay: plainLabel(t.relay, 200) ?? '?',
          epoch: t.epoch,
          role: t.role,
          connection: t.connection,
        }
      : null,
    shares: shares.result.map((s) => ({
      id: s.id,
      ...(s.title !== undefined ? { title: plainLabel(s.title, 80) ?? '' } : {}),
      format: s.format,
      status: s.status,
      messages: s.messages,
      agentPeek: s.agentPeek,
      expiresAt: s.expiresAt,
      watchers: labels(s.watchers),
      pending: s.pending.map((p) => ({
        person: plainLabel(p.person, 32) ?? '?',
        expiresAt: p.expiresAt,
      })),
      blocked: s.blocked.map((b) => ({
        person: plainLabel(b.person, 32) ?? '?',
        reason: b.reason,
      })),
      peeks: s.peeks.map((p) => ({ person: plainLabel(p.person, 32) ?? '?', at: p.at })),
    })),
    watches: watchLines(watches.result),
    note: '읽기만 한 결과다. 공유를 열고 닫거나 승인 대기를 받아 주거나 끊는 일은 사용자가 /gestalt:share로 한다. 대신 gestalt peer 명령을 치지 않는다. 링크와 뷰어 주소는 비밀값이라 싣지 않았다.',
  });
}

async function handleList(input: PeerInput, deps: PeerDeps): Promise<string> {
  if (input.person !== undefined && !isPersonName(input.person)) {
    return JSON.stringify({ error: 'person은 팀원 이름 꼴이어야 해요' });
  }
  const watches = await ask<WatchListItem[]>(deps, { op: 'watches' });
  if (!watches.ok) return JSON.stringify({ error: watches.error });
  // 이름 꼴(isPersonName)을 통과한 입력이라 정리하기 전 owner와 그대로 비교해도 된다
  const person = input.person;
  const list = watchLines(
    person === undefined ? watches.result : watches.result.filter((w) => w.owner === person),
  );
  return JSON.stringify({
    watches: list,
    note: '이 머신에서 보고 있거나 최근에 끝난 팀원 공유만 보인다. 팀원이 연 다른 공유는 사람이 링크를 받아 gestalt peer watch로 열어야 여기에 생긴다. agentPeek이 true인 공유만 peek이 된다.',
  });
}
