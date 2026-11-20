import { existsSync, mkdirSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConductorStore } from '../../../src/conductor/store.js';
import {
  excerpt,
  getOrderDetail,
  listOrders,
  loadResults,
  parseSince,
  readResultFile,
  resolveOrderId,
  searchResults,
} from '../../../src/conductor/results.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';
import { cleanupOutsideDirs, hasControl, outsideDir, put, seed } from './results-fixtures.js';

afterEach(() => {
  cleanupStateDirs();
  cleanupOutsideDirs();
});

const A = 'ord-aaaaaaaa';
const B = 'ord-bbbbbbbb';
const C = 'ord-cccccccc';

describe('loadResults', () => {
  it('저장소 디렉토리가 없으면 만들지 않고 던진다', () => {
    const missing = join('.gestalt-test', 'conductor-없는경로-never');
    expect(() => loadResults({ stateDir: missing })).toThrow('상태 저장소가 없어요');
    expect(existsSync(missing)).toBe(false);
  });

  it('events.jsonl이 없으면 던지고 파일을 만들지 않는다', () => {
    const dir = tempStateDir();
    expect(() => loadResults({ stateDir: dir })).toThrow('events.jsonl');
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(false);
  });

  it('stateDir은 realpath로 돌려준다', () => {
    const { dir } = seed([{ order: { id: A } }]);
    expect(loadResults({ stateDir: dir }).stateDir).toBe(realpathSync(dir));
  });

  it('없는 repoPaths와 상대 경로는 허용 루트에서 뺀다', () => {
    const { dir } = seed([{ order: { id: A } }]);
    const repo = outsideDir();
    const r = loadResults({
      stateDir: dir,
      repoPaths: { 'acme/app': repo, 'acme/gone': join(repo, 'nope'), 'acme/rel': 'relative/x' },
    });
    expect(r.repoRoots).toEqual([realpathSync(repo)]);
  });

  it('주문 refs를 중복 없이 분류하고 처음 적힌 보고 번호를 남긴다', () => {
    const base = tempStateDir();
    const note = put(join(realpathSync(base), 'reports', 'n.md'));
    const { dir } = seed(
      [
        {
          order: { id: A },
          reports: [{ refs: [note, 'https://example.com/a'] }, { refs: [note, 'abc1234'] }],
        },
      ],
      base,
    );
    const { orderRefs } = loadResults({ stateDir: dir });
    const { refs, firstReport } = orderRefs.get(A)!;
    expect(refs.map((r) => r.kind)).toEqual(['file', 'url', 'reference']);
    expect(firstReport).toEqual([1, 1, 2]);
  });

  it('repoPaths 아래 파일은 읽을 수 있고 아니면 outside', () => {
    const repo = outsideDir();
    const inRepo = put(join(repo, 'docs', 'plan.md'));
    const elsewhere = put(join(outsideDir(), 'plan.md'));
    const { dir } = seed([{ order: { id: A }, reports: [{ refs: [inRepo, elsewhere] }] }]);
    const r = loadResults({ stateDir: dir, repoPaths: { 'acme/app': repo } });
    expect(r.orderRefs.get(A)!.refs.map((x) => x.kind)).toEqual(['file', 'outside']);
  });

  it('git-worktree 워커의 handle 경로를 허용 루트로 넣는다. 다른 주문의 워크트리는 안 쓴다', () => {
    const tree = outsideDir();
    const mine = put(join(tree, 'out.md'));
    const { dir } = seed([
      {
        order: { id: A },
        worker: { kind: 'git-worktree', handle: tree },
        reports: [{ refs: [mine] }],
      },
      { order: { id: B }, reports: [{ refs: [mine] }] },
    ]);
    const r = loadResults({ stateDir: dir });
    expect(r.orderRefs.get(A)!.refs[0]!.kind).toBe('file');
    expect(r.orderRefs.get(B)!.refs[0]!.kind).toBe('outside');
  });

  it('오르카 워커는 주문 id와 회차로 된 워크트리 이름이 상위 조각에 있으면 허용한다', () => {
    const base = outsideDir();
    const inTree = put(join(base, `${A}-1`, 'result.md'));
    const wrongName = put(join(base, `${A}-9`, 'result.md'));
    const { dir } = seed([
      {
        order: { id: A },
        worker: { kind: 'orca-worktree', attempt: 1 },
        reports: [{ refs: [inTree, wrongName] }],
      },
    ]);
    const r = loadResults({ stateDir: dir });
    expect(r.orderRefs.get(A)!.refs.map((x) => x.kind)).toEqual(['file', 'outside']);
  });

  it('보고를 못 붙인 워커의 보고와 지운 주문은 보이지 않는다', () => {
    const { dir, workers } = seed([
      {
        order: { id: A, status: 'done' },
        worker: { status: 'finished' },
        reports: [{ summary: '지울 주문' }],
      },
      { order: { id: B }, reports: [{ summary: '남을 주문' }] },
    ]);
    ConductorStore.open(dir).removeOrder(A);
    const r = loadResults({ stateDir: dir });
    expect(Object.keys(r.snapshot.orders)).toEqual([B]);
    expect(listOrders(r).orders.map((o) => o.id)).toEqual([B]);
    expect(searchResults(r, '지울 주문').hits).toHaveLength(0);
    expect(workers).toHaveLength(2);
  });
});

describe('listOrders', () => {
  const orders = () =>
    seed([
      {
        order: { id: A, repo: 'acme/app', status: 'done', updatedAt: '2026-11-03T00:00:00.000Z' },
        reports: [{}, {}],
      },
      {
        order: { id: B, repo: 'acme/web', status: 'queued', updatedAt: '2026-11-05T00:00:00.000Z' },
      },
      {
        order: {
          id: C,
          repo: 'acme/app',
          status: 'done',
          issueKey: 'ACME-7',
          updatedAt: '2026-11-04T00:00:00.000Z',
        },
      },
    ]);

  it('최근 갱신순으로 정렬하고 보고 수와 refs 수를 센다', () => {
    const r = loadResults({ stateDir: orders().dir });
    const { total, orders: list } = listOrders(r);
    expect(total).toBe(3);
    expect(list.map((o) => o.id)).toEqual([B, C, A]);
    expect(list[2]).toMatchObject({ reportCount: 2, refCount: 0, relatedCount: 0 });
  });

  it('갱신 시각이 같으면 id순', () => {
    const { dir } = seed([
      { order: { id: B, updatedAt: '2026-11-01T00:00:00.000Z' } },
      { order: { id: A, updatedAt: '2026-11-01T00:00:00.000Z' } },
    ]);
    expect(
      listOrders(loadResults({ stateDir: dir }))
        .orders.map((o) => o.id)
        .sort(),
    ).toEqual([A, B]);
    expect(listOrders(loadResults({ stateDir: dir })).orders.map((o) => o.id)).toEqual([A, B]);
  });

  it('repo, status, issueKey, since 필터를 건다', () => {
    const r = loadResults({ stateDir: orders().dir });
    const ids = (f: Parameters<typeof listOrders>[1]) => listOrders(r, f).orders.map((o) => o.id);
    expect(ids({ repo: 'acme/app' })).toEqual([C, A]);
    expect(ids({ status: 'queued' })).toEqual([B]);
    expect(ids({ issueKey: 'ACME-7' })).toEqual([C]);
    expect(ids({ since: '2026-11-04' })).toEqual([B, C]);
    expect(ids({ repo: 'acme/app', status: 'queued' })).toEqual([]);
  });

  it('since가 날짜가 아니면 던진다', () => {
    expect(() => parseSince('nope')).toThrow('--since');
    const r = loadResults({ stateDir: orders().dir });
    expect(() => listOrders(r, { since: 'nope' })).toThrow('--since');
  });
});

describe('resolveOrderId', () => {
  const r = () => loadResults({ stateDir: seed([{ order: { id: A } }, { order: { id: B } }]).dir });

  it('전체 id와 유일한 앞부분은 받는다', () => {
    const results = r();
    expect(resolveOrderId(results, A)).toEqual({ ok: true, id: A });
    expect(resolveOrderId(results, 'ord-bb')).toEqual({ ok: true, id: B });
  });

  it('모호하면 후보를 주고 모르면 unknown, 빈 입력도 unknown', () => {
    const results = r();
    expect(resolveOrderId(results, 'ord-')).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: [A, B],
    });
    expect(resolveOrderId(results, 'zzz')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(resolveOrderId(results, '')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('지운 주문은 removed', () => {
    const { dir } = seed([{ order: { id: A, status: 'done' }, worker: { status: 'finished' } }]);
    ConductorStore.open(dir).removeOrder(A);
    expect(resolveOrderId(loadResults({ stateDir: dir }), A)).toMatchObject({
      ok: false,
      reason: 'removed',
    });
  });
});

describe('getOrderDetail', () => {
  it('보고에 번호를 붙이고 gate와 refs를 모은다', () => {
    const { dir } = seed([{ order: { id: A }, reports: [{ summary: '하나' }, { summary: '둘' }] }]);
    const store = ConductorStore.open(dir);
    store.openGate({
      id: 'gate-1',
      orderId: A,
      type: 'merge',
      status: 'open',
      reason: '머지 확인',
      refs: [],
      openedAt: '2026-11-01T00:00:00.000Z',
    });
    const d = getOrderDetail(loadResults({ stateDir: dir }), A)!;
    expect(d.reports.map((x) => [x.index, x.summary])).toEqual([
      [1, '하나'],
      [2, '둘'],
    ]);
    expect(d.gates.map((g) => g.id)).toEqual(['gate-1']);
    expect(d.workers).toHaveLength(1);
  });

  it('모르는 주문은 undefined', () => {
    const { dir } = seed([{ order: { id: A } }]);
    expect(getOrderDetail(loadResults({ stateDir: dir }), B)).toBeUndefined();
  });
});

describe('주문 없음 묶음', () => {
  function layout() {
    const base = tempStateDir();
    const abs = realpathSync(base);
    const refd = put(join(abs, 'reports', 'linked.md'), '주문에 걸림');
    const refdDir = join(abs, 'refs', 'dirref');
    put(join(refdDir, 'inside.md'), '디렉토리 ref 하위');
    put(join(abs, 'reports', 'free.md'), '떠도는 보고');
    put(join(abs, 'results', 'nested', 'deep.log'), '깊은 로그');
    put(join(abs, 'notes', `${A}-memo.md`), '이름에 주문 id');
    put(join(abs, 'artifacts', B, 'out.txt'), '상위 디렉토리에 주문 id');
    put(join(abs, 'artifacts', 'ord-deadbeef-gone.md'), '없는 주문 id');
    put(join(abs, 'reports', 'image.png'), 'png');
    put(join(abs, 'top.md'), '루트 md');
    put(join(abs, 'top.txt'), '루트 txt는 안 모음');
    for (const skip of [
      'prompts',
      'handoffs',
      'sessions',
      'inbox',
      'queue',
      'worktrees',
      'context',
      'deploy',
      'slack',
    ]) {
      put(join(abs, skip, 'x.md'), '운영 파일');
    }
    put(join(abs, `${A}-x`, 'a.md'), '최상위 ord- 디렉토리');
    put(join(abs, 'wrk-abc12345', 'b.md'), '최상위 wrk- 디렉토리');
    put(join(abs, 'other', 'c.md'), '이름 규칙 밖');
    const target = outsideDir();
    put(join(target, 'd.md'), '심링크 너머');
    symlinkSync(target, join(abs, 'ord-linkdir0'));
    seed([{ order: { id: A }, reports: [{ refs: [refd, refdDir] }] }, { order: { id: B } }], base);
    return { base, abs };
  }

  it('수집 대상 디렉토리와 허용 확장자만 모으고 운영 디렉토리는 제외한다', () => {
    const { base } = layout();
    const rels = loadResults({ stateDir: base })
      .files.map((f) => f.rel)
      .sort();
    expect(rels).toEqual(
      [
        'artifacts/ord-bbbbbbbb/out.txt',
        'artifacts/ord-deadbeef-gone.md',
        'notes/ord-aaaaaaaa-memo.md',
        'ord-aaaaaaaa-x/a.md',
        'reports/free.md',
        'results/nested/deep.log',
        'top.md',
        'wrk-abc12345/b.md',
      ].sort(),
    );
  });

  it('주문 refs에 걸린 파일과 디렉토리 ref 하위 파일은 뺀다', () => {
    const { base } = layout();
    const rels = loadResults({ stateDir: base }).files.map((f) => f.rel);
    expect(rels).not.toContain('reports/linked.md');
    expect(rels).not.toContain('refs/dirref/inside.md');
  });

  it('최상위 ord-/wrk- 디렉토리: ord-는 그 주문 관련 파일, wrk-는 주문 없음, 심링크 디렉토리는 제외', () => {
    const { base } = layout();
    const { files } = loadResults({ stateDir: base });
    const by = (rel: string) => files.find((f) => f.rel === rel);
    expect(by(`${A}-x/a.md`)?.orderId).toBe(A);
    expect(by('wrk-abc12345/b.md')?.orderId).toBeUndefined();
    expect(files.some((f) => f.rel.startsWith('ord-linkdir0'))).toBe(false);
    expect(files.some((f) => f.rel.startsWith('other/'))).toBe(false);
    expect(files.some((f) => f.rel.startsWith('prompts/'))).toBe(false);
  });

  it('파일 이름이나 상위 디렉토리에 주문 id가 있으면 관련 파일에 붙는다', () => {
    const { base } = layout();
    const r = loadResults({ stateDir: base });
    const by = (rel: string) => r.files.find((f) => f.rel === rel);
    expect(by('notes/ord-aaaaaaaa-memo.md')?.orderId).toBe(A);
    expect(by('artifacts/ord-bbbbbbbb/out.txt')?.orderId).toBe(B);
    expect(by('artifacts/ord-deadbeef-gone.md')?.orderId).toBeUndefined();
    expect(
      getOrderDetail(r, A)!
        .related.map((f) => f.rel)
        .sort(),
    ).toEqual(['notes/ord-aaaaaaaa-memo.md', 'ord-aaaaaaaa-x/a.md']);
    const sum = listOrders(r).orders.find((o) => o.id === A)!;
    expect(sum.relatedCount).toBe(2);
  });

  it('심링크인 수집 디렉토리(reports 등)는 따라가지 않는다', () => {
    const base = tempStateDir();
    const target = outsideDir();
    put(join(target, 'leak.md'), '밖');
    symlinkSync(target, join(realpathSync(base), 'reports'));
    seed([{ order: { id: A } }], base);
    expect(loadResults({ stateDir: base }).files).toEqual([]);
  });

  it('파일 키는 저장소 상대 경로로 정해지고 키 조회만 본문을 연다', () => {
    const { base } = layout();
    const r = loadResults({ stateDir: base });
    const f = r.files.find((x) => x.rel === 'reports/free.md')!;
    expect(f.key).toMatch(/^[0-9a-f]{16}$/);
    expect(loadResults({ stateDir: base }).files.find((x) => x.rel === f.rel)!.key).toBe(f.key);
    expect(readResultFile(r, f.key)?.text).toBe('떠도는 보고');
    expect(readResultFile(r, 'ffffffffffffffff')).toBeNull();
    expect(readResultFile(r, '../../etc/passwd')).toBeNull();
    expect(readResultFile(r, f.path)).toBeNull();
  });

  it('mtime 최신순으로 정렬한다', () => {
    const base = tempStateDir();
    const abs = realpathSync(base);
    const old = put(join(abs, 'reports', 'old.md'));
    put(join(abs, 'reports', 'new.md'));
    utimesSync(old, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    seed([{ order: { id: A } }], base);
    expect(loadResults({ stateDir: base }).files.map((f) => f.rel)).toEqual([
      'reports/new.md',
      'reports/old.md',
    ]);
  });

  it('저장소 파일이 하나도 없어도 비어 있을 뿐 던지지 않는다', () => {
    const { dir } = seed([{ order: { id: A } }]);
    mkdirSync(join(dir, 'refs'), { recursive: true });
    expect(loadResults({ stateDir: dir }).files).toEqual([]);
  });
});

describe('searchResults', () => {
  function corpus() {
    const base = tempStateDir();
    const abs = realpathSync(base);
    const refFile = put(
      join(abs, 'reports', 'review.md'),
      ['첫 줄', 'Needle 가 본문에 있다', '셋째', 'needle again', 'NEEDLE 3', 'needle 4'].join('\n'),
    );
    put(join(abs, 'reports', 'loose.md'), '떠도는 파일의 needle');
    put(join(abs, 'notes', 'needle-name.md'), '본문에는 없다');
    put(join(abs, 'notes', `${A}-extra.md`), '관련 파일 needle');
    seed(
      [
        {
          order: {
            id: A,
            title: 'Needle 제목',
            repo: 'acme/app',
            status: 'done',
            updatedAt: '2026-11-02T00:00:00.000Z',
          },
          reports: [
            { summary: '요약 needle 하나', refs: [refFile] },
            { summary: '두 번째 NEEDLE' },
          ],
        },
        {
          order: {
            id: B,
            title: '다른 주문',
            repo: 'acme/web',
            status: 'queued',
            updatedAt: '2026-11-04T00:00:00.000Z',
          },
          reports: [{ summary: '다른 needle' }],
        },
      ],
      base,
    );
    return loadResults({ stateDir: base });
  }

  it('빈 검색어는 결과가 없다', () => {
    expect(searchResults(corpus(), '   ')).toEqual({ query: '', total: 0, hits: [] });
  });

  it('대소문자를 무시하고 제목, 요약, refs 본문, 관련 파일, 주문 없음 파일에서 찾는다', () => {
    const { hits } = searchResults(corpus(), 'needle');
    const kinds = (id: string | null) =>
      hits.filter((h) => h.orderId === id).map((h) => `${h.source}:${h.where}`);
    expect(kinds(A)).toContain('title:title');
    expect(kinds(A).filter((k) => k.startsWith('summary'))).toHaveLength(2);
    expect(kinds(A).some((k) => k.startsWith('ref:'))).toBe(true);
    expect(kinds(A)).toContain('file:notes/ord-aaaaaaaa-extra.md');
    expect(kinds(B)).toEqual(['summary:summary']);
    expect(kinds(null).sort()).toEqual(['file:notes/needle-name.md', 'file:reports/loose.md']);
  });

  it('주문 갱신순으로 내고 한 주문 안에서는 제목, 요약(최근 보고 먼저), refs, 관련 파일 순, 주문 없음은 끝', () => {
    const { hits } = searchResults(corpus(), 'needle');
    expect(hits[0]!.orderId).toBe(B);
    const a = hits.filter((h) => h.orderId === A);
    expect(a.map((h) => h.source)).toEqual([
      'title',
      'summary',
      'summary',
      'ref',
      'ref',
      'ref',
      'file',
    ]);
    expect(a.filter((h) => h.source === 'summary').map((h) => h.reportIndex)).toEqual([2, 1]);
    const firstUnlinked = hits.findIndex((h) => h.orderId === null);
    expect(hits.slice(firstUnlinked).every((h) => h.orderId === null)).toBe(true);
  });

  it('파일 하나에서 3건까지만 내고 줄 번호를 단다', () => {
    const refHits = searchResults(corpus(), 'needle').hits.filter((h) => h.source === 'ref');
    expect(refHits).toHaveLength(3);
    expect(refHits.map((h) => h.line)).toEqual([2, 4, 5]);
  });

  it('본문에 없고 파일 이름에만 맞으면 이름으로 1건 낸다', () => {
    const named = searchResults(corpus(), 'needle-name').hits;
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ source: 'file', where: 'notes/needle-name.md' });
    expect(named[0]!.line).toBeUndefined();
  });

  it('body:false면 제목과 요약만 찾는다', () => {
    const { hits } = searchResults(corpus(), 'needle', { body: false });
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(['title', 'summary']));
  });

  it('repo, status를 걸면 주문 없음 파일을 뺀다', () => {
    const r = corpus();
    expect(searchResults(r, 'needle', { repo: 'acme/web' }).hits.map((h) => h.orderId)).toEqual([
      B,
    ]);
    const byStatus = searchResults(r, 'needle', { status: 'queued' }).hits;
    expect(byStatus.every((h) => h.orderId === B)).toBe(true);
    expect(searchResults(r, 'needle', { issueKey: 'NOPE-1' }).total).toBe(0);
  });

  it('since는 주문은 updatedAt, 주문 없음 파일은 mtime 기준', () => {
    const r = corpus();
    const hits = searchResults(r, 'needle', { since: '2026-11-03' }).hits;
    expect(hits.some((h) => h.orderId === A)).toBe(false);
    expect(hits.some((h) => h.orderId === B)).toBe(true);
    expect(hits.some((h) => h.orderId === null)).toBe(true);
    expect(searchResults(r, 'needle', { since: '2999-01-01' }).hits).toEqual([]);
  });

  it('limit은 자르되 total은 자르기 전 건수', () => {
    const r = corpus();
    const all = searchResults(r, 'needle');
    const cut = searchResults(r, 'needle', { limit: 2 });
    expect(cut.hits).toHaveLength(2);
    expect(cut.total).toBe(all.total);
  });

  it('정규식 메타 문자는 글자 그대로 찾는다', () => {
    const { dir } = seed([{ order: { id: A }, reports: [{ summary: '값 a.b*c(1) 확인' }] }]);
    const r = loadResults({ stateDir: dir });
    expect(searchResults(r, 'a.b*c(1)').total).toBe(1);
    expect(searchResults(r, '.*').total).toBe(0);
    expect(searchResults(r, ')(').total).toBe(0);
  });

  it('발췌 안의 matchStart, matchLength가 키워드를 가리킨다', () => {
    for (const h of searchResults(corpus(), 'needle').hits) {
      expect(h.excerpt.slice(h.matchStart, h.matchStart + h.matchLength).toLowerCase()).toBe(
        'needle',
      );
    }
  });

  it('refs 본문이 바뀐 뒤 같은 LoadedResults에서는 옛 본문으로 찾는다(캐시)', () => {
    const base = tempStateDir();
    const note = put(join(realpathSync(base), 'reports', 'c.md'), 'cachekey 처음');
    seed([{ order: { id: A }, reports: [{ refs: [note] }] }], base);
    const r = loadResults({ stateDir: base });
    expect(searchResults(r, 'cachekey').total).toBe(1);
    put(note, '다른 내용');
    expect(searchResults(r, 'cachekey').total).toBe(1);
    expect(searchResults(loadResults({ stateDir: base }), 'cachekey').total).toBe(0);
  });
});

describe('excerpt', () => {
  it('앞뒤 80자를 자르고 말줄임표를 붙이며 위치는 발췌 안 기준', () => {
    const text = `${'가'.repeat(100)}KEY${'나'.repeat(100)}`;
    const e = excerpt(text, /key/iu)!;
    expect(e.excerpt.startsWith('…')).toBe(true);
    expect(e.excerpt.endsWith('…')).toBe(true);
    expect(e.excerpt.slice(e.matchStart, e.matchStart + e.matchLength)).toBe('KEY');
    expect(e.excerpt).toHaveLength(1 + 80 + 3 + 80 + 1);
  });

  it('개행과 제어 문자는 공백으로 바꾼다', () => {
    const e = excerpt('앞\n\u001b[31mKEY\u0007뒤', /key/iu)!;
    expect(hasControl(e.excerpt)).toBe(false);
    expect(e.excerpt.slice(e.matchStart, e.matchStart + 3)).toBe('KEY');
  });

  it('안 맞으면 null, 같은 정규식을 g 플래그로 재사용해도 lastIndex에 안 휘둘린다', () => {
    expect(excerpt('없다', /key/iu)).toBeNull();
    const re = /key/giu;
    expect(excerpt('key', re)).not.toBeNull();
    expect(excerpt('key', re)).not.toBeNull();
  });
});
