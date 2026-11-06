import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createCli } from '../../../src/cli/index.js';
import {
  extractCauseLines,
  parseJobLink,
  readChecks,
  waitForCi,
  type CiWaitDeps,
  type CmdResult,
} from '../../../src/ship/ci.js';

const JOB_LINK = 'https://github.com/o/r/actions/runs/111/job/222';

const ok = (stdout: string): CmdResult => ({ status: 0, stdout, stderr: '' });
const checksJson = (...buckets: Array<[string, string]>): string =>
  JSON.stringify(
    buckets.map(([name, bucket]) => ({ name, workflow: 'CI', bucket, link: JOB_LINK })),
  );

/**
 * 시계를 가짜로 돌린다. sleep 은 기다리지 않고 시각만 민다 — 실제 대기 없이 상한과 유예를
 * 넘기는 경로를 확인하려고 둔다.
 */
function fakeDeps(script: {
  checks: Array<CmdResult>;
  head?: Array<string>;
  log?: CmdResult;
}): CiWaitDeps & { calls: string[][] } {
  let t = 0;
  let checksAt = 0;
  let headAt = 0;
  const calls: string[][] = [];
  return {
    calls,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'pr' && args[1] === 'checks') {
        const r = script.checks[Math.min(checksAt, script.checks.length - 1)]!;
        checksAt += 1;
        return r;
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const seq = script.head ?? [];
        const sha = seq[Math.min(headAt, seq.length - 1)] ?? '';
        headAt += 1;
        return ok(JSON.stringify({ headRefOid: sha }));
      }
      if (args[0] === 'run' && args[1] === 'view') return script.log ?? ok('');
      throw new Error(`예상 못 한 호출: ${cmd} ${args.join(' ')}`);
    },
  };
}

const opts = { prNumber: 7, timeoutSec: 900, graceSec: 120, intervalSec: 30 };

describe('readChecks', () => {
  it('종료 코드가 0이 아니어도 stdout 의 JSON 을 읽는다 — gh 는 실패나 진행 중이면 0 이 아니다', () => {
    const r = readChecks({ status: 8, stdout: checksJson(['build', 'pending']), stderr: '' });
    expect(r).toEqual({
      kind: 'checks',
      checks: [{ name: 'build', workflow: 'CI', bucket: 'pending', link: JOB_LINK }],
    });
  });

  it('체크가 없다는 stderr 는 none 으로 읽는다', () => {
    expect(
      readChecks({ status: 1, stdout: '', stderr: "no checks reported on the 'x' branch" }),
    ).toEqual({
      kind: 'none',
    });
  });

  it('그 밖의 실패는 error 다', () => {
    const r = readChecks({ status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway\nmore' });
    expect(r).toEqual({ kind: 'error', message: 'HTTP 502: Bad Gateway' });
  });
});

describe('parseJobLink', () => {
  it('Actions 잡 링크에서 레포와 잡 id 를 읽는다', () => {
    expect(parseJobLink(JOB_LINK)).toEqual({ repo: 'o/r', jobId: '222' });
  });

  it('외부 앱 링크는 null 이다', () => {
    expect(parseJobLink('https://app.codecov.io/gh/o/r/pull/7')).toBeNull();
  });
});

describe('extractCauseLines', () => {
  const line = (msg: string) =>
    `build (ubuntu-latest, 22)\tTest with coverage\t2026-11-02T11:25:15.1481670Z ${msg}`;

  it('러너 주석을 먼저 고르고 종료 코드 줄은 버린다', () => {
    const log = [
      line('[gestalt] answer deliver failed: boom'),
      line('\x1b[90mstderr\x1b[2m | tests/unit/x.test.ts > handles failed tasks'),
      line(' Test Files  354 passed | 1 skipped (355)'),
      line('##[error]Error: write EPIPE'),
      line(' ELIFECYCLE  Test failed. See above for more details.'),
      line('##[error]Process completed with exit code 1.'),
    ].join('\n');
    expect(extractCauseLines(log)).toEqual([
      'Error: write EPIPE',
      'ELIFECYCLE  Test failed. See above for more details.',
    ]);
  });

  it('테스트 러너 실패 표시를 로그 순서대로 고른다', () => {
    const log = [
      line(' FAIL  tests/unit/hygiene.test.ts > 금지어가 없다'),
      line('AssertionError: expected [ "a.md" ] to deeply equal []'),
      line(' Test Files  1 failed | 354 passed (355)'),
    ].join('\n');
    expect(extractCauseLines(log)).toEqual([
      'FAIL  tests/unit/hygiene.test.ts > 금지어가 없다',
      'AssertionError: expected [ "a.md" ] to deeply equal []',
      'Test Files  1 failed | 354 passed (355)',
    ]);
  });

  it('표시가 없으면 끝 다섯 줄을 낸다', () => {
    const log = ['a', 'b', 'c', 'd', 'e', 'f', '##[error]Process completed with exit code 2.']
      .map(line)
      .join('\n');
    expect(extractCauseLines(log)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('같은 줄은 한 번만, 개수는 상한까지', () => {
    const log = Array.from({ length: 20 }, (_, i) => line(`error TS2322: 타입 ${i % 12}`)).join(
      '\n',
    );
    const picked = extractCauseLines(log, 8);
    expect(picked).toHaveLength(8);
    expect(new Set(picked).size).toBe(8);
  });
});

describe('waitForCi', () => {
  it('진행 중이면 기다렸다가 끝나면 pass', async () => {
    const deps = fakeDeps({
      checks: [ok(checksJson(['build', 'pending'])), ok(checksJson(['build', 'pass']))],
    });
    const r = await waitForCi(opts, deps);
    expect(r.status).toBe('pass');
    expect(r.waitedSec).toBe(30);
  });

  it('체크가 안 붙은 채 유예가 지나면 CI 없음', async () => {
    const none: CmdResult = { status: 1, stdout: '', stderr: 'no checks reported on the b branch' };
    const r = await waitForCi(opts, fakeDeps({ checks: [none] }));
    expect(r.status).toBe('none');
    expect(r.waitedSec).toBe(120);
  });

  it('유예 안에 체크가 붙으면 CI 없음으로 끝내지 않는다', async () => {
    const none: CmdResult = { status: 1, stdout: '', stderr: 'no checks reported on the b branch' };
    const r = await waitForCi(
      opts,
      fakeDeps({ checks: [none, none, ok(checksJson(['build', 'pass']))] }),
    );
    expect(r.status).toBe('pass');
  });

  it('실패하면 잡 로그에서 원인 줄을 붙인다', async () => {
    const deps = fakeDeps({
      checks: [{ status: 1, stdout: checksJson(['build', 'fail'], ['lint', 'pass']), stderr: '' }],
      log: ok('build\tTest\t2026-11-02T11:25:15.1Z ##[error]Error: denylist hit in docs/a.md'),
    });
    const r = await waitForCi(opts, deps);
    expect(r.status).toBe('fail');
    expect(r.failed).toEqual([
      {
        name: 'build',
        workflow: 'CI',
        bucket: 'fail',
        link: JOB_LINK,
        causeLines: ['Error: denylist hit in docs/a.md'],
      },
    ]);
    expect(deps.calls).toContainEqual([
      'gh',
      'run',
      'view',
      '--job',
      '222',
      '--log-failed',
      '-R',
      'o/r',
    ]);
  });

  it('실패가 하나라도 있으면 나머지가 진행 중이어도 상한에서 fail 이다', async () => {
    const deps = fakeDeps({ checks: [ok(checksJson(['build', 'fail'], ['e2e', 'pending']))] });
    const r = await waitForCi({ ...opts, timeoutSec: 60 }, deps);
    expect(r.status).toBe('fail');
    expect(r.pending).toEqual(['e2e']);
  });

  it('상한까지 안 끝나면 진행 중으로 끝낸다', async () => {
    const r = await waitForCi(
      { ...opts, timeoutSec: 90 },
      fakeDeps({ checks: [ok(checksJson(['build', 'pending']))] }),
    );
    expect(r.status).toBe('pending');
    expect(r.pending).toEqual(['build']);
    expect(r.waitedSec).toBe(90);
  });

  it('로그를 못 읽으면 이유를 남기고 판정은 그대로 fail 이다', async () => {
    const deps = fakeDeps({
      checks: [ok(checksJson(['build', 'fail']))],
      log: { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' },
    });
    const r = await waitForCi(opts, deps);
    expect(r.status).toBe('fail');
    expect(r.failed[0]!.logError).toBe('HTTP 404: Not Found');
  });

  it('gh 가 연달아 실패하면 판정을 지어내지 않고 던진다', async () => {
    const bad: CmdResult = { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    await expect(waitForCi(opts, fakeDeps({ checks: [bad] }))).rejects.toThrow('HTTP 502');
  });

  it('head 를 주면 PR head 가 그 커밋이 될 때까지 먼저 기다린다', async () => {
    const deps = fakeDeps({
      head: ['old', 'old', 'abc1234def'],
      checks: [ok(checksJson(['build', 'pass']))],
    });
    const r = await waitForCi({ ...opts, head: 'abc1234' }, deps);
    expect(r.status).toBe('pass');
    expect(r.head).toBe('abc1234');
    const firstChecks = deps.calls.findIndex((c) => c[2] === 'checks');
    const views = deps.calls.slice(0, firstChecks).filter((c) => c[2] === 'view');
    expect(views).toHaveLength(3);
  });

  it('유예 안에 head 가 안 바뀌면 push 를 확인하라고 던진다', async () => {
    const deps = fakeDeps({ head: ['old'], checks: [ok(checksJson(['build', 'pass']))] });
    await expect(waitForCi({ ...opts, head: 'abc1234' }, deps)).rejects.toThrow('push가 끝났는지');
  });
});

describe('ship ci-wait 명령 등록', () => {
  const sub = (cmd: Command, name: string): Command => {
    const found = cmd.commands.find((c) => c.name() === name);
    expect(found, `${name} 하위 명령이 없다`).toBeDefined();
    return found!;
  };

  it('스킬 문서가 쓰는 플래그가 다 있다', () => {
    const ciWait = sub(sub(createCli(), 'ship'), 'ci-wait');
    const flags = ciWait.options.map((o) => o.long);
    for (const f of ['--pr', '--head', '--repo', '--timeout', '--grace', '--interval', '--json']) {
      expect(flags).toContain(f);
    }
  });
});
