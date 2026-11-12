import type { CloudProvider, NodeKind } from './types.js';

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 이름 안에 이 글자가 있으면 그 제품이다. 관리형 이름이 붙어도(aurora-mysql) 잡게 앞에서부터 본다 */
const DATASTORE_ICONS: Record<CloudProvider, readonly [string, string][]> = {
  aws: [
    ['aurora', 'Aurora'],
    ['mariadb', 'RDS'],
    ['mysql', 'RDS'],
    ['postgres', 'RDS'],
    ['rds', 'RDS'],
    ['redis', 'ElastiCache'],
    ['valkey', 'ElastiCache'],
    ['memcache', 'ElastiCache'],
    ['elasticache', 'ElastiCache'],
    ['dynamo', 'DynamoDB'],
    ['documentdb', 'DocumentDB'],
    ['docdb', 'DocumentDB'],
    ['opensearch', 'opensearch'],
    ['elasticsearch', 'opensearch'],
  ],
  gcp: [
    ['alloydb', 'AlloyDB'],
    ['spanner', 'Spanner'],
    ['bigquery', 'BigQuery'],
    ['bigtable', 'Bigtable'],
    ['firestore', 'Firestore'],
    ['memorystore', 'Memorystore'],
    ['redis', 'Memorystore'],
    ['memcache', 'Memorystore'],
    ['mysql', 'Cloud SQL'],
    ['postgres', 'Cloud SQL'],
    ['sqlserver', 'Cloud SQL'],
    ['cloudsql', 'Cloud SQL'],
    ['datastore', 'Datastore'],
  ],
  azure: [
    ['cosmos', 'cosmos'],
    ['redis', 'redis'],
    ['postgres', 'postgres'],
    ['mysql', 'mysql'],
    ['sqlserver', 'SQL-Database'],
    ['mssql', 'SQL-Database'],
    ['sqldatabase', 'SQL-Database'],
  ],
};

/** deploy_target과 cluster의 engine. 정규화한 값과 정확히 같아야 한다 */
const ENGINE_ICONS: Record<CloudProvider, Record<string, string>> = {
  aws: {
    lambda: 'Lambda',
    fargate: 'Fargate',
    ec2: 'EC2',
    ecs: 'ecs',
    eks: 'eks',
    apprunner: 'App-Runner',
    beanstalk: 'Elastic-Beanstalk',
    elasticbeanstalk: 'Elastic-Beanstalk',
  },
  gcp: {
    cloudrun: 'Cloud Run',
    run: 'Cloud Run',
    appengine: 'App Engine',
    computeengine: 'Compute Engine',
    gce: 'Compute Engine',
    vm: 'Compute Engine',
    cloudfunctions: 'Cloud Functions',
    functions: 'Cloud Functions',
    gke: 'GKE',
  },
  azure: {
    appservice: 'webapp',
    webapp: 'webapp',
    functions: 'functions',
    azurefunctions: 'functions',
    containerapps: 'containerapps',
    containerapp: 'containerapps',
    vm: 'vm',
    aks: 'aks',
    staticwebapps: 'staticwebapps',
    staticwebapp: 'staticwebapps',
  },
};

const KIND_ICONS: Record<CloudProvider, Partial<Record<NodeKind, string>>> = {
  aws: {
    cdn: 'CloudFront',
    domain: 'Route-53',
    bucket: 's3',
    network: 'vpc',
    firewall: 'WAF',
    cluster: 'eks',
    cloud_account: 'AWS-Cloud-logo',
  },
  gcp: {
    cdn: 'Cloud CDN',
    domain: 'Cloud DNS',
    bucket: 'Cloud Storage',
    network: 'VPC',
    firewall: 'Cloud Armor',
    cluster: 'GKE',
    workload: 'Compute Engine',
    cloud_account: 'google-cloud',
  },
  azure: {
    cdn: 'frontdoor',
    domain: 'dns',
    bucket: 'storage',
    network: 'vnet',
    subnet: 'Subnet',
    firewall: 'nsg',
    cluster: 'aks',
    workload: 'containerapps',
    cloud_account: 'Azure-A',
  },
};

/** 박스 라벨 아이콘. AWS만 리전과 서브넷 그룹 아이콘이 따로 있다 */
export const BOX_ICONS = {
  aws: {
    cloud: 'AWS-Cloud-logo',
    region: 'Region',
    public: 'Public-subnet',
    private: 'Private-subnet',
  },
  gcp: { cloud: 'google-cloud' },
  azure: { cloud: 'Azure-A' },
} as const;

export function iconKey(vendor: CloudProvider, name: string): string {
  return `${vendor}:${name}`;
}

/** 노드 하나의 공식 아이콘 키. 표에 없으면 undefined이고 그 노드는 내장 선 아이콘으로 선다 */
export function vendorIconKey(
  vendor: CloudProvider,
  node: { kind: NodeKind; label: string; engine?: string },
): string | undefined {
  let name: string | undefined;
  if (node.kind === 'datastore') {
    const text = norm(node.engine ?? node.label);
    name = DATASTORE_ICONS[vendor].find(([needle]) => text.includes(needle))?.[1];
  } else if (node.kind === 'deploy_target' || node.kind === 'cluster') {
    name = node.engine !== undefined ? ENGINE_ICONS[vendor][norm(node.engine)] : undefined;
    if (name === undefined && node.kind === 'cluster') name = KIND_ICONS[vendor].cluster;
  } else {
    name = KIND_ICONS[vendor][node.kind];
  }
  return name !== undefined ? iconKey(vendor, name) : undefined;
}

export function splitKey(key: string): [CloudProvider | undefined, string] {
  const at = key.indexOf(':');
  const vendor = key.slice(0, at);
  const name = key.slice(at + 1);
  return vendor === 'aws' || vendor === 'gcp' || vendor === 'azure'
    ? [vendor, name]
    : [undefined, name];
}
