import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { isToolsLevel } from './redact.js';
import type { ToolsLevel } from './redact.js';
import { ensurePrivateDir, MAX_SOCKET_PATH_BYTES, socketPath, statePath } from './paths.js';
import { PeerState } from './state.js';
import type { ShareCloseReason } from './state.js';
import { ShareStream } from './share.js';
import { ViewerServer } from './viewer.js';
import { DEFAULT_EXPIRES_MINUTES, MAX_EXPIRES_MINUTES, MAX_REQUEST_BYTES } from './protocol.js';
import type { DaemonStatus, PeerRequest, PeerResponse, ShareInfo } from './protocol.js';
import { isSessionId } from './locate.js';

export interface PeerDaemonOptions {
  root: string;
  /** 기본은 `<root>/state.db`. 테스트는 `.gestalt-test/peer-*.db`를 넘긴다 */
  dbPath?: string;
  /** 대화 기록을 다시 읽는 간격 */
  pollMs?: number;
  /** 가리기에서 `~`로 바꿀 홈. 테스트가 가짜 홈을 넣는다 */
  home?: string;
}

interface OpenShare {
  stream: ShareStream;
  token: string;
  sessionId: string | null;
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
 * `gestalt peer daemon`. 공유를 들고 대화 기록을 따라 읽어 로컬 뷰어로 흘린다.
 *
 * 바깥으로 나가는 연결이 하나도 없다. 소켓은 0600, 디렉토리는 0700이라 같은 OS
 * 사용자만 명령을 넣는다. 뷰어는 `127.0.0.1`에만 붙는다.
 */
export class PeerDaemon {
  private ipc: Server | null = null;
  private viewer: ViewerServer;
  private state: PeerState | null = null;
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

  constructor(private readonly options: PeerDaemonOptions) {
    this.sock = socketPath(options.root);
    this.tmpSock = join(options.root, `${process.pid}.s`);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.viewer = new ViewerServer({
      lookup: (id) => {
        const s = this.shares.get(id);
        return s ? { stream: s.stream, token: s.token } : undefined;
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
    await this.clearStaleSocket();

    const state = new PeerState(this.options.dbPath ?? statePath(this.options.root));
    this.state = state;
    try {
      for (const id of state.closeDangling('daemon_restart')) {
        state.audit('share_close', id, 'daemon_restart');
      }
      await this.viewer.start(0);
      await this.listenIpc();
    } catch (err) {
      // stop()은 부르지 않는다. 여기까지 연 건 뷰어와 DB뿐이고 stop은 소켓 자리까지
      // 치우는 경로라 반쯤 뜬 데몬이 이미 떠 있는 다른 데몬의 자리를 건드릴 수 있다
      await this.viewer.stop();
      state.close();
      this.state = null;
      throw err;
    }
    this.startedAt = Date.now();

    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.shares.keys()]) this.closeShare(id, 'daemon_stop');
    const ipc = this.ipc;
    this.ipc = null;
    try {
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
      this.removeOwnSocket();
      this.state?.close();
      this.state = null;
    }
  }

  /** 테스트가 타이머를 기다리지 않고 한 번 돌릴 때 쓴다 */
  tick(now = Date.now()): void {
    for (const [id, share] of [...this.shares]) {
      try {
        if (now >= share.expiresAt) {
          this.closeShare(id, 'expired');
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
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[peer] share ${id} failed: ${msg}\n`);
        try {
          this.closeShare(id, 'error');
        } catch {
          // 감사 로그 쓰기까지 실패해도 공유는 이미 맵에서 빠졌다
        }
      }
    }
  }

  handle(req: PeerRequest): PeerResponse {
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
          return { ok: false, error: `열린 공유가 아니에요: ${String(req.id)}` };
        }
        this.closeShare(req.id, 'unshare');
        return { ok: true, result: { id: req.id } };
      }
      default:
        return { ok: false, error: `모르는 요청이에요: ${String((req as { op?: unknown }).op)}` };
    }
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
    const createdAt = Date.now();
    const expiresAt = createdAt + Math.round(minutes * 60_000);
    const stream = new ShareStream({ id, transcriptPath: real, tools, home: this.options.home });
    stream.poll();

    this.shares.set(id, { stream, token, sessionId: req.sessionId ?? null, createdAt, expiresAt });
    this.state!.insertShare({
      id,
      sessionId: req.sessionId ?? null,
      transcriptPath: real,
      tools,
      createdAt,
      expiresAt,
    });
    this.state!.audit('share_open', id, JSON.stringify({ tools, expiresAt }));
    return { ok: true, result: this.info(id) };
  }

  private closeShare(id: string, reason: ShareCloseReason): void {
    const share = this.shares.get(id);
    if (!share) return;
    this.shares.delete(id);
    share.stream.close(reason);
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
      url: `http://127.0.0.1:${this.viewer.port}/s/${id}?t=${s.token}`,
    };
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
    };
  }

  /**
   * 남은 소켓 파일을 치운다. 누가 받고 있으면 데몬이 이미 떠 있는 거라 던진다.
   * 소켓이 아닌 파일이면 안 지운다 — 경로를 잘못 줬을 때 남의 파일을 지우지 않게.
   *
   * 살아 있는지 본 뒤 지우기 전 사이에 다른 데몬이 새 소켓을 만들면 그걸 지울 수 있다.
   * 지우기 직전에 같은 파일인지 한 번 더 보지만 그 틈까지 막지는 못한다.
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
        if (line.trim() !== '') socket.write(JSON.stringify(this.answer(line)) + '\n');
        nl = buf.indexOf('\n');
      }
    });
  }

  private answer(line: string): PeerResponse {
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
      return this.handle(req as PeerRequest);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function sameFile(path: string, id: FileId): boolean {
  try {
    const st = lstatSync(path);
    return st.dev === id.dev && st.ino === id.ino;
  } catch {
    return false;
  }
}
