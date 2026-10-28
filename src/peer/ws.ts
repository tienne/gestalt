import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

/**
 * 릴레이와 데몬이 쓰는 최소 WebSocket(RFC 6455). 글자 메시지만 주고받는다.
 *
 * 의존성을 더하지 않으려고 직접 짰다. Node 22에 클라이언트(`WebSocket` 전역)는 있지만
 * 서버가 없어서 프레임 해석을 어차피 짜야 하고 양쪽이 같은 코드를 쓰면 밀린 양을
 * `socket.writableLength`로 똑같이 잴 수 있다.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 메시지 하나의 상한. 넘으면 1009로 닫는다 */
export const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WsOptions {
  /** 클라이언트는 보내는 프레임을 가리고(mask) 서버는 가린 프레임만 받는다 */
  client: boolean;
  maxMessageBytes?: number;
}

/**
 * 연결 하나. 이벤트는 `message`(글자), `close`(코드, 이유), `pong`이다.
 * `error`는 내보내지 않는다 — 소켓 오류는 1006 close로 바꿔 한 길로만 끝나게 한다.
 */
export class WsConnection extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;
  private closeSent = false;
  private readonly maxMessageBytes: number;

  constructor(
    private readonly socket: Duplex,
    private readonly options: WsOptions,
    head?: Buffer,
  ) {
    super();
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish(1006, ''));
    socket.on('error', () => this.finish(1006, ''));
    socket.on('drain', () => this.emit('drain'));
    // 핸드셰이크 응답과 같은 패킷에 실려 온 첫 프레임이다. 버퍼에 먼저 넣어 차례를 지키고
    // 해석은 부른 쪽이 message 리스너를 붙인 뒤로 미룬다
    if (head && head.length > 0) {
      this.buf = Buffer.from(head);
      setImmediate(() => this.onData(Buffer.alloc(0)));
    }
  }

  /** 소켓 버퍼에 밀려 있는 바이트 */
  get bufferedAmount(): number {
    return (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  get isOpen(): boolean {
    return !this.closed && !this.closeSent;
  }

  send(text: string): boolean {
    if (!this.isOpen) return false;
    return this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  ping(): void {
    if (this.isOpen) this.writeFrame(OP_PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const r = Buffer.from(reason.slice(0, 100), 'utf8');
      const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0);
      r.copy(body, 2);
      this.writeFrame(OP_CLOSE, body);
    }
    // 상대가 close로 답하지 않아도 오래 붙잡지 않는다
    const timer = setTimeout(() => this.socket.destroy(), 1_000);
    timer.unref();
    this.socket.end();
    this.finish(code, reason);
  }

  /** 상대에게 알리지 않고 끊는다. 안 읽는 상대를 떼어낼 때 쓴다 */
  terminate(code = 1006, reason = ''): void {
    this.socket.destroy();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.emit('close', code, reason);
  }

  private writeFrame(op: number, payload: Buffer): boolean {
    const mask = this.options.client;
    const len = payload.length;
    const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const header = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
    header[0] = 0x80 | op;
    header[1] = (mask ? 0x80 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
    if (lenBytes === 2) header.writeUInt16BE(len, 2);
    else if (lenBytes === 8) header.writeBigUInt64BE(BigInt(len), 2);
    let body = payload;
    if (mask) {
      const key = randomBytes(4);
      key.copy(header, 2 + lenBytes);
      body = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) body[i] = payload[i]! ^ key[i & 3]!;
    }
    try {
      return this.socket.write(Buffer.concat([header, body]));
    } catch {
      return false;
    }
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (!this.closed) {
      const frame = this.readFrame();
      if (!frame) return;
      this.onFrame(frame.fin, frame.op, frame.payload);
    }
  }

  private readFrame(): { fin: boolean; op: number; payload: Buffer } | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    const op = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) {
        this.close(1009, 'too big');
        return null;
      }
      len = Number(big);
      off = 10;
    }
    if (len > this.maxMessageBytes) {
      this.close(1009, 'too big');
      return null;
    }
    // 서버는 가린 프레임만, 클라이언트는 안 가린 프레임만 받는다(RFC 6455 5.1)
    if (masked === this.options.client) {
      this.close(1002, 'mask');
      return null;
    }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    let payload = b.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const key = b.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i]! ^ key[i & 3]!;
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    this.buf = b.subarray(off + maskLen + len);
    return { fin, op, payload };
  }

  private onFrame(fin: boolean, op: number, payload: Buffer): void {
    switch (op) {
      case OP_PING:
        if (this.isOpen) this.writeFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        this.emit('pong');
        return;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.close(code === 1005 ? 1000 : code, reason);
        return;
      }
      case OP_BINARY:
        this.close(1003, 'text only');
        return;
      case OP_TEXT:
      case OP_CONT: {
        if (op === OP_TEXT && this.fragments.length > 0) {
          this.close(1002, 'fragment');
          return;
        }
        if (op === OP_CONT && this.fragments.length === 0) {
          this.close(1002, 'continuation');
          return;
        }
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessageBytes) {
          this.close(1009, 'too big');
          return;
        }
        this.fragments.push(payload);
        if (!fin) return;
        const text = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.fragmentBytes = 0;
        this.emit('message', text);
        return;
      }
      default:
        this.close(1002, 'opcode');
    }
  }
}

/**
 * http(s) 서버의 `upgrade` 이벤트에서 부른다. 핸드셰이크가 틀리면 400으로 닫고 null.
 */
export function acceptUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: Omit<WsOptions, 'client'> = {},
): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (
    req.method !== 'GET' ||
    upgrade !== 'websocket' ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    req.headers['sec-websocket-version'] !== '13'
  ) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WsConnection(socket, { ...options, client: false }, head);
}

/** `ws://` 또는 `wss://`로 붙는다 */
export function connectWs(
  url: string,
  options: Omit<WsOptions, 'client'> & { timeoutMs?: number } = {},
): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      reject(new Error(`ws:// 또는 wss:// 주소여야 해요: ${url}`));
      return;
    }
    const key = randomBytes(16).toString('base64');
    const make = u.protocol === 'wss:' ? httpsRequest : httpRequest;
    const req = make({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`릴레이가 ${options.timeoutMs ?? 10_000}ms 안에 답하지 않았어요`));
    }, options.timeoutMs ?? 10_000);
    req.once('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(new Error('릴레이 핸드셰이크 응답이 맞지 않아요'));
        return;
      }
      resolve(new WsConnection(socket, { ...options, client: true }, head));
    });
    req.once('response', (res) => {
      clearTimeout(timer);
      res.resume();
      reject(new Error(`릴레이가 WebSocket을 거절했어요 (HTTP ${res.statusCode})`));
    });
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}
