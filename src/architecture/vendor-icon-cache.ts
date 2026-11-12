import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { log } from '../core/log.js';
import { iconKey, norm } from './vendor-icon-keys.js';
import type { CloudProvider } from './types.js';

/**
 * 벤더 아이콘 패키지를 받아 필요한 SVG만 홈 캐시에 풀고 manifest로 기록한다.
 * 패키지 주소와 이름 해석은 stack-diagram의 fetch_icons.py를 옮겼다.
 */

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

// 리다이렉트가 엉뚱한 곳으로 데려가도 그 응답을 아이콘으로 쓰지 않게 실제로 받는 곳만 연다
const ALLOWED_HOSTS = [
  'aws.amazon.com',
  'awsstatic.com',
  'services.google.com',
  'learn.microsoft.com',
  'arch-center.azureedge.net',
] as const;
// 실제 패키지는 수십 MB다. 오염된 CDN이 끝없는 응답을 줘도 렌더 프로세스가 메모리로 죽지 않게 막는다
export const MAX_PKG_BYTES = 300 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_SVG_BYTES = 256 * 1024;
// 패키지에 없던 이름도 벤더가 나중에 추가할 수 있어 한동안 지나면 다시 본다
export const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 캐시 파일은 `${vendor}/${norm(name)}.svg`로만 쓴다. 이 꼴이 아니면 manifest가 오염된 것이다
const CACHE_FILE_RE = /^(aws|gcp|azure)\/[a-z0-9]+\.svg$/;

interface PackageIndex {
  /** 정규화 이름 → [zip 안 경로, 패키지 주소]. 파일 이름순으로 먼저 본 것을 남긴다 */
  index: Map<string, { member: string; pkg: string }>;
  /** 접두어를 뗀 이름 → index 키(gcp는 폴더 이름). 겹치면 먼저 본 것을 남긴다 */
  stripped: Map<string, string>;
  /** 패키지 주소 → zip 바이트 */
  zips: Map<string, Uint8Array>;
  /** gcp만. 정규화 제품 이름 → 정규화 폴더 이름 */
  targets?: Map<string, string>;
}

function listMembers(zip: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(zip, {
    filter: (f) => {
      if (names.length >= MAX_ZIP_ENTRIES)
        throw new Error('아이콘 패키지의 zip 엔트리가 너무 많다');
      names.push(f.name);
      return false;
    },
  });
  return names.sort();
}

const stripAws = (s: string): string => s.replace(/^(aws|amazon)/, '');
const stripAzure = (s: string): string => s.replace(/^(azure|microsoft)|s$/g, '');
const stripGcp = (s: string): string => s.replace(/^(google|cloud)+/, '');

function firstSeen(entries: Iterable<[string, string]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [s, k] of entries) if (!m.has(s)) m.set(s, k);
  return m;
}

function lookup(vendor: CloudProvider, pkg: PackageIndex, query: string): string | undefined {
  const { index, stripped } = pkg;
  if (vendor === 'aws') {
    const q = norm(AWS_ALIASES[norm(query)] ?? query);
    return index.has(q) ? q : stripped.get(q);
  }
  if (vendor === 'azure') {
    const q = norm(AZURE_ALIASES[norm(query)] ?? query);
    return index.has(q) ? q : stripped.get(stripAzure(q));
  }
  const q = norm(query);
  const hit = pkg.targets!.get(q) ?? stripped.get(q);
  return hit !== undefined && index.has(hit) ? hit : undefined;
}

export interface ManifestEntry {
  /** 캐시 안 파일 이름. 없으면 패키지에 그 이름이 없었거나 쓸 수 있는 SVG가 아니었다 */
  file?: string;
  member?: string;
  package?: string;
  fetchedAt: string;
}

export interface Manifest {
  version: 1;
  icons: Record<string, ManifestEntry>;
}

export function readManifest(dir: string): Manifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) return { version: 1, icons: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { icons?: unknown };
    const raw = parsed.icons;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { version: 1, icons: {} };
    }
    const icons = Object.fromEntries(
      Object.entries(raw).filter(
        ([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v),
      ),
    ) as Record<string, ManifestEntry>;
    return { version: 1, icons };
  } catch {
    return { version: 1, icons: {} };
  }
}

export function writeManifest(dir: string, manifest: Manifest): void {
  const sorted = Object.fromEntries(
    Object.keys(manifest.icons)
      .sort()
      .map((k) => [k, manifest.icons[k]!]),
  );
  // 다른 렌더가 같은 홈 캐시를 동시에 읽어도 반쯤 쓴 파일을 보지 않게 바꿔치기로 쓴다
  writeAtomic(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ version: 1, icons: sorted }, null, 2)}\n`,
  );
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** 이 키를 지금 받으러 가야 하는가. 받은 적 없거나, 못 쓴다고 적어 둔 지 TTL이 지났을 때다 */
export function needsFetch(entry: ManifestEntry | undefined, now: Date): boolean {
  if (entry === undefined) return true;
  if (entry.file !== undefined) return false;
  // 날짜가 깨졌으면 언제 적었는지 모르니 지난 것으로 본다
  return !(now.getTime() - Date.parse(entry.fetchedAt) <= NEGATIVE_TTL_MS);
}

const PROLOG_RE =
  /^(?:\uFEFF|\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b[^>[]*(?:\[[\s\S]*?\])?\s*>)*/i;
const ACTIVE_CONTENT_RE = /<script|<foreignObject|[\s"'/]on[a-z]+\s*=/i;

function looksSvg(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes).toString('utf8');
  const body = text.slice(PROLOG_RE.exec(text)?.[0].length ?? 0);
  return body.startsWith('<svg') && !ACTIVE_CONTENT_RE.test(text);
}

export function readCached(dir: string, entry: ManifestEntry | undefined): string | undefined {
  const file = entry?.file;
  if (typeof file !== 'string' || !CACHE_FILE_RE.test(file)) return undefined;
  try {
    const path = join(dir, file);
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    if (bytes.length > MAX_SVG_BYTES || !looksSvg(bytes)) return undefined;
    return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function assertAllowed(url: string): void {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'https:') throw new Error(`${url}는 https가 아니다`);
  if (!ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
    throw new Error(`${url}는 아이콘을 받는 곳이 아니다`);
  }
}

async function getBytes(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT },
  });
  // 직접 만든 Response는 url이 비어 있다. 그때는 요청한 주소가 도착지다
  assertAllowed(res.url || url);
  if (!res.ok) throw new Error(`${url} 응답 ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_PKG_BYTES) throw new Error(`${url} 응답이 ${declared}바이트로 너무 크다`);
  if (res.body === null) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PKG_BYTES) {
      await reader.cancel();
      throw new Error(`${url} 응답이 ${MAX_PKG_BYTES}바이트를 넘는다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
    const stripped = firstSeen([...targets].map(([k, v]): [string, string] => [stripGcp(k), v]));
    return { index, stripped, zips, targets };
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
  const strip = vendor === 'aws' ? stripAws : stripAzure;
  const stripped = firstSeen([...index.keys()].map((k): [string, string] => [strip(k), k]));
  return { index, stripped, zips };
}

function cacheFileName(name: string): string {
  return `${norm(name) || 'icon'}.svg`;
}

export interface FetchVendorOptions {
  fetchImpl: typeof fetch;
  now: () => Date;
  pageTimeoutMs: number;
  packageTimeoutMs: number;
}

/**
 * 패키지를 받아 이번에 필요한 아이콘만 캐시에 쓴다. 패키지는 받았는데 쓸 SVG를 못 얻은 이름은 그 사실도 적어
 * 렌더마다 수십 MB를 다시 받지 않게 한다. 받기 자체가 실패하면 아무것도 적지 않고 던진다
 */
export async function fetchVendor(
  vendor: CloudProvider,
  names: readonly string[],
  dir: string,
  manifest: Manifest,
  opts: FetchVendorOptions,
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
      continue;
    }
    const { member } = pkg.index.get(key)!;
    wanted.set(member, [...(wanted.get(member) ?? []), name]);
  }
  const written = new Set<string>();
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
        writeAtomic(join(dir, file), bytes);
        manifest.icons[iconKey(vendor, name)] = { file, member, package: url, fetchedAt };
        written.add(name);
      }
    }
  }
  for (const name of names) {
    if (!written.has(name)) manifest.icons[iconKey(vendor, name)] = { fetchedAt };
  }
}
