import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PeerDaemon } from '../../peer/daemon.js';
import { DaemonUnavailableError, request } from '../../peer/client.js';
import { errMessage } from '../../peer/errors.js';
import { claudeConfigDir, locateTranscript } from '../../peer/locate.js';
import { codexHome, locateCodexRollout } from '../../peer/codex.js';
import { ensurePrivateDir, peerRoot, socketPath } from '../../peer/paths.js';
import { plainLabel } from '../../peer/message.js';
import { isToolsLevel } from '../../peer/redact.js';
import type {
  ControlResult,
  DaemonStatus,
  MemberInfo,
  PeerConfig,
  PeerRequest,
  ShareInfo,
  WatchListItem,
  WatchResult,
} from '../../peer/protocol.js';
import { RelayServer } from '../../peer/relay.js';
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

async function call<T>(req: PeerRequest, timeoutMs?: number): Promise<T> {
  const root = resolveRoot();
  try {
    const res = await request<T>(socketPath(root), req, timeoutMs);
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
    codex?: string;
    tools?: string;
    expires?: string;
    messages?: boolean;
  },
): Promise<void> {
  if ([options.session, options.transcript, options.codex].filter(Boolean).length !== 1) {
    fail('--session, --transcript, --codex 중 하나만 주세요');
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
  if (options.codex) {
    // Codex 기록을 찾는 것도 부르는 쪽 환경이다. 오르카는 CODEX_HOME을 계정 디렉토리로 옮긴다
    const found = locateCodexRollout(options.codex, codexHome());
    if (!found.ok) {
      fail(`Codex 기록을 못 찾았어요: ${found.reason}\n  CODEX_HOME: ${found.home}`);
    }
    transcriptPath = found.path;
  } else if (options.session) {
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
    ...(options.codex ? { format: 'codex' as const } : {}),
    ...(options.messages === false ? { messages: false } : {}),
  });

  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(`공유를 열었어요 (${info.id}). 만료 ${time(info.expiresAt)}`);
  if (info.format === 'codex') {
    console.log('Codex 세션이라 읽기만 해요. 팀원 메시지와 질문 답은 안 받아요.');
  }
  if (info.link) {
    if (info.messages) {
      console.log(
        '링크를 연 팀원이 이 세션에 메시지를 넣을 수 있어요. 막으려면 --no-messages로 여세요.',
      );
    }
    console.log(`이 세션의 대화와 도구 출력이 링크를 연 팀원에게 보여요. ${VIEWER_WARNING}`);
    console.log(`\n팀원에게 건넬 링크 (# 뒤가 공유 키예요):\n${info.link}`);
    console.log(`\n내 뷰어:\n${info.url}\n`);
    return;
  }
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
    const title = s.title ? ` "${plainLabel(s.title, 80) ?? ''}"` : '';
    const codex = s.format === 'codex' ? ' [codex]' : '';
    console.log(
      `${s.id}${codex}${title}  ${s.status}  보는 사람 ${s.viewers}  도구 ${s.tools}  만료 ${time(s.expiresAt)}`,
    );
    console.log(`  ${s.url}`);
    if (s.link) console.log(`  ${s.link}`);
    // 이름은 명단에서 온 값이지만 원격에서 받은 문서라 한 줄 라벨로 정리해 찍는다
    if (s.watchers.length > 0) console.log(`  원격으로 보는 중: ${names(s.watchers)}`);
    for (const p of s.pending) {
      console.log(
        `  승인 대기: ${names([p.person])} (${time(p.expiresAt)}까지) → gestalt peer approve ${names([p.person])} --share ${s.id}`,
      );
    }
    for (const b of s.blocked) {
      console.log(`  ${b.reason === 'kicked' ? '끊음' : '거절함'}: ${names([b.person])}`);
    }
  }
}

function names(list: string[]): string {
  return list.map((n) => plainLabel(n, 32) ?? '?').join(', ');
}

export async function peerUnshareCommand(options: PeerOptions & { id: string }): Promise<void> {
  const result = await call<{ id: string; watchers?: string[] }>({
    op: 'unshare',
    id: options.id,
  });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`공유를 종료했어요 (${result.id}).`);
  if (result.watchers && result.watchers.length > 0) {
    console.log(`원격으로 보던 ${names(result.watchers)} 님도 끊겼어요.`);
  }
}

type ControlOptions = PeerOptions & { name: string; share?: string };

/** kick, approve, deny가 같이 쓰는 요청과 출력. lines가 사람이 읽을 결과 줄을 만든다 */
async function controlCommand(
  op: 'kick' | 'approve' | 'deny',
  options: ControlOptions,
  lines: (r: ControlResult) => string[],
): Promise<void> {
  const r = await call<ControlResult>({
    op,
    person: options.name,
    ...(options.share ? { share: options.share } : {}),
  });
  if (options.json) {
    console.log(JSON.stringify(r));
    return;
  }
  for (const line of lines(r)) console.log(line);
}

export function peerKickCommand(options: ControlOptions): Promise<void> {
  return controlCommand('kick', options, (r) => [
    `${options.name} 님을 공유 ${r.shares.length}개에서 끊었어요. 끊은 구독 ${r.count}개`,
    '그 공유가 열려 있는 동안 다시 못 붙고 메시지도 못 넣어요. 이미 본 내용은 회수하지 못해요.',
  ]);
}

export function peerApproveCommand(options: ControlOptions): Promise<void> {
  return controlCommand('approve', options, (r) => [
    `${options.name} 님을 받아 줬어요 (공유 ${r.shares.join(', ')}).`,
    '그 공유가 열려 있는 동안은 다시 붙어도 묻지 않아요.',
  ]);
}

export function peerDenyCommand(options: ControlOptions): Promise<void> {
  return controlCommand('deny', options, (r) => [
    `${options.name} 님을 거절했어요 (공유 ${r.shares.join(', ')}).`,
    '그 공유가 열려 있는 동안 다시 붙지 못해요.',
  ]);
}

const FIRST_WATCH_LABEL: Record<string, string> = {
  ask: '물어보기 (처음 붙는 사람은 주인이 받아 줘야 해요)',
  team: '팀원이면 바로 허용',
};

export async function peerConfigCommand(
  options: PeerOptions & { firstWatch?: string },
): Promise<void> {
  // 값 검사는 데몬이 한다. 여기서 또 보면 두 곳의 규칙이 어긋날 수 있다
  const r = await call<PeerConfig>({
    op: 'config',
    ...(options.firstWatch !== undefined
      ? { firstWatch: options.firstWatch as PeerConfig['firstWatch'] }
      : {}),
  });
  if (options.json) {
    console.log(JSON.stringify(r));
    return;
  }
  console.log(`첫 접속: ${FIRST_WATCH_LABEL[r.firstWatch] ?? r.firstWatch}`);
  if (r.revoked && r.revoked > 0) {
    console.log(
      `팀 설정으로 붙어 있던 구독 ${r.revoked}개를 끊었어요. 그 사람들은 다시 승인을 받아야 해요.`,
    );
  }
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
  console.log(`  기기 id ${status.machineKey}`);
  const t = status.team;
  if (!t) {
    console.log('  팀 없음 (`gestalt peer init` 또는 `gestalt peer join <코드>`)');
    return;
  }
  console.log(`  팀 ${t.team} 판 ${t.epoch}, 나는 ${t.person}(${t.role ?? '명단 밖'})`);
  console.log(
    `  릴레이 ${t.relay} ${t.connection}, 원격으로 보는 사람 ${t.remoteViewers}, 보고 있는 공유 ${t.watches}`,
  );
}

export async function peerInitCommand(
  options: PeerOptions & { name?: string; relay?: string },
): Promise<void> {
  if (!options.name || !options.relay) fail('--name과 --relay를 주세요');
  const t = await call<NonNullable<DaemonStatus['team']>>({
    op: 'init',
    person: options.name,
    relay: options.relay,
  });
  if (options.json) {
    console.log(JSON.stringify(t, null, 2));
    return;
  }
  console.log(`팀을 만들었어요. 나는 ${t.person}(관리자), 판 ${t.epoch}`);
  console.log(`\n릴레이를 띄울 머신에서 이걸 실행해 주세요:`);
  console.log(
    `  gestalt peer relay --port ${new URL(t.relay).port || '<포트>'} --team ${t.team}\n`,
  );
}

export async function peerInviteCommand(options: PeerOptions & { name?: string }): Promise<void> {
  if (!options.name) fail('--name을 주세요');
  const r = await call<{ code: string; expiresAt: number }>({ op: 'invite', person: options.name });
  if (options.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(
    `${options.name}에게 건넬 초대 코드예요. 한 번만 쓰이고 ${time(r.expiresAt)}에 만료돼요.`,
  );
  console.log(`비밀번호처럼 다뤄 주세요. 받은 사람이 \`gestalt peer join <코드>\`를 실행해요.\n`);
  console.log(r.code + '\n');
}

export async function peerJoinCommand(
  options: PeerOptions & { code: string; wait?: string },
): Promise<void> {
  const waitSecs = options.wait === undefined ? 60 : Number(options.wait);
  if (!Number.isFinite(waitSecs) || waitSecs <= 0 || waitSecs > 600) fail('--wait는 1~600초예요');
  const t = await call<NonNullable<DaemonStatus['team']>>(
    { op: 'join', code: options.code, timeoutMs: waitSecs * 1000 },
    waitSecs * 1000 + 5_000,
  );
  if (options.json) {
    console.log(JSON.stringify(t, null, 2));
    return;
  }
  console.log(`팀에 들었어요. 나는 ${t.person}, 판 ${t.epoch}, 릴레이 ${t.relay}`);
}

export async function peerRemoveCommand(options: PeerOptions & { name: string }): Promise<void> {
  const r = await call<{ removed: number; epoch: number }>({ op: 'remove', person: options.name });
  if (options.json) {
    console.log(JSON.stringify(r));
    return;
  }
  console.log(`${options.name}의 기기 ${r.removed}대를 뺐어요. 명단 판 ${r.epoch}`);
  console.log('열린 공유에서 바로 끊기고 릴레이에도 다시 못 붙어요.');
}

export async function peerMembersCommand(options: PeerOptions): Promise<void> {
  const list = await call<MemberInfo[]>({ op: 'members' });
  if (options.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  for (const m of list) {
    const me = m.me ? ' (나)' : '';
    console.log(
      `${m.person}${me}  ${m.role}  ${m.online ? '온라인' : '오프라인'}  ${m.machineKey.slice(0, 12)}…`,
    );
  }
}

export async function peerWatchCommand(
  options: PeerOptions & { link: string; open?: boolean },
): Promise<void> {
  const w = await call<WatchResult>({ op: 'watch', link: options.link }, 20_000);
  if (options.json) {
    console.log(JSON.stringify(w, null, 2));
    return;
  }
  console.log(`${w.owner}의 공유(${w.share})를 보기 시작했어요. 보기 id ${w.id}`);
  if (w.waiting) {
    console.log('주인 승인을 기다리는 중이에요. 받아 주면 뷰어에 대화가 보여요.');
  }
  console.log(`\n${w.url}\n`);
  if (options.open !== false) {
    try {
      const { default: open } = await import('open');
      await open(w.url);
    } catch (e) {
      console.error(`브라우저를 못 열었어요: ${errMessage(e)}`);
    }
  }
}

export async function peerWatchesCommand(options: PeerOptions): Promise<void> {
  const list = await call<WatchListItem[]>({ op: 'watches' });
  if (options.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('보고 있는 공유가 없어요.');
    return;
  }
  for (const w of list) {
    const status = w.closed ? closedLabel(w.closed) : (WATCH_STATUS[w.status] ?? w.status);
    console.log(`${w.id}  ${w.owner}/${w.share}  ${status}  이벤트 ${w.events}`);
    if (w.url) console.log(`  ${w.url}`);
  }
}

const WATCH_STATUS: Record<string, string> = {
  live: '실시간',
  waiting: '주인 승인 기다리는 중',
  offline: '주인 데몬 오프라인',
  missing: '주인 대화 기록이 안 보임',
  truncated: '주인 대화 기록이 줄어 멈춤',
};

/** 끝난 보기의 이유. 주인 데몬이 보낸 글자가 섞여서 모르는 값은 정리해 찍는다 */
function closedLabel(reason: string): string {
  switch (reason) {
    case 'kicked':
      return '끝남: 주인이 끊음';
    case 'denied':
      return '끝남: 주인이 거절함';
    case 'approval_timeout':
      return '끝남: 주인 승인을 기다리다 시간이 지남';
    case 'removed':
      return '끝남: 내가 명단에서 빠짐';
    case 'owner_removed':
      return '끝남: 주인이 명단에서 빠짐';
    default:
      return `끝남: ${plainLabel(reason, 64) ?? '?'}`;
  }
}

export async function peerUnwatchCommand(options: PeerOptions & { id: string }): Promise<void> {
  const r = await call<{ id: string }>({ op: 'unwatch', id: options.id });
  if (options.json) console.log(JSON.stringify(r));
  else console.log(`보기를 멈췄어요 (${r.id}).`);
}

const STATUS_LABEL: Record<string, string> = {
  queued: '릴레이가 들고 있음(주인 오프라인)',
  sent: '보냄',
  arrived: '주인 데몬이 받음',
  inserted: '주인 세션에 넣음(보류됐으면 여기서 멈춤)',
  delivered: '들어감',
  rejected: '거절',
};

export async function peerSendCommand(
  options: PeerOptions & { watch: string; body: string[] },
): Promise<void> {
  let body = options.body.join(' ');
  if (body.trim() === '' && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (body.trim() === '') fail('보낼 본문을 인자나 표준 입력으로 주세요');
  const r = await call<{ id: string; status: string }>(
    { op: 'send', watch: options.watch, body },
    15_000,
  );
  if (options.json) {
    console.log(JSON.stringify(r));
    return;
  }
  console.log(`메시지를 보냈어요 (${r.id}). 지금 상태: ${STATUS_LABEL[r.status] ?? r.status}`);
  console.log(`이후 상태는 \`gestalt peer messages ${options.watch}\`나 뷰어에서 봐요.`);
}

export async function peerMessagesCommand(
  options: PeerOptions & { watch?: string },
): Promise<void> {
  if (options.watch) {
    const list = await call<
      { id: string; status: string; text: string; at: number; reason?: string }[]
    >({ op: 'messages', watch: options.watch });
    if (options.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (list.length === 0) console.log('보낸 메시지가 없어요.');
    for (const m of list) {
      const label = plainLabel(m.reason);
      const reason = label ? ` (${label})` : '';
      console.log(
        `${time(m.at)}  ${STATUS_LABEL[m.status] ?? m.status}${reason}  ${m.text.slice(0, 60)}`,
      );
    }
    return;
  }
  const log = await call<
    { at: number; shareId: string | null; action: string; detail: string | null }[]
  >({
    op: 'messages',
  });
  if (options.json) {
    console.log(JSON.stringify(log, null, 2));
    return;
  }
  if (log.length === 0) console.log('주고받은 메시지와 질문 기록이 없어요.');
  for (const r of log) {
    // 공유 id와 거절 이유는 원격에서 온 값이 섞인다. 터미널에 찍기 전에 제어 문자를 지운다
    const share = plainLabel(r.shareId) ?? '-';
    console.log(`${time(r.at)}  ${share}  ${r.action}  ${plainLabel(r.detail, 400) ?? ''}`);
  }
}

export async function peerRelayCommand(options: {
  team?: string;
  port?: string;
  host?: string;
  tlsCert?: string;
  tlsKey?: string;
}): Promise<void> {
  if (!options.team) fail('--team <팀 id>를 주세요. 관리자의 `gestalt peer init` 출력에 있어요');
  const port = options.port === undefined ? 8443 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port는 0~65535예요');
  if (!!options.tlsCert !== !!options.tlsKey) fail('--tls-cert와 --tls-key는 같이 주세요');
  const root = resolveRoot();
  let relay: RelayServer;
  try {
    ensurePrivateDir(join(root, 'relay'));
    relay = new RelayServer({
      team: options.team,
      host: options.host ?? '0.0.0.0',
      port,
      rosterFile: join(root, 'relay', `${options.team}.json`),
      tls: options.tlsCert
        ? { cert: readFileSync(options.tlsCert), key: readFileSync(options.tlsKey!) }
        : undefined,
    });
    await relay.start();
  } catch (e) {
    fail(`릴레이를 못 띄웠어요: ${errMessage(e)}`);
  }
  const scheme = options.tlsCert ? 'wss' : 'ws';
  console.log(`peer 릴레이가 떴어요. ${scheme}://${options.host ?? '0.0.0.0'}:${relay.port}`);
  console.log(
    '대화 내용은 봉인된 채로만 지나가요. 릴레이가 보는 건 보낸 기기, 받는 기기, 크기, 시각이에요.',
  );
  if (!options.tlsCert) {
    console.log('TLS 없이 떠 있어요. 라우팅 정보도 가리려면 --tls-cert와 --tls-key를 주세요.');
  }
  const stop = (): void => {
    void relay.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
