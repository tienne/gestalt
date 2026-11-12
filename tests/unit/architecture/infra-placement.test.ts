import { describe, expect, it } from 'vitest';
import { resolveInfraPlacement } from '../../../src/architecture/infra-placement.js';
import {
  mergeArchitectureIrs,
  redactForSharing,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { base, node } from '../../fixtures/architecture-categories/common.js';
import { awsIr, gcpIr } from '../../fixtures/architecture-infra/vendors.js';

function irOf(nodes: ArchitectureIr['nodes']): ArchitectureIr {
  return { ...base(['web-product', 'infra']), nodes, edges: [] };
}

describe('resolveInfraPlacement', () => {
  it('provider와 region을 placedIn, parent, account 순으로 물려받는다', () => {
    const p = resolveInfraPlacement([
      node('acct', 'cloud_account', { provider: 'gcp', region: 'asia-northeast3' }),
      node('vpc', 'network', { account: 'acct' }),
      node('sn', 'subnet', { parent: 'vpc' }),
      node('db', 'datastore', { placedIn: 'sn' }),
      node('own', 'datastore', { provider: 'gcp', region: 'asia-northeast3', placedIn: 'sn' }),
    ]);
    for (const id of ['acct', 'vpc', 'sn', 'db', 'own']) {
      expect(p.provider.get(id), id).toBe('gcp');
      expect(p.region.get(id), id).toBe('asia-northeast3');
    }
    expect(p.conflicts).toEqual({ provider: [], region: [] });
  });

  it('조상이 없고 적지도 않았으면 값이 없다', () => {
    const p = resolveInfraPlacement([node('db', 'datastore')]);
    expect(p.provider.has('db')).toBe(false);
    expect(p.region.has('db')).toBe(false);
  });

  it('인프라 레벨 kind가 아닌 노드는 건너뛰고 물려주지도 않는다', () => {
    const p = resolveInfraPlacement([
      node('svc', 'service'),
      node('db', 'datastore', { parent: 'svc' }),
    ]);
    expect(p.provider.has('svc')).toBe(false);
    expect(p.provider.has('db')).toBe(false);
  });

  it('노드에 적은 값이 물려받을 값과 다르면 충돌로 모으고 적은 값을 따른다', () => {
    const p = resolveInfraPlacement([
      node('vpc', 'network', { provider: 'aws', region: 'us-east-1' }),
      node('db', 'datastore', { placedIn: 'vpc', provider: 'azure', region: 'us-east-1' }),
    ]);
    expect(p.provider.get('db')).toBe('azure');
    expect(p.conflicts.provider).toEqual(['db']);
    expect(p.conflicts.region).toEqual([]);
  });

  it('parent 순환이 있어도 멈춘다', () => {
    const p = resolveInfraPlacement([
      node('a', 'subnet', { parent: 'b', provider: 'aws' }),
      node('b', 'subnet', { parent: 'a' }),
    ]);
    expect(p.provider.get('a')).toBe('aws');
  });
});

describe('검증기의 인프라 배치 규칙', () => {
  const validate = (ir: ArchitectureIr) => validateArchitectureIr(ir, { checkFiles: false });

  it('올바른 배치는 오류도 경고도 없다', () => {
    const r = validate(awsIr());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.warnings.filter((w) => w.code === 'INFRA_PLACEMENT_CONFLICT')).toEqual([]);
  });

  it('placedIn이 없는 노드를 가리키면 PLACED_IN_NOT_FOUND다', () => {
    const r = validate(irOf([node('db', 'datastore', { placedIn: 'ghost' })]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContainEqual(
        expect.objectContaining({ code: 'PLACED_IN_NOT_FOUND', nodeId: 'db' }),
      );
    }
  });

  it('placedIn 대상이 network, subnet, cluster가 아니면 INVALID_PLACED_IN_KIND다', () => {
    const r = validate(irOf([node('bk', 'bucket'), node('db', 'datastore', { placedIn: 'bk' })]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContainEqual(
        expect.objectContaining({ code: 'INVALID_PLACED_IN_KIND', nodeId: 'db' }),
      );
    }
  });

  it('network, subnet, cluster는 placedIn 대상이 된다', () => {
    for (const kind of ['network', 'subnet', 'cluster'] as const) {
      const r = validate(
        irOf([node('t', kind, { provider: 'aws' }), node('db', 'datastore', { placedIn: 't' })]),
      );
      const codes = r.ok ? [] : r.errors.map((e) => e.code);
      expect(codes, kind).not.toContain('INVALID_PLACED_IN_KIND');
    }
  });

  it('물려받을 값과 다르면 INFRA_PLACEMENT_CONFLICT 경고를 필드마다 한 건으로 묶어 낸다', () => {
    const r = validate(
      irOf([
        node('vpc', 'network', { provider: 'aws', region: 'us-east-1' }),
        node('db1', 'datastore', { placedIn: 'vpc', provider: 'gcp' }),
        node('db2', 'datastore', { placedIn: 'vpc', provider: 'azure' }),
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const conflicts = r.value.warnings.filter((w) => w.code === 'INFRA_PLACEMENT_CONFLICT');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ field: 'provider', nodeIds: ['db1', 'db2'] });
    }
  });
});

describe('새 필드와 공유본, 병합', () => {
  it('공유본 redactForSharing은 provider, region, exposure, placedIn, engine을 그대로 둔다', () => {
    const ir = awsIr();
    const shared = redactForSharing(ir);
    const pick = (i: ArchitectureIr) =>
      i.nodes.map(({ id, provider, region, exposure, placedIn, engine }) => ({
        id,
        provider,
        region,
        exposure,
        placedIn,
        engine,
      }));
    expect(pick(shared)).toEqual(pick(ir));
  });

  it('공유본은 계정 ID 꼴 region을 가린다', () => {
    const ir = awsIr();
    ir.nodes = ir.nodes.map((n) => (n.id === 'vpc' ? { ...n, region: 'x-123456789012' } : n));
    const shared = redactForSharing(ir);
    expect(JSON.stringify(shared)).not.toMatch(/(?<!\d)\d{12}(?!\d)/);
  });

  it('병합으로 id가 바뀌어도 placedIn이 새 id를 따라가고 검증을 통과한다', () => {
    const r = mergeArchitectureIrs([awsIr(), gcpIr()], { groupNames: ['aws', 'gcp'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.ir.nodes.map((n) => n.id));
    const placed = r.ir.nodes.filter((n) => n.placedIn !== undefined);
    expect(placed.length).toBeGreaterThan(0);
    for (const n of placed) expect(ids.has(n.placedIn!), `${n.id} -> ${n.placedIn}`).toBe(true);
    expect(r.ir.nodes.filter((n) => n.engine === 'ec2')).toHaveLength(1);
    expect(validateArchitectureIr(r.ir, { checkFiles: false }).ok).toBe(true);
  });
});
