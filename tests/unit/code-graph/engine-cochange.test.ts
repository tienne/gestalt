/**
 * CodeGraphEngine과 co-change 모듈이 만나는 이음매 테스트.
 *
 * `cochange.ts`의 순수 함수는 `cochange.test.ts`가 덮는다. 여기서 보는 건
 * 그 함수들을 build와 blast-radius에 잇는 `engine.ts` 쪽 배선이다. 가드를
 * 지우거나 인자를 빠뜨렸을 때 실제로 빨간불이 켜져야 한다.
 *
 * `engine.test.ts`는 glob 의존을 이유로 엔진을 직접 import하지 않는다. 그
 * 이유는 이제 유효하지 않다 (`engine.ts`는 `readdirSync`를 쓴다). 이 파일은
 * 실제 `CodeGraphEngine`을 그대로 돌린다.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type CoChangeModule = typeof import('../../../src/code-graph/cochange.js');

// vi.mock은 파일 최상단으로 끌어올려지므로 훅도 vi.hoisted로 먼저 만들어야
// 한다. 일반 const로 두면 engine.ts가 cochange.js를 import하는 시점에 아직
// 초기화 전이라 TDZ로 죽는다.
const hooks = vi.hoisted(() => ({
  syncCoChange: null as (() => unknown) | null,
  buildCoChangeLookup: null as ((...args: unknown[]) => unknown) | null,
}));

vi.mock('../../../src/code-graph/cochange.js', async (importOriginal) => {
  const actual = await importOriginal<CoChangeModule>();
  return {
    ...actual,
    syncCoChange: (...args: Parameters<CoChangeModule['syncCoChange']>) =>
      hooks.syncCoChange ? hooks.syncCoChange() : actual.syncCoChange(...args),
    buildCoChangeLookup: (...args: Parameters<CoChangeModule['buildCoChangeLookup']>) =>
      hooks.buildCoChangeLookup
        ? hooks.buildCoChangeLookup(...args)
        : actual.buildCoChangeLookup(...args),
  };
});

import { CodeGraphEngine } from '../../../src/code-graph/engine.js';
import { CodeGraphStore } from '../../../src/code-graph/storage.js';
import { syncCoChange, DEFAULT_NEIGHBOR_LIMIT } from '../../../src/code-graph/cochange.js';

const FAKE_HEAD = 'a'.repeat(40);

function makeRepoRoot(tag: string): string {
  const root = resolve('.gestalt-test', `${tag}-${randomUUID()}`);
  mkdirSync(join(root, '.gestalt'), { recursive: true });
  return root;
}

function dbPathOf(root: string): string {
  return join(root, '.gestalt', 'code-graph.db');
}

/**
 * seed 하나와 이웃 n개를 DB에 심고 파일도 실제로 만든다.
 * `buildCoChangeLookup`의 기본 `exists`가 `existsSync`라 워킹트리에 없는
 * 경로는 조회 단계에서 통째로 빠진다.
 */
function seedCoChange(
  root: string,
  neighborCount: number,
  opts: { pairCount?: (i: number) => number; solo?: number; seedCount?: number } = {},
): { seed: string; seeds: string[]; neighbors: string[] } {
  mkdirSync(join(root, 'src'), { recursive: true });

  const solo = opts.solo ?? 10;
  const seedCount = opts.seedCount ?? 1;
  const seeds: string[] = [];
  const neighbors: string[] = [];
  const pairs = [];
  const solos = [];

  for (let s = 0; s < seedCount; s++) {
    const seed = join(root, 'src', `seed-${s}.ts`);
    writeFileSync(seed, '// seed\n');
    seeds.push(seed);
    solos.push({ filePath: seed, count: solo });

    // seed마다 이웃을 겹치지 않게 준다. 합칠 때 중복 제거가 아니라 limit이
    // 개수를 정한다는 걸 보려면 교집합이 없어야 한다.
    for (let i = 0; i < neighborCount; i++) {
      const neighbor = join(root, 'src', `neighbor-${s}-${String(i).padStart(3, '0')}.ts`);
      writeFileSync(neighbor, '// neighbor\n');
      neighbors.push(neighbor);

      const count = opts.pairCount ? opts.pairCount(i) : 5 + i;
      const [a, b] = seed < neighbor ? [seed, neighbor] : [neighbor, seed];
      pairs.push({ fileA: a!, fileB: b!, count });
      solos.push({ filePath: neighbor, count: solo });
    }
  }

  const store = new CodeGraphStore(dbPathOf(root));
  store.mergeCoChange({
    pairs,
    solos,
    meta: {
      headSha: FAKE_HEAD,
      commitsUsed: 100,
      commitsScanned: 120,
      maxFilesPerCommit: 20,
      defaultMinPairCount: 3,
    },
    reset: true,
  });
  store.close();

  return { seed: seeds[0]!, seeds, neighbors };
}

describe('CodeGraphEngine ↔ co-change 이음매', () => {
  let root: string;
  let engine: CodeGraphEngine;

  beforeEach(() => {
    root = makeRepoRoot('engine-cochange');
    engine = new CodeGraphEngine();
    hooks.syncCoChange = null;
    hooks.buildCoChangeLookup = null;
  });

  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
    hooks.syncCoChange = null;
    hooks.buildCoChangeLookup = null;
  });

  describe('build()의 co-change 가드', () => {
    it('syncCoChange가 throw해도 build는 예외를 내지 않고 coChange: undefined로 끝난다', () => {
      hooks.syncCoChange = () => {
        throw new Error('git exploded');
      };

      const result = engine.build(root);

      expect(result.coChange).toBeUndefined();
      expect(result.timeTakenMs).toBeGreaterThanOrEqual(0);
    });

    it('syncCoChange가 성공하면 그 요약이 BuildResult에 실린다', () => {
      hooks.syncCoChange = () => ({
        pairs: 7,
        commitsUsed: 5,
        commitsScanned: 9,
        mode: 'full' as const,
      });

      const result = engine.build(root);

      expect(result.coChange).toEqual({
        pairs: 7,
        commitsUsed: 5,
        commitsScanned: 9,
        mode: 'full',
      });
    });
  });

  describe('blastRadius()의 조회 가드', () => {
    it('buildCoChangeLookup이 throw해도 blastRadius가 결과를 돌려주고 사유를 싣는다', () => {
      const { seed } = seedCoChange(root, 3);
      hooks.buildCoChangeLookup = () => {
        throw new Error('lookup exploded');
      };

      const result = engine.blastRadius(root, { changedFiles: [seed] });

      expect(result.coChangeAvailable).toBe(false);
      expect(result.coChangeReason).toBe('lookup exploded');
      expect(result.impactedFiles).toContain(seed);
      expect(result.summary).toContain('Git history signal unavailable');
      expect(result.rankedFiles.every((f) => f.origin === 'import')).toBe(true);
    });

    it('diffRadius도 같은 가드를 거쳐 사유를 싣는다', () => {
      hooks.buildCoChangeLookup = () => {
        throw new Error('lookup exploded');
      };

      const result = engine.diffRadius(root);

      expect(result.coChangeAvailable).toBe(false);
      expect(result.coChangeReason).toBe('lookup exploded');
    });

    it('가드가 없을 때는 이력 신호가 실제로 실린다', () => {
      const { seed } = seedCoChange(root, 3);

      const result = engine.blastRadius(root, { changedFiles: [seed] });

      expect(result.coChangeAvailable).toBe(true);
      expect(result.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(3);
    });
  });

  describe('튜닝 파라미터 배선', () => {
    it('limit이 blastRadius 경로까지 닿아 이웃을 자른다', () => {
      const { seed } = seedCoChange(root, 5);

      const capped = engine.blastRadius(root, { changedFiles: [seed], coChange: { limit: 2 } });
      const uncapped = engine.blastRadius(root, { changedFiles: [seed] });

      expect(capped.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(2);
      expect(uncapped.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(5);
    });

    it('limit을 안 주면 DEFAULT_NEIGHBOR_LIMIT에서 잘린다', () => {
      const excess = DEFAULT_NEIGHBOR_LIMIT + 5;
      const { seed } = seedCoChange(root, excess);

      const result = engine.blastRadius(root, { changedFiles: [seed] });

      expect(result.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(
        DEFAULT_NEIGHBOR_LIMIT,
      );
    });

    it('seed가 여럿이면 합친 뒤에도 limit을 넘지 않는다', () => {
      // seed마다 2개씩 총 4개가 임계를 통과한다. seed별로만 자르면 4개가
      // 그대로 올라온다 — 합친 목록을 한 번 더 자르는지 보는 자리다.
      const { seeds } = seedCoChange(root, 2, { seedCount: 2 });

      const result = engine.blastRadius(root, {
        changedFiles: seeds,
        coChange: { limit: 2 },
      });

      expect(result.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(2);
    });

    it('잘려나가는 쪽은 점수가 낮은 이웃이다', () => {
      const { seed, neighbors } = seedCoChange(root, 5);

      const capped = engine.blastRadius(root, { changedFiles: [seed], coChange: { limit: 2 } });
      const kept = capped.rankedFiles.filter((f) => f.origin === 'history').map((f) => f.filePath);

      // pairCount가 5+i라 마지막 둘이 가장 높다
      expect(kept).toEqual([neighbors[4]!, neighbors[3]!]);
    });

    it('minPairCount가 blastRadius 경로까지 닿는다', () => {
      // pair 2 / solo 4 라 confidence는 0.5다. 걸리는 건 minPairCount 하나뿐이다
      const { seed } = seedCoChange(root, 2, { pairCount: () => 2, solo: 4 });

      const strict = engine.blastRadius(root, { changedFiles: [seed] });
      const loose = engine.blastRadius(root, {
        changedFiles: [seed],
        coChange: { minPairCount: 2 },
      });

      expect(strict.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(0);
      expect(loose.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(2);
    });

    it('minConfidence가 blastRadius 경로까지 닿는다', () => {
      // pair 5 / solo 10 이라 confidence는 0.5다
      const { seed } = seedCoChange(root, 2, { pairCount: () => 5 });

      const strict = engine.blastRadius(root, {
        changedFiles: [seed],
        coChange: { minConfidence: 0.9 },
      });
      const loose = engine.blastRadius(root, { changedFiles: [seed] });

      expect(strict.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(0);
      expect(loose.rankedFiles.filter((f) => f.origin === 'history')).toHaveLength(2);
    });

    it('diffRadius가 받은 튜닝을 그대로 조회에 넘긴다', () => {
      // diffRadius는 git diff로 파일을 찾는데 여기는 git 레포가 아니라
      // 변경 목록이 빈다. 넘어가는 인자는 그래도 가로챌 수 있다.
      let seenTuning: unknown;
      hooks.buildCoChangeLookup = (...args: unknown[]) => {
        seenTuning = args[3];
        throw new Error('stop here');
      };

      engine.diffRadius(root, { coChange: { limit: 3, minPairCount: 1 } });

      expect(seenTuning).toEqual({ limit: 3, minPairCount: 1 });
    });

    it('blastRadius가 받은 튜닝을 그대로 조회에 넘긴다', () => {
      const { seed } = seedCoChange(root, 2);
      let seenTuning: unknown;
      hooks.buildCoChangeLookup = (...args: unknown[]) => {
        seenTuning = args[3];
        throw new Error('stop here');
      };

      engine.blastRadius(root, { changedFiles: [seed], coChange: { minConfidence: 0.7 } });

      expect(seenTuning).toEqual({ minConfidence: 0.7 });
    });
  });

  describe('저장소 인덱스', () => {
    it('cg_cochange에 pair_count 인덱스가 생긴다', () => {
      const store = new CodeGraphStore(dbPathOf(root));
      const db = (
        store as unknown as { db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } } }
      ).db;
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cg_cochange'`)
        .all() as { name: string }[];
      store.close();

      expect(rows.map((r) => r.name)).toContain('idx_cg_cochange_count');
    });
  });
});

describe('대용량 git log 수집', () => {
  let root: string;

  beforeEach(() => {
    root = makeRepoRoot('cochange-biglog');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('1MB를 넘는 git log 출력을 주입된 runGit으로 끝까지 파싱한다', () => {
    const commitCount = 40;
    const filesPerCommit = 15;
    const longName = 'x'.repeat(180);

    let log = '';
    for (let c = 0; c < commitCount; c++) {
      log += `${c.toString(16).padStart(40, '0')}\n`;
      for (let f = 0; f < filesPerCommit; f++) {
        log += `src/${longName}-${f}.ts\n`;
      }
    }
    // 1MB에 못 미치면 이 테스트는 아무것도 안 지킨다. 계산으로 맞추지 않고
    // 실제 길이를 보며 채운다.
    let padCommits = 0;
    while (log.length <= 1024 * 1024) {
      log += `${(commitCount + padCommits).toString(16).padStart(40, '0')}\n`;
      for (let f = 0; f < filesPerCommit; f++) {
        log += `pad/${longName}-${padCommits}-${f}.ts\n`;
      }
      padCommits++;
    }
    expect(log.length).toBeGreaterThan(1024 * 1024);

    const totalCommits = commitCount + padCommits;
    const runGit = (_root: string, args: string[]): string => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${root}\n`;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${'b'.repeat(40)}\n`;
      return log;
    };

    const store = new CodeGraphStore(dbPathOf(root));
    const result = syncCoChange(store, root, { runGit });

    expect(result).toBeDefined();
    expect(result!.commitsScanned).toBe(totalCommits);
    expect(result!.commitsUsed).toBe(totalCommits);
    expect(store.countCoChangePairs()).toBeGreaterThan(0);
    store.close();
  });

  it('실제 git 서브프로세스로 1MB를 넘는 출력을 읽는다 (maxBuffer 가드)', () => {
    const gitRoot = join(root, 'repo');
    mkdirSync(join(gitRoot, 'src'), { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: gitRoot,
        stdio: 'ignore',
      });
    };
    git('init', '-q');

    // 기본 maxBuffer 1MB를 넘기려면 출력이 1MB를 넘어야 한다.
    // 파일 수 대신 경로 길이를 키워 커밋 수를 줄인다.
    const longName = 'y'.repeat(180);
    const fileCount = 900;
    const commitCount = 8;
    for (let c = 0; c < commitCount; c++) {
      for (let f = 0; f < fileCount; f++) {
        writeFileSync(join(gitRoot, 'src', `${longName}-${f}.ts`), `rev ${c}\n`);
      }
      git('add', '-A');
      git('commit', '-q', '-m', `rev ${c}`);
    }

    const raw = execFileSync('git', ['log', '--format=%H', '--name-only', '--no-merges'], {
      cwd: gitRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(raw.length).toBeGreaterThan(1024 * 1024);

    const store = new CodeGraphStore(join(root, 'store.db'));
    const result = syncCoChange(store, gitRoot);

    // 커밋마다 900개를 건드려 MAX_FILES_PER_COMMIT에 전부 걸린다.
    // 여기서 보는 건 페어 수가 아니라 예외 없이 끝까지 읽었는지다.
    expect(result).toBeDefined();
    expect(result!.commitsScanned).toBe(commitCount);
    expect(result!.commitsUsed).toBe(0);
    store.close();
  }, 120_000);
});
