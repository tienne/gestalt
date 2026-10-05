import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScannedDoc } from '../../../src/architecture/doc-scan.js';
import { findStaleDocs } from '../../../src/architecture/doc-stale.js';
import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';
import { base, code, node } from '../../fixtures/architecture-categories/common.js';

// 가짜 API 레포 acme-api와 지식 레포 acme-kb
const empty = { sections: [], evidenceMix: {}, routes: [], screens: [], mdLinks: [], gaps: [] };

const ORDERS: ScannedDoc = {
  ...empty,
  repoId: 'kb',
  path: 'orders.md',
  title: '주문',
  codeRefs: [
    { repo: 'acme-api', path: 'orders/src/OrderController.java', pinned: 'branch', line: 3 },
    { repo: 'acme-api', path: 'orders/src/util', pinned: 'none', line: 4 },
  ],
};
const API: ScannedDoc = { ...empty, repoId: 'kb', path: 'api.md', codeRefs: [] };
const MISC: ScannedDoc = { ...empty, repoId: 'kb', path: 'misc.md', codeRefs: [] };

function linkIr(): ArchitectureIr {
  return {
    ...base(),
    view: 'knowledge-link',
    repos: [{ id: 'be', name: 'acme-api', root: '/srv/acme-api' }],
    nodes: [
      node('ep:GET /api/orders', 'endpoint', {
        label: 'GET /api/orders',
        repo: 'be',
        evidence: [code('be:orders/src/OrderController.java:20')],
      }),
      node('doc:kb/api.md', 'document', {
        repo: 'kb',
        displayName: 'API 안내',
        doc: { path: 'api.md' },
      }),
    ],
    edges: [
      {
        id: 'desc:doc:kb/api.md->ep:GET /api/orders',
        from: 'doc:kb/api.md',
        to: 'ep:GET /api/orders',
        kind: 'describes',
        evidence: [{ type: 'doc', location: 'kb:api.md:1', visibility: 'private' }],
        lineStyle: 'dashed',
      },
    ],
  };
}

describe('findStaleDocs', () => {
  it('문서가 가리킨 파일이나 폴더 아래 파일이 바뀌면 그 문서를 고른다', () => {
    const docs = findStaleDocs(
      [ORDERS, API, MISC],
      [
        { repo: 'acme-api', path: 'orders/src/OrderController.java' },
        { repo: 'acme-api', path: 'orders/src/util/Money.java' },
      ],
    );
    expect(docs).toEqual([
      {
        doc: 'kb/orders.md',
        title: '주문',
        reasons: [
          { kind: 'code-ref', file: 'orders/src/OrderController.java', line: 3 },
          { kind: 'code-ref', file: 'orders/src/util/Money.java', line: 4 },
        ],
      },
    ]);
  });

  it('link_docs 결과가 있으면 설명하는 기술 노드의 근거 파일이 바뀐 문서도 고른다', () => {
    const docs = findStaleDocs(
      [ORDERS, API, MISC],
      [{ repo: 'be', path: 'orders/src/OrderController.java' }],
      { linkIr: linkIr() },
    );
    expect(docs.map((d) => [d.doc, d.reasons.map((r) => r.kind)])).toEqual([
      ['kb/api.md', ['node']],
      ['kb/orders.md', ['code-ref']],
    ]);
    expect(docs[0]).toMatchObject({ title: 'API 안내', reasons: [{ node: 'ep:GET /api/orders' }] });
  });

  it('바뀐 파일이 아무 문서에도 안 닿으면 비운다', () => {
    expect(findStaleDocs([ORDERS], [{ repo: 'acme-api', path: 'billing/x.ts' }])).toEqual([]);
  });
});

describe('ges_architecture stale_docs', () => {
  let tmpRoot: string;
  const put = (rel: string, text: string): void => {
    const p = join(tmpRoot, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@acme.test', ...args], {
      cwd,
      encoding: 'utf-8',
    });

  beforeEach(async () => {
    tmpRoot = resolve('.gestalt-test', `doc-stale-${randomUUID()}`);
    put(
      'acme-kb/orders.md',
      '# 주문\n\n[evidence: acme-api:orders/src/OrderController.java@main]\n',
    );
    await handleArchitecturePassthrough(
      { action: 'scan_docs', docRoots: [{ repoId: 'kb', name: 'acme-kb', path: '../acme-kb' }] },
      join(tmpRoot, 'work'),
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('changedFiles로 손봐야 할 문서를 고르고 파일로 남긴다', async () => {
    const r = (await handleArchitecturePassthrough(
      { action: 'stale_docs', changedFiles: ['acme-api:orders/src/OrderController.java'] },
      join(tmpRoot, 'work'),
    )) as { summary: Record<string, unknown>; sample: unknown[]; stalePath: string };
    expect(r.summary).toEqual({
      changedFiles: 1,
      staleDocs: 1,
      viaCodeRef: 1,
      viaNode: 0,
      linkedIr: false,
    });
    expect(r.sample).toEqual([
      { doc: 'kb/orders.md', title: '주문', files: ['orders/src/OrderController.java'] },
    ]);
    expect(JSON.parse(readFileSync(r.stalePath, 'utf8')).docs).toHaveLength(1);
  });

  it('diffBase를 주면 코드 레포에서 git diff로 바뀐 파일을 찾는다', async () => {
    const api = join(tmpRoot, 'acme-api');
    put('acme-api/orders/src/OrderController.java', 'class A {}\n');
    git(api, 'init', '-q', '-b', 'main');
    git(api, 'add', '.');
    git(api, 'commit', '-q', '-m', 'init');
    put('acme-api/orders/src/OrderController.java', 'class B {}\n');
    git(api, 'commit', '-q', '-am', 'change');
    const r = (await handleArchitecturePassthrough(
      {
        action: 'stale_docs',
        diffBase: 'HEAD~1',
        changedRepo: 'acme-api',
        codeRoots: { 'acme-api': '../acme-api' },
      },
      join(tmpRoot, 'work'),
    )) as { summary: Record<string, unknown> };
    expect(r.summary).toMatchObject({ changedFiles: 1, staleDocs: 1 });
  });

  it('바뀐 파일을 알 방법이 없으면 거부한다', async () => {
    const r = (await handleArchitecturePassthrough(
      { action: 'stale_docs', diffBase: 'main' },
      join(tmpRoot, 'work'),
    )) as { ok: boolean; errors: { code: string }[] };
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('MISSING_INPUT');
  });
});
