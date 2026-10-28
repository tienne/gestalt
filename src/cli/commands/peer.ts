import { isAbsolute, resolve } from 'node:path';
import { PeerDaemon } from '../../peer/daemon.js';
import { DaemonUnavailableError, request } from '../../peer/client.js';
import { errMessage } from '../../peer/errors.js';
import { claudeConfigDir, locateTranscript } from '../../peer/locate.js';
import { peerRoot, socketPath } from '../../peer/paths.js';
import { isToolsLevel } from '../../peer/redact.js';
import type { DaemonStatus, PeerRequest, ShareInfo } from '../../peer/protocol.js';
import { VIEWER_WARNING } from '../../peer/viewer-html.js';

interface PeerOptions {
  json?: boolean;
}

/** 데몬이 안 떠 있을 때의 종료 코드. 다른 실패(1)와 나눠 스크립트가 구분하게 한다 */
const EXIT_NO_DAEMON = 3;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function resolveRoot(): string {
  try {
    return peerRoot();
  } catch (e) {
    fail(errMessage(e));
  }
}

async function call<T>(req: PeerRequest): Promise<T> {
  const root = resolveRoot();
  try {
    const res = await request<T>(socketPath(root), req);
    if (!res.ok) fail(res.error);
    return res.result;
  } catch (e) {
    if (e instanceof DaemonUnavailableError) fail(e.message, EXIT_NO_DAEMON);
    fail(errMessage(e));
  }
}

function time(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function makeStopHandler(
  daemon: Pick<PeerDaemon, 'stop'>,
  exit: (code: number) => void,
  logErr: (message: string) => void = (message) => console.error(message),
): () => void {
  let stopping = false;
  return () => {
    // 정리가 걸려도 사용자가 빠져나갈 길은 남겨 둔다
    if (stopping) {
      exit(1);
      return;
    }
    stopping = true;
    void daemon.stop().then(
      () => exit(0),
      (e: unknown) => {
        logErr(errMessage(e));
        exit(1);
      },
    );
  };
}

export async function peerDaemonCommand(): Promise<void> {
  const root = resolveRoot();
  const daemon = new PeerDaemon({ root });
  try {
    await daemon.start();
  } catch (e) {
    fail(`peer 데몬을 못 띄웠어요: ${errMessage(e)}`);
  }

  console.log(`peer 데몬이 떴어요. 소켓 ${daemon.socketPath}, 뷰어 포트 ${daemon.viewerPort}`);
  console.log('Ctrl+C로 멈춰요. 멈추는 중에 한 번 더 누르면 바로 끝나요.');

  const stop = makeStopHandler(daemon, (code) => process.exit(code));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // 타이머가 unref라 이벤트 루프를 붙잡는 건 서버 소켓뿐이다. 그걸로 충분하다
}

export async function peerShareCommand(
  options: PeerOptions & {
    session?: string;
    transcript?: string;
    tools?: string;
    expires?: string;
  },
): Promise<void> {
  if (!!options.session === !!options.transcript) {
    fail('--session과 --transcript 중 하나만 주세요');
  }
  if (options.tools !== undefined && !isToolsLevel(options.tools)) {
    fail('--tools는 full, summary, none 중 하나예요');
  }
  let expiresMinutes: number | undefined;
  if (options.expires !== undefined) {
    expiresMinutes = Number(options.expires);
    if (!Number.isFinite(expiresMinutes) || expiresMinutes <= 0)
      fail('--expires는 분 단위 양수예요');
  }

  let transcriptPath: string;
  let sessionId: string | undefined;
  if (options.session) {
    // 세션을 찾는 건 부르는 쪽 환경이다. 데몬은 다른 CLAUDE_CONFIG_DIR로 떴을 수 있다
    const found = locateTranscript(options.session, claudeConfigDir());
    if (!found.ok) {
      fail(
        `대화 기록을 못 찾았어요: ${found.reason}\n  설정 디렉토리: ${found.configDir}\n  sessionId: ${options.session}`,
      );
    }
    transcriptPath = found.path;
    sessionId = found.sessionId;
  } else {
    const raw = options.transcript!;
    transcriptPath = isAbsolute(raw) ? raw : resolve(raw);
  }

  const info = await call<ShareInfo>({
    op: 'share',
    transcriptPath,
    sessionId,
    tools: options.tools as 'full' | 'summary' | 'none' | undefined,
    expiresMinutes,
  });

  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`공유를 열었어요 (${info.id}). 만료 ${time(info.expiresAt)}`);
  console.log(`이 세션의 대화와 도구 출력이 뷰어에 보여요. ${VIEWER_WARNING}`);
  console.log(`\n${info.url}\n`);
}

export async function peerSharesCommand(options: PeerOptions): Promise<void> {
  const list = await call<ShareInfo[]>({ op: 'shares' });
  if (options.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('열린 공유가 없어요.');
    return;
  }
  for (const s of list) {
    const title = s.title ? ` "${s.title}"` : '';
    console.log(
      `${s.id}${title}  ${s.status}  보는 사람 ${s.viewers}  도구 ${s.tools}  만료 ${time(s.expiresAt)}`,
    );
    console.log(`  ${s.url}`);
  }
}

export async function peerUnshareCommand(options: PeerOptions & { id: string }): Promise<void> {
  const result = await call<{ id: string }>({ op: 'unshare', id: options.id });
  if (options.json) console.log(JSON.stringify(result));
  else console.log(`공유를 종료했어요 (${result.id}).`);
}

export async function peerStatusCommand(options: PeerOptions): Promise<void> {
  const status = await call<DaemonStatus>({ op: 'status' });
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`peer 데몬 pid ${status.pid}, ${time(status.startedAt)}부터`);
  console.log(`  루트 ${status.root}`);
  console.log(
    `  뷰어 포트 ${status.viewerPort}, 열린 공유 ${status.shares}, 보는 사람 ${status.viewers}`,
  );
}
