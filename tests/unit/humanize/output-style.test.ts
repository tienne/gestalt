import { describe, it, expect } from 'vitest';
import { buildOutputStyle } from '../../../scripts/build-output-style.js';
import { parseRuleBook } from '../../../src/humanize/rules.js';

/** 금지 목록에서 그 룰의 한 줄을 뽑는다 */
function bannedLine(rendered: string, id: string): string {
  const line = rendered.split('\n').find((row) => row.startsWith(`- **${id} `));
  if (!line) throw new Error(`금지 목록에 ${id} 줄이 없다`);
  return line;
}

describe('buildOutputStyle', () => {
  const rendered = buildOutputStyle();

  it('HOIST가 올린 문장을 금지 목록에 싣는다', () => {
    // 이 줄이 빨개지면 root 기준이 다시 산출물에서 빠진 것이다
    expect(bannedLine(rendered, 'F-9')).toContain(
      '"뿌리"는 root 한 단어가 그 대상 이름인 자리에서만 쓴다 — root cause처럼 수식하는 자리는 대상이다',
    );
  });

  it('올린 문장을 두 번 싣지 않는다', () => {
    const line = bannedLine(rendered, 'F-9');
    const first = line.indexOf('"뿌리"는 root 한 단어가');
    expect(line.indexOf('"뿌리"는 root 한 단어가', first + 1)).toBe(-1);
  });

  it('HOIST에 안 올린 룰은 처방이 한 문장에서 끝난다', () => {
    // F-10도 처방이 열세 문장이라 F-9와 조건이 같다. 안 올렸으니 안 늘어야 한다
    const line = bannedLine(rendered, 'F-10');
    expect(line).toContain('그 자리에서 실제로 무엇이 되는지를 동사로 쓴다');
    expect(line).not.toContain('가르는 것은 누가 정하는 자리냐다');
  });

  it('올린 룰 말고는 금지 목록 줄이 처방 상한 안에 있다', () => {
    const book = parseRuleBook();
    for (const line of rendered.split('\n')) {
      const id = line.match(/^- \*\*([A-J]-\d{1,2}) /)?.[1];
      if (!id || id in { 'F-9': 0 }) continue;
      if (!book.rules.get(id)) continue;
      const prescription = line.split('** → ')[1] ?? '';
      expect(prescription.length, `${id} 처방 칸이 상한을 넘었다`).toBeLessThanOrEqual(76);
    }
  });

  it('룰북 표에는 생성기용 마크업이 없다', () => {
    // 룰북은 플러그인으로 배포되고 에이전트 여럿이 원문을 그대로 읽는다.
    // 실을 문장을 고르는 일은 생성기의 HOIST가 맡고 룰북은 산문만 갖는다
    const book = parseRuleBook();
    for (const rule of book.rules.values()) {
      expect(rule.prescription, `${rule.id} 처방`).not.toContain('<!--');
      expect(rule.pattern, `${rule.id} 패턴`).not.toContain('<!--');
    }
  });
});
