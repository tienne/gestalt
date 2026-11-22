import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRecentEvents, TAIL_BYTES } from '../../../src/conductor/recent-events.js';
import { EVENTS_FILE, emptySnapshot } from '../../../src/conductor/store.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

const line = (i: number, pad = '') =>
  `${JSON.stringify({
    type: 'checkpoint-saved',
    at: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    checkpoint: {
      orderId: `ord-${i}`,
      workerId: 'wrk-1',
      skill: `ship${pad}`,
      next: '',
      completedSkills: [],
      refs: [],
    },
  })}\n`;

describe('readRecentEvents', () => {
  it('로그가 읽는 범위보다 길어도 끝에서 limit개를 오래된 것부터 돌려준다', () => {
    const dir = tempStateDir();
    const count = Math.ceil(TAIL_BYTES / line(0).length) * 2;
    writeFileSync(
      join(dir, EVENTS_FILE),
      Array.from({ length: count }, (_, i) => line(i)).join(''),
    );

    const events = readRecentEvents(dir, emptySnapshot(), 50);

    expect(events).toHaveLength(50);
    expect(events[0]!.orderId).toBe(`ord-${count - 50}`);
    expect(events.at(-1)!.orderId).toBe(`ord-${count - 1}`);
  });

  it('읽는 범위가 줄 첫머리에서 시작하면 그 줄을 버리지 않는다', () => {
    const dir = tempStateDir();
    const tail: string[] = [];
    let size = 0;
    for (let i = 1; size + line(i).length <= TAIL_BYTES; i++) {
      tail.push(line(i));
      size += line(i).length;
    }
    // 첫 줄에 남은 바이트를 채워 끝 줄들의 합이 읽는 범위와 딱 맞게 한다
    tail[0] = line(1, 'x'.repeat(TAIL_BYTES - size));
    writeFileSync(join(dir, EVENTS_FILE), line(0) + tail.join(''));

    const events = readRecentEvents(dir, emptySnapshot(), tail.length + 10);

    expect(events).toHaveLength(tail.length);
    expect(events[0]!.orderId).toBe('ord-1');
  });
});
