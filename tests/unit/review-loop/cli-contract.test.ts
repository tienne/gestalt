import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 스킬 문서가 `state=$(gestalt review-loop state ...) || { ...; exit 1; }` 으로 적는
 * 관용구는 이 계약 위에 선다 — 실패하면 stdout 에 아무것도 안 내고 종료 코드로 답한다.
 * 명령 치환은 stdout 만 가져가므로 실패한 조회가 빈 문자열로 넘어가면 미대응이 0 으로
 * 읽히고 승인이 그대로 나간다.
 */
describe('CLI 의 출력 계약', () => {
  const bin = resolve('bin/gestalt.ts');

  const run = (args: string[]) => {
    try {
      const stdout = execFileSync('npx', ['tsx', bin, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      const err = e as SpawnSyncReturns<string> & { status: number | null };
      return {
        status: err.status ?? -1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      };
    }
  };

  it('성공하면 값만 stdout 에 낸다', () => {
    const r = run(['review-loop', 'parse', 'https://github.com/o/r/pull/42']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('42');
  });

  it.each([
    ['셸 주입을 노린 값', "12'; id; t='3"],
    ['경로를 벗어나는 값', '../../etc'],
    ['github.com 이 아닌 주소', 'https://evil.example.com/x/pull/7'],
    ['번호 뒤에 글자', '18abc'],
  ])('%s 은 stdout 을 비우고 종료 코드로 답한다', (_name, target) => {
    const r = run(['review-loop', 'parse', target]);
    expect(r.status, '실패인데 종료 코드가 0 이다').toBe(1);
    expect(r.stdout, '실패했는데 stdout 에 무언가 있다').toBe('');
    expect(r.stderr.trim(), '무엇이 틀렸는지 안 알려준다').not.toBe('');
  });

  it('상태 자리 뿌리도 값만 낸다', () => {
    const r = run(['review-loop', 'dir']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().endsWith('gestalt-review-loop')).toBe(true);
  });

  it('레포까지 읽어 JSON 으로 낸다', () => {
    const r = run(['review-loop', 'parse', 'https://github.com/cli/cli/pull/9', '--json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ prNumber: 9, owner: 'cli', repo: 'cli' });
  });

  it('JSON 으로 낼 때도 실패하면 stdout 이 빈다', () => {
    const r = run(['review-loop', 'parse', '../../etc', '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  /**
   * 라운드 내내 좌표가 필요한 자리가 이 명령을 부른다. 문서가 `jq -r`로 뽑는 키
   * 넷이 그대로 나와야 그 블록들이 선다.
   */
  it('좌표 넷을 한 번에 낸다', () => {
    const r = run(['review-loop', 'resolve', '--pr', 'https://github.com/cli/cli/pull/9']);
    expect(r.status).toBe(0);
    const coords = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(coords).sort()).toEqual(['owner', 'prNumber', 'repo', 'stateDir']);
    expect(coords.owner).toBe('cli');
    expect(coords.repo).toBe('cli');
    expect(coords.prNumber).toBe(9);
    expect(String(coords.stateDir).endsWith('cli--cli--9')).toBe(true);
  });

  it('좌표도 실패하면 stdout 이 빈다', () => {
    const r = run(['review-loop', 'resolve', '--pr', 'https://evil.example.com/x/pull/7']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim()).not.toBe('');
  });

  /**
   * 조회는 네트워크를 타므로 여기서는 그 앞단만 본다. 대상이 안 읽히면 조회에
   * 닿기 전에 멈춰야 한다. 그때 stdout 이 비어야 부르는 쪽의 `|| exit 1` 이 선다.
   */
  it('조회도 대상이 안 읽히면 stdout 을 비우고 멈춘다', () => {
    const r = run(['review-loop', 'state', '--pr', '18abc', '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });
}, 60_000);
