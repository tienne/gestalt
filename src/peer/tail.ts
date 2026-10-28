import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

export type TailStatus = 'ok' | 'missing' | 'truncated';

export interface TailRead {
  lines: string[];
  status: TailStatus;
}

/** 한 번에 읽는 크기. 대화 기록은 수십 MB까지 커서 통째로 올리지 않는다 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * read 한 번에 읽는 상한. 데몬은 IPC와 뷰어를 같은 스레드에서 돌려서 큰 기록을 한 번에
 * 읽으면 그동안 명령이 멈춘다. 나머지는 다음 read가 이어 읽는다.
 */
export const DEFAULT_READ_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * 한 줄 상한. 이미지가 든 도구 결과 줄도 들어가게 넉넉히 잡는다. 넘는 줄은 개행까지
 * 버린다. 개행이 끝내 안 오는 파일에서 메모리가 끝없이 늘지 않게 하는 게 목적이다.
 */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface TailOptions {
  startOffset?: number;
  readBudgetBytes?: number;
  maxLineBytes?: number;
}

/**
 * jsonl 파일을 바이트 위치로 이어 읽는다.
 *
 * 줄은 개행이 붙어야 끝난 걸로 본다. Claude Code가 한 줄을 쓰는 도중에 읽으면
 * 반쪽 JSON이 나오는데 그걸 모르는 줄로 세면 숫자가 부풀고 다음 읽기에서 뒷반쪽이
 * 또 깨진다. 개행 없는 꼬리는 다음 읽기까지 들고 있는다.
 *
 * 파일이 줄거나 다른 파일로 바뀌면 멈춘다. 처음부터 다시 읽으면 이미 보낸 줄이
 * 두 번 나간다. 무엇이 바뀌었는지 모르는 채로 계속 흘리는 것보다 멈추고 알리는 게 낫다.
 */
export class TranscriptTail {
  private offset: number;
  /** 개행을 아직 못 만난 꼬리. 청크마다 합치면 긴 줄에서 누적분을 매번 다시 복사한다 */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** 상한을 넘은 줄의 나머지를 개행까지 버리는 중 */
  private discarding = false;
  private oversized = 0;
  private inode: number | undefined;
  private stopped: TailStatus | undefined;
  private readonly budget: number;
  private readonly maxLine: number;

  constructor(
    private readonly path: string,
    options: TailOptions = {},
  ) {
    this.offset = options.startOffset ?? 0;
    this.budget = options.readBudgetBytes ?? DEFAULT_READ_BUDGET_BYTES;
    this.maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** 다음 읽기가 시작할 바이트 위치. 덜 쓰인 꼬리는 포함하지 않는다 */
  get position(): number {
    return this.offset - this.pendingBytes;
  }

  /** 상한을 넘어 버린 줄 수. 형식을 몰라 건너뛴 줄과 섞지 않는다 */
  get oversizedLines(): number {
    return this.oversized;
  }

  read(): TailRead {
    if (this.stopped === 'truncated') return { lines: [], status: 'truncated' };

    let size: number;
    let ino: number;
    try {
      const st = statSync(this.path);
      size = st.size;
      ino = st.ino;
    } catch {
      return { lines: [], status: 'missing' };
    }

    if (this.inode !== undefined && ino !== this.inode) return this.halt();
    if (size < this.offset) return this.halt();
    this.inode = ino;
    if (size === this.offset) return { lines: [], status: 'ok' };

    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return { lines: [], status: 'missing' };
    }

    const lines: string[] = [];
    try {
      // stat과 open 사이에 파일이 바뀌었으면 열린 쪽 기준으로 다시 본다
      const opened = fstatSync(fd);
      if (opened.ino !== this.inode || opened.size < this.offset) return this.halt();

      const end = Math.min(opened.size, this.offset + this.budget);
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, end - this.offset));
      while (this.offset < end) {
        const want = Math.min(chunk.length, end - this.offset);
        const got = readSync(fd, chunk, 0, want, this.offset);
        if (got <= 0) break;
        this.offset += got;
        this.feed(chunk.subarray(0, got), lines);
      }
    } finally {
      closeSync(fd);
    }
    return { lines, status: 'ok' };
  }

  /** `buf`는 다음 청크가 덮어쓴다. 들고 있을 꼬리는 복사해 둔다 */
  private feed(buf: Buffer, into: string[]): void {
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      if (this.discarding) {
        if (nl === -1) return;
        this.discarding = false;
        start = nl + 1;
        continue;
      }
      if (nl === -1) {
        const rest = buf.subarray(start);
        if (this.pendingBytes + rest.length > this.maxLine) {
          this.oversized++;
          this.dropPending();
          this.discarding = true;
        } else {
          this.pending.push(Buffer.from(rest));
          this.pendingBytes += rest.length;
        }
        return;
      }
      const piece = buf.subarray(start, nl);
      if (this.pendingBytes + piece.length > this.maxLine) {
        this.oversized++;
      } else {
        const line = this.pendingBytes === 0 ? piece : Buffer.concat([...this.pending, piece]);
        into.push(line.toString('utf8'));
      }
      this.dropPending();
      start = nl + 1;
    }
  }

  private dropPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private halt(): TailRead {
    this.stopped = 'truncated';
    this.dropPending();
    this.discarding = false;
    return { lines: [], status: 'truncated' };
  }
}
