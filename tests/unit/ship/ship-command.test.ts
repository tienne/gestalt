import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/ship/ci.js', () => ({ waitForCi: vi.fn() }));

import { shipCheckpointSaveCommand, shipCiWaitCommand } from '../../../src/cli/commands/ship.js';
import { waitForCi } from '../../../src/ship/ci.js';

describe('ship 명령의 실패 출력 — 스킬이 stdout 을 판정으로 읽는다', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(waitForCi).mockReset();
  });

  it('ci-wait 가 던지면 stderr 에 이유를 쓰고 1 로 끝나며 stdout 은 비운다', async () => {
    vi.mocked(waitForCi).mockRejectedValue(new Error('HTTP 502: Bad Gateway'));
    await expect(shipCiWaitCommand({ pr: '7', json: true })).rejects.toThrow('exit 1');
    expect(err).toHaveBeenCalledWith('HTTP 502: Bad Gateway');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['--head', { head: '--output=x' }],
    ['--repo', { repo: '--jq=.' }],
    ['--repo', { repo: '-x/y' }],
    ['--repo', { repo: 'a/..' }],
  ])('%s 가 형식에 안 맞으면 gh 를 부르지 않고 1 로 끝난다', async (flag, extra) => {
    await expect(shipCiWaitCommand({ pr: '7', json: true, ...extra })).rejects.toThrow('exit 1');
    expect(waitForCi).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining(flag));
    expect(log).not.toHaveBeenCalled();
  });

  it('repo 이름이 `.` 으로 시작해도 owner/repo 꼴이면 받는다', async () => {
    vi.mocked(waitForCi).mockResolvedValue({ status: 'pass' } as never);
    await shipCiWaitCommand({ pr: '7', json: true, repo: 'owner/.github' });
    expect(waitForCi).toHaveBeenCalledWith(expect.objectContaining({ repo: 'owner/.github' }));
  });

  it('checkpoint save 가 던지면 1 로 끝나고 stdout 은 비운다', () => {
    expect(() => shipCheckpointSaveCommand({ dir: '/tmp/x', phase: 'c', next: 'x' })).toThrow(
      'exit 1',
    );
    expect(err).toHaveBeenCalledWith(expect.stringContaining('--phase'));
    expect(log).not.toHaveBeenCalled();
  });

  it('checkpoint save 의 --base 가 브랜치 이름 꼴이 아니면 저장하지 않고 1 로 끝난다', () => {
    expect(() =>
      shipCheckpointSaveCommand({ dir: '/tmp/x', phase: '2', next: 'x', base: '-x' }),
    ).toThrow('exit 1');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('--base'));
    expect(log).not.toHaveBeenCalled();
  });
});
