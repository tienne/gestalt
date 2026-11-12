import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  renderDrilldownHtml,
  shouldDrillDown,
  validateArchitectureIr,
  type ArchitectureIr,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import type { IconSet } from '../../../src/architecture/vendor-icons.js';
import { infraIr } from '../../fixtures/architecture-categories/infra.js';
import { node } from '../../fixtures/architecture-categories/common.js';
import { ACCOUNT_ID, awsIr, azureIr, gcpIr } from '../../fixtures/architecture-infra/vendors.js';

function validated(ir: ArchitectureIr): ValidatedIr {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const FALLBACK_ONLY: IconSet = { icons: {}, stats: { official: 0, fallback: 0 } };
const PIXEL = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
const officialSet = (keys: string[]): IconSet => ({
  icons: Object.fromEntries(keys.map((k) => [k, { source: 'official' as const, dataUri: PIXEL }])),
  stats: { official: keys.length, fallback: 0 },
});

async function render(
  ir: ArchitectureIr,
  audience: 'private' | 'shared',
  icons?: IconSet,
): Promise<string> {
  const v = validated(ir);
  const d = await computeDrilldown(v);
  return renderDrilldownHtml(v, d, { audience, ...(icons !== undefined ? { icons } : {}) });
}

const infraSection = (html: string): string => {
  const start = html.indexOf('class="level infra-level"');
  if (start < 0) return '';
  return html.slice(start, html.indexOf('</section>', start));
};

describe('인프라 레벨 생성 조건', () => {
  it('provider, region, exposure, placedIn 중 하나라도 적으면 레벨이 생긴다', async () => {
    for (const build of [awsIr, gcpIr, azureIr]) {
      const d = await computeDrilldown(validated(build()));
      expect(d.levels.map((l) => l.id)).toContain('infra');
      expect(d.levels.find((l) => l.id === 'infra')!.kind).toBe('infra');
    }
    const onlyRegion = awsIr();
    onlyRegion.nodes = [node('db', 'datastore', { region: 'us-east-1' })];
    onlyRegion.edges = [];
    expect((await computeDrilldown(validated(onlyRegion))).levels.map((l) => l.id)).toContain(
      'infra',
    );
  });

  it('새 필드가 하나도 없으면 인프라 kind 노드가 있어도 레벨이 없다', async () => {
    const legacy = awsIr();
    legacy.nodes = legacy.nodes.map(
      ({ provider: _p, region: _r, exposure: _e, placedIn: _pi, ...n }) => n,
    );
    const d = await computeDrilldown(validated(legacy));
    expect(d.levels.map((l) => l.id)).not.toContain('infra');
    expect(Object.values(d.enter)).not.toContain('infra');
    expect(shouldDrillDown(validated(legacy))).toBe(false);
  });

  it('새 필드를 안 쓰는 기존 infra IR은 레벨이 안 붙는다', async () => {
    const d = await computeDrilldown(validated(infraIr()));
    expect(d.levels.map((l) => l.id)).not.toContain('infra');
  });

  it('인프라 레벨이 있으면 service가 없어도 드릴다운으로 그린다', () => {
    expect(awsIr().nodes.some((n) => n.kind === 'service')).toBe(false);
    expect(shouldDrillDown(validated(awsIr()))).toBe(true);
  });

  it('prod가 아닌 환경 노드는 레벨에서 뺀다', async () => {
    const ir = awsIr();
    ir.nodes.push(
      node('db-dev', 'datastore', { placedIn: 'sn-prv', engine: 'postgres', environment: 'dev' }),
      node('db-prod', 'datastore', { placedIn: 'sn-prv', engine: 'postgres', environment: 'prod' }),
    );
    const level = (await computeDrilldown(validated(ir))).levels.find((l) => l.id === 'infra')!;
    expect(level.nodeIds).toContain('db-prod');
    expect(level.nodeIds).not.toContain('db-dev');
  });

  it('prod가 아닌 자리에 든 노드는 환경을 안 적어도 레벨에서 뺀다', async () => {
    const ir = awsIr();
    ir.nodes.push(
      node('vpc-stage', 'network', {
        provider: 'aws',
        region: 'ap-northeast-2',
        account: 'acct',
        environment: 'stage',
      }),
      node('sn-stage', 'subnet', { parent: 'vpc-stage', exposure: 'private' }),
      node('api-stage', 'deploy_target', { placedIn: 'sn-stage', engine: 'lambda' }),
    );
    const level = (await computeDrilldown(validated(ir))).levels.find((l) => l.id === 'infra')!;
    expect(level.nodeIds).toContain('vpc');
    expect(level.nodeIds).toContain('api');
    for (const id of ['vpc-stage', 'sn-stage', 'api-stage'])
      expect(level.nodeIds).not.toContain(id);
  });

  it('레벨의 노드는 id 순으로 정렬돼 있고 이 레벨 안 노드끼리의 선만 싣는다', async () => {
    const ir = awsIr();
    ir.nodes.push(node('svc', 'service'));
    const level = (await computeDrilldown(validated(ir))).levels.find((l) => l.id === 'infra')!;
    expect(level.nodeIds).toEqual([...level.nodeIds].sort());
    expect(level.nodeIds).not.toContain('svc');
    const ids = new Set(level.nodeIds);
    expect(level.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(level.edges.length).toBe(level.infra!.edges.length);
  });
});

describe('인프라 레벨 enter', () => {
  it('레벨에 선 노드는 모두 infra 레벨로 들어간다', async () => {
    const d = await computeDrilldown(validated(awsIr()));
    const level = d.levels.find((l) => l.id === 'infra')!;
    for (const id of level.nodeIds) expect(d.enter[id]).toBe('infra');
  });

  it('서비스 사슬로 가는 기존 enter는 그대로 둔다', async () => {
    const ir = awsIr();
    ir.nodes.push(node('svc', 'service'));
    const d = await computeDrilldown(validated(ir));
    expect(d.enter['svc']).not.toBe('infra');
  });

  it('루트 그림에 인프라 구성 카드가 서고 벤더 이름을 적는다', async () => {
    const html = await render(awsIr(), 'private');
    expect(html).toContain('인프라 구성');
    expect(html).toContain('data-level-id="infra"');
    expect(html).toMatch(/AWS/);
  });
});

describe('인프라 레벨 렌더', () => {
  it('같은 입력과 같은 아이콘 세트면 바이트까지 같다', async () => {
    const icons = officialSet(['aws:Lambda']);
    expect(await render(awsIr(), 'private', icons)).toBe(await render(awsIr(), 'private', icons));
    expect(await render(awsIr(), 'shared', icons)).toBe(await render(awsIr(), 'shared', icons));
  });

  it('인프라 레벨이 없는 그림에는 인프라 표식이 하나도 안 붙는다', async () => {
    const html = await render(infraIr(), 'private', FALLBACK_ONLY);
    expect(html).not.toContain('data-icons=');
    expect(html).not.toContain('infra-level');
    expect(html).not.toContain('u-cloud');
    expect(html).not.toContain('infra-credit');
  });

  it('루트 html에 data-icons로 공식과 대체 아이콘 수를 적는다', async () => {
    const k = ['aws:Lambda', 'aws:CloudFront'];
    const withOfficial = await render(awsIr(), 'private', officialSet(k));
    const official = (withOfficial.match(/data-icons="official:(\d+) fallback:(\d+)"/) ?? []).slice(
      1,
    );
    expect(Number(official[0])).toBeGreaterThanOrEqual(2);
    // 인프라 레벨의 아이콘 키 수와 합이 같다
    const d = await computeDrilldown(validated(awsIr()));
    const keys = d.levels.find((l) => l.id === 'infra')!.infra!.iconKeys;
    expect(Number(official[0]) + Number(official[1])).toBe(keys.length);

    const none = await render(awsIr(), 'private');
    expect(none).toMatch(new RegExp(`data-icons="official:0 fallback:${keys.length}"`));
  });

  it('공식 아이콘이 있으면 img data URI와 출처 줄이 서고 없으면 내장 아이콘만 쓴다', async () => {
    const withOfficial = infraSection(
      await render(awsIr(), 'private', officialSet(['aws:Lambda'])),
    );
    expect(withOfficial).toContain(`<img src="${PIXEL}"`);
    expect(withOfficial).toContain('AWS Architecture Icons');
    expect(withOfficial).toContain('상표는 각 소유자의 것');
    const without = infraSection(await render(awsIr(), 'private'));
    expect(without).not.toContain('<img');
    expect(without).not.toContain('infra-credit');
    expect(without).toContain('u-cloud');
  });

  it('AWS 공식 서비스 아이콘은 bare 타일이고 GCP는 흰 타일이다', async () => {
    const aws = infraSection(await render(awsIr(), 'private', officialSet(['aws:Lambda'])));
    expect(aws).toMatch(/class="tile bare"/);
    const gcp = infraSection(await render(gcpIr(), 'private', officialSet(['gcp:Cloud Run'])));
    expect(gcp).toContain('<img');
    expect(gcp).not.toMatch(/class="tile bare"/);
  });

  it('박스 라벨은 노드 서랍을 열도록 data-node-id를 단다', async () => {
    const section = infraSection(await render(awsIr(), 'private'));
    for (const id of ['acct', 'vpc', 'sn-pub', 'sn-prv']) {
      expect(section).toMatch(new RegExp(`<span class="g-label[^"]*" data-node-id="${id}"`));
    }
  });

  it('원본과 공유본이 같은 아이콘 세트를 받으면 인프라 레벨 그림이 같다', async () => {
    const icons = officialSet(['aws:Lambda', 'aws:CloudFront']);
    const priv = await render(awsIr(), 'private', icons);
    const shared = await render(awsIr(), 'shared', icons);
    expect(priv.match(/data-icons="[^"]+"/)?.[0]).toBe(shared.match(/data-icons="[^"]+"/)?.[0]);
    const sizes = (h: string): string[] =>
      [...h.matchAll(/class="group [^"]+" [^>]*style="([^"]+)"/g)].map((m) => m[1]!);
    expect(sizes(shared)).toEqual(sizes(priv));
  });
});

describe('shared 렌더 공개 범위', () => {
  const ID12 = /(?<!\d)\d{12}(?!\d)/;
  function leakyIr(): ArchitectureIr {
    const ir = awsIr();
    ir.nodes = ir.nodes.map((n) =>
      n.id === 'acct'
        ? (({ displayName: _d, ...rest }) => rest)(n)
        : n.id === 'vpc'
          ? { ...n, label: `vpc-${ACCOUNT_ID}`, region: `ap-${ACCOUNT_ID}` }
          : n.id === 'db'
            ? { ...n, label: `db-${ACCOUNT_ID}`, displayName: `메인 ${ACCOUNT_ID}` }
            : n,
    );
    return ir;
  }

  it('원본에는 계정 ID가 그대로 있다(검증 전제)', async () => {
    const section = infraSection(await render(leakyIr(), 'private'));
    expect(section).toMatch(ID12);
  });

  it('공유본 인프라 레벨에는 12자리 계정 ID가 어디에도 안 남는다', async () => {
    const section = infraSection(await render(leakyIr(), 'shared', officialSet(['aws:Lambda'])));
    expect(section).not.toBe('');
    expect(section).not.toMatch(ID12);
  });

  it('박스 라벨, data-box-id, aria-label, title 속성에서 모두 가려진다', async () => {
    const section = infraSection(await render(leakyIr(), 'shared'));
    const attrs = [...section.matchAll(/(?:aria-label|title|data-box-id)="([^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(attrs.length).toBeGreaterThan(5);
    for (const a of attrs) expect(a).not.toMatch(ID12);
    const labels = [...section.matchAll(/<span class="g-label[^>]*>.*?<\/span><\/span>/g)].map(
      (m) => m[0],
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l).not.toMatch(ID12);
  });

  it('타일 aria-label 끝에 담은 박스 이름이 붙고 공유본에서는 그 이름도 가려진다', async () => {
    const tileAria = (h: string): string[] =>
      [...h.matchAll(/class="node inode[^"]*"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]!);
    const priv = tileAria(infraSection(await render(leakyIr(), 'private')));
    const shared = tileAria(infraSection(await render(leakyIr(), 'shared')));
    const inBox = shared.filter((a) => a.endsWith(' 안'));
    expect(inBox.length).toBeGreaterThan(0);
    expect(inBox.length).toBe(priv.filter((a) => a.endsWith(' 안')).length);
    for (const a of shared) expect(a).not.toMatch(ID12);
  });

  it('공유본 전체 HTML에도 계정 ID가 남지 않는다', async () => {
    const html = await render(leakyIr(), 'shared');
    expect(html).not.toMatch(ID12);
  });

  it('공유본에서도 구조(박스 개수, 타일 개수)는 원본과 같다', async () => {
    const count = (h: string, re: RegExp): number => (h.match(re) ?? []).length;
    const priv = infraSection(await render(leakyIr(), 'private'));
    const shared = infraSection(await render(leakyIr(), 'shared'));
    expect(count(shared, /class="group /g)).toBe(count(priv, /class="group /g));
    expect(count(shared, /class="node inode/g)).toBe(count(priv, /class="node inode/g));
  });
});
