import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { isToolsLevel } from './redact.js';
import type { ToolsLevel } from './redact.js';
import {
  ensurePrivateDir,
  MAX_SOCKET_PATH_BYTES,
  socketPath,
  statePath,
  watchingDir,
} from './paths.js';
import { PeerState } from './state.js';
import type { ShareCloseReason } from './state.js';
import { ShareStream } from './share.js';
import { ViewerServer } from './viewer.js';
import {
  DEFAULT_EXPIRES_MINUTES,
  DEFAULT_FIRST_WATCH_APPROVAL,
  MAX_EXPIRES_MINUTES,
  MAX_REQUEST_BYTES,
} from './protocol.js';
import type {
  ControlResult,
  DaemonStatus,
  PeerConfig,
  PeerRequest,
  PeerResponse,
  PendingWatcher,
  ShareInfo,
} from './protocol.js';
import { isSessionId } from './locate.js';
import { errMessage } from './errors.js';
import { loadOrCreateMachineKey } from './keys.js';
import type { MachineKey } from './keys.js';
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';
import type { DaemonLock } from './lock.js';
import { PeerNetwork, PeerNetworkError } from './network.js';
import type { InboundMessage, PeerNetworkOptions } from './network.js';
import { findInboxSocket, writeInbox } from './inbox.js';
import type { InboxResult } from './inbox.js';
import { frameHeader, frameMessage, plainLabel } from './message.js';
import { isPersonName, isShareId } from './roster.js';
import type { WatchListItem, WatchResult } from './protocol.js';

export interface PeerDaemonOptions {
  root: string;
  /** 기본은 `<root>/state.db`. 테스트는 `.gestalt-test/peer-*.db`를 넘긴다 */
  dbPath?: string;
  /** 대화 기록을 다시 읽는 간격 */
  pollMs?: number;
  /** 가리기에서 `~`로 바꿀 홈. 테스트가 가짜 홈을 넣는다 */
  home?: string;
  /** 릴레이에 다시 붙는 간격 같은 것. 테스트가 줄인다 */
  network?: PeerNetworkOptions['transport'];
  /** 첫 접속 승인을 기다리는 시한. 테스트가 줄인다 */
  approvalTtlMs?: number;
  /** 승인 대기를 긴 안내 문구로 알리는 시간. 테스트가 줄인다 */
  approvalNoticeMs?: number;
}

interface OpenShare {
  stream: ShareStream;
  token: string;
  /** 링크의 `#` 뒤에 붙는 공유 키. 메모리에만 있다 */
  shareKey: string;
  sessionId: string | null;
  /**
   * 팀원 메시지를 받는지. 끄면 deliver를 안 달아 주인 데몬이 messages_off로 거절한다.
   * sessionId가 없는 --transcript 공유도 같다
   */
  messages: boolean;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_POLL_MS = 500;

/** stop이 IPC 서버가 닫히길 기다리는 상한. 넘으면 기다리지 않고 정리를 마친다 */
const STOP_TIMEOUT_MS = 2_000;

interface FileId {
  dev: number;
  ino: number;
}

/**
 * `gestalt peer daemon`. 공유를 들고 대화 기록을 따라 읽어 로컬 뷰어로 흘린다. 팀에
 * 들었으면 팀 릴레이에 붙어 팀원에게 공유를 넘기고 팀원 공유를 받아 로컬 뷰어로 옮긴다.
 *
 * 바깥으로 나가는 연결은 팀 릴레이 하나다. 소켓은 0600, 디렉토리는 0700이라 같은 OS
 * 사용자만 명령을 넣는다. 뷰어는 `127.0.0.1`에만 붙는다.
 */
export class PeerDaemon {
  private ipc: Server | null = null;
  private viewer: ViewerServer;
  private state: PeerState | null = null;
  private network: PeerNetwork | null = null;
  private key: MachineKey | null = null;
  private lock: DaemonLock | null = null;
  private shares = new Map<string, OpenShare>();
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private conns = new Set<Socket>();
  /** 이 데몬이 만든 소켓 파일. stop은 소켓 자리가 아직 이것일 때만 지운다 */
  private ownSocket: FileId | null = null;
  private readonly sock: string;
  /** listen할 임시 이름. 권한을 좁힌 뒤 진짜 이름으로 링크한다 */
  private readonly tmpSock: string;
  private readonly pollMs: number;
  /** 훅 상태 파일을 다시 쓰기로 예약했는지. 한 틱 안의 바뀜을 한 번에 쓴다 */
  private watchingQueued = false;
  /** 세션마다 마지막으로 쓴 훅 출력. 같으면 다시 안 쓴다 */
  private watchingWritten = new Map<string, string>();
  /**
   * 이 프로세스가 시작한 시각을 ps로 읽은 글자. 훅이 같은 pid의 시작 시각과 맞춰 봐서 데몬이 죽은 뒤
   * 그 pid를 받은 다른 프로세스를 데몬으로 믿지 않게 한다. ps를 못 부르면 빈 글자다
   */
  private readonly startStamp = processStartStamp(process.pid);

  constructor(private readonly options: PeerDaemonOptions) {
    this.sock = socketPath(options.root);
    this.tmpSock = join(options.root, `${process.pid}.s`);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.viewer = new ViewerServer({
      lookup: (id) => {
        const s = this.shares.get(id);
        if (s) return { stream: s.stream, token: s.token };
        return this.network?.lookupWatch(id);
      },
      onConnect: (id) => this.state?.audit('viewer_connect', id),
      onDisconnect: (id) => this.state?.audit('viewer_disconnect', id),
    });
  }

  get socketPath(): string {
    return this.sock;
  }

  get viewerPort(): number | undefined {
    return this.viewer.port;
  }

  async start(): Promise<void> {
    for (const path of [this.sock, this.tmpSock]) {
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
        throw new Error(`소켓 경로가 너무 길어요(${MAX_SOCKET_PATH_BYTES}바이트 한도): ${path}`);
      }
    }
    ensurePrivateDir(this.options.root);
    const lock = await acquireDaemonLock(this.options.root, this.sock);
    let state: PeerState | null = null;
    try {
      await this.clearStaleSocket();
      state = new PeerState(this.options.dbPath ?? statePath(this.options.root));
      this.state = state;
      for (const id of state.closeDangling('daemon_restart')) {
        state.audit('share_close', id, 'daemon_restart');
      }
      this.key = loadOrCreateMachineKey(this.options.root);
      // 죽은 데몬이 남긴 보는 중 표시를 치운다. 훅은 pid도 보지만 그 pid를 다른 프로세스가 받을 수 있다
      this.clearWatching();
      await this.viewer.start(0);
      await this.listenIpc();
    } catch (err) {
      // stop()은 부르지 않는다. 여기까지 연 건 뷰어와 DB뿐이고 stop은 소켓 자리까지
      // 치우는 경로라 반쯤 뜬 데몬이 이미 떠 있는 다른 데몬의 자리를 건드릴 수 있다
      await this.viewer.stop();
      state?.close();
      this.state = null;
      releaseDaemonLock(lock);
      throw err;
    }
    this.lock = lock;
    this.network = new PeerNetwork({
      state,
      key: this.key,
      lookupShare: (id) => {
        const s = this.shares.get(id);
        if (!s) return undefined;
        return {
          stream: s.stream,
          shareKey: s.shareKey,
          // 인박스 소켓은 세션 id로 찾으므로 --transcript로 연 공유는 메시지를 못 받는다
          ...(s.messages && s.sessionId
            ? {
                deliver: (m: InboundMessage, onSeen: () => void) =>
                  this.deliverMessage(id, m, onSeen),
              }
            : {}),
        };
      },
      transport: this.options.network,
      approvalTtlMs: this.options.approvalTtlMs,
      approvalNoticeMs: this.options.approvalNoticeMs,
      onControlChange: () => this.scheduleWatching(),
    });
    this.network.start();
    this.startedAt = Date.now();

    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.shares.keys()]) this.closeShareSafely(id, 'daemon_stop');
    const ipc = this.ipc;
    this.ipc = null;
    const network = this.network;
    this.network = null;
    try {
      await network?.stop().catch((err: unknown) => {
        process.stderr.write(`[peer] network stop failed: ${errMessage(err)}\n`);
      });
      await this.viewer.stop();
      if (ipc) {
        // 열린 연결이 남아 있으면 close 콜백이 안 불려 stop이 끝나지 않는다
        for (const c of this.conns) c.destroy();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
          ipc.close(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } finally {
      this.clearWatching();
      this.removeOwnSocket();
      this.state?.close();
      this.state = null;
      if (this.lock) releaseDaemonLock(this.lock);
      this.lock = null;
    }
  }

  /** 테스트가 타이머를 기다리지 않고 한 번 돌릴 때 쓴다 */
  tick(now = Date.now()): void {
    for (const [id, share] of [...this.shares]) {
      try {
        if (now >= share.expiresAt) {
          this.closeShareSafely(id, 'expired');
          continue;
        }
        const before = share.stream.unknownLines;
        const { unknownGrew } = share.stream.poll();
        if (unknownGrew) {
          const added = share.stream.unknownLines - before;
          this.state?.audit(
            'unknown_lines',
            id,
            JSON.stringify({ added, claudeVersion: share.stream.claudeVersion ?? null }),
          );
        }
      } catch (err) {
        // setInterval 밖으로 던지면 데몬이 죽는다. 그 공유만 종료하고 나머지는 계속 돈다
        process.stderr.write(`[peer] share ${id} failed: ${errMessage(err)}\n`);
        this.closeShareSafely(id, 'error');
      }
    }
  }

  /**
   * closeShare는 DB에 쓰다가 던질 수 있다. tick에서 던지면 뒤 공유를 못 돌고 stop에서
   * 던지면 뷰어와 IPC 서버와 소켓 파일 정리까지 건너뛴다. unshare에서 던지면 공유는 이미
   * 종료됐는데 실패로 답해서 다시 unshare하면 열린 공유가 아니라고 나온다. 공유는 던지기
   * 전에 이미 맵에서 빠지므로 남는 건 DB 기록 하나다.
   */
  private closeShareSafely(id: string, reason: ShareCloseReason): void {
    try {
      this.closeShare(id, reason);
    } catch (err) {
      process.stderr.write(`[peer] share ${id} close failed: ${errMessage(err)}\n`);
    }
  }

  handle(req: PeerRequest): PeerResponse | Promise<PeerResponse> {
    switch (req.op) {
      case 'ping':
        return { ok: true, result: 'pong' };
      case 'status':
        return { ok: true, result: this.status() };
      case 'shares':
        return { ok: true, result: [...this.shares.keys()].map((id) => this.info(id)!) };
      case 'share':
        return this.openShare(req);
      case 'unshare': {
        if (typeof req.id !== 'string' || !this.shares.has(req.id)) {
          return { ok: false, error: `열린 공유가 아니에요: ${plainLabel(req.id) ?? ''}` };
        }
        // 끊기는 사람을 닫기 전에 센다. 닫으면 구독이 끝나 목록이 빈다
        const ended = this.network?.shareControl(req.id).watchers ?? [];
        this.closeShareSafely(req.id, 'unshare');
        return { ok: true, result: { id: req.id, watchers: ended } };
      }
      case 'kick':
      case 'approve':
      case 'deny':
        return this.control(req);
      case 'config':
        return this.config(req);
      case 'init':
        return this.withNetwork((n) => n.init(String(req.person), String(req.relay)));
      case 'invite':
        return this.withNetwork((n) => n.invite(String(req.person)));
      case 'join': {
        const timeout = req.timeoutMs;
        return this.withNetworkAsync((n) =>
          n.join(String(req.code), Number.isFinite(timeout) && timeout! > 0 ? timeout : undefined),
        );
      }
      case 'remove':
        return this.withNetwork((n) => n.remove(String(req.person)));
      case 'members':
        return this.withNetwork((n) => n.members());
      case 'watch':
        return this.withNetworkAsync(async (n): Promise<WatchResult> => {
          const w = await n.watch(String(req.link));
          return {
            id: w.id,
            share: w.share,
            owner: w.owner,
            url: this.viewerUrl(w.id, w.token),
            ...(w.waiting ? { waiting: true } : {}),
          };
        });
      case 'watches':
        return this.withNetwork((n): WatchListItem[] =>
          n.listWatches().map((w) => {
            const live = n.lookupWatch(w.id);
            return live ? { ...w, url: this.viewerUrl(w.id, live.token) } : w;
          }),
        );
      case 'send': {
        const watch = String(req.watch);
        const body = req.body;
        return this.withNetworkAsync((n) => n.sendMessage(watch, String(body), 'human'));
      }
      case 'messages': {
        if (req.watch !== undefined) {
          const watch = String(req.watch);
          return this.withNetwork((n) => n.listMessages(watch));
        }
        return { ok: true, result: this.state?.messageLog() ?? [] };
      }
      case 'unwatch': {
        const id = String(req.id);
        return this.withNetwork((n) => {
          if (!n.unwatch(id)) throw new PeerNetworkError(`보고 있는 공유가 아니에요: ${id}`);
          return { id };
        });
      }
      default:
        return { ok: false, error: `모르는 요청이에요: ${String((req as { op?: unknown }).op)}` };
    }
  }

  /** kick, approve, deny. share가 없으면 열린 공유 전부에 건다 */
  private control(
    req: Extract<PeerRequest, { op: 'kick' | 'approve' | 'deny' }>,
  ): PeerResponse<ControlResult> {
    if (!isPersonName(req.person)) return { ok: false, error: '이름 꼴이 아니에요' };
    let ids: string[];
    if (req.share !== undefined) {
      if (!isShareId(req.share) || !this.shares.has(req.share)) {
        return { ok: false, error: `열린 공유가 아니에요: ${plainLabel(req.share) ?? ''}` };
      }
      ids = [req.share];
    } else {
      ids = [...this.shares.keys()];
      if (ids.length === 0) return { ok: false, error: '열린 공유가 없어요' };
    }
    const { op, person } = req;
    return this.withNetwork((n) => CONTROL_OPS[op](n, person, ids));
  }

  private config(req: Extract<PeerRequest, { op: 'config' }>): PeerResponse<PeerConfig> {
    const state = this.state;
    if (!state) return { ok: false, error: '데몬이 아직 안 떴어요' };
    if (req.firstWatch !== undefined) {
      if (req.firstWatch !== 'ask' && req.firstWatch !== 'team') {
        return { ok: false, error: '--first-watch는 ask, team 중 하나예요' };
      }
      state.setSettings({ ...state.getSettings(), firstWatch: req.firstWatch });
      const revoked = this.network?.setFirstWatch(req.firstWatch) ?? 0;
      return { ok: true, result: { firstWatch: req.firstWatch, revoked } };
    }
    return {
      ok: true,
      result: { firstWatch: state.getSettings().firstWatch ?? DEFAULT_FIRST_WATCH_APPROVAL },
    };
  }

  private withNetwork<T>(fn: (n: PeerNetwork) => T): PeerResponse<T> {
    if (!this.network) return { ok: false, error: '데몬이 아직 안 떴어요' };
    try {
      return { ok: true, result: fn(this.network) };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  private async withNetworkAsync<T>(fn: (n: PeerNetwork) => Promise<T>): Promise<PeerResponse<T>> {
    if (!this.network) return { ok: false, error: '데몬이 아직 안 떴어요' };
    try {
      return { ok: true, result: await fn(this.network) };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  /**
   * 팀원이 보낸 메시지를 주인 세션 인박스에 쓴다. 들어간 게 대화 기록에 보이면 대화 흐름에
   * 끼우고 onSeen을 부른다. 지켜보는 일은 쓰기 전에 걸어야 쓰자마자 생긴 줄을 놓치지 않는다.
   */
  private async deliverMessage(
    shareId: string,
    m: InboundMessage,
    onSeen: () => void,
  ): Promise<InboxResult> {
    const share = this.shares.get(shareId);
    if (!share) return { ok: false, reason: 'share_closed' };
    const found = findInboxSocket(share.stream.transcriptPath, share.sessionId);
    if (!found.ok || !found.path)
      return { ok: false, reason: found.ok ? '인박스 소켓이 없어요' : found.reason };
    const stream = share.stream;
    const header = frameHeader(m.person, m.origin, m.id);
    stream.awaitMessage(header, () => {
      stream.pushPeerMessage({ id: m.id, from: m.person, origin: m.origin, text: m.body });
      onSeen();
    });
    const result = await writeInbox(
      found.path,
      frameMessage({ from: m.person, origin: m.origin, id: m.id, body: m.body }),
    );
    if (!result.ok) stream.cancelAwait(header);
    return result;
  }

  private viewerUrl(id: string, token: string): string {
    return `http://127.0.0.1:${this.viewer.port}/s/${id}?t=${token}`;
  }

  private announceShares(): void {
    this.network?.announce([...this.shares.keys()]);
  }

  private openShare(req: Extract<PeerRequest, { op: 'share' }>): PeerResponse {
    const path = req.transcriptPath;
    if (typeof path !== 'string' || !isAbsolute(path)) {
      return { ok: false, error: 'transcriptPath는 절대경로여야 해요' };
    }
    // 아무 파일이나 열지 못하게 대화 기록 꼴만 받는다
    if (!path.endsWith('.jsonl')) return { ok: false, error: '.jsonl 파일만 공유할 수 있어요' };
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return { ok: false, error: `대화 기록 파일이 없어요: ${path}` };
    }
    // `x.jsonl -> 다른 파일` 심링크는 이름만 맞는다. 검사와 따라 읽기를 실제 경로에 건다
    if (!real.endsWith('.jsonl')) return { ok: false, error: '.jsonl 파일만 공유할 수 있어요' };
    try {
      if (!statSync(real).isFile()) return { ok: false, error: `파일이 아니에요: ${path}` };
    } catch {
      return { ok: false, error: `대화 기록 파일이 없어요: ${path}` };
    }
    if (req.sessionId !== undefined && !isSessionId(req.sessionId)) {
      return { ok: false, error: 'sessionId 형식이 아니에요' };
    }

    const tools: ToolsLevel = req.tools ?? 'summary';
    if (!isToolsLevel(tools))
      return { ok: false, error: '--tools는 full, summary, none 중 하나예요' };

    const minutes = req.expiresMinutes ?? DEFAULT_EXPIRES_MINUTES;
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_EXPIRES_MINUTES) {
      return { ok: false, error: `--expires는 1~${MAX_EXPIRES_MINUTES}분이에요` };
    }

    const id = randomBytes(6).toString('base64url');
    const token = randomBytes(24).toString('base64url');
    const shareKey = randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = createdAt + Math.round(minutes * 60_000);
    const stream = new ShareStream({ id, transcriptPath: real, tools, home: this.options.home });
    stream.poll();

    this.shares.set(id, {
      stream,
      token,
      shareKey,
      sessionId: req.sessionId ?? null,
      messages: req.messages !== false,
      createdAt,
      expiresAt,
    });
    this.state!.insertShare({
      id,
      sessionId: req.sessionId ?? null,
      transcriptPath: real,
      tools,
      createdAt,
      expiresAt,
    });
    this.state!.audit(
      'share_open',
      id,
      JSON.stringify({ tools, expiresAt, messages: req.messages !== false }),
    );
    this.announceShares();
    return { ok: true, result: this.info(id) };
  }

  private closeShare(id: string, reason: ShareCloseReason): void {
    const share = this.shares.get(id);
    if (!share) return;
    this.shares.delete(id);
    share.stream.close(reason);
    this.network?.forgetShare(id);
    this.scheduleWatching();
    this.announceShares();
    this.state?.closeShare(id, reason);
    this.state?.audit('share_close', id, reason);
  }

  private info(id: string): ShareInfo | undefined {
    const s = this.shares.get(id);
    if (!s) return undefined;
    return {
      id,
      sessionId: s.sessionId,
      transcriptPath: s.stream.transcriptPath,
      tools: s.stream.tools,
      messages: s.messages && s.sessionId !== null,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      status: s.stream.currentStatus,
      viewers: s.stream.viewerCount,
      events: s.stream.eventCount,
      unknownLines: s.stream.unknownLines,
      failedLines: s.stream.failedLines,
      oversizedLines: s.stream.oversizedLines,
      droppedEvents: s.stream.droppedEvents,
      title: s.stream.sessionTitle,
      url: this.viewerUrl(id, s.token),
      link: this.network?.linkFor(id, s.shareKey),
      ...(this.network?.shareControl(id) ?? { watchers: [], pending: [], blocked: [] }),
    };
  }

  private scheduleWatching(): void {
    if (this.watchingQueued) return;
    this.watchingQueued = true;
    setImmediate(() => {
      this.watchingQueued = false;
      this.writeWatching();
    });
  }

  /**
   * 보는 중 표시 훅이 읽을 세션별 상태 파일을 다시 쓴다. 원격으로 보는 사람이나 승인을 기다리는
   * 사람이 있는 세션만 파일이 있다. 훅은 파일이 있으면 적힌 데몬이 살아 있는 한 그 내용을 그대로
   * 내보낸다. 아무도 없는 세션은 파일을 지워서 끊긴 사람이 다음 프롬프트에 계속 보이지 않게 한다.
   * `--transcript`로 연 공유는 세션 id가 없어서 표시하지 않는다.
   *
   * 마지막에 쓴 내용을 세션마다 기억해 같은 내용이면 건너뛰고 쓰기와 지우기는 파일마다 따로 실패를
   * 처리한다. 디렉토리를 못 만들면 그 차례는 아무것도 안 쓴다.
   */
  private writeWatching(): void {
    const network = this.network;
    if (!network || !this.state) return;
    const sessions = new Map<string, { watchers: Set<string>; pending: PendingWatcher[] }>();
    for (const [id, s] of this.shares) {
      if (!s.sessionId) continue;
      const c = network.shareControl(id);
      if (c.watchers.length === 0 && c.pending.length === 0) continue;
      let entry = sessions.get(s.sessionId);
      if (!entry) {
        entry = { watchers: new Set(), pending: [] };
        sessions.set(s.sessionId, entry);
      }
      for (const w of c.watchers) entry.watchers.add(w);
      entry.pending.push(...c.pending);
    }
    const dir = watchingDir(this.options.root);
    for (const sessionId of [...this.watchingWritten.keys()]) {
      if (sessions.has(sessionId)) continue;
      try {
        unlinkSync(join(dir, sessionId));
        this.watchingWritten.delete(sessionId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          this.watchingWritten.delete(sessionId);
        else process.stderr.write(`[peer] watching remove failed: ${errMessage(err)}\n`);
      }
    }
    if (sessions.size === 0) return;
    try {
      ensurePrivateDir(dir);
    } catch (err) {
      process.stderr.write(`[peer] watching dir failed: ${errMessage(err)}\n`);
      return;
    }
    for (const [sessionId, e] of sessions) {
      const context = watchingContext([...e.watchers], e.pending);
      const line = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      });
      if (this.watchingWritten.get(sessionId) === line) continue;
      try {
        const tmp = join(dir, `.${sessionId}.tmp`);
        writeFileSync(tmp, `${process.pid}\n${this.startStamp}\n${line}\n`, { mode: 0o600 });
        renameSync(tmp, join(dir, sessionId));
        this.watchingWritten.set(sessionId, line);
      } catch (err) {
        process.stderr.write(`[peer] watching state failed: ${errMessage(err)}\n`);
      }
    }
  }

  private clearWatching(): void {
    this.watchingWritten.clear();
    const dir = watchingDir(this.options.root);
    try {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    } catch (err) {
      process.stderr.write(`[peer] watching cleanup failed: ${errMessage(err)}\n`);
    }
  }

  private status(): DaemonStatus {
    let viewers = 0;
    for (const s of this.shares.values()) viewers += s.stream.viewerCount;
    return {
      pid: process.pid,
      root: this.options.root,
      viewerPort: this.viewer.port ?? 0,
      startedAt: this.startedAt,
      shares: this.shares.size,
      viewers,
      machineKey: this.key?.id ?? '',
      team: this.network?.status() ?? null,
    };
  }

  /**
   * 남은 소켓 파일을 치운다. 누가 받고 있으면 데몬이 이미 떠 있는 거라 던진다.
   * 소켓이 아닌 파일이면 안 지운다 — 경로를 잘못 줬을 때 남의 파일을 지우지 않게.
   *
   * 데몬 잠금(`peer.lock`)을 쥔 뒤에만 부른다. 잠금을 쥔 데몬은 하나라서 확인하고 지우는
   * 사이에 다른 데몬이 새 소켓을 만들 수 없다. 잠금 없이 소켓을 만드는 옛 버전 데몬이
   * 끼어드는 경우만 남아서 지우기 직전에 같은 파일인지 한 번 더 본다.
   */
  private async clearStaleSocket(): Promise<void> {
    if (!existsSync(this.sock)) return;
    const stale = lstatSync(this.sock);
    if (!stale.isSocket()) {
      throw new Error(`소켓 자리에 다른 파일이 있어요: ${this.sock}`);
    }
    const alive = await new Promise<boolean>((resolve) => {
      const c = createConnection(this.sock);
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => resolve(false));
    });
    if (alive) throw new Error(`데몬이 이미 떠 있어요: ${this.sock}`);
    if (sameFile(this.sock, stale)) unlinkSync(this.sock);
  }

  /**
   * 임시 이름으로 listen하고 0600으로 좁힌 뒤 진짜 이름에 하드 링크를 건다.
   *
   * 진짜 이름에 바로 listen하면 net.Server.close가 그 경로를 무조건 지운다(libuv). 그새
   * 다른 데몬이 그 자리를 차지했으면 남의 소켓이 사라진다. 링크는 이름이 이미 있으면
   * 실패하므로 동시에 뜬 데몬끼리 서로 덮어쓰지도 않는다.
   */
  private listenIpc(): Promise<void> {
    const tmp = this.tmpSock;
    if (existsSync(tmp) && lstatSync(tmp).isSocket()) unlinkSync(tmp);
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.serve(socket));
      server.once('error', reject);
      server.listen(tmp, () => {
        server.off('error', reject);
        server.on('error', (err) => process.stderr.write(`[peer] ipc error: ${err.message}\n`));
        try {
          chmodSync(tmp, 0o600);
          linkSync(tmp, this.sock);
        } catch (err) {
          server.close();
          const code = (err as NodeJS.ErrnoException).code;
          reject(code === 'EEXIST' ? new Error(`데몬이 이미 떠 있어요: ${this.sock}`) : err);
          return;
        }
        try {
          unlinkSync(tmp);
        } catch {
          // 남아도 close가 지운다
        }
        const st = lstatSync(this.sock);
        this.ownSocket = { dev: st.dev, ino: st.ino };
        this.ipc = server;
        resolve();
      });
    });
  }

  private removeOwnSocket(): void {
    const own = this.ownSocket;
    this.ownSocket = null;
    if (!own) return;
    try {
      if (sameFile(this.sock, own)) unlinkSync(this.sock);
    } catch {
      // 이미 없으면 그만이다
    }
  }

  private serve(socket: Socket): void {
    let buf = '';
    let rejected = false;
    // 오래 걸리는 요청(join, watch)이 있어도 답은 받은 차례대로 쓴다
    let queue: Promise<void> = Promise.resolve();
    this.conns.add(socket);
    socket.on('close', () => this.conns.delete(socket));
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (rejected) return;
      buf += chunk;
      if (Buffer.byteLength(buf) > MAX_REQUEST_BYTES) {
        rejected = true;
        buf = '';
        // 바로 destroy하면 거절 답이 나가기 전에 끊길 수 있다
        socket.end(JSON.stringify({ ok: false, error: '요청이 너무 커요' }) + '\n', () =>
          socket.destroy(),
        );
        return;
      }
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') {
          queue = queue.then(async () => {
            const res = await this.answer(line);
            if (!socket.destroyed) socket.write(JSON.stringify(res) + '\n');
          });
        }
        nl = buf.indexOf('\n');
      }
    });
  }

  private async answer(line: string): Promise<PeerResponse> {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return { ok: false, error: 'JSON이 아니에요' };
    }
    if (
      typeof req !== 'object' ||
      req === null ||
      typeof (req as { op?: unknown }).op !== 'string'
    ) {
      return { ok: false, error: 'op가 없어요' };
    }
    try {
      return await this.handle(req as PeerRequest);
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }
}

/**
 * 훅이 주인 세션 모델에 붙일 글자. 이름은 명단에서 온 값이지만 모델 컨텍스트로 들어가므로 한 줄
 * 라벨로 정리하고 이름 꼴이 아니면 뺀다. 승인 명령은 모델이 직접 치지 않게 적는다. 주인이
 * 받아 주는 자리를 모델이 대신 채우면 승인이 뜻이 없다.
 */
export function watchingContext(watchers: string[], pending: PendingWatcher[]): string {
  const names = (list: string[]): string[] =>
    [...new Set(list.map((n) => plainLabel(n, 32)).filter(isPersonName))].sort();
  const lines: string[] = [];
  const who = names(watchers);
  if (who.length > 0) {
    lines.push(`[gestalt peer] ${who.join(', ')} 님이 이 세션의 대화를 보는 중이다.`);
  }
  // 긴 안내는 대기가 생기고 잠깐만 붙인다(brief가 서기 전). 프롬프트마다 같은 문장이 컨텍스트에
  // 쌓이지 않게 그 뒤로는 줄인다
  const fresh = names(pending.filter((p) => !p.brief).map((p) => p.person));
  const old = names(pending.map((p) => p.person)).filter((n) => !fresh.includes(n));
  if (fresh.length > 0) {
    lines.push(
      `[gestalt peer] ${fresh.join(', ')} 님이 이 세션을 보려고 주인 승인을 기다린다. ` +
        '사용자에게 알리기만 하고 승인이나 거절 명령은 직접 실행하지 않는다. ' +
        `사용자가 \`gestalt peer approve ${fresh[0]}\`나 \`gestalt peer deny ${fresh[0]}\`로 정한다.`,
    );
  }
  if (old.length > 0) {
    lines.push(`[gestalt peer] 승인 대기: ${old.join(', ')}. 사용자가 정할 일이다.`);
  }
  return lines.join('\n');
}

/**
 * pid의 시작 시각을 ps로 읽어 공백을 뺀 글자로. 훅(`scripts/peer-watching-hook.sh`)이 같은 명령으로
 * 읽어 맞춰 본다. 로캘과 시간대에 따라 글자가 달라지지 않게 LC_ALL=C, TZ=UTC로 부른다. 데몬과 세션이
 * 다른 TZ로 떠도 같은 프로세스면 같은 글자가 나와야 한다.
 */
export function processStartStamp(pid: number): string {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    return out.replace(/\s+/g, '');
  } catch {
    return '';
  }
}

const CONTROL_OPS: Record<
  'kick' | 'approve' | 'deny',
  (n: PeerNetwork, person: string, shares: string[]) => ControlResult
> = {
  kick: (n, person, shares) => n.kick(person, shares),
  approve: (n, person, shares) => n.approve(person, shares),
  deny: (n, person, shares) => n.deny(person, shares),
};

function sameFile(path: string, id: FileId): boolean {
  try {
    const st = lstatSync(path);
    return st.dev === id.dev && st.ino === id.ino;
  } catch {
    return false;
  }
}
