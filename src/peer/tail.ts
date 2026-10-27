import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

export type TailStatus = 'ok' | 'missing' | 'truncated';

export interface TailRead {
  lines: string[];
  status: TailStatus;
}

/** 한 번에 읽는 크기. 대화 기록은 수십 MB까지 커서 통째로 올리지 않는다 */
const CHUNK_BYTES = 1024 * 1024;

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
  private pending: Buffer = Buffer.alloc(0);
  private inode: number | undefined;
  private stopped: TailStatus | undefined;

  constructor(
    private readonly path: string,
    startOffset = 0,
  ) {
    this.offset = startOffset;
  }

  /** 다음 읽기가 시작할 바이트 위치. 덜 쓰인 꼬리는 포함하지 않는다 */
  get position(): number {
    return this.offset - this.pending.length;
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

      const end = opened.size;
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, end - this.offset));
      while (this.offset < end) {
        const want = Math.min(chunk.length, end - this.offset);
        const got = readSync(fd, chunk, 0, want, this.offset);
        if (got <= 0) break;
        this.offset += got;
        this.pending = Buffer.concat([this.pending, chunk.subarray(0, got)]);
        this.drainLines(lines);
      }
    } finally {
      closeSync(fd);
    }
    return { lines, status: 'ok' };
  }

  private drainLines(into: string[]): void {
    let start = 0;
    let nl = this.pending.indexOf(0x0a, start);
    while (nl !== -1) {
      into.push(this.pending.subarray(start, nl).toString('utf8'));
      start = nl + 1;
      nl = this.pending.indexOf(0x0a, start);
    }
    if (start > 0) this.pending = Buffer.from(this.pending.subarray(start));
  }

  private halt(): TailRead {
    this.stopped = 'truncated';
    this.pending = Buffer.alloc(0);
    return { lines: [], status: 'truncated' };
  }
}
