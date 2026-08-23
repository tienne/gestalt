import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

/**
 * 웹 UI 하나가 여러 레포를 보여주려면 어떤 레포가 있는지 알아야 한다.
 *
 * 이 목록은 `~/.gestalt/repos.json`에 있다. 테스트가 진짜 홈을 건드리면 안 된다.
 * homedir을 임시 자리로 돌려놓고 돈다.
 */

let fakeHome: string;
const savedHome = process.env['GESTALT_HOME'];

const registry = await import('../../../src/local-pr/registry.js');
const { LocalPrEngine } = await import('../../../src/local-pr/engine.js');

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), `gestalt-registry-${randomUUID().slice(0, 8)}-`));
  run(repo, ['init', '-q']);
  run(repo, ['config', 'user.email', 't@e.st']);
  run(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  run(repo, ['add', '-A']);
  run(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('레포 레지스트리', () => {
  const repos: string[] = [];

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), `gestalt-home-${randomUUID().slice(0, 8)}-`));
    process.env['GESTALT_HOME'] = fakeHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['GESTALT_HOME'];
    else process.env['GESTALT_HOME'] = savedHome;
    rmSync(fakeHome, { recursive: true, force: true });
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('등록한 레포가 목록에 뜬다', () => {
    const repo = makeRepo();
    repos.push(repo);

    registry.registerRepo(repo);

    expect(registry.listRepos().map((r) => r.key)).toEqual([registry.repoKey(repo)]);
  });

  it('PR을 만드는 것만으로는 목록이 안 는다', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = run(repo, ['branch', '--show-current']);
    run(repo, ['checkout', '-q', '-b', 'work']);
    writeFileSync(join(repo, 'b.txt'), 'y\n');
    run(repo, ['add', '-A']);
    run(repo, ['commit', '-q', '-m', 'work']);

    // 이 경로는 MCP ges_pr의 repoRoot로 이어져 있다. 여기서 등록하면 도구 호출 한 번이
    // 인증 없는 웹 UI가 열어 줄 레포를 영구히 늘린다
    const engine = new LocalPrEngine(repo);
    try {
      engine.create({ title: '테스트', author: 'codex:test', base, head: 'work' });
    } finally {
      engine.dispose();
    }

    expect(registry.listRepos()).toHaveLength(0);
  });

  it('같은 레포를 두 번 등록해도 한 줄이다', () => {
    const repo = makeRepo();
    repos.push(repo);

    registry.registerRepo(repo);
    registry.registerRepo(repo);

    expect(registry.listRepos()).toHaveLength(1);
  });

  it('워크트리에서 등록해도 본체와 같은 키다', () => {
    const repo = makeRepo();
    repos.push(repo);
    const wt = join(tmpdir(), `gestalt-wt-${randomUUID().slice(0, 8)}`);
    run(repo, ['worktree', 'add', '--detach', '-q', wt, 'HEAD']);

    try {
      // 워크트리 여럿이 저장소 하나를 공유하므로 목록에서도 한 줄이어야 한다
      expect(registry.repoKey(wt)).toBe(registry.repoKey(repo));

      registry.registerRepo(repo);
      registry.registerRepo(wt);

      expect(registry.listRepos()).toHaveLength(1);
    } finally {
      run(repo, ['worktree', 'remove', '--force', wt]);
    }
  });

  it('사라진 레포는 목록에서 뺀다', () => {
    const repo = makeRepo();
    registry.registerRepo(repo);
    rmSync(repo, { recursive: true, force: true });

    expect(registry.listRepos()).toHaveLength(0);
  });

  it('목록 파일이 깨져도 빈 목록으로 시작한다', () => {
    const repo = makeRepo();
    repos.push(repo);
    registry.registerRepo(repo);
    writeFileSync(join(fakeHome, '.gestalt', 'repos.json'), '{{{ 깨진 JSON', 'utf-8');

    // 손상된 목록 때문에 서버가 아예 안 뜨는 게 더 나쁘다
    expect(() => registry.listRepos()).not.toThrow();
    expect(registry.listRepos()).toHaveLength(0);
  });
  it('모양이 안 맞는 항목은 안 연다', () => {
    const repo = makeRepo();
    repos.push(repo);
    registry.registerRepo(repo);

    // 이 path가 그대로 LocalPrEngine의 cwd가 되고 상세 페이지가 거기서 git을 돌린다.
    // 파싱만 하고 믿으면 손으로 넣은 값이 명령의 작업 디렉토리가 된다
    const listPath = join(fakeHome, '.gestalt', 'repos.json');
    const good = JSON.parse(readFileSync(listPath, 'utf-8')) as unknown[];
    writeFileSync(
      listPath,
      JSON.stringify([
        ...good,
        { key: 'aaaaaaaa', path: 'relative/repo', name: 'rel', addedAt: '' },
        { key: 'bbbbbbbb', path: `${repo}/../..`, name: 'up', addedAt: '' },
        { key: 'not-hex!', path: repo, name: 'badkey', addedAt: '' },
        { key: 'cccccccc', path: repo, name: '', addedAt: '' },
        { key: 'dddddddd', name: 'nopath', addedAt: '' },
        'string이 항목으로 들어옴',
      ]),
      'utf-8',
    );

    expect(registry.listRepos().map((r) => r.key)).toEqual([registry.repoKey(repo)]);
  });

  it('목록 파일은 주인만 읽는다', () => {
    const repo = makeRepo();
    repos.push(repo);
    registry.registerRepo(repo);

    // 사용자가 작업하는 비공개 레포의 절대 경로가 여기 다 모인다
    const mode = statSync(join(fakeHome, '.gestalt', 'repos.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('여러 프로세스가 동시에 등록해도 서로를 안 지운다', async () => {
    // 워크트리 여럿이 같은 목록에 동시에 손대는 게 이 레포의 기본 흐름이다.
    // 읽고 고쳐 쓰는 사이를 안 막으면 나중에 쓴 쪽이 먼저 쓴 쪽의 줄을 덮는다
    const made = Array.from({ length: 4 }, () => makeRepo());
    repos.push(...made);

    const script = join(fakeHome, 'register.mjs');
    const moduleUrl = pathToFileURL(resolve('src/local-pr/registry.ts')).href;
    writeFileSync(
      script,
      `const { registerRepo } = await import(${JSON.stringify(moduleUrl)});\n` +
        `for (let i = 0; i < 20; i++) registerRepo(process.argv[2]);\n`,
      'utf-8',
    );

    const tsx = resolve('node_modules', '.bin', 'tsx');
    await Promise.all(
      made.map((repo) =>
        promisify(execFile)(tsx, [script, repo], {
          env: { ...process.env, GESTALT_HOME: fakeHome },
        }),
      ),
    );

    expect(
      registry
        .listRepos()
        .map((r) => r.key)
        .sort(),
    ).toEqual(made.map((r) => registry.repoKey(r)).sort());
  }, 60_000);

  it('쓰는 중에 읽어도 반쯤 쓰인 목록은 안 보인다', async () => {
    const repo = makeRepo();
    repos.push(repo);

    // 읽는 쪽은 잠금을 안 잡는다 — pr serve가 목록을 읽는 동안 워커가 등록을 친다.
    // 자르고 나서 쓰면 그 사이에 읽은 쪽이 빈 파일을 보고 목록이 통째로 사라진다
    const seeded = Array.from({ length: 300 }, (_, i) => ({
      key: i.toString(16).padStart(8, '0'),
      path: repo,
      name: `seed-${i}`,
      addedAt: '',
    }));
    mkdirSync(join(fakeHome, '.gestalt'), { recursive: true });
    writeFileSync(join(fakeHome, '.gestalt', 'repos.json'), JSON.stringify(seeded), 'utf-8');

    const other = makeRepo();
    repos.push(other);
    const script = join(fakeHome, 'churn.mjs');
    const moduleUrl = pathToFileURL(resolve('src/local-pr/registry.ts')).href;
    writeFileSync(
      script,
      `const { registerRepo } = await import(${JSON.stringify(moduleUrl)});\n` +
        `for (let i = 0; i < 150; i++) registerRepo(process.argv[2]);\n`,
      'utf-8',
    );

    const tsx = resolve('node_modules', '.bin', 'tsx');
    let running = true;
    const child = promisify(execFile)(tsx, [script, other], {
      env: { ...process.env, GESTALT_HOME: fakeHome },
    }).finally(() => {
      running = false;
    });

    let seenLeast = Number.POSITIVE_INFINITY;
    while (running) {
      seenLeast = Math.min(seenLeast, registry.listRepos().length);
      await new Promise((r) => setImmediate(r));
    }
    await child;

    expect(seenLeast).toBeGreaterThanOrEqual(seeded.length);
  }, 60_000);

  it('쥔 채로 죽은 잠금은 부순다', () => {
    const repo = makeRepo();
    repos.push(repo);

    // 잠금은 디렉토리다. 프로세스가 쥔 채로 죽으면 아무도 못 지우므로 목록이 영영 안 는다
    const lock = join(fakeHome, '.gestalt', 'repos.json.lock');
    mkdirSync(lock, { recursive: true });
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);

    registry.registerRepo(repo);

    expect(registry.listRepos()).toHaveLength(1);
  });

  it('쓰다 만 임시 파일은 다음 등록 때 치운다', () => {
    const repo = makeRepo();
    repos.push(repo);

    // 옆에 쓰고 rename으로 갈아 끼우므로, 쓰는 도중 죽으면 그 이름이 영영 남는다
    mkdirSync(join(fakeHome, '.gestalt'), { recursive: true });
    const leftover = join(fakeHome, '.gestalt', 'repos.json.99999.tmp');
    writeFileSync(leftover, '[]\n', 'utf-8');

    registry.registerRepo(repo);

    expect(existsSync(leftover)).toBe(false);
    expect(registry.listRepos()).toHaveLength(1);
  });

  it('내가 쥔 잠금이 아니면 안 푼다', () => {
    const lock = join(fakeHome, '.gestalt', 'repos.json.lock');

    // 내가 오래 쥐고 있는 사이에 남이 stale로 부수고 자기 잠금을 새로 만든 상황.
    // 내가 끝나며 무조건 지우면 남이 목록을 고치는 도중에 그 잠금이 풀린다
    registry.withLock(() => {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'owner'), '남의-것', 'utf-8');
    });

    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(lock, 'owner'), 'utf-8')).toBe('남의-것');
  });

  it('내 잠금은 끝나면 푼다', () => {
    const lock = join(fakeHome, '.gestalt', 'repos.json.lock');

    registry.withLock(() => undefined);

    expect(existsSync(lock)).toBe(false);
  });

  it('방금 잡힌 잠금은 기다리다 포기한다', () => {
    const repo = makeRepo();
    repos.push(repo);

    const lock = join(fakeHome, '.gestalt', 'repos.json.lock');
    mkdirSync(lock, { recursive: true });

    // 무한정 기다리면 pr serve가 안 뜬다. 못 고쳤다고 말하고 끝낸다
    expect(() => registry.registerRepo(repo)).toThrow(/잠겨/);
  }, 20_000);
});
