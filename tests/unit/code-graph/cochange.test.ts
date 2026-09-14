import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CodeGraphStore,
  MAX_MATCHED_ROWS,
  CO_CHANGE_NEIGHBORS_SQL,
  CO_CHANGE_PAIRS_SQL,
} from '../../../src/code-graph/storage.js';
import type { CoChangeNeighborRow } from '../../../src/code-graph/storage.js';
import {
  parseGitLog,
  countPairs,
  scoreNeighbor,
  pairKey,
  syncCoChange,
  queryCoChange,
  buildCoChangeLookup,
  MAX_FILES_PER_COMMIT,
  MIN_PAIR_COUNT,
  CONFIDENCE_DECIMALS,
  LIFT_DECIMALS,
} from '../../../src/code-graph/cochange.js';
import type { GitRunner } from '../../../src/code-graph/cochange.js';

const ROOT = '/repo';

/** 임계를 걷어낸 이웃 행 전량. 저장 자체를 보는 테스트가 쓴다 */
function allNeighborRows(store: CodeGraphStore, filePath: string): CoChangeNeighborRow[] {
  return store.getCoChangeNeighbors(filePath, 1, 0, store.getCoChangeSolo(filePath)).rows;
}

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

/** `git log --format=%H --name-only --no-merges` 출력을 흉내낸다 */
function gitLog(commits: string[][]): string {
  return commits.map((files, i) => `${sha(i + 1)}\n\n${files.join('\n')}\n`).join('\n');
}

interface FakeGitConfig {
  toplevel?: string;
  head?: string;
  fullLog?: string;
  rangeLog?: Record<string, string>;
  isAncestor?: boolean;
}

function fakeGit(config: FakeGitConfig = {}): GitRunner {
  return (_root, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return `${config.toplevel ?? ROOT}\n`;
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return `${config.head ?? sha(999)}\n`;
    }
    if (args[0] === 'merge-base') {
      if (config.isAncestor) return '';
      throw new Error('not an ancestor');
    }
    if (args[0] === 'log') {
      const range = args.find((a) => a.includes('..'));
      if (range) return config.rangeLog?.[range] ?? '';
      return config.fullLog ?? '';
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

/** 모든 경로가 워킹트리에 있다고 본다 */
const allExist = (): boolean => true;

interface RawDb {
  prepare(s: string): { all(p: unknown): unknown[] };
  close(): void;
}

/**
 * 스토어를 거치지 않고 질의문을 직접 돈다. 스토어를 거치면 JS의 slice가
 * 같은 행 수를 만들어내서 SQL이 실제로 몇 행을 읽었는지 안 보인다.
 */
function rawDb(dbPath: string): RawDb {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (p: string) => RawDb;
  return new Database(dbPath);
}

describe('parseGitLog()', () => {
  it('커밋 단위로 sha와 파일 목록을 분리한다', () => {
    const commits = parseGitLog(gitLog([['src/a.ts', 'src/b.ts'], ['README.md']]));

    expect(commits).toHaveLength(2);
    expect(commits[0]!.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(commits[1]!.files).toEqual(['README.md']);
  });

  it('파일이 하나도 없는 커밋도 레코드로 남긴다', () => {
    const commits = parseGitLog(`${sha(1)}\n\n${sha(2)}\n\nsrc/a.ts\n`);

    expect(commits).toHaveLength(2);
    expect(commits[0]!.files).toEqual([]);
  });
});

describe('countPairs() — 대형 커밋 제외', () => {
  it(`${MAX_FILES_PER_COMMIT}개 초과 커밋에만 있는 페어는 결과에 없다`, () => {
    const big = Array.from({ length: 25 }, (_, i) => `src/big${i}.ts`);
    const raw = gitLog([
      big,
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
    ]);

    const counts = countPairs(parseGitLog(raw));

    expect(counts.pairs.has(pairKey('src/big0.ts', 'src/big1.ts'))).toBe(false);
    expect(counts.solos.has('src/big0.ts')).toBe(false);
    expect(counts.pairs.get(pairKey('src/a.ts', 'src/b.ts'))).toBe(3);
    expect(counts.commitsUsed).toBe(3);
    expect(counts.commitsScanned).toBe(4);
  });

  it('경계: 20개 커밋은 쓰고 21개 커밋은 버린다', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `src/t${i}.ts`);
    const twentyOne = Array.from({ length: 21 }, (_, i) => `src/o${i}.ts`);

    const counts = countPairs(parseGitLog(gitLog([twenty, twentyOne])));

    expect(counts.commitsUsed).toBe(1);
    expect(counts.pairs.has(pairKey('src/t0.ts', 'src/t1.ts'))).toBe(true);
    expect(counts.pairs.has(pairKey('src/o0.ts', 'src/o1.ts'))).toBe(false);
  });

  it('파일이 1개뿐인 커밋은 페어를 못 만드니 쓰지 않는다', () => {
    const counts = countPairs(parseGitLog(gitLog([['src/solo.ts'], ['src/a.ts', 'src/b.ts']])));

    expect(counts.commitsUsed).toBe(1);
    expect(counts.solos.has('src/solo.ts')).toBe(false);
  });

  it('한 커밋에 같은 파일이 두 번 나와도 한 번만 센다', () => {
    const counts = countPairs([{ sha: sha(1), files: ['src/a.ts', 'src/a.ts', 'src/b.ts'] }]);

    expect(counts.solos.get('src/a.ts')).toBe(1);
    expect(counts.pairs.get(pairKey('src/a.ts', 'src/b.ts'))).toBe(1);
  });
});

describe('scoreNeighbor()', () => {
  it('confidence는 방향별로 계산해 큰 쪽을 쓴다', () => {
    const { confidence } = scoreNeighbor(6, 6, 36, 36);
    expect(confidence).toBeCloseTo(1, 5);
  });

  it('흔한 파일은 lift가 1 근처로 눌린다', () => {
    // 36커밋 중 36번 등장하는 파일과의 페어 — 우연과 다를 바 없다
    const common = scoreNeighbor(6, 6, 36, 36);
    // 6번만 등장하는 파일과의 페어 — 우연 대비 6배
    const dedicated = scoreNeighbor(6, 6, 6, 36);

    expect(common.lift).toBeCloseTo(1, 5);
    expect(dedicated.lift).toBeCloseTo(6, 5);
    expect(dedicated.confidence * dedicated.lift).toBeGreaterThan(common.confidence * common.lift);
  });

  it('solo가 0이면 0점이다 (0으로 나누지 않는다)', () => {
    expect(scoreNeighbor(3, 0, 0, 10)).toEqual({ confidence: 0, lift: 0 });
  });

  it(`confidence는 ${CONFIDENCE_DECIMALS}자리, lift는 ${LIFT_DECIMALS}자리로 잘라 낸다`, () => {
    // 반올림 전 원값은 conf 0.6666…, lift 3.3333… 이다
    const { confidence, lift } = scoreNeighbor(2, 3, 20, 100);

    expect(confidence).toBe(0.67);
    expect(lift).toBe(3.3);
  });

  it('부동소수점 꼬리가 응답에 새어나가지 않는다', () => {
    // 이 레포를 돌려보면 conf 1 / lift 45.666666666666664 로 나오던 조합
    const { confidence, lift } = scoreNeighbor(5, 5, 6, 274);

    expect(String(confidence)).toBe('1');
    expect(String(lift)).toBe('45.7');
  });
});

describe('co-change 저장과 조회', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  /**
   * src/x.ts ↔ src/y.ts 는 전용 페어(6회, 서로만 함께 바뀜),
   * package.json 은 36커밋 전부에 끼는 흔한 파일이다.
   */
  function seedCommonFileHistory(): void {
    const commits: string[][] = [];
    for (let i = 0; i < 6; i++) commits.push(['src/x.ts', 'src/y.ts', 'package.json']);
    for (let i = 0; i < 30; i++) commits.push(['package.json', `src/m${i}.ts`]);

    const summary = syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ fullLog: gitLog(commits) }),
    });
    expect(summary?.commitsUsed).toBe(36);
  }

  it('lift가 흔한 파일을 전용 페어 아래로 누른다', () => {
    seedCommonFileHistory();

    const result = queryCoChange(store, ROOT, { target: 'src/x.ts', exists: allExist });

    expect(result.available).toBe(true);
    expect(result.neighbors[0]!.filePath).toBe('/repo/src/y.ts');

    const pkg = result.neighbors.find((n) => n.filePath === '/repo/package.json')!;
    expect(pkg.confidence).toBeCloseTo(1, 5);
    expect(pkg.lift).toBeCloseTo(1, 5);
    expect(result.neighbors[0]!.lift).toBeGreaterThan(pkg.lift);
  });

  it('상대경로와 절대경로, 후행 슬래시가 같은 결과를 낸다', () => {
    seedCommonFileHistory();

    const rel = queryCoChange(store, ROOT, { target: 'src/x.ts', exists: allExist });
    const abs = queryCoChange(store, ROOT, { target: '/repo/src/x.ts', exists: allExist });
    const trailing = queryCoChange(store, `${ROOT}/`, { target: 'src/x.ts', exists: allExist });

    expect(abs.neighbors).toEqual(rel.neighbors);
    expect(trailing.neighbors).toEqual(rel.neighbors);
    expect(rel.neighbors.length).toBeGreaterThan(0);
  });

  it('수집 이력이 없으면 available:false와 사유를 싣는다', () => {
    const result = queryCoChange(store, ROOT, { target: 'src/x.ts', exists: allExist });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('has not been collected');
    expect(result.pairsInDb).toBe(0);
  });

  it('이력은 있는데 이웃이 0건이면 조용히 넘어가지 않고 사유를 남긴다', () => {
    seedCommonFileHistory();

    const result = queryCoChange(store, ROOT, { target: 'src/nope.ts', exists: allExist });

    expect(result.available).toBe(true);
    expect(result.neighbors).toHaveLength(0);
    expect(result.pairsInDb).toBeGreaterThan(0);
    expect(result.reason).toContain('no co-change neighbors');
  });

  it('워킹트리에 없는 파일은 결과에서 빠지고 남은 파일 점수는 그대로다', () => {
    const commits: string[][] = [];
    for (let i = 0; i < 6; i++) commits.push(['src/x.ts', 'src/y.ts', 'src/gone.ts']);
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ fullLog: gitLog(commits) }),
    });

    const withAll = queryCoChange(store, ROOT, { target: 'src/x.ts', exists: allExist });
    const withoutGone = queryCoChange(store, ROOT, {
      target: 'src/x.ts',
      exists: (p) => !p.endsWith('gone.ts'),
    });

    expect(withAll.neighbors.map((n) => n.filePath)).toContain('/repo/src/gone.ts');
    expect(withoutGone.neighbors.map((n) => n.filePath)).not.toContain('/repo/src/gone.ts');

    // 존재 필터는 조회에서만 돈다. 수집에서 걸렀다면 solo가 깎여 점수가 달라진다.
    const yAll = withAll.neighbors.find((n) => n.filePath === '/repo/src/y.ts')!;
    const yFiltered = withoutGone.neighbors.find((n) => n.filePath === '/repo/src/y.ts')!;
    expect(yFiltered.confidence).toBe(yAll.confidence);
    expect(yFiltered.lift).toBe(yAll.lift);
  });

  it('target을 생략하면 상위 페어 목록을 낸다', () => {
    seedCommonFileHistory();

    const result = queryCoChange(store, ROOT, { exists: allExist });

    expect(result.neighbors).toHaveLength(0);
    expect(result.pairs.length).toBeGreaterThan(0);
    expect(result.pairs[0]!.fileA).toBe('/repo/src/x.ts');
    expect(result.pairs[0]!.fileB).toBe('/repo/src/y.ts');
  });

  it('minPairCount 미만 페어는 버린다', () => {
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({
        fullLog: gitLog([
          ['src/a.ts', 'src/b.ts'],
          ['src/a.ts', 'src/b.ts'],
        ]),
      }),
    });

    const result = queryCoChange(store, ROOT, { target: 'src/a.ts', exists: allExist });
    expect(result.neighbors).toHaveLength(0);

    const loosened = queryCoChange(store, ROOT, {
      target: 'src/a.ts',
      minPairCount: 2,
      exists: allExist,
    });
    expect(loosened.neighbors).toHaveLength(1);
  });

  it('전역 페어 목록도 minPairCount 미만을 버린다', () => {
    // 이웃 조회와 전역 조회는 질의가 따로다. 한쪽만 보면 다른 쪽 필터를
    // 지워도 아무 불이 안 켜진다
    const commits: string[][] = [];
    for (let i = 0; i < 5; i++) commits.push(['src/a.ts', 'src/b.ts']);
    for (let i = 0; i < 2; i++) commits.push(['src/c.ts', 'src/d.ts']);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const strict = queryCoChange(store, ROOT, { minPairCount: 5, exists: allExist });
    const loose = queryCoChange(store, ROOT, { minPairCount: 2, exists: allExist });

    expect(strict.pairs.map((p) => p.pairCount)).toEqual([5]);
    expect(loose.pairs.map((p) => p.pairCount).sort()).toEqual([2, 5]);
    expect(store.getCoChangePairs(5, 0).rows).toHaveLength(1);
    expect(store.getCoChangePairs(2, 0).rows).toHaveLength(2);
  });

  it('조회 결과의 점수는 반올림된 상태로 나온다', () => {
    seedCommonFileHistory();

    const byTarget = queryCoChange(store, ROOT, { target: 'src/x.ts', exists: allExist });
    const byPairs = queryCoChange(store, ROOT, { exists: allExist });
    const scored = [...byTarget.neighbors, ...byPairs.pairs];

    expect(scored.length).toBeGreaterThan(0);
    for (const s of scored) {
      expect(s.confidence).toBe(Number(s.confidence.toFixed(CONFIDENCE_DECIMALS)));
      expect(s.lift).toBe(Number(s.lift.toFixed(LIFT_DECIMALS)));
    }
  });

  it('limit이 이웃 개수를 자른다', () => {
    seedCommonFileHistory();

    const all = queryCoChange(store, ROOT, { target: 'src/x.ts', exists: allExist });
    const capped = queryCoChange(store, ROOT, { target: 'src/x.ts', limit: 1, exists: allExist });

    expect(all.neighbors.length).toBeGreaterThan(1);
    expect(capped.neighbors).toHaveLength(1);
    expect(capped.neighbors[0]).toEqual(all.neighbors[0]);
  });

  it('target 없는 페어 목록에서도 워킹트리에 없는 파일은 빠진다', () => {
    seedCommonFileHistory();

    const result = queryCoChange(store, ROOT, {
      exists: (p) => !p.endsWith('/src/y.ts'),
    });

    const files = result.pairs.flatMap((p) => [p.fileA, p.fileB]);
    expect(files.length).toBeGreaterThan(0);
    expect(files).not.toContain('/repo/src/y.ts');
  });
});

describe('syncCoChange() — 수집 가드와 증분', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-sync-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  it('repoRoot가 레포 최상위가 아니면 아무것도 수집하지 않는다', () => {
    // 테스트가 repoRoot를 레포 안쪽에 만드는 자리. 가드가 없으면 부모 레포의
    // 전체 이력이 통째로 딸려온다.
    const summary = syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({
        toplevel: '/some/parent/repo',
        fullLog: gitLog([['src/a.ts', 'src/b.ts']]),
      }),
    });

    expect(summary).toBeUndefined();
    expect(store.countCoChangePairs()).toBe(0);
    expect(store.getCoChangeMeta()).toBeNull();
  });

  it('git 레포가 아니면 undefined를 반환한다', () => {
    const summary = syncCoChange(store, ROOT, {
      runGit: () => {
        throw new Error('not a git repository');
      },
    });

    expect(summary).toBeUndefined();
    expect(store.countCoChangePairs()).toBe(0);
  });

  it('증분 모드는 새 커밋만 읽어 카운터를 더한다', () => {
    const base = Array.from({ length: 3 }, () => ['src/a.ts', 'src/b.ts']);
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ head: sha(10), fullLog: gitLog(base) }),
    });
    const before = store.getCoChangeMeta()!;
    expect(before.commitsUsed).toBe(3);

    syncCoChange(store, ROOT, {
      mode: 'incremental',
      runGit: fakeGit({
        head: sha(20),
        isAncestor: true,
        rangeLog: { [`${sha(10)}..HEAD`]: gitLog([['src/a.ts', 'src/b.ts']]) },
      }),
    });

    const after = store.getCoChangeMeta()!;
    expect(after.commitsUsed).toBe(4);
    expect(after.headSha).toBe(sha(20));

    const neighbors = allNeighborRows(store, '/repo/src/a.ts');
    expect(neighbors[0]!.pairCount).toBe(4);
  });

  it('HEAD가 그대로면 다시 읽지 않는다', () => {
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ head: sha(10), fullLog: gitLog([['src/a.ts', 'src/b.ts']]) }),
    });

    const summary = syncCoChange(store, ROOT, {
      mode: 'incremental',
      runGit: fakeGit({
        head: sha(10),
        fullLog: 'SHOULD NOT BE READ',
      }),
    });

    expect(summary?.mode).toBe('incremental');
    expect(store.getCoChangeMeta()!.commitsUsed).toBe(1);
  });

  it('이전 기준점에 도달할 수 없으면 전량 재수집으로 내린다', () => {
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ head: sha(10), fullLog: gitLog([['src/a.ts', 'src/b.ts']]) }),
    });

    // rebase로 이력이 갈렸다 — merge-base가 실패한다
    const summary = syncCoChange(store, ROOT, {
      mode: 'incremental',
      runGit: fakeGit({
        head: sha(20),
        isAncestor: false,
        fullLog: gitLog([
          ['src/c.ts', 'src/d.ts'],
          ['src/c.ts', 'src/d.ts'],
        ]),
      }),
    });

    expect(summary?.mode).toBe('full');
    expect(summary?.commitsUsed).toBe(2);
    // 리셋됐으니 옛 페어는 남아 있지 않다
    expect(allNeighborRows(store, '/repo/src/a.ts')).toHaveLength(0);
  });

  it('full 모드는 기존 카운트를 비우고 새로 쓴다', () => {
    const run = fakeGit({ head: sha(10), fullLog: gitLog([['src/a.ts', 'src/b.ts']]) });
    syncCoChange(store, ROOT, { mode: 'full', runGit: run });
    syncCoChange(store, ROOT, { mode: 'full', runGit: run });

    expect(store.getCoChangeMeta()!.commitsUsed).toBe(1);
    expect(allNeighborRows(store, '/repo/src/a.ts')[0]!.pairCount).toBe(1);
  });
});

describe('buildCoChangeLookup()', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-lookup-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
  });

  it('여러 seed의 이웃을 합치고 seed 자신은 뺀다', () => {
    const commits: string[][] = [];
    for (let i = 0; i < 4; i++) commits.push(['src/a.ts', 'src/b.ts']);
    for (let i = 0; i < 4; i++) commits.push(['src/c.ts', 'src/d.ts']);
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ fullLog: gitLog(commits) }),
    });

    const lookup = buildCoChangeLookup(store, ROOT, ['src/a.ts', 'src/c.ts'], {
      exists: allExist,
    });

    expect(lookup.available).toBe(true);
    expect(lookup.neighbors.map((n) => n.filePath).sort()).toEqual([
      '/repo/src/b.ts',
      '/repo/src/d.ts',
    ]);
  });

  it('seed끼리 짝이면 이웃으로 올리지 않는다', () => {
    const commits = Array.from({ length: 4 }, () => ['src/a.ts', 'src/b.ts']);
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ fullLog: gitLog(commits) }),
    });

    const lookup = buildCoChangeLookup(store, ROOT, ['src/a.ts', 'src/b.ts'], {
      exists: allExist,
    });

    expect(lookup.neighbors).toHaveLength(0);
    expect(lookup.available).toBe(true);
    expect(lookup.reason).toContain('no co-change neighbors');
  });

  it('수집 전이면 available:false다', () => {
    const lookup = buildCoChangeLookup(store, ROOT, ['src/a.ts'], { exists: allExist });

    expect(lookup.available).toBe(false);
    expect(lookup.reason).toContain('has not been collected');
  });

  it('같은 이웃이 두 seed에 걸리면 점수가 높은 쪽만 남는다', () => {
    const commits: string[][] = [];
    // shared.ts는 a.ts와 8번, b.ts와 3번 함께 바뀌었다
    for (let i = 0; i < 8; i++) commits.push(['src/a.ts', 'src/shared.ts']);
    for (let i = 0; i < 3; i++) commits.push(['src/b.ts', 'src/shared.ts']);
    for (let i = 0; i < 20; i++) commits.push([`src/n${i}.ts`, 'src/b.ts']);
    syncCoChange(store, ROOT, {
      mode: 'full',
      runGit: fakeGit({ fullLog: gitLog(commits) }),
    });

    const viaA = queryCoChange(store, ROOT, { target: 'src/a.ts', exists: allExist }).neighbors[0]!;
    const lookup = buildCoChangeLookup(store, ROOT, ['src/a.ts', 'src/b.ts'], { exists: allExist });
    const shared = lookup.neighbors.filter((n) => n.filePath === '/repo/src/shared.ts');

    expect(shared).toHaveLength(1);
    expect(shared[0]!.pairCount).toBe(viaA.pairCount);
    expect(shared[0]!.confidence).toBe(viaA.confidence);
  });
});

describe('syncCoChange() — 실제 git 호출', () => {
  let store: CodeGraphStore;
  let dbPath: string;
  let nested: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-realgit-${randomUUID()}.db`;
    nested = resolve(process.cwd(), '.gestalt-test', `cochange-root-${randomUUID()}`);
    mkdirSync(nested, { recursive: true });
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`);
    if (existsSync(nested)) rmSync(nested, { recursive: true, force: true });
  });

  // runGit을 주입하지 않는 유일한 테스트다. 진짜 git 출력을 받고도 가드가
  // 도는지는 여기서만 확인된다 — fake로는 `--show-toplevel`이 뭘 내는지 못 본다.
  it('레포 안쪽 디렉토리를 repoRoot로 주면 이 레포의 이력을 빨아들이지 않는다', () => {
    const summary = syncCoChange(store, nested, { mode: 'full' });

    expect(summary).toBeUndefined();
    expect(store.countCoChangePairs()).toBe(0);
    expect(store.getCoChangeMeta()).toBeNull();
  });

  it('레포 최상위에서는 실제 이력을 절대경로로 수집한다', () => {
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    }).trim();

    const summary = syncCoChange(store, toplevel, { mode: 'full' });
    expect(summary).toBeDefined();
    expect(summary!.mode).toBe('full');

    // CI 체크아웃은 depth 1이라 페어가 안 나온다. 이력이 얕으면 형태만 본다.
    if (summary!.pairs === 0) return;

    const pairs = queryCoChange(store, toplevel, { minPairCount: MIN_PAIR_COUNT }).pairs;
    for (const p of pairs) {
      expect(p.fileA.startsWith(`${toplevel}/`)).toBe(true);
      expect(p.fileB.startsWith(`${toplevel}/`)).toBe(true);
    }
  });
});

describe('자르는 자리 — 임계는 질의, 개수는 한 곳', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-truncate-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
    }
  });

  /** seed 하나에 이웃 `count`개를 각각 `times`번 붙인다 */
  function seedNeighbors(seed: string, count: number, times = 3): void {
    const commits: string[][] = [];
    for (let i = 0; i < count; i++) {
      for (let t = 0; t < times; t++) commits.push([seed, `src/n${i}.ts`]);
    }
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });
  }

  it('돌려준 목록이 전체 순위의 상위 접두사다', () => {
    // pair_count 순위와 점수 순위를 일부러 어긋내둔다. seed 전용으로만 바뀌는
    // 파일은 카운트가 낮아도 confidence 1.0이라 점수가 높다. 반대로 아무 데나 끼는
    // 파일은 카운트가 높아도 lift가 눌려 아래로 내려간다.
    const commits: string[][] = [];
    for (let i = 0; i < 12; i++) commits.push(['src/seed.ts', 'src/hub.ts']);
    for (let i = 0; i < 12; i++) commits.push(['src/other.ts', 'src/hub.ts']);
    for (let i = 0; i < 4; i++) commits.push(['src/seed.ts', 'src/tight.ts']);
    for (let i = 0; i < 3; i++) commits.push(['src/seed.ts', 'src/mid.ts']);
    for (let i = 0; i < 6; i++) commits.push(['src/mid.ts', 'src/noise.ts']);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const full = queryCoChange(store, ROOT, { target: 'src/seed.ts', limit: 30, exists: allExist });
    const top1 = queryCoChange(store, ROOT, { target: 'src/seed.ts', limit: 1, exists: allExist });
    const top2 = queryCoChange(store, ROOT, { target: 'src/seed.ts', limit: 2, exists: allExist });

    // 전제가 성립하는지 먼저 본다 — 카운트 1위와 점수 1위가 다른 파일이어야
    // 접두사 주장이 시험대에 오른다
    const byCount = [...full.neighbors].sort((a, b) => b.pairCount - a.pairCount);
    expect(byCount[0]!.filePath).not.toBe(full.neighbors[0]!.filePath);

    expect(top1.neighbors).toEqual(full.neighbors.slice(0, 1));
    expect(top2.neighbors).toEqual(full.neighbors.slice(0, 2));
    expect(top1.totalMatched).toBe(full.neighbors.length);
    expect(top2.totalMatched).toBe(full.neighbors.length);
  });

  it('seed가 여럿인 합친 목록도 상위 접두사다', () => {
    // blast-radius가 타는 경로다. seed마다 따로 자르면 여기서 어긋난다
    const commits: string[][] = [];
    for (let i = 0; i < 12; i++) commits.push(['src/a.ts', 'src/hub.ts']);
    for (let i = 0; i < 12; i++) commits.push(['src/z.ts', 'src/hub.ts']);
    for (let i = 0; i < 3; i++) commits.push(['src/a.ts', 'src/tight-a.ts']);
    for (let i = 0; i < 5; i++) commits.push(['src/b.ts', 'src/hub.ts']);
    for (let i = 0; i < 4; i++) commits.push(['src/b.ts', 'src/tight-b.ts']);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const seeds = ['src/a.ts', 'src/b.ts'];
    const full = buildCoChangeLookup(store, ROOT, seeds, { limit: 30, exists: allExist });

    for (let n = 1; n <= full.neighbors.length; n++) {
      const cut = buildCoChangeLookup(store, ROOT, seeds, { limit: n, exists: allExist });
      expect(cut.neighbors).toEqual(full.neighbors.slice(0, n));
      expect(cut.totalMatched).toBe(full.neighbors.length);
    }
  });

  it('이웃이 옛 후보 하한을 넘겨도 질의가 자르지 않는다', () => {
    // 옛 구현은 후보를 max(limit*10, 200)까지만 떴다. 그 하한을 넘기는
    // 픽스처라야 상한이 실제로 걸리는 자리를 지난다
    seedNeighbors('src/a.ts', 250);

    const rows = allNeighborRows(store, '/repo/src/a.ts');
    const lookup = buildCoChangeLookup(store, ROOT, ['src/a.ts'], { limit: 1, exists: allExist });

    expect(rows).toHaveLength(250);
    expect(lookup.neighbors).toHaveLength(1);
    expect(lookup.totalMatched).toBe(250);
    expect(lookup.truncated).toBe(true);
  });

  it('전역 페어 조회도 옛 후보 하한 너머를 전부 센다', () => {
    seedNeighbors('src/a.ts', 250);

    const result = queryCoChange(store, ROOT, { limit: 1, exists: allExist });

    expect(result.pairs).toHaveLength(1);
    expect(result.totalMatched).toBe(250);
    expect(result.truncated).toBe(true);
  });

  it('잘림 표식은 목록보다 하나라도 많을 때부터 켜진다', () => {
    seedNeighbors('src/a.ts', 4);

    const exact = queryCoChange(store, ROOT, { target: 'src/a.ts', limit: 4, exists: allExist });
    const over = queryCoChange(store, ROOT, { target: 'src/a.ts', limit: 3, exists: allExist });

    expect(exact.neighbors).toHaveLength(4);
    expect(exact.truncated).toBe(false);
    expect(over.neighbors).toHaveLength(3);
    expect(over.truncated).toBe(true);
    expect(over.totalMatched).toBe(4);
  });

  it('전역 페어 조회의 잘림 표식도 같은 경계를 쓴다', () => {
    seedNeighbors('src/a.ts', 4);

    const exact = queryCoChange(store, ROOT, { limit: 4, exists: allExist });
    const over = queryCoChange(store, ROOT, { limit: 3, exists: allExist });

    expect(exact.truncated).toBe(false);
    expect(over.truncated).toBe(true);
    expect(over.totalMatched).toBe(4);
  });

  it('합친 목록의 잘림 표식도 같은 경계를 쓴다', () => {
    const commits: string[][] = [];
    for (const n of ['na1', 'na2'])
      for (let i = 0; i < 3; i++) commits.push(['src/a.ts', `src/${n}.ts`]);
    for (const n of ['nb1', 'nb2'])
      for (let i = 0; i < 3; i++) commits.push(['src/b.ts', `src/${n}.ts`]);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const seeds = ['src/a.ts', 'src/b.ts'];
    const exact = buildCoChangeLookup(store, ROOT, seeds, { limit: 4, exists: allExist });
    const over = buildCoChangeLookup(store, ROOT, seeds, { limit: 3, exists: allExist });

    expect(exact.neighbors).toHaveLength(4);
    expect(exact.totalMatched).toBe(4);
    expect(exact.truncated).toBe(false);
    expect(over.neighbors).toHaveLength(3);
    expect(over.totalMatched).toBe(4);
    expect(over.truncated).toBe(true);
  });

  it('존재 확인은 seed 전체에 걸쳐 한 경로당 한 번만 돈다', () => {
    const commits: string[][] = [];
    for (let i = 0; i < 3; i++) commits.push(['src/a.ts', 'src/shared.ts']);
    for (let i = 0; i < 3; i++) commits.push(['src/b.ts', 'src/shared.ts']);
    for (let i = 0; i < 3; i++) commits.push(['src/a.ts', 'src/only-a.ts']);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const calls = new Map<string, number>();
    buildCoChangeLookup(store, ROOT, ['src/a.ts', 'src/b.ts'], {
      exists: (p) => {
        calls.set(p, (calls.get(p) ?? 0) + 1);
        return true;
      },
    });

    // shared.ts는 seed 둘의 이웃으로 두 번 나온다. 메모이즈가 없으면 stat도 두 번이다
    expect(calls.get('/repo/src/shared.ts')).toBe(1);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
  });

  it('전역 페어 조회도 같은 파일을 거듭 stat하지 않는다', () => {
    // 허브 파일 하나가 페어 여럿에 끼는 게 이 경로의 실제 모양이다
    const commits: string[][] = [];
    for (let i = 0; i < 5; i++) {
      for (let t = 0; t < 3; t++) commits.push(['src/hub.ts', `src/n${i}.ts`]);
    }
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const calls = new Map<string, number>();
    queryCoChange(store, ROOT, {
      exists: (p) => {
        calls.set(p, (calls.get(p) ?? 0) + 1);
        return true;
      },
    });

    expect(calls.get('/repo/src/hub.ts')).toBe(1);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
  });
});

describe('임계를 질의로 내린 자리', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-threshold-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
    }
  });

  /**
   * seed와 near가 `together`번 함께, 나머지는 따로 바뀌어 둘의 solo가
   * 똑같이 `soloTotal`이 된다. confidence 분모를 정확한 값으로 박으려고 쓴다 —
   * 한쪽만 키우면 작은 solo가 분모가 되어 confidence가 1로 올라간다.
   */
  function withConfidence(together: number, soloTotal: number): void {
    const commits: string[][] = [];
    for (let i = 0; i < together; i++) commits.push(['src/seed.ts', 'src/near.ts']);
    for (let i = 0; i < soloTotal - together; i++) {
      commits.push(['src/seed.ts', `src/f${i}.ts`]);
      commits.push(['src/near.ts', `src/g${i}.ts`]);
    }
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });
  }

  it('임계는 반올림 전 값에 걸린다', () => {
    // 8/27 = 0.2963… 이라 표시값은 0.30으로 올라간다. 표시값에 임계를 걸면
    // 통과해버리는 자리다
    withConfidence(8, 27);
    const near = '/repo/src/near.ts';

    const strict = queryCoChange(store, ROOT, {
      target: 'src/seed.ts',
      minConfidence: 0.3,
      exists: allExist,
    });
    const loose = queryCoChange(store, ROOT, {
      target: 'src/seed.ts',
      minConfidence: 0.29,
      exists: allExist,
    });

    expect(loose.neighbors.map((n) => n.filePath)).toContain(near);
    expect(loose.neighbors.find((n) => n.filePath === near)!.confidence).toBe(0.3);
    expect(strict.neighbors.map((n) => n.filePath)).not.toContain(near);
  });

  it('임계 경계값은 통과시킨다', () => {
    // 3/10 = 0.3 정확히. `>` 로 쓰면 여기서 빠진다
    withConfidence(3, 10);

    const result = queryCoChange(store, ROOT, {
      target: 'src/seed.ts',
      minConfidence: 0.3,
      exists: allExist,
    });

    expect(result.neighbors.map((n) => n.filePath)).toContain('/repo/src/near.ts');
  });

  it('임계에 걸린 행은 존재 확인까지 가지 않는다', () => {
    withConfidence(8, 27);

    const checked: string[] = [];
    queryCoChange(store, ROOT, {
      target: 'src/seed.ts',
      minConfidence: 0.3,
      exists: (p) => {
        checked.push(p);
        return true;
      },
    });

    // JS단으로 임계를 되돌리면 버릴 행까지 stat이 돈다
    expect(checked).not.toContain('/repo/src/near.ts');
  });

  it('confidence는 두 방향 중 큰 쪽으로 걸린다', () => {
    // seed는 20번 바뀌고 이웃은 3번뿐이다. seed 방향은 3/20 = 0.15라 임계
    // 아래지만 이웃 방향은 3/3 = 1.0이다
    const commits: string[][] = [];
    for (let i = 0; i < 3; i++) commits.push(['src/seed.ts', 'src/rare.ts']);
    for (let i = 0; i < 17; i++) commits.push(['src/seed.ts', `src/f${i}.ts`]);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const result = queryCoChange(store, ROOT, {
      target: 'src/seed.ts',
      minConfidence: 0.9,
      exists: allExist,
    });

    expect(result.neighbors.map((n) => n.filePath)).toEqual(['/repo/src/rare.ts']);
  });

  it('seed 쪽 solo가 비어도 이웃 쪽 solo로 임계를 건다', () => {
    const commits: string[][] = [];
    for (let i = 0; i < 4; i++) commits.push(['src/seed.ts', 'src/near.ts']);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    // soloSelf를 0으로 넘긴다 — CASE의 "반대쪽만 살아 있는" 가지다
    const kept = store.getCoChangeNeighbors('/repo/src/seed.ts', 1, 1, 0).rows;
    const dropped = store.getCoChangeNeighbors('/repo/src/seed.ts', 5, 1, 0).rows;

    expect(kept.map((r) => r.other)).toEqual(['/repo/src/near.ts']);
    expect(dropped).toHaveLength(0);
  });

  it('양쪽 solo가 다 비면 confidence 0으로 본다', () => {
    // solo 없이 페어만 심는다. LEFT JOIN이 0을 내는 가지다
    store.mergeCoChange({
      pairs: [{ fileA: '/repo/src/a.ts', fileB: '/repo/src/b.ts', count: 5 }],
      solos: [],
      meta: {
        headSha: sha(1),
        commitsUsed: 5,
        commitsScanned: 5,
        maxFilesPerCommit: MAX_FILES_PER_COMMIT,
        defaultMinPairCount: MIN_PAIR_COUNT,
      },
      reset: true,
    });

    expect(store.getCoChangeNeighbors('/repo/src/a.ts', 1, 0, 0).rows).toHaveLength(1);
    expect(store.getCoChangeNeighbors('/repo/src/a.ts', 1, 0.01, 0).rows).toHaveLength(0);
    expect(store.getCoChangePairs(1, 0).rows).toHaveLength(1);
    expect(store.getCoChangePairs(1, 0.01).rows).toHaveLength(0);
  });

  it('전역 페어 조회도 같은 임계를 질의에서 건다', () => {
    withConfidence(8, 27);

    const hasSeedNearPair = (minConfidence: number): boolean =>
      store
        .getCoChangePairs(1, minConfidence)
        .rows.some((r) => r.fileA === '/repo/src/near.ts' && r.fileB === '/repo/src/seed.ts');

    expect(hasSeedNearPair(0.29)).toBe(true);
    expect(hasSeedNearPair(0.3)).toBe(false);
  });

  it('점수가 같으면 동시등장이 많은 쪽을 먼저 세운다', () => {
    // 둘 다 confidence 1.0에 lift 1.0이라 점수가 정확히 같다. 남는 열쇠는
    // 동시등장뿐이다. 그게 빠지면 경로 순(a가 먼저)으로 밀린다
    const commits: string[][] = [];
    for (let i = 0; i < 3; i++) commits.push(['src/seed.ts', 'src/a-three.ts']);
    for (let i = 0; i < 5; i++) commits.push(['src/seed.ts', 'src/z-five.ts']);
    for (let i = 0; i < 12; i++) commits.push(['src/seed.ts', `src/f${i}.ts`]);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const result = queryCoChange(store, ROOT, { target: 'src/seed.ts', exists: allExist });
    const tied = result.neighbors.filter((n) => n.pairCount > 1);

    expect(tied.map((n) => n.confidence * n.lift)).toEqual([1, 1]);
    expect(tied.map((n) => n.filePath)).toEqual(['/repo/src/z-five.ts', '/repo/src/a-three.ts']);
  });

  it('점수와 카운트가 같으면 경로 순으로 세운다', () => {
    // 삽입 순서를 알파벳 역순으로 준다 — 마지막 열쇠가 빠지면 그 순서가 샌다
    const commits: string[][] = [];
    for (const n of ['src/z.ts', 'src/m.ts', 'src/a.ts']) {
      for (let i = 0; i < 3; i++) commits.push(['src/seed.ts', n]);
    }
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const result = queryCoChange(store, ROOT, { target: 'src/seed.ts', exists: allExist });

    expect(result.neighbors.map((n) => n.filePath)).toEqual([
      '/repo/src/a.ts',
      '/repo/src/m.ts',
      '/repo/src/z.ts',
    ]);
  });
});

describe('질의 단 천장 — 임계가 0이어도 읽는 행이 유한하다', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-ceiling-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
    }
  });

  /** seed 하나에 이웃 `count`개를 각각 세 번씩 붙인다 */
  function seedNeighbors(seed: string, count: number): void {
    const commits: string[][] = [];
    for (let i = 0; i < count; i++) {
      for (let t = 0; t < 3; t++) commits.push([seed, `src/n${i}.ts`]);
    }
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });
  }

  /** 호출 횟수를 세는 exists. 천장이 이 루프 앞에 있는지 가른다 */
  function countingExists(): { fn: (p: string) => boolean; calls: () => number } {
    let calls = 0;
    return {
      fn: () => {
        calls++;
        return true;
      },
      calls: () => calls,
    };
  }

  it('기본 천장은 출력 상한보다 크게 앞서 있어 정상 질의에 안 걸린다', () => {
    // MCP가 받는 limit의 최대가 500이다. 천장이 그 근처면 사용자가 보는
    // 목록을 천장이 결정하게 된다 — 그러면 접두사 주장이 매번 깨진다
    expect(MAX_MATCHED_ROWS).toBe(10_000);
    expect(MAX_MATCHED_ROWS).toBeGreaterThanOrEqual(500 * 20);
  });

  it('천장과 같은 수면 걸리지 않고 전량이 나온다', () => {
    seedNeighbors('src/a.ts', 10);

    const scan = store.getCoChangeNeighbors('/repo/src/a.ts', 1, 0, 0, 10);

    expect(scan.rows).toHaveLength(10);
    expect(scan.capped).toBe(false);
  });

  it('천장을 하나만 넘겨도 걸리고 천장만큼만 나온다', () => {
    seedNeighbors('src/a.ts', 11);

    const scan = store.getCoChangeNeighbors('/repo/src/a.ts', 1, 0, 0, 10);

    expect(scan.rows).toHaveLength(10);
    expect(scan.capped).toBe(true);
  });

  it('전역 페어 조회도 천장 경계를 양쪽에서 똑같이 본다', () => {
    seedNeighbors('src/a.ts', 11);

    const atCeiling = store.getCoChangePairs(1, 0, 11);
    const overCeiling = store.getCoChangePairs(1, 0, 10);

    expect(atCeiling.rows).toHaveLength(11);
    expect(atCeiling.capped).toBe(false);
    expect(overCeiling.rows).toHaveLength(10);
    expect(overCeiling.capped).toBe(true);
  });

  it('이웃 질의문이 scanLimit에서 멈춘다', () => {
    // 스토어를 거치면 JS slice가 같은 개수를 만들어내 SQL의 LIMIT이
    // 사라진 걸 못 본다. 질의문을 직접 돌려야 읽은 행 수가 드러난다
    seedNeighbors('src/a.ts', 40);
    const db = rawDb(dbPath);
    try {
      const rows = db.prepare(CO_CHANGE_NEIGHBORS_SQL).all({
        path: '/repo/src/a.ts',
        minPairCount: 1,
        minConfidence: 0,
        soloSelf: 0,
        scanLimit: 5,
      });

      expect(rows).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('전역 페어 질의문도 scanLimit에서 멈춘다', () => {
    seedNeighbors('src/a.ts', 40);
    const db = rawDb(dbPath);
    try {
      const rows = db
        .prepare(CO_CHANGE_PAIRS_SQL)
        .all({ minPairCount: 1, minConfidence: 0, scanLimit: 5 });

      expect(rows).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('천장이 exists 루프보다 앞에 걸린다', () => {
    // 뒤에 있으면 stat은 이미 40번 다 돈 뒤다. 천장을 둔 이유가 사라진다
    seedNeighbors('src/a.ts', 40);
    const counter = countingExists();

    const result = queryCoChange(store, ROOT, {
      target: 'src/a.ts',
      limit: 30,
      exists: counter.fn,
      maxMatchedRows: 10,
    });

    expect(counter.calls()).toBe(10);
    expect(result.neighbors.length).toBeLessThanOrEqual(10);
    expect(result.matchedCapped).toBe(true);
  });

  it('전역 페어 경로의 exists 팬아웃도 천장 안에 갇힌다', () => {
    // 페어마다 파일이 둘이라 서로 다른 경로는 천장 + seed 하나다
    seedNeighbors('src/a.ts', 40);
    const counter = countingExists();

    const result = queryCoChange(store, ROOT, {
      limit: 50,
      exists: counter.fn,
      maxMatchedRows: 10,
    });

    expect(counter.calls()).toBe(11);
    expect(result.matchedCapped).toBe(true);
  });

  it('천장에 걸린 것과 limit에 잘린 것을 따로 알린다', () => {
    seedNeighbors('src/a.ts', 40);

    // limit이 천장보다 커서 자를 게 없다. truncated는 꺼져 있는데 목록은
    // 여전히 전부가 아니다 — 그 자리를 matchedCapped가 메운다
    const capped = queryCoChange(store, ROOT, {
      target: 'src/a.ts',
      limit: 30,
      exists: allExist,
      maxMatchedRows: 10,
    });

    expect(capped.matchedCapped).toBe(true);
    expect(capped.truncated).toBe(false);
    expect(capped.totalMatched).toBe(10);
  });

  it('천장에 안 닿으면 세 경로 다 matchedCapped가 꺼져 있다', () => {
    seedNeighbors('src/a.ts', 40);

    const target = queryCoChange(store, ROOT, { target: 'src/a.ts', exists: allExist });
    const global = queryCoChange(store, ROOT, { exists: allExist });
    const lookup = buildCoChangeLookup(store, ROOT, ['src/a.ts'], { exists: allExist });

    expect(target.matchedCapped).toBe(false);
    expect(global.matchedCapped).toBe(false);
    expect(lookup.matchedCapped).toBe(false);
    expect(target.totalMatched).toBe(40);
  });

  it('전역 페어 경로도 천장에 걸리면 matchedCapped를 켠다', () => {
    seedNeighbors('src/a.ts', 40);

    const result = queryCoChange(store, ROOT, {
      limit: 50,
      exists: allExist,
      maxMatchedRows: 10,
    });

    expect(result.matchedCapped).toBe(true);
    expect(result.totalMatched).toBe(10);
  });

  it('seed 하나만 천장에 걸려도 합친 목록이 알린다', () => {
    // b는 이웃이 둘뿐이라 천장에 못 닿는다. a 하나 때문에 켜져야 한다
    const commits: string[][] = [];
    for (let i = 0; i < 40; i++) {
      for (let t = 0; t < 3; t++) commits.push(['src/a.ts', `src/n${i}.ts`]);
    }
    for (let t = 0; t < 3; t++) commits.push(['src/b.ts', 'src/solo.ts']);
    syncCoChange(store, ROOT, { mode: 'full', runGit: fakeGit({ fullLog: gitLog(commits) }) });

    const onlyB = buildCoChangeLookup(store, ROOT, ['src/b.ts'], {
      exists: allExist,
      maxMatchedRows: 10,
    });
    const both = buildCoChangeLookup(store, ROOT, ['src/a.ts', 'src/b.ts'], {
      exists: allExist,
      maxMatchedRows: 10,
    });

    expect(onlyB.matchedCapped).toBe(false);
    expect(both.matchedCapped).toBe(true);
  });
});

describe('쿼리 플랜 — 인덱스를 타는지 고정한다', () => {
  let store: CodeGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/cochange-plan-${randomUUID()}.db`;
    store = new CodeGraphStore(dbPath);
    store.mergeCoChange({
      pairs: [{ fileA: '/repo/src/a.ts', fileB: '/repo/src/b.ts', count: 5 }],
      solos: [
        { filePath: '/repo/src/a.ts', count: 5 },
        { filePath: '/repo/src/b.ts', count: 5 },
      ],
      meta: {
        headSha: sha(1),
        commitsUsed: 5,
        commitsScanned: 5,
        maxFilesPerCommit: MAX_FILES_PER_COMMIT,
        defaultMinPairCount: MIN_PAIR_COUNT,
      },
      reset: true,
    });
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
    }
  });

  /**
   * 스토어가 실제로 prepare하는 문자열을 그대로 설명시킨다. 테스트가 SQL을
   * 베껴 쓰면 베낀 쪽 계획만 보게 된다.
   *
   * 계획 문장은 SQLite 버전마다 표현이 갈리므로 인덱스 이름만 본다. 그건
   * 우리가 지은 식별자라 버전과 무관하다.
   */
  function planOf(sql: string, params: Record<string, unknown>): string[] {
    const db = rawDb(dbPath);
    try {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[];
      return rows.map((r) => r.detail);
    } finally {
      db.close();
    }
  }

  it('전역 페어 질의가 pair_count 인덱스를 탄다', () => {
    const plan = planOf(CO_CHANGE_PAIRS_SQL, {
      minPairCount: 3,
      minConfidence: 0.3,
      scanLimit: 11,
    });

    expect(plan.join('\n')).toContain('idx_cg_cochange_count');
    // 인덱스를 지우면 여기가 전체 스캔으로 떨어진다. 임계가 걸러주는 것처럼
    // 보여도 읽는 행은 테이블 전체가 된다
    expect(plan.filter((d) => /^SCAN\b/.test(d) && d.includes('cg_cochange'))).toEqual([]);
  });

  it('이웃 질의가 file_a와 file_b 양쪽에서 인덱스를 탄다', () => {
    const plan = planOf(CO_CHANGE_NEIGHBORS_SQL, {
      path: '/repo/src/a.ts',
      minPairCount: 3,
      minConfidence: 0.3,
      soloSelf: 5,
      scanLimit: 11,
    });

    // file_a는 PRIMARY KEY가, file_b는 따로 만든 인덱스가 받는다.
    // 뒤쪽을 지우면 UNION의 반대 방향이 조용히 전체 스캔이 된다
    expect(plan.join('\n')).toContain('idx_cg_cochange_b');
    expect(plan.filter((d) => /^SCAN\b/.test(d) && d.includes('cg_cochange'))).toEqual([]);
  });
});
