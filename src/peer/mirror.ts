import { ShareFeed } from './feed.js';
import type { ShareFrame, ShareStatus } from './feed.js';

/**
 * 보는 사람 데몬이 원격 공유를 받아 로컬 뷰어로 옮기는 자리. 뷰어 서버는 내 공유와
 * 똑같이 다룬다.
 *
 * 이벤트 번호는 주인 쪽 번호를 그대로 쓴다. 다시 붙어서 이어 받을 때 주인 쪽이 그 사이를
 * 버렸으면 번호가 건너뛴다. 그때는 들고 있던 걸 비우고 건너뛴 개수를 생략으로 알린다.
 */
export class MirrorFeed extends ShareFeed {
  private unknown = 0;

  constructor(
    id: string,
    readonly ownerKey: string,
    readonly ownerPerson: string,
    readonly shareId: string,
    maxBacklogBytes?: number,
  ) {
    super(id, maxBacklogBytes);
  }

  override get unknownLines(): number {
    return this.unknown;
  }

  /** 주인 쪽 프레임을 반영한다. 주인 쪽 trimmed는 번호 건너뜀으로 따로 잡으므로 무시한다 */
  apply(frames: ShareFrame[]): void {
    if (this.isClosed) return;
    for (const frame of frames) {
      switch (frame.type) {
        case 'event': {
          if (!Number.isSafeInteger(frame.seq) || typeof frame.json !== 'string') continue;
          if (frame.seq <= this.eventCount) continue;
          if (frame.seq > this.eventCount + 1) {
            const gap = frame.seq - 1 - this.eventCount;
            this.skipTo(frame.seq - 1);
            this.emit({ type: 'trimmed', dropped: gap });
          }
          this.pushEvent(frame.json);
          break;
        }
        case 'stats':
          if (Number.isSafeInteger(frame.unknownLines) && frame.unknownLines !== this.unknown) {
            this.unknown = frame.unknownLines;
            this.emit({ type: 'stats', unknownLines: this.unknown });
          }
          break;
        case 'state':
          if (isShareStatus(frame.status)) this.setStatus(frame.status);
          break;
        case 'closed':
          this.close(typeof frame.reason === 'string' ? frame.reason : 'closed');
          return;
        case 'trimmed':
          break;
      }
    }
    this.trim();
  }

  markOffline(): void {
    this.setStatus('offline');
  }
}

function isShareStatus(v: unknown): v is ShareStatus {
  return v === 'live' || v === 'missing' || v === 'truncated' || v === 'offline';
}
