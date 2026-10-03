/**
 * 질의 시점 최신화 — 드리프트 검사, 증분 반영, 락 경합.
 *
 * mtime은 전부 과거로 박아둔다. 방금 쓴 파일은 RACY_WINDOW_MS 안이라
 * stat이 같아도 다시 읽게 돼 있다. 그대로 두면 "안 읽는다"를 검증할 수 없다.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const { CodeGraphEngine, STALE_MESSAGE, REINDEX_PENDING_MESSAGE } =
  await import('../../../src/code-graph/engine.js');
const { typescriptPlugin } = await import('../../../src/code-graph/plugins/typescript.js');
const { tryAcquireLock } = await import('../../../src/code-graph/lock.js');
const { CodeGraphStore } = await import('../../../src/code-graph/storage.js');
const { default: Database } = await import('better-sqlite3');

const PAST = Date.now() / 1000 - 3600;

function setMtime(path: string, secondsAgo = 3600): void {
  const t = Date.now() / 1000 - secondsAgo;
  fs.utimesSync(path, t, t);
}

function write(path: string, content: string, secondsAgo = 3600): void {
  fs.writeFileSync(path, content);
  setMtime(path, secondsAgo);
}

function setupRepo() {
  const repoRoot = resolve(process.cwd(), '.gestalt-test', `freshness-${randomUUID()}`);
  fs.mkdirSync(repoRoot, { recursive: true });
  const f = join(repoRoot, 'f.ts');
  const a = join(repoRoot, 'a.ts');
  const b = join(repoRoot, 'b.ts');
  write(f, 'export function helper() {\n  return 1;\n}\n');
  write(
    a,
    "import { helper } from './f.js';\n\nexport function useHelper() {\n  return helper();\n}\n",
  );
  write(b, "import { useHelper } from './a.js';\n\nexport const run = () => useHelper();\n");
  return {
    repoRoot,
    f,
    a,
    b,
    lockPath: join(repoRoot, '.gestalt', 'code-graph.lock'),
    dbPath: join(repoRoot, '.gestalt', 'code-graph.db'),
    cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true }),
  };
}

function readsUnder(root: string): string[] {
  return vi
    .mocked(fs.readFileSync)
    .mock.calls.map((c) => String(c[0]))
    .filter((p) => p.startsWith(root) && !p.includes('.gestalt/'));
}

/** 노드와 엣지를 비교 가능한 꼴로 뽑는다. updatedAt과 엣지 id는 빌드마다 달라서 뺀다 */
function snapshot(dbPath: string) {
  const store = new CodeGraphStore(dbPath);
  try {
    const nodes = store
      .getAllNodes()
      .map((n) => `${n.id}|${n.kind}|${n.lineStart}-${n.lineEnd}|${n.fileHash ?? ''}`)
      .sort();
    const edges = store
      .getAllEdges()
      .map((e) => `${e.kind}|${e.sourceId}|${e.targetId}|${e.line}`)
      .sort();
    return { nodes, edges };
  } finally {
    store.close();
  }
}

describe('질의 시점 최신화', () => {
  let engine: InstanceType<typeof CodeGraphEngine>;
  let repo: ReturnType<typeof setupRepo>;

  beforeEach(() => {
    engine = new CodeGraphEngine();
    repo = setupRepo();
    engine.build(repo.repoRoot, { mode: 'full' });
    vi.mocked(fs.readFileSync).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.close();
    repo.cleanup();
  });

  it('바뀐 게 없으면 파일을 하나도 읽지 않는다', async () => {
    const parse = vi.spyOn(typescriptPlugin, 'parse');
    const report = await engine.refresh(repo.repoRoot);

    expect(report).toMatchObject({ status: 'fresh', checkedFiles: 3 });
    expect(readsUnder(repo.repoRoot)).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
  });

  it('touch만 하면 해시만 확인하고 재파싱하지 않는다. 다음 검사는 다시 안 읽는다', async () => {
    setMtime(repo.f, 1800);
    const parse = vi.spyOn(typescriptPlugin, 'parse');

    const first = await engine.refresh(repo.repoRoot);
    expect(first).toMatchObject({
      status: 'refreshed',
      changed: { added: 0, modified: 0, removed: 0, touched: 1 },
    });
    expect(parse).not.toHaveBeenCalled();

    vi.mocked(fs.readFileSync).mockClear();
    expect((await engine.refresh(repo.repoRoot)).status).toBe('fresh');
    expect(readsUnder(repo.repoRoot)).toEqual([]);
  });

  it('내용이 바뀌면 그 파일과 1-hop 참조 파일만 재파싱한다', async () => {
    write(repo.f, 'export function helper() {\n  return 2;\n}\nexport function extra() {}\n', 1800);
    const parse = vi.spyOn(typescriptPlugin, 'parse');

    const report = await engine.refresh(repo.repoRoot);
    expect(report).toMatchObject({ status: 'refreshed', changed: { modified: 1 } });
    expect(parse.mock.calls.map((c) => c[0]).sort()).toEqual([repo.a, repo.f].sort());

    const query = engine.query(repo.repoRoot, 'imports_of', 'f.ts');
    expect(query.nodes.map((n) => n.filePath)).toEqual([repo.a]);
    const fNodes = snapshot(repo.dbPath).nodes.filter((n) => n.includes(`${repo.f}:extra`));
    expect(fNodes).toHaveLength(1);
  });

  it('새 파일은 그래프에 들어간다', async () => {
    const c = join(repo.repoRoot, 'c.ts');
    write(c, "import { helper } from './f.js';\nexport const c = helper;\n", 1800);

    const report = await engine.refresh(repo.repoRoot);
    expect(report).toMatchObject({ status: 'refreshed', changed: { added: 1 } });
    const importers = engine
      .query(repo.repoRoot, 'imports_of', 'f.ts')
      .nodes.map((n) => n.filePath);
    expect(importers.sort()).toEqual([repo.a, c].sort());
  });

  it('지워진 파일은 노드와 stat이 함께 정리된다', async () => {
    fs.rmSync(repo.b);

    const report = await engine.refresh(repo.repoRoot);
    expect(report).toMatchObject({ status: 'refreshed', changed: { removed: 1 } });
    const snap = snapshot(repo.dbPath);
    expect(snap.nodes.some((n) => n.includes(repo.b))).toBe(false);
    const store = new CodeGraphStore(repo.dbPath);
    expect(store.getAllFileStats().has(repo.b)).toBe(false);
    store.close();
    expect((await engine.refresh(repo.repoRoot)).status).toBe('fresh');
  });

  it('full 재빌드도 사라진 파일을 지운다', () => {
    fs.rmSync(repo.b);
    engine.build(repo.repoRoot, { mode: 'full' });
    expect(snapshot(repo.dbPath).nodes.some((n) => n.includes(repo.b))).toBe(false);
  });

  it('추가, 수정, 삭제를 증분으로 반영한 결과가 콜드 빌드와 같다', async () => {
    // f를 지워 a→f가 끊긴 상태, a를 고쳐 b가 참조하는 쪽이 바뀐 상태, 새 파일 d
    fs.rmSync(repo.f);
    write(repo.a, "import { helper } from './f.js';\nexport function useHelper2() {}\n", 1800);
    write(
      join(repo.repoRoot, 'd.ts'),
      "import { run } from './b.js';\nexport const d = run;\n",
      1800,
    );

    await engine.refresh(repo.repoRoot);
    const incremental = snapshot(repo.dbPath);

    engine.close();
    fs.rmSync(join(repo.repoRoot, '.gestalt'), { recursive: true, force: true });
    const cold = new CodeGraphEngine();
    cold.build(repo.repoRoot, { mode: 'full' });
    cold.close();

    expect(incremental).toEqual(snapshot(repo.dbPath));
  });

  it('A가 F보다 먼저 처리돼도 full 재빌드가 A→F 엣지를 잃지 않는다', () => {
    // 재파싱 순서가 a → f일 때 f의 deleteByFile이 방금 넣은 a→f를 지우던 문제
    write(repo.a, "import { helper } from './f.js';\nexport function x() { return helper(); }\n");
    write(repo.f, 'export function helper() {\n  return 3;\n}\n');
    engine.build(repo.repoRoot, { mode: 'full' });
    const importers = engine.query(repo.repoRoot, 'imports_of', 'f.ts').nodes;
    expect(importers.map((n) => n.filePath)).toEqual([repo.a]);
  });

  it('stat 행이 없는 옛 DB는 노드 해시로 한 번 확정하고 재파싱하지 않는다', async () => {
    const store = new CodeGraphStore(repo.dbPath);
    for (const p of [repo.a, repo.b, repo.f]) store.deleteFileStat(p);
    store.close();
    const parse = vi.spyOn(typescriptPlugin, 'parse');

    expect(await engine.refresh(repo.repoRoot)).toMatchObject({
      status: 'refreshed',
      changed: { touched: 3, modified: 0 },
    });
    expect(parse).not.toHaveBeenCalled();
    expect((await engine.refresh(repo.repoRoot)).status).toBe('fresh');
  });

  it('기록 직후 같은 mtime과 크기로 다시 쓰인 파일도 놓치지 않는다', async () => {
    // 방금 쓴 파일로 빌드해 mtime이 기록 시각에 바짝 붙게 만든다
    const g = join(repo.repoRoot, 'g.ts');
    fs.writeFileSync(g, 'export const g = 1;\n');
    engine.build(repo.repoRoot, { mode: 'incremental' });
    const before = fs.statSync(g);
    fs.writeFileSync(g, 'export const g = 2;\n');
    fs.utimesSync(g, before.atime, before.mtime);

    const report = await engine.refresh(repo.repoRoot);
    expect(report).toMatchObject({ status: 'refreshed', changed: { modified: 1 } });
  });

  it('그래프 DB가 없으면 만들지 않고 넘어간다', async () => {
    const empty = resolve(process.cwd(), '.gestalt-test', `freshness-empty-${randomUUID()}`);
    fs.mkdirSync(empty, { recursive: true });
    try {
      expect(await engine.refresh(empty)).toMatchObject({ status: 'skipped', reason: 'no_graph' });
      expect(fs.existsSync(join(empty, '.gestalt', 'code-graph.db'))).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('include로 좁힌 그래프는 범위 밖 파일을 added로 보지 않는다', async () => {
    fs.mkdirSync(join(repo.repoRoot, 'src'));
    write(join(repo.repoRoot, 'src', 'in.ts'), 'export const x = 1;\n');
    engine.build(repo.repoRoot, { mode: 'full', include: ['src/**'] });

    expect((await engine.refresh(repo.repoRoot)).status).toBe('fresh');
  });

  describe('락', () => {
    it('다른 프로세스가 갱신 중이면 기다렸다가 이전 그래프 기준이라고 알린다', async () => {
      const held = tryAcquireLock(repo.lockPath);
      expect(held).not.toBeNull();
      write(repo.f, 'export function renamed() {}\n', 1800);
      const parse = vi.spyOn(typescriptPlugin, 'parse');

      const started = Date.now();
      const report = await engine.refresh(repo.repoRoot, { lockTimeoutMs: 200 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      expect(report).toMatchObject({
        status: 'stale',
        reason: 'locked',
        message: STALE_MESSAGE,
        pending: { modified: 1 },
      });
      expect(parse).not.toHaveBeenCalled();

      held!.release();
      expect((await engine.refresh(repo.repoRoot)).status).toBe('refreshed');
    });

    it('기다리는 사이 다른 쪽이 반영했으면 다시 빌드하지 않는다', async () => {
      const held = tryAcquireLock(repo.lockPath)!;
      write(repo.f, 'export function helper() { return 9; }\n', 1800);

      const pending = engine.refresh(repo.repoRoot, { lockTimeoutMs: 1500 });
      // 다른 프로세스 자리. 연결을 따로 열어 반영하고 락을 놓는다
      const other = new CodeGraphEngine();
      other.build(repo.repoRoot, { mode: 'incremental' });
      other.close();
      const parse = vi.spyOn(typescriptPlugin, 'parse');
      held.release();

      expect((await pending).status).toBe('fresh');
      expect(parse).not.toHaveBeenCalled();
    });

    it('갱신이 끝나면 락 파일이 남지 않는다', async () => {
      write(repo.f, 'export function helper() { return 5; }\n', 1800);
      await engine.refresh(repo.repoRoot);
      expect(fs.existsSync(repo.lockPath)).toBe(false);
    });
  });
});

describe('락 파일', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = resolve(process.cwd(), '.gestalt-test', `lock-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    path = join(dir, 'x.lock');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('배타적으로 잡히고 pid를 담는다', () => {
    const h = tryAcquireLock(path)!;
    expect(JSON.parse(fs.readFileSync(path, 'utf-8') as string)).toMatchObject({
      pid: process.pid,
      token: h.token,
    });
    expect(tryAcquireLock(path)).toBeNull();
    expect(h.release()).toBe(true);
    expect(fs.existsSync(path)).toBe(false);
  });

  it('주인이 죽은 락은 넘겨받는다', () => {
    fs.writeFileSync(path, JSON.stringify({ pid: 999_999, token: 'dead', acquiredAt: Date.now() }));
    const h = tryAcquireLock(path);
    expect(h).not.toBeNull();
    h!.release();
  });

  it('너무 오래 잡힌 락은 주인이 살아 있어도 넘겨받는다', () => {
    fs.writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'old', acquiredAt: 0 }));
    expect(tryAcquireLock(path, { staleMs: 1000 })).not.toBeNull();
  });

  it('락이 남에게 넘어간 뒤에는 원래 주인이 해제해도 지우지 않는다', () => {
    const mine = tryAcquireLock(path)!;
    // stale 판정으로 다른 프로세스가 넘겨받은 상황
    const theirs = JSON.stringify({
      pid: process.pid + 1,
      token: 'theirs',
      acquiredAt: Date.now(),
    });
    fs.writeFileSync(path, theirs);

    expect(mine.release()).toBe(false);
    expect(fs.readFileSync(path, 'utf-8')).toBe(theirs);
  });

  it('같은 pid라도 토큰이 다르면 지우지 않는다', () => {
    const first = tryAcquireLock(path)!;
    fs.writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, token: 'other', acquiredAt: Date.now() }),
    );
    expect(first.release()).toBe(false);
    expect(fs.existsSync(path)).toBe(true);
  });

  it('막 만들어져 아직 비어 있는 락은 빼앗지 않는다', () => {
    fs.writeFileSync(path, '');
    expect(tryAcquireLock(path)).toBeNull();
    fs.utimesSync(path, PAST, PAST);
    expect(tryAcquireLock(path)).not.toBeNull();
  });
});

/**
 * main에서 빌드한 DB 꼴로 되돌린다. 이 브랜치가 더한 건 테이블 일곱 개와 cg_nodes.doc 컬럼뿐이라
 * 그걸 걷어내면 main 스키마와 같다. 노드와 엣지, co-change는 그대로 남는다.
 */
function downgradeToMainSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    for (const t of [
      'cg_file_stat',
      'cg_meta',
      'cg_doc_terms',
      'cg_text_commits',
      'cg_commit_terms',
      'cg_commit_files',
      'cg_ticket_files',
    ]) {
      db.exec(`DROP TABLE ${t}`);
    }
    db.exec('ALTER TABLE cg_nodes DROP COLUMN doc');
  } finally {
    db.close();
  }
}

describe('옛 스키마 DB 업그레이드', () => {
  let engine: InstanceType<typeof CodeGraphEngine>;
  let repo: ReturnType<typeof setupRepo>;

  beforeEach(() => {
    repo = setupRepo();
    const builder = new CodeGraphEngine();
    builder.build(repo.repoRoot, { mode: 'full' });
    builder.close();
    downgradeToMainSchema(repo.dbPath);
    engine = new CodeGraphEngine();
    vi.mocked(fs.readFileSync).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.close();
    repo.cleanup();
  });

  it('지우지 않아도 refresh가 전량 다시 색인하고 질의가 된다', async () => {
    expect(await engine.refresh(repo.repoRoot)).toMatchObject({ status: 'refreshed' });

    const store = new CodeGraphStore(repo.dbPath);
    expect(store.getMeta('doc_index_version')).not.toBeNull();
    expect(store.getAllFileStats().size).toBe(3);
    store.close();
    expect(engine.query(repo.repoRoot, 'imports_of', 'f.ts').nodes.map((n) => n.filePath)).toEqual([
      repo.a,
    ]);
    expect(engine.blastRadius(repo.repoRoot, { changedFiles: [repo.f] }).impactedFiles).toEqual(
      expect.arrayContaining([repo.a, repo.b]),
    );
    expect((await engine.refresh(repo.repoRoot)).status).toBe('fresh');
  });

  it('지원 파일이 상한을 넘으면 손대지 않고 이전 그래프로 답한다', async () => {
    const parse = vi.spyOn(typescriptPlugin, 'parse');

    const report = await engine.refresh(repo.repoRoot, { maxInlineParse: 2 });

    expect(report).toEqual({
      status: 'stale',
      reason: 'reindex_pending',
      message: REINDEX_PENDING_MESSAGE,
      toParse: 3,
      durationMs: expect.any(Number),
    });
    // 옛 DB는 stat 행이 없어 드리프트 검사가 파일을 전부 읽는다. 넘길 거면 그것도 안 한다
    expect(parse).not.toHaveBeenCalled();
    expect(readsUnder(repo.repoRoot)).toEqual([]);
    expect(engine.query(repo.repoRoot, 'imports_of', 'f.ts').nodes.map((n) => n.filePath)).toEqual([
      repo.a,
    ]);
  });

  it('지원 파일 수가 상한과 같으면 그 자리에서 색인한다', async () => {
    expect(await engine.refresh(repo.repoRoot, { maxInlineParse: 3 })).toMatchObject({
      status: 'refreshed',
    });
    expect((await engine.refresh(repo.repoRoot, { maxInlineParse: 3 })).status).toBe('fresh');
  });
});

describe('다시 파싱할 파일 수 상한', () => {
  let engine: InstanceType<typeof CodeGraphEngine>;
  let repo: ReturnType<typeof setupRepo>;

  beforeEach(() => {
    engine = new CodeGraphEngine();
    repo = setupRepo();
    engine.build(repo.repoRoot, { mode: 'full' });
    write(repo.f, 'export function helper() {\n  return 2;\n}\n');
    write(join(repo.repoRoot, 'g.ts'), 'export const g = 1;\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.close();
    repo.cleanup();
  });

  it('추가와 수정을 합쳐 상한을 넘으면 반영하지 않고 넘긴다', async () => {
    const parse = vi.spyOn(typescriptPlugin, 'parse');

    expect(await engine.refresh(repo.repoRoot, { maxInlineParse: 1 })).toMatchObject({
      status: 'stale',
      reason: 'reindex_pending',
      toParse: 2,
      pending: { added: 1, modified: 1 },
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it('상한과 같으면 그 자리에서 반영한다', async () => {
    expect(await engine.refresh(repo.repoRoot, { maxInlineParse: 2 })).toMatchObject({
      status: 'refreshed',
      changed: { added: 1, modified: 1 },
    });
  });

  it('touch만 한 파일은 다시 파싱하지 않으니 세지 않는다', async () => {
    engine.build(repo.repoRoot, { mode: 'incremental' });
    setMtime(repo.a, 60);
    setMtime(repo.b, 60);

    expect(await engine.refresh(repo.repoRoot, { maxInlineParse: 0 })).toMatchObject({
      status: 'refreshed',
      changed: { touched: 2 },
    });
  });
});
