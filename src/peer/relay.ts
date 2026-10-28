import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { isRawKey } from './keys.js';
import { checkRosterUpdate, isAdmin, memberOf } from './roster.js';
import type { RosterVerdict, SignedRoster } from './roster.js';
import { verifyText } from './seal.js';
import { acceptUpgrade } from './ws.js';
import type { WsConnection } from './ws.js';
import { CLOSE_REJECTED, CLOSE_REMOVED, helloSigned } from './wire.js';
import type { ClientFrame, HelloMode, RelayErrorCode, ServerFrame } from './wire.js';
import { errMessage } from './errors.js';
import { MESSAGE_RECEIVE_LIMIT } from './message.js';

export interface RelayServerOptions {
  /** 팀 id. 처음 받는 명단은 이 키가 서명해야 한다 */
  team: string;
  host?: string;
  port?: number;
  /** 받은 명단을 남겨 둘 파일. 릴레이가 다시 떠도 내보낸 기기의 옛 명단을 안 받으려고 둔다 */
  rosterFile?: string;
  tls?: { cert: Buffer; key: Buffer };
  /** 테스트가 릴레이를 지나는 프레임을 들여다볼 때 쓴다 */
  onFrame?: (direction: 'in' | 'out', text: string) => void;
  /** hello를 기다리는 시간 */
  helloTimeoutMs?: number;
  /** join 모드 연결이 명단에 오르기를 기다리는 시간 */
  joinTimeoutMs?: number;
  pingMs?: number;
}

interface Conn {
  ws: WsConnection;
  nonce: string;
  key?: string;
  mode?: HelloMode;
  /** member면 명단에 오른 연결 */
  member: boolean;
  joins: number;
  alive: boolean;
  timer?: NodeJS.Timeout;
}

interface QueuedSend {
  from: string;
  to: string;
  data: string;
  at: number;
}

interface QueuedJoin {
  to: string;
  from: string;
  data: string;
  at: number;
}

/** 받는 쪽 소켓에 이만큼 넘게 밀려 있으면 그 연결을 끊는다. 안 읽는 기기 하나가 릴레이 메모리를 못 붙잡게 한다 */
export const MAX_RELAY_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_JOIN_DATA = 16 * 1024;
const MAX_JOINS_PER_CONN = 3;
const MAX_QUEUED_JOINS = 64;
const JOIN_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ANNOUNCED_PER_CONN = 256;
/** 오프라인 기기에게 온 것을 들고 있는 기간. 설계 원문의 7일 */
export const SEND_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUED_PER_TARGET = 256;
const MAX_QUEUED_TOTAL = 4096;
/** 들고 있을 수 있는 한 건의 크기. 메시지 본문 16KB가 봉인되고 base64로 불어나도 들어간다 */
const MAX_QUEUED_DATA = 64 * 1024;
const SHARE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `gestalt peer relay`. 팀이 한 대 띄우는 WebSocket 중계 서버다.
 *
 * 기기 키로 서명한 challenge로 접속을 받고 명단에 없는 키는 member로 안 받는다. 명단 밖
 * 키는 join 모드로만 붙어 초대한 관리자에게 봉인한 요청 하나를 넘길 수 있다.
 *
 * 대화 기록은 쌓지 않는다. 받는 기기가 없으면 실패로 답한다. 쌓아 두는 건 관리자가 오프라인일
 * 때의 join 요청뿐이고 메모리에만 둔다.
 */
export class RelayServer {
  private server: Server | null = null;
  private roster: SignedRoster | null = null;
  private conns = new Set<Conn>();
  private members = new Map<string, Conn>();
  private pending = new Map<string, Conn>();
  private announced = new Map<string, string>();
  private joinQueue: QueuedJoin[] = [];
  private sendQueue: QueuedSend[] = [];
  private pinger: NodeJS.Timeout | null = null;

  constructor(private readonly options: RelayServerOptions) {
    if (!isRawKey(options.team)) throw new Error('팀 id 꼴이 아니에요 (43자 base64url)');
  }

  get port(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : undefined;
  }

  get epoch(): number {
    return this.roster?.roster.epoch ?? 0;
  }

  /** 오프라인 기기에게 가려고 들고 있는 건수 */
  get queuedSends(): number {
    return this.sendQueue.length;
  }

  /** 지금 member로 붙어 있는 기기 id */
  get onlineKeys(): string[] {
    return [...this.members.keys()];
  }

  async start(): Promise<number> {
    this.loadRosterFile();
    const handler = (_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('gestalt peer relay: WebSocket only\n');
    };
    const server = this.options.tls
      ? createHttpsServer({ cert: this.options.tls.cert, key: this.options.tls.key }, handler)
      : createHttpServer(handler);
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const ws = acceptUpgrade(req, socket, head);
      if (ws) this.accept(ws);
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        server.on('error', (err) => process.stderr.write(`[peer-relay] ${err.message}\n`));
        resolve();
      });
    });
    this.pinger = setInterval(() => this.pingAll(), this.options.pingMs ?? 30_000);
    this.pinger.unref();
    return this.port!;
  }

  async stop(): Promise<void> {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    for (const c of this.conns) c.ws.terminate(1001, 'relay stop');
    this.conns.clear();
    this.members.clear();
    this.pending.clear();
    this.announced.clear();
    this.sendQueue = [];
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(ws: WsConnection): void {
    const conn: Conn = {
      ws,
      nonce: randomBytes(24).toString('base64url'),
      member: false,
      joins: 0,
      alive: true,
    };
    this.conns.add(conn);
    conn.timer = setTimeout(
      () => ws.close(CLOSE_REJECTED, 'hello timeout'),
      this.options.helloTimeoutMs ?? 10_000,
    );
    conn.timer.unref();
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (text: string) => {
      this.options.onFrame?.('in', text);
      try {
        this.onMessage(conn, text);
      } catch (err) {
        process.stderr.write(`[peer-relay] frame failed: ${errMessage(err)}\n`);
        this.reject(conn, 'bad_frame', '프레임을 처리하지 못했어요');
      }
    });
    ws.on('close', () => this.drop(conn));
    this.send(conn, { t: 'challenge', nonce: conn.nonce });
  }

  private onMessage(conn: Conn, text: string): void {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      return this.reject(conn, 'bad_frame', 'JSON이 아니에요');
    }
    if (typeof frame !== 'object' || frame === null || typeof frame.t !== 'string') {
      return this.reject(conn, 'bad_frame', 't가 없어요');
    }
    if (!conn.key) {
      if (frame.t !== 'hello') return this.reject(conn, 'bad_frame', 'hello부터 보내야 해요');
      return this.hello(conn, frame);
    }
    if (!conn.member) {
      if (frame.t === 'join') return this.join(conn, frame);
      return;
    }
    switch (frame.t) {
      case 'send':
        return this.forward(conn, frame);
      case 'resolve': {
        if (!Number.isSafeInteger(frame.id)) return;
        const owner = typeof frame.share === 'string' ? this.announced.get(frame.share) : undefined;
        this.send(conn, { t: 'resolved', id: frame.id, owner: owner ?? null });
        return;
      }
      case 'announce':
        return this.announce(conn, frame.shares);
      case 'roster': {
        const verdict = this.acceptRoster(frame.roster);
        if (!verdict.ok) {
          this.send(conn, { t: 'error', code: 'bad_signature', message: verdict.reason });
        }
        return;
      }
      default:
        return;
    }
  }

  private hello(conn: Conn, frame: Extract<ClientFrame, { t: 'hello' }>): void {
    if (frame.team !== this.options.team) return this.reject(conn, 'wrong_team', '다른 팀이에요');
    if (frame.mode !== 'member' && frame.mode !== 'join') {
      return this.reject(conn, 'bad_frame', 'mode가 틀렸어요');
    }
    if (
      !isRawKey(frame.key) ||
      !verifyText(frame.key, helloSigned(frame.team, conn.nonce, frame.mode), frame.sig)
    ) {
      return this.reject(conn, 'bad_signature', 'hello 서명이 맞지 않아요');
    }
    if (conn.timer) clearTimeout(conn.timer);
    conn.key = frame.key;
    conn.mode = frame.mode;

    // 들고 온 명단이 더 새것이면 받는다. 낮거나 서명이 틀리면 조용히 버린다
    if (frame.roster !== undefined) this.acceptRoster(frame.roster);

    const roster = this.roster;
    if (roster && memberOf(roster.roster, frame.key)) {
      this.admit(conn);
      return;
    }
    if (frame.mode === 'member') {
      if (!roster) return this.reject(conn, 'no_roster', '릴레이가 아직 팀 명단을 못 받았어요');
      return this.reject(conn, 'not_member', '명단에 없는 기기예요', CLOSE_REMOVED);
    }
    const prev = this.pending.get(frame.key);
    if (prev) prev.ws.close(4000, 'replaced');
    this.pending.set(frame.key, conn);
    conn.timer = setTimeout(
      () => conn.ws.close(CLOSE_REJECTED, 'join timeout'),
      this.options.joinTimeoutMs ?? 120_000,
    );
    conn.timer.unref();
    this.send(conn, { t: 'pending' });
  }

  /** member로 올린다. 같은 기기의 이전 연결은 닫는다 */
  private admit(conn: Conn): void {
    const key = conn.key!;
    if (conn.timer) clearTimeout(conn.timer);
    if (this.pending.get(key) === conn) this.pending.delete(key);
    const prev = this.members.get(key);
    if (prev && prev !== conn) {
      this.members.delete(key);
      prev.member = false;
      prev.ws.close(4000, 'replaced');
    }
    conn.member = true;
    this.members.set(key, conn);
    this.send(conn, {
      t: 'welcome',
      roster: this.roster!,
      online: [...this.members.keys()].filter((k) => k !== key),
    });
    this.broadcast({ t: 'presence', key, online: true }, conn);
    this.flushJoins(key);
    this.flushSends(key);
  }

  private forward(conn: Conn, frame: Extract<ClientFrame, { t: 'send' }>): void {
    if (!Number.isSafeInteger(frame.id)) return;
    const ack = (ok: boolean, error?: string, queued?: true): void => {
      if (frame.ack === false) return;
      this.send(conn, {
        t: 'ack',
        id: frame.id,
        ok,
        ...(error ? { error } : {}),
        ...(queued ? { queued } : {}),
      });
    };
    if (typeof frame.to !== 'string' || typeof frame.data !== 'string')
      return ack(false, 'bad_frame');
    const target = this.members.get(frame.to);
    if (!target) {
      if (frame.queue !== true) return ack(false, 'offline');
      return this.enqueueSend(conn.key!, frame.to, frame.data)
        ? ack(true, undefined, true)
        : ack(false, 'queue_full');
    }
    if (target.ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
      target.ws.terminate(1008, 'slow');
      return ack(false, 'slow');
    }
    this.send(target, { t: 'recv', from: conn.key!, data: frame.data });
    ack(true);
  }

  private announce(conn: Conn, shares: unknown): void {
    if (!Array.isArray(shares) || shares.length > MAX_ANNOUNCED_PER_CONN) return;
    const key = conn.key!;
    const wanted = new Set(
      shares.filter((s): s is string => typeof s === 'string' && SHARE_ID.test(s)),
    );
    for (const [id, owner] of [...this.announced]) {
      if (owner === key && !wanted.has(id)) this.announced.delete(id);
    }
    for (const id of wanted) {
      const owner = this.announced.get(id);
      // 먼저 알린 기기가 붙어 있으면 그대로 둔다. 남의 공유 id를 가로채지 못하게
      if (owner && owner !== key && this.members.has(owner)) continue;
      this.announced.set(id, key);
    }
  }

  private join(conn: Conn, frame: ClientFrame): void {
    if (frame.t !== 'join') return;
    conn.joins++;
    if (conn.joins > MAX_JOINS_PER_CONN) {
      return this.reject(conn, 'rate_limited', 'join 요청이 너무 많아요');
    }
    const roster = this.roster;
    if (
      !roster ||
      typeof frame.to !== 'string' ||
      !isAdmin(roster.roster, frame.to) ||
      typeof frame.data !== 'string' ||
      frame.data.length > MAX_JOIN_DATA
    ) {
      return;
    }
    const item: QueuedJoin = { to: frame.to, from: conn.key!, data: frame.data, at: Date.now() };
    const admin = this.members.get(frame.to);
    if (admin) {
      this.send(admin, { t: 'join', from: item.from, data: item.data });
      return;
    }
    // 관리자가 오프라인이면 붙을 때까지 들고 있는다. 같은 기기가 다시 보내면 앞의 것을 바꾼다
    this.joinQueue = this.joinQueue.filter((q) => !(q.from === item.from && q.to === item.to));
    this.joinQueue.push(item);
    if (this.joinQueue.length > MAX_QUEUED_JOINS) this.joinQueue.shift();
  }

  /** 명단에 있는 기기에게 가는 것만 들고 있는다. 상한을 넘으면 받지 않는다 */
  private enqueueSend(from: string, to: string, data: string): boolean {
    const roster = this.roster;
    if (!roster || !memberOf(roster.roster, to) || data.length > MAX_QUEUED_DATA) return false;
    const now = Date.now();
    this.sendQueue = this.sendQueue.filter((q) => now - q.at < SEND_QUEUE_TTL_MS);
    if (this.sendQueue.length >= MAX_QUEUED_TOTAL) return false;
    const forTarget = this.sendQueue.filter((q) => q.to === to);
    if (forTarget.length >= MAX_QUEUED_PER_TARGET) return false;
    // 한 사람이 받는 기기 몫을 혼자 채우지 못하게 한다. 주인 쪽 수신 한도와 같은 숫자다
    if (forTarget.filter((q) => q.from === from).length >= MESSAGE_RECEIVE_LIMIT) return false;
    this.sendQueue.push({ from, to, data, at: now });
    return true;
  }

  private flushSends(key: string): void {
    const now = Date.now();
    const target = this.members.get(key);
    if (!target) return;
    const mine = this.sendQueue.filter((q) => q.to === key);
    this.sendQueue = this.sendQueue.filter((q) => q.to !== key);
    for (const [i, q] of mine.entries()) {
      // 막 붙은 기기가 안 읽으면 남은 건 다시 들고 있는다
      if (target.ws.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
        this.sendQueue.push(...mine.slice(i));
        return;
      }
      if (now - q.at >= SEND_QUEUE_TTL_MS) continue;
      // 그사이 명단에서 빠진 기기가 보낸 건 넘기지 않는다
      if (this.roster && !memberOf(this.roster.roster, q.from)) continue;
      this.send(target, { t: 'recv', from: q.from, data: q.data });
    }
  }

  private flushJoins(key: string): void {
    const now = Date.now();
    this.joinQueue = this.joinQueue.filter((q) => now - q.at < JOIN_QUEUE_TTL_MS);
    const target = this.members.get(key);
    if (!target) return;
    const mine = this.joinQueue.filter((q) => q.to === key);
    this.joinQueue = this.joinQueue.filter((q) => q.to !== key);
    for (const q of mine) this.send(target, { t: 'join', from: q.from, data: q.data });
  }

  /**
   * 명단을 받는다. 받으면 모두에게 돌리고 빠진 기기는 바로 끊고 명단에 새로 오른 join 연결은
   * member로 올린다.
   */
  private acceptRoster(incoming: unknown): RosterVerdict {
    const verdict = checkRosterUpdate(this.roster, incoming, {
      team: this.options.team,
      anchor: this.options.team,
    });
    if (!verdict.ok) return verdict;
    const roster = incoming as SignedRoster;
    this.roster = roster;
    this.saveRosterFile();
    // 빠진 기기가 보냈거나 빠진 기기에게 가던 건 버린다
    this.sendQueue = this.sendQueue.filter(
      (q) => memberOf(roster.roster, q.from) && memberOf(roster.roster, q.to),
    );
    for (const [key, conn] of [...this.members]) {
      if (memberOf(roster.roster, key)) continue;
      this.members.delete(key);
      conn.member = false;
      for (const [id, owner] of [...this.announced]) if (owner === key) this.announced.delete(id);
      conn.ws.close(CLOSE_REMOVED, 'removed');
      this.broadcast({ t: 'presence', key, online: false });
    }
    this.broadcast({ t: 'roster', roster });
    for (const [key, conn] of [...this.pending]) {
      if (memberOf(roster.roster, key)) this.admit(conn);
    }
    return verdict;
  }

  private drop(conn: Conn): void {
    if (conn.timer) clearTimeout(conn.timer);
    this.conns.delete(conn);
    const key = conn.key;
    if (!key) return;
    if (this.pending.get(key) === conn) this.pending.delete(key);
    if (this.members.get(key) === conn) {
      this.members.delete(key);
      for (const [id, owner] of [...this.announced]) if (owner === key) this.announced.delete(id);
      this.broadcast({ t: 'presence', key, online: false });
    }
  }

  private reject(
    conn: Conn,
    code: RelayErrorCode,
    message: string,
    closeCode = CLOSE_REJECTED,
  ): void {
    this.send(conn, { t: 'error', code, message });
    conn.ws.close(closeCode, code);
  }

  private broadcast(frame: ServerFrame, except?: Conn): void {
    for (const c of this.members.values()) if (c !== except) this.send(c, frame);
  }

  private send(conn: Conn, frame: ServerFrame): void {
    const text = JSON.stringify(frame);
    this.options.onFrame?.('out', text);
    conn.ws.send(text);
  }

  private pingAll(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate(1006, 'no pong');
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  private loadRosterFile(): void {
    const file = this.options.rosterFile;
    if (!file || !existsSync(file)) return;
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      process.stderr.write(`[peer-relay] 명단 파일을 못 읽어 버려요: ${file}\n`);
      return;
    }
    // 파일에 남은 명단도 서명을 다시 본다. 판의 차례는 처음 받는 것처럼 팀 id 서명만 믿는다
    const verdict = checkRosterUpdate(null, saved, {
      team: this.options.team,
      anchor: this.options.team,
    });
    if (verdict.ok) this.roster = saved as SignedRoster;
    else process.stderr.write(`[peer-relay] 명단 파일을 버려요: ${verdict.reason}\n`);
  }

  private saveRosterFile(): void {
    const file = this.options.rosterFile;
    if (!file || !this.roster) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.roster) + '\n', { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      process.stderr.write(`[peer-relay] 명단 파일을 못 썼어요: ${errMessage(err)}\n`);
    }
  }
}
