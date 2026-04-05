import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { GraphVisualizationServer } from '../../../src/graph-viz/server.js';
import { NodeKind, EdgeKind } from '../../../src/code-graph/types.js';
import type { CodeGraphNode, CodeGraphEdge } from '../../../src/code-graph/types.js';

function makeNode(id: string): CodeGraphNode {
  return {
    id,
    kind: NodeKind.File,
    name: id,
    filePath: `src/${id}.ts`,
    isTest: false,
    updatedAt: Date.now(),
  };
}

function makeEdge(sourceId: string, targetId: string): CodeGraphEdge {
  return { kind: EdgeKind.IMPORTS_FROM, sourceId, targetId, updatedAt: Date.now() };
}

// 랜덤 포트 범위 (충돌 최소화)
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

describe('GraphVisualizationServer', () => {
  const servers: GraphVisualizationServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => s.stop().catch(() => {})));
    servers.length = 0;
  });

  it('start() 후 port getter가 실제 포트를 반환한다', async () => {
    const server = new GraphVisualizationServer([], []);
    servers.push(server);

    const port = randomPort();
    await server.start(port);

    expect(server.port).toBe(port);
  });

  it('GET / 요청에 HTML을 반환한다', async () => {
    const nodes = [makeNode(`node-${randomUUID()}`)];
    const edges = [makeEdge(nodes[0]!.id, nodes[0]!.id)];
    const server = new GraphVisualizationServer(nodes, edges);
    servers.push(server);

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html>');
  });

  it('GET /api/graph 요청에 nodes/edges JSON을 반환한다', async () => {
    const node = makeNode(`n-${randomUUID()}`);
    const edge = makeEdge(node.id, node.id);
    const server = new GraphVisualizationServer([node], [edge]);
    servers.push(server);

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/graph`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json() as { nodes: unknown[]; edges: unknown[] };
    expect(body.nodes).toHaveLength(1);
    expect(body.edges).toHaveLength(1);
  });

  it('알 수 없는 경로는 404를 반환한다', async () => {
    const server = new GraphVisualizationServer([], []);
    servers.push(server);

    const port = randomPort();
    await server.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('stop() 후 서버가 더 이상 응답하지 않는다', async () => {
    const server = new GraphVisualizationServer([], []);
    servers.pop(); // afterEach에 두면 already stopped이므로 수동 관리

    const port = randomPort();
    await server.start(port);
    await server.stop();

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('stop()은 미시작 상태에서 호출해도 에러가 없다', async () => {
    const server = new GraphVisualizationServer([], []);
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
