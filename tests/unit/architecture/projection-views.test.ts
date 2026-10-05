import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchitectureStore,
  mergeArchitectureIrs,
  mergeWithPrevious,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { checkoutSequenceIr } from '../../fixtures/architecture-categories/sequence.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = resolve('.gestalt-test', `projection-views-${randomUUID()}`);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function refundProjection(): NonNullable<ArchitectureIr['projections']>[number] {
  return {
    id: 'refund',
    shape: 'sequence',
    title: '환불 순서',
    question: '환불을 누르면 누가 무엇을 주고받나요?',
    messages: [
      {
        id: 'r1',
        from: 'app',
        to: 'api',
        label: 'POST /orders/refund',
        edge: 'e-app-api',
        evidence: [],
        lineStyle: 'solid',
      },
    ],
  };
}

describe('투영 views 저장', () => {
  it('투영마다 가리키는 노드와 엣지, 걸린 질문만 담아 따로 쓴다', () => {
    const store = new ArchitectureStore(repoRoot);
    const ir = checkoutSequenceIr();
    ir.unresolved = [
      { id: 'q-m7', subject: { messageId: 'm7' }, question: '결과 화면 주소를 돌려주나요?' },
      { id: 'q-app', subject: { nodeId: 'app' }, question: '앱은 하나뿐인가요?' },
    ];
    const paths = store.saveViews(ir);
    expect(paths).toEqual([store.viewPath('screen-chain', 'checkout')]);
    const slice = JSON.parse(readFileSync(paths[0]!, 'utf8'));
    expect(slice.projection.id).toBe('checkout');
    expect(slice.nodes.map((n: { id: string }) => n.id).sort()).toEqual([
      'api',
      'app',
      'ledger',
      'pg',
    ]);
    expect(slice.edges.map((e: { id: string }) => e.id).sort()).toEqual([
      'e-api-ledger',
      'e-api-pg',
      'e-app-api',
    ]);
    expect(slice.unresolved.map((q: { id: string }) => q.id)).toEqual(['q-m7']);
  });

  it('이번 IR에서 빠진 투영 파일은 지우고 다른 그림의 파일은 둔다', () => {
    const store = new ArchitectureStore(repoRoot);
    const ir = checkoutSequenceIr();
    store.saveViews({ ...ir, projections: [...ir.projections!, refundProjection()] });
    store.saveViews({ ...ir, view: 'deploy-path' });
    store.saveViews(ir);
    const names = readdirSync(join(repoRoot, '.gestalt/architecture/views')).sort();
    expect(names).toEqual(['deploy-path.checkout.json', 'screen-chain.checkout.json']);
  });

  it('투영이 없으면 views 디렉토리를 만들지 않는다', () => {
    const store = new ArchitectureStore(repoRoot);
    const { projections: _drop, ...ir } = checkoutSequenceIr();
    expect(store.saveViews(ir)).toEqual([]);
    expect(existsSync(join(repoRoot, '.gestalt/architecture/views'))).toBe(false);
  });
});

describe('지난 실행의 투영 이어받기', () => {
  it('이번에 안 나온 지난 투영은 가리키는 것이 살아 있으면 남긴다', () => {
    const prev = checkoutSequenceIr();
    prev.projections!.push(refundProjection());
    const merged = mergeWithPrevious(prev, checkoutSequenceIr());
    expect(merged.projections!.map((p) => p.id)).toEqual(['checkout', 'refund']);
    expect(validateArchitectureIr(merged, { checkFiles: false }).ok).toBe(true);
  });

  it('가리키던 노드가 사라진 지난 투영은 버린다', () => {
    const prev = checkoutSequenceIr();
    prev.projections!.push(refundProjection());
    const next = checkoutSequenceIr();
    next.nodes = next.nodes.filter((n) => n.id !== 'app');
    next.edges = next.edges.filter((e) => e.from !== 'app');
    next.projections = undefined;
    const merged = mergeWithPrevious(prev, next);
    expect(merged.projections).toBeUndefined();
  });

  it('지난 투영과 메시지 id가 겹치면 이번 것을 쓴다', () => {
    const prev = checkoutSequenceIr();
    prev.projections![0]!.title = '옛 제목';
    const merged = mergeWithPrevious(prev, checkoutSequenceIr());
    expect(merged.projections!.map((p) => p.title)).toEqual(['결제 승인 순서']);
  });
});

describe('분석 합치기의 투영', () => {
  function withRemote(name: string): ArchitectureIr {
    const ir = checkoutSequenceIr();
    ir.repos = [{ id: 'app', name, root: `/c/${name}`, remote: `git@github.com:acme/${name}.git` }];
    ir.unresolved = [{ id: 'q-m7', subject: { messageId: 'm7' }, question: '돌려주나요?' }];
    return ir;
  }

  it('두 분석의 투영을 나란히 싣고 투영과 메시지 id가 겹치지 않게 바꾼다', () => {
    const result = mergeArchitectureIrs([withRemote('acme-shop'), withRemote('acme-admin')]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const projections = result.ir.projections!;
    expect(projections).toHaveLength(2);
    expect(new Set(projections.map((p) => p.id)).size).toBe(2);
    const messageIds = projections.flatMap((p) => p.messages.map((m) => m.id));
    expect(new Set(messageIds).size).toBe(messageIds.length);
    const nodeIds = new Set(result.ir.nodes.map((n) => n.id));
    const edgeIds = new Set(result.ir.edges.map((e) => e.id));
    for (const m of projections.flatMap((p) => p.messages)) {
      expect(nodeIds.has(m.from) && nodeIds.has(m.to)).toBe(true);
      if (m.edge !== undefined) expect(edgeIds.has(m.edge)).toBe(true);
    }
    const asked = result.ir.unresolved.flatMap((q) =>
      q.subject.messageId !== undefined ? [q.subject.messageId] : [],
    );
    expect(asked).toHaveLength(2);
    for (const id of asked) expect(messageIds).toContain(id);
  });
});
