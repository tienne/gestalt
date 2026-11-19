// 라이브 서버 테스트가 함께 쓰는 서버 띄우기와 요청 헬퍼, 작은 IR
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';
import {
  ArchitectureLiveServer,
  type ArchitectureLiveServerDeps,
} from '../../../src/architecture/live-server.js';
import { liveConnectSrc } from '../../../src/architecture/live-port.js';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  Evidence,
} from '../../../src/architecture/index.js';

const codeEv: Evidence = { type: 'code', location: 'web:src/a.ts:1', visibility: 'public' };

export function sampleIr(): ArchitectureIr {
  const n = (
    id: string,
    kind: ArchitectureNode['kind'],
    label = id,
    parent?: string,
  ): ArchitectureNode => ({
    id,
    kind,
    label,
    repo: 'web',
    evidence: [codeEv],
    ...(parent ? { parent } : {}),
  });
  const e = (
    id: string,
    from: string,
    to: string,
    kind: ArchitectureEdge['kind'],
  ): ArchitectureEdge => ({ id, from, to, kind, evidence: [codeEv], lineStyle: 'solid' });
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    nodes: [
      n('shop', 'service'),
      n('list', 'screen', 'OrderList', 'shop'),
      n('ep', 'endpoint', 'GET /orders'),
      n('mod', 'app_module', 'order-handler'),
      n('tbl', 'db_table', 'orders'),
    ],
    edges: [
      e('c1', 'list', 'ep', 'calls'),
      e('h1', 'ep', 'mod', 'handles'),
      e('rw', 'mod', 'tbl', 'reads_writes'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export const page = (title: string, connect = liveConnectSrc()) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${connect}"><title>${title}</title></head><body><p>${title}</p></body></html>`;

export async function startedLive(deps?: ArchitectureLiveServerDeps) {
  const repo = resolve('.gestalt-test', `arch-live-${randomUUID()}`);
  const dir = join(repo, '.gestalt', 'architecture');
  mkdirSync(join(dir, 'views'), { recursive: true });
  writeFileSync(join(dir, 'screen-chain.html'), page('private chain'));
  writeFileSync(join(dir, 'screen-chain.shared.html'), page('shared chain', "connect-src 'none'"));
  writeFileSync(join(dir, 'screen-chain.delta.html'), page('delta'));
  writeFileSync(join(dir, 'views', 'screen-chain.q1.html'), page('view'));
  writeFileSync(join(repo, 'outside.html'), page('outside'));
  symlinkSync(join(repo, 'outside.html'), join(dir, 'deploy-path.html'));
  writeFileSync(join(dir, 'screen-chain.json'), JSON.stringify(sampleIr()));
  const server = new ArchitectureLiveServer(repo, deps);
  // 기본 포트(7894)가 다른 테스트나 세션과 겹치지 않게 아무 빈 포트에 묶는다
  await server.start({ port: 0, attempts: 1 });
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  cleanups.push(() => server.stop());
  return { server, repo, dir };
}

export function call(
  port: number,
  path: string,
  opts: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((done, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
