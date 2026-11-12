import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { log } from '../core/log.js';
import type { CloudProvider, NodeKind } from './types.js';

/**
 * 클라우드 벤더 공식 아이콘. 벤더가 배포하는 패키지에서 필요한 SVG만 풀어 홈 캐시에 두고
 * 렌더는 캐시에서 읽은 data URI만 쓴다. 받지 못하면 언제나 내장 선 아이콘으로 돌아간다.
 * 이름 해석과 패키지 주소는 stack-diagram의 fetch_icons.py를 옮겼다.
 */

export type IconMode = 'auto' | 'offline' | 'off';

export type IconEntry = { source: 'official'; dataUri: string } | { source: 'fallback' };

export interface IconStats {
  official: number;
  fallback: number;
}

export interface IconSet {
  /** iconKey → 아이콘. 요청에 없던 키는 없다 */
  icons: Record<string, IconEntry>;
  stats: IconStats;
}

export interface ResolveVendorIconsOptions {
  cacheDir: string;
  mode?: IconMode;
  fetchImpl?: typeof fetch;
  /** 패키지 안내 페이지 하나를 받는 제한 시간 */
  pageTimeoutMs?: number;
  /** zip 패키지 하나를 받는 제한 시간. 패키지가 수십 MB라 페이지보다 길게 둔다 */
  packageTimeoutMs?: number;
  /** 캐시 기록에 남길 시각. 테스트가 고정한다 */
  now?: () => Date;
}

export const ICON_MODE_ENV = 'GESTALT_ARCH_ICONS';

export function iconModeFromEnv(): IconMode {
  const raw = process.env[ICON_MODE_ENV];
  return raw === 'offline' || raw === 'off' ? raw : 'auto';
}

// ── 패키지 출처 (fetch_icons.py) ──

const USER_AGENT = 'Mozilla/5.0 (compatible; gestalt-architecture)';
const AWS_ICONS_PAGE = 'https://aws.amazon.com/architecture/icons/';
const AWS_PACKAGE_RE =
  /(?:https:)?\/\/[\w.-]+\.awsstatic\.com\/[^"'\s]+\/Icon-package_[^"'\s/]+\.zip/;
const AWS_ICON_RE =
  /^(?:Architecture-Service-Icons_[^/]+\/[^/]+\/64\/Arch_(.+)_64\.svg|Architecture-Group-Icons_[^/]+\/(.+)_32\.svg|Resource-Icons_[^/]+\/Res_General-Icons\/Res_48_Light\/Res_(.+)_48_Light\.svg)$/;
const AWS_ALIASES: Record<string, string> = {
  s3: 'Amazon-Simple-Storage-Service',
  glacier: 'Amazon-Simple-Storage-Service-Glacier',
  sqs: 'Amazon-Simple-Queue-Service',
  sns: 'Amazon-Simple-Notification-Service',
  ses: 'Amazon-Simple-Email-Service',
  ecs: 'Amazon-Elastic-Container-Service',
  eks: 'Amazon-Elastic-Kubernetes-Service',
  ecr: 'Amazon-Elastic-Container-Registry',
  elb: 'Elastic-Load-Balancing',
  alb: 'Elastic-Load-Balancing',
  nlb: 'Elastic-Load-Balancing',
  iam: 'AWS-Identity-and-Access-Management',
  kms: 'AWS-Key-Management-Service',
  msk: 'Amazon-Managed-Streaming-for-Apache-Kafka',
  opensearch: 'Amazon-OpenSearch-Service',
  vpc: 'Virtual-private-cloud-VPC',
};

const GCP_PACKAGES = [
  'https://services.google.com/fh/files/misc/core-products-icons.zip',
  'https://services.google.com/fh/files/misc/category-icons.zip',
] as const;
const GCP_ICON_RE = /^(?:Unique|Category) Icons\/([^/]+)\/SVG\/[^/]+\.svg$/;
// 아이콘 폴더 → 제품. 지도 인프라 레벨에 서는 제품이 든 줄만 옮겼다. 맨 "SQL" 줄은 원본처럼 뺀다
const GCP_PRODUCTS: Record<string, string> = {
  Compute:
    'Batch, Container Optimized OS, GCE Systems Management, Migrate To Virtual Machines, OS Config Management, OS Inventory Management, OS Patch Management, VMware Engine',
  Containers: 'Backup for GKE, Knative serving, Migrate To Containers',
  Databases:
    'Bare Metal Solution, Bigtable, Database Center, Database Migration Service, Datastore, Firestore, Memorystore',
  Networking:
    'Cloud Armor, Cloud CDN, Cloud DNS, Cloud Domains, Cloud Firewall Rules, Cloud IDS, Cloud Interconnect, Cloud Load Balancing, Load Balancer, Cloud NAT, Cloud Network, Cloud Router, Cloud VPN, Connectivity Test, Data Transfer, Network Connectivity Center, Network Intelligence Center, Network Security, Network Tiers, Network Topology, Packet Mirroring, Partner Interconnect, Premium Network Tier, Private Connectivity, Private Service Connect, Routes, Service Mesh, Virtual Private Cloud, VPC',
  'Serverless Computing': 'Serverless, App Engine, Cloud Functions, Cloud Run functions',
  Storage:
    'Filestore, Google Cloud NetApp Volumes, Local SSD, Parallelstore, Storage Transfer Service',
  AlloyDB: 'AlloyDB Omni',
  BigQuery: 'BigQuery Functions, BigQuery Omni',
  'Cloud Spanner': 'Spanner',
  'Cloud Storage': 'GCS',
  'Compute Engine': 'GCE',
  GKE: 'Google Kubernetes Engine, Kubernetes Engine',
  Hyperdisk: 'Persistent Disk',
};

const AZURE_ICONS_PAGE = 'https://learn.microsoft.com/en-us/azure/architecture/icons/';
const AZURE_PACKAGE_RE =
  /https:\/\/arch-center\.azureedge\.net\/icons\/Azure_Public_Service_Icons_V\d+\.zip/;
const AZURE_ICON_RE = /^Azure_Public_Service_Icons\/Icons\/[^/]+\/\d+\s*-icon-service-(.+)\.svg$/;
const AZURE_ALIASES: Record<string, string> = {
  webapp: 'App-Services',
  functions: 'Function-Apps',
  azurefunctions: 'Function-Apps',
  aks: 'Kubernetes-Services',
  vm: 'Virtual-Machine',
  vmss: 'VM-Scale-Sets',
  containerapp: 'Container-Apps-Environments',
  containerapps: 'Container-Apps-Environments',
  acr: 'Container-Registries',
  aci: 'Container-Instances',
  staticwebapp: 'Static-Apps',
  staticwebapps: 'Static-Apps',
  frontdoor: 'Front-Door-and-CDN-Profiles',
  appgateway: 'Application-Gateways',
  lb: 'Load-Balancers',
  vnet: 'Virtual-Networks',
  nsg: 'Network-Security-Groups',
  waf: 'Web-Application-Firewall-Policies(WAF)',
  dns: 'DNS-Zones',
  expressroute: 'ExpressRoute-Circuits',
  trafficmanager: 'Traffic-Manager-Profiles',
  vpngateway: 'Virtual-Network-Gateways',
  storage: 'Storage-Accounts',
  blob: 'Storage-Accounts',
  blobstorage: 'Storage-Accounts',
  cosmos: 'Azure-Cosmos-DB',
  redis: 'Azure-Managed-Redis',
  managedredis: 'Azure-Managed-Redis',
  postgres: 'Azure-Database-PostgreSQL-Server',
  postgresql: 'Azure-Database-PostgreSQL-Server',
  mysql: 'Azure-Database-MySQL-Server',
  eventgrid: 'Event-Grid-Topics',
  apim: 'API-Management-Services',
  apimanagement: 'API-Management-Services',
  foundry: 'AI-Foundry',
  aisearch: 'Cognitive-Search',
  search: 'Cognitive-Search',
  appinsights: 'Application-Insights',
  loganalytics: 'Log-Analytics-Workspaces',
  datafactory: 'Data-Factories',
  synapse: 'Azure-Synapse-Analytics',
  resourcegroup: 'Resource-Groups',
  rg: 'Resource-Groups',
  managedidentity: 'Managed-Identities',
};

/** 아이콘 출처 표기. 상표는 각 소유자의 것이다 */
export const ICON_CREDITS: Record<CloudProvider, string> = {
  aws: 'AWS Architecture Icons',
  gcp: 'Google Cloud product icons',
  azure: 'Azure Public Service Icons',
};

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── 노드 → 아이콘 이름 ──

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

// ── 패키지 색인 ──

interface PackageIndex {
  /** 정규화 이름 → [zip 안 경로, 패키지 주소]. 파일 이름순으로 먼저 본 것을 남긴다 */
  index: Map<string, { member: string; pkg: string }>;
  /** 패키지 주소 → zip 바이트 */
  zips: Map<string, Uint8Array>;
  /** gcp만. 정규화 제품 이름 → 정규화 폴더 이름 */
  targets?: Map<string, string>;
}

function listMembers(zip: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(zip, {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  return names.sort();
}

function lookup(vendor: CloudProvider, pkg: PackageIndex, query: string): string | undefined {
  const { index } = pkg;
  const keys = [...index.keys()];
  if (vendor === 'aws') {
    const q = norm(AWS_ALIASES[norm(query)] ?? query);
    return index.has(q) ? q : keys.find((k) => k.replace(/^(aws|amazon)/, '') === q);
  }
  if (vendor === 'azure') {
    const q = norm(AZURE_ALIASES[norm(query)] ?? query);
    const short = (s: string): string => s.replace(/^(azure|microsoft)|s$/g, '');
    return index.has(q) ? q : keys.find((k) => short(k) === short(q));
  }
  const targets = pkg.targets!;
  const q = norm(query);
  const hit =
    targets.get(q) ??
    [...targets.entries()].find(([k]) => k.replace(/^(google|cloud)+/, '') === q)?.[1];
  return hit !== undefined && index.has(hit) ? hit : undefined;
}

// ── 캐시 ──

interface ManifestEntry {
  /** 캐시 안 파일 이름. 없으면 패키지에 그 이름이 없었다 */
  file?: string;
  member?: string;
  package?: string;
  fetchedAt: string;
}

interface Manifest {
  version: 1;
  icons: Record<string, ManifestEntry>;
}

function readManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return { version: 1, icons: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
    return { version: 1, icons: parsed.icons ?? {} };
  } catch {
    return { version: 1, icons: {} };
  }
}

function writeManifest(dir: string, manifest: Manifest): void {
  const sorted = Object.fromEntries(
    Object.keys(manifest.icons)
      .sort()
      .map((k) => [k, manifest.icons[k]!]),
  );
  // 다른 렌더가 같은 홈 캐시를 동시에 읽어도 반쯤 쓴 파일을 보지 않게 바꿔치기로 쓴다
  const tmp = join(dir, `manifest.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ version: 1, icons: sorted }, null, 2)}\n`);
  renameSync(tmp, join(dir, 'manifest.json'));
}

const MAX_SVG_BYTES = 256 * 1024;

function looksSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 200)).toString('utf8').trimStart();
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!DOC');
}

function readCached(dir: string, entry: ManifestEntry | undefined): string | undefined {
  if (entry?.file === undefined) return undefined;
  const path = join(dir, entry.file);
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  if (bytes.length > MAX_SVG_BYTES || !looksSvg(bytes)) return undefined;
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
}

// ── 받기 ──

async function getBytes(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`${url} 응답 ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function packageFromPage(
  fetchImpl: typeof fetch,
  page: string,
  re: RegExp,
  opts: { page: number; pkg: number },
): Promise<{ url: string; zip: Uint8Array }> {
  const html = Buffer.from(await getBytes(fetchImpl, page, opts.page)).toString('utf8');
  const link = re.exec(html);
  if (!link) throw new Error(`${page}에서 아이콘 패키지 링크를 못 찾았다`);
  const url = new URL(link[0], page).toString();
  return { url, zip: await getBytes(fetchImpl, url, opts.pkg) };
}

async function loadPackage(
  vendor: CloudProvider,
  fetchImpl: typeof fetch,
  timeouts: { page: number; pkg: number },
): Promise<PackageIndex> {
  const index = new Map<string, { member: string; pkg: string }>();
  const zips = new Map<string, Uint8Array>();
  if (vendor === 'gcp') {
    for (const url of GCP_PACKAGES) {
      const zip = await getBytes(fetchImpl, url, timeouts.pkg);
      zips.set(url, zip);
      for (const f of listMembers(zip)) {
        const m = GCP_ICON_RE.exec(f);
        if (m) index.set(norm(m[1]!), { member: f, pkg: url });
      }
    }
    const targets = new Map<string, string>([...index.keys()].map((k) => [k, k]));
    for (const [folder, products] of Object.entries(GCP_PRODUCTS)) {
      for (const p of products.split(', ')) targets.set(norm(p), norm(folder));
    }
    return { index, zips, targets };
  }
  const { url, zip } =
    vendor === 'aws'
      ? await packageFromPage(fetchImpl, AWS_ICONS_PAGE, AWS_PACKAGE_RE, timeouts)
      : await packageFromPage(fetchImpl, AZURE_ICONS_PAGE, AZURE_PACKAGE_RE, timeouts);
  zips.set(url, zip);
  for (const f of listMembers(zip)) {
    if (vendor === 'aws') {
      const m = AWS_ICON_RE.exec(f);
      if (!m) continue;
      // General- 접두는 General-Shield가 AWS-Shield의 짧은 이름을 가로채지 않게 한다
      const name = m[1] ?? m[2] ?? `General-${m[3]!}`;
      const key = norm(name);
      if (!index.has(key)) index.set(key, { member: f, pkg: url });
    } else {
      const m = AZURE_ICON_RE.exec(f);
      if (!m) continue;
      const key = norm(m[1]!);
      if (!index.has(key)) index.set(key, { member: f, pkg: url });
    }
  }
  return { index, zips };
}

function cacheFileName(name: string): string {
  return `${norm(name) || 'icon'}.svg`;
}

/** 패키지를 받아 이번에 필요한 아이콘만 캐시에 쓴다. 이름이 패키지에 없으면 그 사실도 적어 다음에 다시 받지 않는다 */
async function fetchVendor(
  vendor: CloudProvider,
  names: readonly string[],
  dir: string,
  manifest: Manifest,
  opts: Required<Pick<ResolveVendorIconsOptions, 'pageTimeoutMs' | 'packageTimeoutMs'>> & {
    fetchImpl: typeof fetch;
    now: () => Date;
  },
): Promise<void> {
  const pkg = await loadPackage(vendor, opts.fetchImpl, {
    page: opts.pageTimeoutMs,
    pkg: opts.packageTimeoutMs,
  });
  const fetchedAt = opts.now().toISOString();
  const wanted = new Map<string, string[]>();
  for (const name of names) {
    const key = lookup(vendor, pkg, name);
    if (key === undefined) {
      log(`architecture: ${vendor} 아이콘 패키지에 "${name}"이 없어 내장 아이콘을 쓴다`);
      manifest.icons[iconKey(vendor, name)] = { fetchedAt };
      continue;
    }
    const { member } = pkg.index.get(key)!;
    wanted.set(member, [...(wanted.get(member) ?? []), name]);
  }
  const vendorDir = join(dir, vendor);
  mkdirSync(vendorDir, { recursive: true });
  const pkgOf = new Map([...pkg.index.values()].map((v) => [v.member, v.pkg]));
  for (const [url, zip] of pkg.zips) {
    const files = unzipSync(zip, {
      filter: (f) =>
        wanted.has(f.name) && pkgOf.get(f.name) === url && f.originalSize <= MAX_SVG_BYTES,
    });
    for (const [member, bytes] of Object.entries(files)) {
      if (!looksSvg(bytes)) continue;
      for (const name of wanted.get(member) ?? []) {
        const file = `${vendor}/${cacheFileName(name)}`;
        writeFileSync(join(dir, file), bytes);
        manifest.icons[iconKey(vendor, name)] = { file, member, package: url, fetchedAt };
      }
    }
  }
}

/**
 * iconKey 목록을 아이콘으로 바꾼다. 캐시에 있는 건 그대로 쓴다. auto 모드면 캐시에 없는 벤더 패키지를
 * 한 번 받아 필요한 SVG만 캐시에 푼다. 어떤 실패도 던지지 않고 그 아이콘만 내장 아이콘으로 돌린다
 */
export async function resolveVendorIcons(
  keys: Iterable<string>,
  opts: ResolveVendorIconsOptions,
): Promise<IconSet> {
  const mode = opts.mode ?? iconModeFromEnv();
  const sorted = [...new Set(keys)].sort();
  const icons: Record<string, IconEntry> = {};
  const finish = (): IconSet => {
    const values = Object.values(icons);
    return {
      icons,
      stats: {
        official: values.filter((v) => v.source === 'official').length,
        fallback: values.filter((v) => v.source === 'fallback').length,
      },
    };
  };
  if (mode === 'off') {
    for (const k of sorted) icons[k] = { source: 'fallback' };
    return finish();
  }
  const dir = opts.cacheDir;
  let manifest = readManifest(dir);
  const missing = sorted.filter((k) => manifest.icons[k] === undefined);
  if (mode === 'auto' && missing.length > 0) {
    const byVendor = new Map<CloudProvider, string[]>();
    for (const k of missing) {
      const [vendor, name] = splitKey(k);
      if (vendor === undefined) continue;
      byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), name]);
    }
    try {
      mkdirSync(dir, { recursive: true });
      // 벤더끼리는 서로 기다릴 이유가 없다. 한 벤더가 실패해도 나머지는 캐시에 쓴다
      const vendors = [...byVendor.keys()].sort();
      const results = await Promise.allSettled(
        vendors.map((v) =>
          fetchVendor(v, byVendor.get(v)!, dir, manifest, {
            fetchImpl: opts.fetchImpl ?? fetch,
            now: opts.now ?? ((): Date => new Date()),
            pageTimeoutMs: opts.pageTimeoutMs ?? 15_000,
            packageTimeoutMs: opts.packageTimeoutMs ?? 120_000,
          }),
        ),
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
          log(`architecture: ${vendors[i]!} 아이콘을 받지 못해 내장 아이콘을 쓴다. ${message}`);
        }
      });
      writeManifest(dir, manifest);
    } catch (e) {
      log(`architecture: 아이콘 캐시를 쓰지 못했다. ${e instanceof Error ? e.message : String(e)}`);
    }
    manifest = readManifest(dir);
  }
  for (const k of sorted) {
    const dataUri = readCached(dir, manifest.icons[k]);
    icons[k] = dataUri !== undefined ? { source: 'official', dataUri } : { source: 'fallback' };
  }
  return finish();
}

function splitKey(key: string): [CloudProvider | undefined, string] {
  const at = key.indexOf(':');
  const vendor = key.slice(0, at);
  const name = key.slice(at + 1);
  return vendor === 'aws' || vendor === 'gcp' || vendor === 'azure'
    ? [vendor, name]
    : [undefined, name];
}
