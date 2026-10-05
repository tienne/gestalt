import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  docCommitDates,
  isAged,
  lastTouched,
  summarizeFreshness,
} from '../../../src/architecture/doc-fresh.js';
import { parseArchitectureIr } from '../../../src/architecture/ir-schema.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';
import { knowledgeIr } from '../../fixtures/architecture-categories/knowledge.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

const doc = (path: string, updatedAt?: string, committedAt?: string) => ({
  repoId: 'kb',
  path,
  ...(updatedAt !== undefined ? { updatedAt } : {}),
  ...(committedAt !== undefined ? { committedAt } : {}),
});

describe('문서 신선도', () => {
  it('머리줄 수정일과 커밋 날짜 중 늦은 쪽을 마지막 손댄 날로 본다', () => {
    expect(lastTouched(doc('a.md', '2026-01-01', '2026-03-01'))).toBe('2026-03-01');
    expect(lastTouched(doc('a.md', '2026-05-01', '2026-03-01'))).toBe('2026-05-01');
    expect(lastTouched(doc('a.md', undefined, '2026-03-01'))).toBe('2026-03-01');
    expect(lastTouched(doc('a.md'))).toBeUndefined();
  });

  it('반년 넘게 안 고친 문서만 오래됐다고 보고 날짜 없는 문서는 판단하지 않는다', () => {
    const now = '2026-10-01T00:00:00.000Z';
    expect(isAged(doc('a.md', '2026-01-01'), now)).toBe(true);
    expect(isAged(doc('a.md', '2026-06-01'), now)).toBe(false);
    expect(isAged(doc('a.md'), now)).toBe(false);
  });

  it('달별 수와 오래된 순 목록, 머리줄이 뒤처진 문서 수를 센다', () => {
    const s = summarizeFreshness(
      [
        doc('new.md', '2026-09-10'),
        doc('old.md', undefined, '2025-12-01'),
        doc('behind.md', '2026-01-01', '2026-09-01'),
        doc('none.md'),
      ],
      '2026-10-01T00:00:00.000Z',
    );
    expect(s).toEqual({
      dated: 3,
      undated: 1,
      agedDays: 180,
      aged: 1,
      headerBehind: 1,
      byMonth: { '2025-12': 1, '2026-09': 2 },
      oldest: [
        { doc: 'kb/old.md', date: '2025-12-01' },
        { doc: 'kb/behind.md', date: '2026-09-01' },
        { doc: 'kb/new.md', date: '2026-09-10' },
      ],
    });
  });

  it('오래된 문서 카드에 배지를 달고 서랍에도 적는다', async () => {
    const ir = knowledgeIr();
    ir.nodes.find((n) => n.id === 'd-status')!.doc!.aged = true;
    const r = await renderBoth(ir);
    expect(r.private).toContain('>오래됨</span>');
    expect(r.shared).toContain('>오래됨</span>');
    expect(r.private).toContain("'신선도'");
  });
});

describe('docCommitDates와 scan_docs', () => {
  let tmpRoot: string;
  const kb = (): string => join(tmpRoot, 'acme-kb');
  const put = (rel: string, text: string): void => {
    const p = join(kb(), rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const commit = (date: string, msg: string): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@acme.test', 'commit', '-q', '-m', msg],
      {
        cwd: kb(),
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: `${date}T00:00:00`,
          GIT_COMMITTER_DATE: `${date}T00:00:00`,
        },
      },
    );
  };

  beforeEach(() => {
    tmpRoot = resolve('.gestalt-test', `doc-fresh-${randomUUID()}`);
    mkdirSync(kb(), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: kb() });
    put('README.md', '# 지식\n\n- [주문](./domains/주문.md)\n');
    put('domains/주문.md', '---\nupdated: 2025-01-01\n---\n# 주문\n');
    put('domains/환불.md', '# 환불\n');
    execFileSync('git', ['add', '.'], { cwd: kb() });
    commit('2025-02-01', 'init');
    put('domains/환불.md', '# 환불\n\n바뀐 내용\n');
    execFileSync('git', ['add', '.'], { cwd: kb() });
    commit('2026-09-20', 'refund');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('파일마다 마지막 커밋 날짜를 한글 이름 그대로 돌려준다', () => {
    const dates = docCommitDates(kb());
    expect(dates.get('domains/환불.md')).toBe('2026-09-20');
    expect(dates.get('domains/주문.md')).toBe('2025-02-01');
    expect(docCommitDates(join(tmpRoot, 'none')).size).toBe(0);
  });

  it('scan_docs가 커밋 날짜와 신선도 요약을 싣고 오래된 문서에 표시를 단다', async () => {
    const r = (await handleArchitecturePassthrough(
      { action: 'scan_docs', docRoots: [{ repoId: 'kb', name: 'acme-kb', path: '../acme-kb' }] },
      join(tmpRoot, 'work'),
    )) as { summary: { freshness: { dated: number; undated: number } }; draftPath: string };
    expect(r.summary.freshness).toMatchObject({ dated: 3, undated: 0 });
    const parsed = parseArchitectureIr(JSON.parse(readFileSync(r.draftPath, 'utf8')));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const order = parsed.value.nodes.find((n) => n.id === 'doc:kb/domains/주문.md')!;
    expect(order.doc).toMatchObject({ committedAt: '2025-02-01', aged: true });
    const refund = parsed.value.nodes.find((n) => n.id === 'doc:kb/domains/환불.md')!;
    expect(refund.doc?.committedAt).toBe('2026-09-20');
  });
});
