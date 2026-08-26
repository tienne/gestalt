import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../../../src/events/store.js';

/**
 * 이벤트를 접어 상태를 만드는 전제는 "같은 이벤트면 같은 결과"다.
 *
 * 정렬이 밀리초 timestamp뿐이면 같은 ms에 들어간 이벤트들의 순서를 SQL이 보장하지
 * 않는다. 코멘트를 연속으로 붙이는 흐름은 그 자리를 통상적으로 밟는다.
 *
 * 이 테스트는 결과가 삽입 순서와 같은지를 본다. `ORDER BY`의 rowid 절을 지워도
 * 통과한다 — sqlite가 정렬 레코드에 rowid를 담아 비교해서 동점이면 삽입 순서가
 * 그대로 나오기 때문이다. 그 절은 저장 엔진이 바뀔 때를 위한 것이지 지금 동작을
 * 바꾸지 않는다.
 */
describe('이벤트 정렬', () => {
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dbPath = join('.gestalt-test', `store-order-${randomUUID()}.db`);
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm', '.jsonl']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it('같은 밀리초에 들어간 이벤트도 넣은 순서로 나온다', () => {
    for (let i = 0; i < 50; i++) {
      store.append('local-pr', 'abcd1234', 'pr.comment.added', { seq: i });
    }

    const seqs = store
      .replay('local-pr', 'abcd1234')
      .map((e) => (e.payload as { seq: number }).seq);

    expect(seqs).toEqual([...Array(50).keys()]);
  });

  it('집합 조회도 같은 순서를 준다', () => {
    for (let i = 0; i < 20; i++) {
      store.append('local-pr', 'aaaa1111', 'pr.comment.added', { seq: i });
      store.append('local-pr', 'bbbb2222', 'pr.comment.added', { seq: i });
    }

    const grouped = store.getAllByAggregateType('local-pr');

    expect([...grouped.keys()].sort()).toEqual(['aaaa1111', 'bbbb2222']);
    for (const events of grouped.values()) {
      const seqs = events.map((e) => (e.payload as { seq: number }).seq);
      expect(seqs).toEqual([...Array(20).keys()]);
    }
  });
});
