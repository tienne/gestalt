import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createCli } from '../../../src/cli/index.js';
import {
  assertDir,
  checkCheckpoint,
  compareCheckpoint,
  mergeCheckpoint,
  observeState,
  readCheckpoint,
  saveCheckpoint,
  writeCheckpoint,
  type ObservedState,
  type ShipCheckpoint,
} from '../../../src/ship/checkpoint.js';
import { defaultRunner, type CmdResult } from '../../../src/ship/ci.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

function cp(over: Partial<ShipCheckpoint> = {}): ShipCheckpoint {
  return {
    version: 1,
    branch: 'feat/x',
    phase: '2',
    round: 2,
    localPrId: '3fa9c2e1',
    prNumber: null,
    prUrl: null,
    base: 'main',
    verifyCmd: 'pnpm gate',
    head: HEAD,
    next: '2.1 리뷰 라운드 3',
    stopped: null,
    history: [],
    savedAt: '2026-11-06T00:00:00.000Z',
    ...over,
  };
}

function obs(over: Partial<ObservedState> = {}): ObservedState {
  return {
    branch: 'feat/x',
    head: HEAD,
    dirty: false,
    cpHeadIsAncestor: true,
    aheadBy: 0,
    localPr: { found: true, status: 'open', headSha: HEAD },
    ...over,
  };
}

const kinds = (c: ShipCheckpoint, o: ObservedState) => compareCheckpoint(c, o).map((m) => m.kind);

describe('mergeCheckpoint', () => {
  const at = { branch: 'feat/x', head: HEAD };

  it('뒤 단계에서 저장해도 앞 단계가 남긴 값을 잃지 않는다', () => {
    const p1 = mergeCheckpoint(
      null,
      { phase: '1', next: '2.1', localPrId: '3fa9c2e1', base: 'main' },
      at,
      't1',
    );
    const p3 = mergeCheckpoint(
      p1,
      { phase: '3', next: '4.1', prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' },
      at,
      't2',
    );
    expect(p3).toMatchObject({
      phase: '3',
      localPrId: '3fa9c2e1',
      base: 'main',
      prNumber: 12,
      next: '4.1',
    });
  });

  it('라운드별 이슈 수는 같은 단계와 라운드면 덮어쓴다', () => {
    let c = mergeCheckpoint(null, { phase: '2', next: 'x', round: 1, issues: 7 }, at, 't');
    c = mergeCheckpoint(c, { phase: '2', next: 'x', round: 2, issues: 3 }, at, 't');
    c = mergeCheckpoint(c, { phase: '2', next: 'x', round: 2, issues: 2 }, at, 't');
    c = mergeCheckpoint(c, { phase: '4', next: 'x', round: 1, issues: 5 }, at, 't');
    expect(c.history.map((h) => `${h.phase}:${h.round}=${h.issues}`)).toEqual([
      '2:1=7',
      '2:2=2',
      '4:1=5',
    ]);
  });

  it('이슈 수만 주고 라운드를 모르면 던진다', () => {
    expect(() => mergeCheckpoint(null, { phase: '2', next: 'x', issues: 1 }, at, 't')).toThrow(
      '--round',
    );
  });

  it('멈춤 표시는 다음 저장에서 지워진다 — 다시 저장했다면 그 자리를 넘어선 것이다', () => {
    const stopped = mergeCheckpoint(null, { phase: '2', next: 'x', stopped: 'blocked' }, at, 't');
    expect(stopped.stopped).toBe('blocked');
    expect(mergeCheckpoint(stopped, { phase: '3', next: 'x' }, at, 't').stopped).toBeNull();
  });

  it('라운드는 같은 단계에서만 이어받는다', () => {
    const r3 = mergeCheckpoint(null, { phase: '2', next: 'x', round: 3 }, at, 't');
    expect(mergeCheckpoint(r3, { phase: '2', next: 'y' }, at, 't').round).toBe(3);
    expect(mergeCheckpoint(r3, { phase: 'a', next: 'y' }, at, 't').round).toBeNull();
  });
});

describe('파일 읽고 쓰기', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = resolve('.gestalt-test', `ship-cp-${randomUUID()}`);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('쓴 그대로 읽는다', () => {
    const d = tmp();
    writeCheckpoint(d, cp());
    expect(readCheckpoint(d)).toEqual({ kind: 'ok', checkpoint: cp() });
  });

  it('없으면 none, 깨졌거나 모르는 형식이면 unreadable', () => {
    const d = tmp();
    expect(readCheckpoint(d)).toEqual({ kind: 'none' });
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'checkpoint.json'), '{');
    expect(readCheckpoint(d).kind).toBe('unreadable');
    writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ ...cp(), version: 2 }));
    expect(readCheckpoint(d).kind).toBe('unreadable');
  });

  it('head 가 커밋 해시 꼴이 아니면 unreadable — git 인자로 넘기는 값이다', () => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ ...cp(), head: '--output=x' }));
    expect(readCheckpoint(d).kind).toBe('unreadable');
  });

  it.each(['-x', 'a$(id)', '/main'])(
    'base 가 브랜치 이름 꼴이 아니면(%s) unreadable — 셸 명령에 그대로 들어간다',
    (base) => {
      const d = tmp();
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ ...cp(), base }));
      expect(readCheckpoint(d)).toEqual({
        kind: 'unreadable',
        error: 'base 이름이 형식에 안 맞아요',
      });
    },
  );

  it('base 가 null 이거나 브랜치 이름이면 읽는다', () => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    for (const base of [null, 'main', 'feat/stack-1']) {
      writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ ...cp(), base }));
      expect(readCheckpoint(d).kind).toBe('ok');
    }
  });

  it.each(['a$(id)', '-x', '3fa9c2e', 123])(
    'localPrId 가 8자 16진수가 아니면(%s) unreadable — gestalt pr close 인자로 들어간다',
    (localPrId) => {
      const d = tmp();
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ ...cp(), localPrId }));
      expect(readCheckpoint(d)).toEqual({
        kind: 'unreadable',
        error: 'localPrId 형식에 안 맞아요',
      });
    },
  );

  it('localPrId 가 null 이면 읽는다 — 로컬 PR 을 만들기 전 단계다', () => {
    const d = tmp();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ ...cp(), localPrId: null }));
    expect(readCheckpoint(d).kind).toBe('ok');
  });

  it('상대 경로와 빈 값은 받지 않는다 — 빈 변수가 워킹트리에 파일을 만든다', () => {
    expect(() => assertDir('')).toThrow('절대 경로');
    expect(() => assertDir(undefined)).toThrow('절대 경로');
    expect(() => assertDir('gestalt-ship/feat')).toThrow('절대 경로');
    expect(assertDir('/abs/path')).toBe('/abs/path');
  });
});

describe('compareCheckpoint', () => {
  it('그대로면 어긋난 게 없다', () => {
    expect(kinds(cp(), obs())).toEqual([]);
  });

  it('브랜치가 다르면 짚는다', () => {
    expect(kinds(cp(), obs({ branch: 'other' }))).toEqual(['branch']);
  });

  it('체크포인트 뒤에 커밋이 있으면 몇 개인지 알린다', () => {
    const m = compareCheckpoint(
      cp(),
      obs({ head: NEXT, aheadBy: 2, localPr: { found: true, status: 'open', headSha: HEAD } }),
    );
    expect(m.map((x) => x.kind)).toEqual(['head-ahead', 'local-pr-head']);
    expect(m[0]!.detail).toContain('2개');
  });

  it('rebase 나 reset 으로 갈라졌으면 head-diverged', () => {
    expect(
      kinds(
        cp(),
        obs({
          head: NEXT,
          cpHeadIsAncestor: false,
          localPr: { found: true, status: 'open', headSha: NEXT },
        }),
      ),
    ).toEqual(['head-diverged']);
  });

  it('커밋 안 한 변경이 있으면 짚는다', () => {
    expect(kinds(cp(), obs({ dirty: true }))).toEqual(['dirty']);
  });

  it('로컬 PR 이 없거나 닫혔으면 짚는다', () => {
    expect(kinds(cp(), obs({ localPr: { found: false } }))).toEqual(['local-pr-missing']);
    expect(kinds(cp(), obs({ localPr: { found: true, status: 'closed', headSha: HEAD } }))).toEqual(
      ['local-pr-closed'],
    );
  });

  it('4단계부터는 로컬 PR head 가 뒤처져도 어긋남이 아니다', () => {
    const c = cp({ phase: '4', prNumber: 12 });
    const o = obs({
      localPr: { found: true, status: 'open', headSha: NEXT },
      pr: { ok: true, state: 'OPEN', isDraft: true, headRefOid: HEAD, url: 'u' },
    });
    expect(kinds(c, o)).toEqual([]);
  });

  it('GitHub PR 이 닫혔거나 head 가 다르거나 조회가 실패하면 짚는다', () => {
    const c = cp({ phase: '4', prNumber: 12 });
    const pr = (p: ObservedState['pr']) => kinds(c, obs({ pr: p }));
    expect(pr({ ok: true, state: 'MERGED', isDraft: false, headRefOid: HEAD, url: 'u' })).toEqual([
      'pr-closed',
    ]);
    expect(pr({ ok: true, state: 'OPEN', isDraft: true, headRefOid: NEXT, url: 'u' })).toEqual([
      'pr-head',
    ]);
    expect(pr({ ok: false, error: 'HTTP 401' })).toEqual(['pr-lookup-failed']);
  });
});

describe('observeState', () => {
  const fake = (table: Record<string, CmdResult>) => (cmd: string, args: readonly string[]) => {
    const key = [cmd, ...args].join(' ');
    const hit = table[key];
    if (!hit) throw new Error(`예상 못 한 호출: ${key}`);
    return hit;
  };
  const ok = (stdout: string): CmdResult => ({ status: 0, stdout, stderr: '' });

  it('체크포인트 커밋을 못 찾으면(128) 갈라진 것으로 본다', () => {
    const run = fake({
      'git rev-parse --abbrev-ref HEAD': ok('feat/x\n'),
      'git rev-parse HEAD': ok(`${NEXT}\n`),
      'git status --porcelain --untracked-files=no': ok(''),
      [`git merge-base --is-ancestor ${HEAD} HEAD`]: {
        status: 128,
        stdout: '',
        stderr: 'fatal: Not a valid commit name',
      },
    });
    const o = observeState(cp({ localPrId: null }), { run, localPr: () => null });
    expect(o).toMatchObject({ head: NEXT, cpHeadIsAncestor: false, aheadBy: 0, dirty: false });
  });

  it('GitHub 단계에서만 PR 을 조회한다', () => {
    const base = {
      'git rev-parse --abbrev-ref HEAD': ok('feat/x'),
      'git rev-parse HEAD': ok(HEAD),
      'git status --porcelain --untracked-files=no': ok(' M a.ts'),
      [`git merge-base --is-ancestor ${HEAD} HEAD`]: ok(''),
      [`git rev-list --count ${HEAD}..HEAD`]: ok('0'),
    };
    const o2 = observeState(cp({ prNumber: 12 }), {
      run: fake(base),
      localPr: () => ({ status: 'open', headSha: HEAD }),
    });
    expect(o2.pr).toBeUndefined();
    expect(o2.dirty).toBe(true);

    const o4 = observeState(cp({ phase: '4', prNumber: 12 }), {
      run: fake({
        ...base,
        'gh pr view 12 --json state,isDraft,headRefOid,url': ok(
          JSON.stringify({
            state: 'OPEN',
            isDraft: true,
            headRefOid: HEAD,
            url: 'https://github.com/o/r/pull/12',
          }),
        ),
      }),
      localPr: () => ({ status: 'open', headSha: HEAD }),
    });
    expect(o4.pr).toEqual({
      ok: true,
      state: 'OPEN',
      isDraft: true,
      headRefOid: HEAD,
      url: 'https://github.com/o/r/pull/12',
    });
  });
});

describe('실제 git 레포에서 저장하고 대조한다', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const sh = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  const inRepo = (cmd: string, args: readonly string[]) =>
    defaultRunner(cmd, ['-C', root, ...args]);

  it('저장 직후는 match, 커밋을 더 쌓으면 head-ahead', () => {
    root = mkdtempSync(join(tmpdir(), 'gestalt-ship-cp-'));
    sh('init', '-q');
    sh('symbolic-ref', 'HEAD', 'refs/heads/feat/x');
    sh('config', 'user.email', 't@example.com');
    sh('config', 'user.name', 't');
    writeFileSync(join(root, 'a.txt'), '1');
    sh('add', '.');
    sh('commit', '-q', '-m', 'one');

    const dir = join(root, '.git', 'gestalt-ship', 'feat', 'x');
    saveCheckpoint(
      dir,
      { phase: '2', next: '2.1 라운드 2', round: 1, issues: 4, localPrId: 'deadbeef' },
      inRepo,
    );
    const head = sh('rev-parse', 'HEAD');
    const deps = { run: inRepo, localPr: () => ({ status: 'open', headSha: head }) };

    const first = checkCheckpoint(dir, deps);
    expect(first.status).toBe('match');

    writeFileSync(join(root, 'a.txt'), '2');
    sh('commit', '-q', '-am', 'two');
    const second = checkCheckpoint(dir, deps);
    expect(second.status).toBe('mismatch');
    if (second.status === 'mismatch') {
      expect(second.mismatches.map((m) => m.kind)).toEqual(['head-ahead', 'local-pr-head']);
    }
  });
});

describe('ship checkpoint 명령 등록', () => {
  const sub = (cmd: Command, name: string): Command => {
    const found = cmd.commands.find((c) => c.name() === name);
    expect(found, `${name} 하위 명령이 없다`).toBeDefined();
    return found!;
  };

  it('스킬 문서가 쓰는 플래그가 다 있다', () => {
    const checkpoint = sub(sub(createCli(), 'ship'), 'checkpoint');
    const save = sub(checkpoint, 'save').options.map((o) => o.long);
    for (const f of [
      '--dir',
      '--phase',
      '--next',
      '--round',
      '--local-pr',
      '--pr',
      '--pr-url',
      '--base',
      '--verify-cmd',
      '--issues',
      '--stopped',
    ]) {
      expect(save).toContain(f);
    }
    const check = sub(checkpoint, 'check').options.map((o) => o.long);
    expect(check).toEqual(expect.arrayContaining(['--dir', '--json']));
  });
});
