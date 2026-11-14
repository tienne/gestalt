import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../../../src/conductor/types.js';

// 플러그인은 오르카 타입으로만 컴파일돼 레포 코드를 import하지 못한다. 그래서 파일 글자를 읽어 맞춰 본다
function listIn(source: string, name: string): string[] {
  const body = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1];
  if (body === undefined) throw new Error(`${name}을 못 찾았어요`);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('orca-plugin protocol', () => {
  const source = readFileSync(join(__dirname, '../../../orca-plugin/src/protocol.ts'), 'utf8');

  it('주문 상태 목록이 컨덕터와 같은 순서다', () => {
    expect(listIn(source, 'ORDER_STATUSES')).toEqual([...ORDER_STATUSES]);
  });

  it('끝난 주문 상태가 컨덕터와 같다', () => {
    expect(new Set(listIn(source, 'TERMINAL_ORDER_STATUSES'))).toEqual(
      new Set(TERMINAL_ORDER_STATUSES),
    );
  });
});
