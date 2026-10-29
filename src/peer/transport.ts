import { EventEmitter } from 'node:events';
import type { MachineKey } from './keys.js';
import type { SignedRoster } from './roster.js';
import { signText } from './seal.js';
import { connectWs } from './ws.js';
import type { WsConnection } from './ws.js';
import { CLOSE_REMOVED, helloSigned } from './wire.js';
import type { ClientFrame, HelloMode, ServerFrame } from './wire.js';
import { errMessage } from './errors.js';

/**
 * 데몬끼리 봉인한 바이트를 주고받는 통로. 1차 구현은 RelayTransport 하나다.
 * 나중에 P2P 통로를 더할 때 같은 모양을 맞춘다.
 */
export interface PeerTransport {
  connect(roster: SignedRoster | null): Promise<void>;
  /** 릴레이가 받는 기기에게 넘겼으면 delivered, 받는 기기가 없어 들고 있으면 queued */
  send(
    to: string,
    sealed: Uint8Array,
    options?: { queue?: boolean },
  ): Promise<'queued' | 'delivered'>;
  onReceive(handler: (from: string, sealed: Uint8Array) => void): void;
  close(): Promise<void>;
}

export type TransportState = 'idle' | 'connecting' | 'online' | 'offline' | 'removed' | 'closed';

export interface RelayTransportOptions {
  url: string;
  team: string;
  key: MachineKey;
  mode?: HelloMode;
  /** 끊기면 다시 붙는다. join 모드는 기본 끔 */
  reconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  ackTimeoutMs?: number;
}

export class RelaySendError extends Error {
  constructor(readonly reason: string) {
    super(
      reason === 'offline'
        ? '받는 기기가 릴레이에 안 붙어 있어요'
        : reason === 'not_connected'
          ? '릴레이에 안 붙어 있어요'
          : `릴레이가 전달하지 못했어요: ${reason}`,
    );
    this.name = 'RelaySendError';
  }
}

interface PendingAck {
  resolve: (ok: boolean, error?: string, queued?: boolean) => void;
  timer: NodeJS.Timeout;
}

/**
 * 릴레이 접속 하나. 이벤트:
 * - `state`(TransportState)
 * - `welcome`(roster, online) — member로 붙었다. 다시 붙을 때마다 온다
 * - `roster`(SignedRoster) — 릴레이가 새 명단을 돌렸다. 받을지는 부른 쪽이 다시 확인한다
 * - `presence`(key, online)
 * - `join`(from, sealed) — 관리자에게 온 join 요청
 * - `relay-error`(code, message)
 */
export class RelayTransport extends EventEmitter implements PeerTransport {
  private ws: WsConnection | null = null;
  private roster: SignedRoster | null = null;
  private status: TransportState = 'idle';
  private nextId = 1;
  private acks = new Map<number, PendingAck>();
  private resolves = new Map<number, (owner: string | null) => void>();
  private receivers: ((from: string, sealed: Uint8Array) => void)[] = [];
  private backoff: number;
  private retry: NodeJS.Timeout | null = null;
  private announced: string[] = [];

  constructor(private readonly options: RelayTransportOptions) {
    super();
    this.backoff = options.minBackoffMs ?? 500;
  }

  get state(): TransportState {
    return this.status;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** 다음 hello에 들고 갈 명단 */
  setRoster(roster: SignedRoster | null): void {
    this.roster = roster;
  }

  /**
   * 처음 붙는다. member면 welcome, join 모드면 pending까지 기다린다. 첫 시도가 실패하면
   * 던지고 reconnect가 켜져 있으면 뒤에서 계속 다시 붙는다.
   */
  connect(roster: SignedRoster | null): Promise<void> {
    this.roster = roster;
    return this.attempt();
  }

  onReceive(handler: (from: string, sealed: Uint8Array) => void): void {
    this.receivers.push(handler);
  }

  send(
    to: string,
    sealed: Uint8Array,
    options: { queue?: boolean } = {},
  ): Promise<'queued' | 'delivered'> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || this.status !== 'online') {
        reject(new RelaySendError('not_connected'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new RelaySendError('timeout'));
      }, this.options.ackTimeoutMs ?? 10_000);
      timer.unref();
      this.acks.set(id, {
        timer,
        resolve: (ok, error, queued) =>
          ok
            ? resolve(queued ? 'queued' : 'delivered')
            : reject(new RelaySendError(error ?? 'unknown')),
      });
      this.write({
        t: 'send',
        id,
        to,
        data: Buffer.from(sealed).toString('base64url'),
        ...(options.queue ? { queue: true as const } : {}),
      });
    });
  }

  /**
   * 답을 안 기다리고 보낸다. 공유 스트림 프레임처럼 자주 가는 것에 쓴다. 릴레이도 ack를
   * 안 돌려준다. 받는 쪽이 없으면 조용히 버려진다.
   */
  post(to: string, sealed: Uint8Array): boolean {
    if (!this.ws || this.status !== 'online') return false;
    const id = this.nextId++;
    return this.write({
      t: 'send',
      id,
      to,
      data: Buffer.from(sealed).toString('base64url'),
      ack: false,
    });
  }

  /** 공유 id를 연 기기를 릴레이에 묻는다 */
  resolveShare(share: string, timeoutMs = 5_000): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.status !== 'online') {
        reject(new RelaySendError('not_connected'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.resolves.delete(id);
        reject(new RelaySendError('timeout'));
      }, timeoutMs);
      timer.unref();
      this.resolves.set(id, (owner) => {
        clearTimeout(timer);
        resolve(owner);
      });
      this.write({ t: 'resolve', id, share });
    });
  }

  /** 지금 연 공유 id 전부를 알린다. 다시 붙을 때도 같은 목록을 다시 보낸다 */
  announce(shares: string[]): void {
    this.announced = [...shares];
    if (this.status === 'online') this.write({ t: 'announce', shares: this.announced });
  }

  publishRoster(roster: SignedRoster): void {
    this.roster = roster;
    if (this.status === 'online') this.write({ t: 'roster', roster });
  }

  sendJoin(to: string, sealed: Uint8Array): boolean {
    if (!this.ws) return false;
    return this.write({ t: 'join', to, data: Buffer.from(sealed).toString('base64url') });
  }

  async close(): Promise<void> {
    this.setState('closed');
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bye');
    this.failPending('not_connected');
  }

  private attempt(): Promise<void> {
    if (this.status === 'closed' || this.status === 'removed') return Promise.resolve();
    this.setState('connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      connectWs(this.options.url).then(
        (ws) => {
          if (this.status === 'closed') {
            ws.close(1000, 'bye');
            settle();
            return;
          }
          this.ws = ws;
          ws.on('message', (text: string) => this.onMessage(ws, text, settle));
          ws.on('close', (code: number, reason: string) => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.failPending('not_connected');
            if (code === CLOSE_REMOVED) {
              this.setState('removed');
              settle(new Error('명단에 없는 기기라 릴레이가 끊었어요'));
              return;
            }
            settle(new Error(`릴레이 연결이 끊겼어요 (${code}${reason ? ` ${reason}` : ''})`));
            this.lost();
          });
        },
        (err: unknown) => {
          settle(new Error(`릴레이에 못 붙었어요: ${errMessage(err)}`));
          this.lost();
        },
      );
    });
  }

  private lost(): void {
    if (this.status === 'closed' || this.status === 'removed') return;
    this.setState('offline');
    const reconnect = this.options.reconnect ?? (this.options.mode ?? 'member') === 'member';
    if (!reconnect || this.retry) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.attempt().catch(() => {
        // 실패는 close 핸들러가 다음 시도를 건다
      });
    }, wait);
    this.retry.unref();
  }

  /**
   * 릴레이가 보낸 프레임. 릴레이도 믿지 않는 쪽이라 꼴이 틀린 프레임은 버린다. 여기서
   * 던지면 소켓 data 핸들러 밖으로 나가 데몬이 죽는다.
   */
  private onMessage(ws: WsConnection, text: string, settle: (err?: Error) => void): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null || !wellFormed(frame)) return;
    try {
      this.dispatch(ws, frame, settle);
    } catch (err) {
      process.stderr.write(`[peer] relay frame failed: ${errMessage(err)}\n`);
    }
  }

  private dispatch(ws: WsConnection, frame: ServerFrame, settle: (err?: Error) => void): void {
    switch (frame.t) {
      case 'challenge': {
        const mode = this.options.mode ?? 'member';
        const hello: ClientFrame = {
          t: 'hello',
          team: this.options.team,
          key: this.options.key.id,
          mode,
          sig: signText(this.options.key, helloSigned(this.options.team, frame.nonce, mode)),
          ...(this.roster ? { roster: this.roster } : {}),
        };
        ws.send(JSON.stringify(hello));
        return;
      }
      case 'welcome':
        this.backoff = this.options.minBackoffMs ?? 500;
        this.setState('online');
        if (this.announced.length > 0) this.write({ t: 'announce', shares: this.announced });
        this.emit('welcome', frame.roster, frame.online);
        settle();
        return;
      case 'pending':
        this.emit('pending');
        settle();
        return;
      case 'error':
        this.emit('relay-error', frame.code, frame.message);
        settle(new Error(`릴레이가 거절했어요: ${frame.message}`));
        return;
      case 'recv': {
        const bytes = Buffer.from(frame.data, 'base64url');
        for (const r of this.receivers) {
          try {
            r(frame.from, bytes);
          } catch (err) {
            process.stderr.write(`[peer] receive handler failed: ${errMessage(err)}\n`);
          }
        }
        return;
      }
      case 'ack': {
        const p = this.acks.get(frame.id);
        if (!p) return;
        this.acks.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve(frame.ok, frame.error, frame.queued === true);
        return;
      }
      case 'resolved': {
        const r = this.resolves.get(frame.id);
        this.resolves.delete(frame.id);
        r?.(typeof frame.owner === 'string' ? frame.owner : null);
        return;
      }
      case 'roster':
        this.emit('roster', frame.roster);
        return;
      case 'presence':
        this.emit('presence', frame.key, frame.online);
        return;
      case 'join':
        this.emit('join', frame.from, Buffer.from(frame.data, 'base64url'));
        return;
    }
  }

  private write(frame: ClientFrame): boolean {
    return this.ws?.send(JSON.stringify(frame)) ?? false;
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.acks) {
      clearTimeout(p.timer);
      this.acks.delete(id);
      p.resolve(false, reason);
    }
    this.resolves.clear();
  }

  private setState(next: TransportState): void {
    if (this.status === next) return;
    // closed와 removed는 되돌리지 않는다
    if ((this.status === 'closed' || this.status === 'removed') && next !== 'closed') return;
    this.status = next;
    this.emit('state', next);
  }
}

/** 프레임 종류마다 쓰는 칸의 타입만 본다. 내용 검사는 받는 쪽이 한다 */
function wellFormed(frame: ServerFrame): boolean {
  const f = frame as Record<string, unknown>;
  const str = (k: string): boolean => typeof f[k] === 'string';
  switch (f.t) {
    case 'challenge':
      return str('nonce');
    case 'welcome':
      return typeof f.roster === 'object' && f.roster !== null && Array.isArray(f.online);
    case 'pending':
      return true;
    case 'error':
      return str('code') && str('message');
    case 'recv':
    case 'join':
      return str('from') && str('data');
    case 'ack':
      return Number.isSafeInteger(f.id) && typeof f.ok === 'boolean';
    case 'resolved':
      return Number.isSafeInteger(f.id);
    case 'roster':
      return typeof f.roster === 'object' && f.roster !== null;
    case 'presence':
      return str('key') && typeof f.online === 'boolean';
    default:
      return false;
  }
}
