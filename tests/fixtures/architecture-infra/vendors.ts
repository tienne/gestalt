import type { ArchitectureIr, ArchitectureNode } from '../../../src/architecture/index.js';
import { base, edge, node } from '../architecture-categories/common.js';

// 벤더별 인프라 IR. 이름과 계정 ID는 전부 가짜다
export const ACCOUNT_ID = '123456789012';

function ir(nodes: ArchitectureNode[], edges: ArchitectureIr['edges']): ArchitectureIr {
  return { ...base(['web-product', 'infra']), nodes, edges };
}

export function awsIr(): ArchitectureIr {
  return ir(
    [
      node('acct', 'cloud_account', {
        label: ACCOUNT_ID,
        displayName: 'acme-prod',
        provider: 'aws',
      }),
      node('vpc', 'network', { provider: 'aws', region: 'ap-northeast-2', account: 'acct' }),
      node('sn-pub', 'subnet', { parent: 'vpc', exposure: 'public' }),
      node('sn-prv', 'subnet', { parent: 'vpc', exposure: 'private' }),
      node('lb', 'deploy_target', { placedIn: 'sn-pub', engine: 'ec2' }),
      node('api', 'deploy_target', { placedIn: 'sn-prv', engine: 'lambda' }),
      node('db', 'datastore', { placedIn: 'sn-prv', engine: 'postgres' }),
      node('assets', 'bucket', { provider: 'aws', region: 'ap-northeast-2' }),
      node('cdn', 'cdn', { provider: 'aws', region: 'ap-northeast-2' }),
      node('dns', 'domain', { provider: 'aws' }),
    ],
    [
      edge('e-dns-cdn', 'dns', 'cdn', 'routes'),
      edge('e-cdn-lb', 'cdn', 'lb', 'routes'),
      edge('e-lb-api', 'lb', 'api', 'connects'),
      edge('e-api-db', 'api', 'db', 'connects'),
      edge('e-cdn-assets', 'cdn', 'assets', 'serves'),
    ],
  );
}

export function gcpIr(): ArchitectureIr {
  return ir(
    [
      node('vpc', 'network', { provider: 'gcp' }),
      node('sn', 'subnet', { parent: 'vpc', region: 'asia-northeast3' }),
      node('svc', 'deploy_target', { placedIn: 'sn', engine: 'compute-engine' }),
      node('run', 'deploy_target', {
        provider: 'gcp',
        region: 'asia-northeast3',
        engine: 'cloud-run',
      }),
      node('store', 'bucket', { provider: 'gcp', region: 'asia-northeast3' }),
      node('dns', 'domain', { provider: 'gcp' }),
    ],
    [
      edge('e-dns-svc', 'dns', 'svc', 'routes'),
      edge('e-svc-run', 'svc', 'run', 'connects'),
      edge('e-run-store', 'run', 'store', 'connects'),
    ],
  );
}

export function azureIr(): ArchitectureIr {
  return ir(
    [
      node('vnet', 'network', { provider: 'azure', region: 'koreacentral' }),
      node('sn', 'subnet', { parent: 'vnet' }),
      node('app', 'deploy_target', { placedIn: 'sn', engine: 'app-service' }),
      node('fd', 'cdn', { provider: 'azure' }),
      node('dns', 'domain', { provider: 'azure' }),
    ],
    [edge('e-dns-fd', 'dns', 'fd', 'routes'), edge('e-fd-app', 'fd', 'app', 'routes')],
  );
}
