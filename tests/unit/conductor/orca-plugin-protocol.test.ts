import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../../../src/conductor/types.js';
import { ORDER_STATUS_ROLE, orcaTone } from '../../../src/visual-system/status.js';
import { STATUS_PALETTES } from '../../../src/visual-system/color.js';

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

  it('주문 상태 tone이 시각화 시스템의 상태 역할과 같다', () => {
    const model = readFileSync(join(__dirname, '../../../orca-plugin/src/model.ts'), 'utf8');
    const body = /export const STATUS_TONE[^=]*=\s*\{([^}]*)\}/.exec(model)![1]!;
    const tones = Object.fromEntries(
      [...body.matchAll(/(?:'([^']+)'|\[AWAITING_DEPLOY\]|([a-z]+)): '([a-z]+)'/g)].map((m) => [
        m[1] ?? m[2] ?? 'awaiting-deploy',
        m[3]!,
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(ORDER_STATUS_ROLE).map(([status, role]) => [status, orcaTone(role)]),
    );
    expect(tones).toEqual(expected);
  });

  it('모든 주문 상태에 상태 역할이 있다', () => {
    for (const status of ORDER_STATUSES) expect(ORDER_STATUS_ROLE[status]).toBeDefined();
  });

  it('플러그인 상태색이 Gestalt 상태 팔레트와 같다', () => {
    const palette = readFileSync(join(__dirname, '../../../orca-plugin/src/palette.ts'), 'utf8');
    const colors = Object.fromEntries(
      [...palette.matchAll(/(\w+): \{ dark: '(#[0-9A-F]{6})', light: '(#[0-9A-F]{6})' \}/g)].map(
        (m) => [m[1]!, { dark: m[2]!, light: m[3]! }],
      ),
    );
    expect(colors).toEqual(STATUS_PALETTES);
  });
});
