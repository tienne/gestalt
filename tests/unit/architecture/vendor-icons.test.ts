import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ICON_CREDITS,
  ICON_MODE_ENV,
  iconModeFromEnv,
  resolveVendorIcons,
  type IconMode,
} from '../../../src/architecture/vendor-icons.js';
import { vendorIconKey } from '../../../src/architecture/vendor-icon-keys.js';
import { MAX_PKG_BYTES, NEGATIVE_TTL_MS } from '../../../src/architecture/vendor-icon-cache.js';

const SVG = (tag: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg"><title>${tag}</title></svg>`;
const NOW = new Date('2026-01-02T03:04:05.000Z');
const AWS_PAGE = 'https://aws.amazon.com/architecture/icons/';
const AWS_ZIP = 'https://d1fake.awsstatic.com/icons/Icon-package_20260101.zip';
const AZURE_PAGE = 'https://learn.microsoft.com/en-us/azure/architecture/icons/';
const AZURE_ZIP = 'https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V99.zip';
const GCP_CORE = 'https://services.google.com/fh/files/misc/core-products-icons.zip';
const GCP_CATEGORY = 'https://services.google.com/fh/files/misc/category-icons.zip';

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

/** 세 벤더 패키지를 흉내 낸 응답표. 안내 페이지와 zip 모두 이 안에서 만든다 */
function routes(): Record<string, Uint8Array | string> {
  return {
    [AWS_PAGE]: `<html><a href="${AWS_ZIP}">download</a></html>`,
    [AWS_ZIP]: zipOf({
      'Architecture-Service-Icons_01/Arch_Networking/64/Arch_Amazon-CloudFront_64.svg': SVG('cf'),
      'Architecture-Service-Icons_01/Arch_Compute/64/Arch_AWS-Lambda_64.svg': SVG('lambda'),
      'Architecture-Service-Icons_01/Arch_Storage/64/Arch_Amazon-Simple-Storage-Service_64.svg':
        SVG('s3'),
      'Architecture-Group-Icons_01/AWS-Cloud-logo_32.svg': SVG('cloud'),
    }),
    [AZURE_PAGE]: `<html>${AZURE_ZIP}</html>`,
    [AZURE_ZIP]: zipOf({
      'Azure_Public_Service_Icons/Icons/networking/10061-icon-service-Virtual-Networks.svg':
        SVG('vnet'),
      'Azure_Public_Service_Icons/Icons/networking/10062-icon-service-DNS-Zones.svg': SVG('dns'),
    }),
    [GCP_CORE]: zipOf({
      'Unique Icons/Cloud Run/SVG/CloudRun-512-color.svg': SVG('run'),
      'Unique Icons/Cloud Storage/SVG/CloudStorage-512-color.svg': SVG('gcs'),
    }),
    [GCP_CATEGORY]: zipOf({ 'Category Icons/Networking/SVG/Networking-512-color.svg': SVG('net') }),
  };
}

function fakeFetch(table: Record<string, Uint8Array | string>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = table[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : Buffer.from(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const neverFetch = ((): never => {
  throw new Error('이 테스트에서는 네트워크를 부르면 안 된다');
}) as unknown as typeof fetch;

describe('resolveVendorIcons', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = `.gestalt-test/icons-${randomUUID()}`;
  });

  afterEach(() => {
    if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true });
    vi.restoreAllMocks();
  });

  const run = (
    keys: string[],
    fetchImpl: typeof fetch,
    mode: IconMode = 'auto',
    extra: Record<string, unknown> = {},
  ) => resolveVendorIcons(keys, { cacheDir, mode, fetchImpl, now: () => NOW, ...extra });

  it('세 벤더의 이름을 패키지에서 찾아 data URI로 돌려준다', async () => {
    const { fetchImpl } = fakeFetch(routes());
    const keys = [
      'aws:CloudFront',
      'aws:Lambda',
      'aws:s3',
      'aws:AWS-Cloud-logo',
      'gcp:Cloud Run',
      'gcp:Cloud Storage',
      'azure:vnet',
      'azure:dns',
    ];
    const set = await run(keys, fetchImpl);
    expect(set.stats).toEqual({ official: 8, fallback: 0 });
    const lambda = set.icons['aws:Lambda']!;
    expect(lambda.source).toBe('official');
    if (lambda.source === 'official') {
      expect(lambda.dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
      const body = Buffer.from(lambda.dataUri.split(',')[1]!, 'base64').toString('utf8');
      expect(body).toBe(SVG('lambda'));
    }
  });

  it('필요한 SVG만 캐시에 풀고 manifest에 출처와 받은 날짜를 남긴다', async () => {
    const { fetchImpl } = fakeFetch(routes());
    await run(['aws:CloudFront'], fetchImpl);
    expect(readdirSync(join(cacheDir, 'aws'))).toEqual(['cloudfront.svg']);
    expect(existsSync(join(cacheDir, 'gcp'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf8')) as {
      icons: Record<string, { package?: string; fetchedAt: string; file?: string }>;
    };
    expect(manifest.icons['aws:CloudFront']).toMatchObject({
      file: 'aws/cloudfront.svg',
      package: AWS_ZIP,
      fetchedAt: NOW.toISOString(),
    });
    // zip 자체는 캐시에 남기지 않는다
    expect(
      readdirSync(cacheDir, { recursive: true }).filter((f) => String(f).endsWith('.zip')),
    ).toEqual([]);
  });

  it('패키지에 없는 이름은 내장 아이콘으로 돌리고 다음 호출에서 다시 받지 않는다', async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const first = await run(['aws:Lambda', 'aws:No-Such-Service'], fetchImpl);
    expect(first.icons['aws:Lambda']!.source).toBe('official');
    expect(first.icons['aws:No-Such-Service']).toEqual({ source: 'fallback' });
    expect(first.stats).toEqual({ official: 1, fallback: 1 });
    const before = calls.length;
    const second = await run(['aws:Lambda', 'aws:No-Such-Service'], fetchImpl);
    expect(calls.length).toBe(before);
    expect(second.stats).toEqual({ official: 1, fallback: 1 });
  });

  it('캐시에 있으면 네트워크를 부르지 않고 같은 결과를 낸다', async () => {
    const warm = fakeFetch(routes());
    const first = await run(['aws:CloudFront', 'azure:vnet'], warm.fetchImpl);
    const second = await run(['aws:CloudFront', 'azure:vnet'], neverFetch);
    expect(second).toEqual(first);
    expect(warm.calls.length).toBeGreaterThan(0);
  });

  it('auto 모드에서 일부만 캐시에 있으면 빠진 벤더만 받으러 간다', async () => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    const second = fakeFetch(routes());
    const set = await run(['aws:Lambda', 'gcp:Cloud Run'], second.fetchImpl);
    expect(set.stats).toEqual({ official: 2, fallback: 0 });
    expect(second.calls).toEqual([GCP_CORE, GCP_CATEGORY]);
  });

  it('offline 모드는 캐시가 비어 있어도 fetch를 부르지 않고 전부 내장 아이콘이다', async () => {
    const fetchSpy = vi.fn(neverFetch);
    const set = await run(['aws:Lambda', 'gcp:Cloud Run', 'azure:vnet'], fetchSpy, 'offline');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(set.stats).toEqual({ official: 0, fallback: 3 });
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('offline 모드도 이미 캐시된 아이콘은 쓴다', async () => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    const fetchSpy = vi.fn(neverFetch);
    const set = await run(['aws:Lambda', 'aws:CloudFront'], fetchSpy, 'offline');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(set.icons['aws:Lambda']!.source).toBe('official');
    expect(set.icons['aws:CloudFront']!.source).toBe('fallback');
  });

  it('off 모드는 캐시가 있어도 항상 내장 아이콘이다', async () => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    const fetchSpy = vi.fn(neverFetch);
    const set = await run(['aws:Lambda'], fetchSpy, 'off');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it('응답이 404면 던지지 않고 내장 아이콘으로 돌리고 실패는 기록하지 않아 다음에 다시 시도한다', async () => {
    const down = fakeFetch({});
    const set = await run(['aws:Lambda', 'gcp:Cloud Run'], down.fetchImpl);
    expect(set.stats).toEqual({ official: 0, fallback: 2 });
    expect(down.calls.length).toBeGreaterThan(0);
    const retry = fakeFetch(routes());
    const again = await run(['aws:Lambda', 'gcp:Cloud Run'], retry.fetchImpl);
    expect(again.stats).toEqual({ official: 2, fallback: 0 });
  });

  it('Content-Length가 상한을 넘으면 본문을 읽지 않고 내장 아이콘으로 돌린다', async () => {
    const table = routes();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === AWS_ZIP) {
        return new Response('x', {
          headers: { 'content-length': String(MAX_PKG_BYTES + 1) },
        });
      }
      const body = table[url]!;
      return new Response(typeof body === 'string' ? body : Buffer.from(body));
    }) as typeof fetch;
    const set = await run(['aws:Lambda'], fetchImpl);
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it('본문이 상한을 넘게 흘러오면 읽기를 끊고 내장 아이콘으로 돌린다', async () => {
    const table = routes();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    let cancelled = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === AWS_ZIP) {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream);
      }
      const body = table[url]!;
      return new Response(typeof body === 'string' ? body : Buffer.from(body));
    }) as typeof fetch;
    const set = await run(['aws:Lambda'], fetchImpl);
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(MAX_PKG_BYTES + 4 * chunk.byteLength);
  });

  it.each([
    ['허용 목록 밖 호스트', 'https://evil.example.com/Icon-package_x.zip'],
    ['허용 호스트를 흉내 낸 호스트', 'https://notawsstatic.com/Icon-package_x.zip'],
    ['http', 'http://d1fake.awsstatic.com/icons/Icon-package_20260101.zip'],
  ])('리다이렉트가 %s로 가면 쓰지 않는다', async (_label, finalUrl) => {
    const table = routes();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = table[url]!;
      const res = new Response(typeof body === 'string' ? body : Buffer.from(body));
      if (url === AWS_ZIP) Object.defineProperty(res, 'url', { value: finalUrl });
      return res;
    }) as typeof fetch;
    const set = await run(['aws:Lambda'], fetchImpl);
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
    expect(existsSync(join(cacheDir, 'aws', 'lambda.svg'))).toBe(false);
  });

  it('fetch가 던져도 렌더를 깨지 않는다', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(run(['aws:Lambda'], boom)).resolves.toMatchObject({
      stats: { official: 0, fallback: 1 },
    });
  });

  it('제한 시간 안에 응답이 없으면 포기하고 내장 아이콘으로 돌린다', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const set = await run(['aws:Lambda'], hang, 'auto', {
      pageTimeoutMs: 20,
      packageTimeoutMs: 20,
    });
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it('한 벤더가 실패해도 나머지 벤더 아이콘은 캐시에 쓴다', async () => {
    const table = routes();
    delete table[AWS_PAGE];
    const { fetchImpl } = fakeFetch(table);
    const set = await run(['aws:Lambda', 'azure:vnet', 'gcp:Cloud Run'], fetchImpl);
    expect(set.icons['aws:Lambda']!.source).toBe('fallback');
    expect(set.icons['azure:vnet']!.source).toBe('official');
    expect(set.icons['gcp:Cloud Run']!.source).toBe('official');
  });

  it('요청마다 제한 시간 신호와 User-Agent를 싣고 사람이나 회사 정보는 담지 않는다', async () => {
    const seen: RequestInit[] = [];
    const table = routes();
    const spy = (async (url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      const body = table[String(url)];
      return body === undefined
        ? new Response('x', { status: 404 })
        : new Response(typeof body === 'string' ? body : Buffer.from(body));
    }) as unknown as typeof fetch;
    await run(['aws:Lambda'], spy);
    expect(seen.length).toBeGreaterThan(0);
    for (const init of seen) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.headers as Record<string, string>)['User-Agent']).toBe(
        'Mozilla/5.0 (compatible; gestalt-architecture)',
      );
    }
  });

  it('SVG가 아닌 파일은 캐시에 쓰지 않고 내장 아이콘으로 돌린다', async () => {
    const table = routes();
    table[AWS_ZIP] = zipOf({
      'Architecture-Service-Icons_01/Arch_Compute/64/Arch_AWS-Lambda_64.svg': 'not an image',
    });
    const first = fakeFetch(table);
    const set = await run(['aws:Lambda'], first.fetchImpl);
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
    expect(existsSync(join(cacheDir, 'aws', 'lambda.svg'))).toBe(false);
    // 패키지는 받았으니 못 쓴 이름도 적어 두고 다음 렌더에서 다시 받지 않는다
    const before = first.calls.length;
    const again = await run(['aws:Lambda'], first.fetchImpl);
    expect(first.calls.length).toBe(before);
    expect(again.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it.each([
    ['onload 속성', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['대문자 이벤트 속성', '<svg xmlns="http://www.w3.org/2000/svg"><g ONCLICK="x()"/></svg>'],
    ['script 요소', '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'],
    [
      'foreignObject',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>x</p></foreignObject></svg>',
    ],
    ['HTML 문서', '<!DOCTYPE html><html><svg></svg></html>'],
  ])('%s가 든 SVG는 쓰지 않는다', async (_label, body) => {
    const table = routes();
    table[AWS_ZIP] = zipOf({
      'Architecture-Service-Icons_01/Arch_Compute/64/Arch_AWS-Lambda_64.svg': body,
    });
    const set = await run(['aws:Lambda'], fakeFetch(table).fetchImpl);
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it('xml 선언과 주석, svg DOCTYPE이 앞에 붙은 SVG는 쓴다', async () => {
    const table = routes();
    const body = `<?xml version="1.0"?>\n<!-- Generator: x -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG('lambda')}`;
    table[AWS_ZIP] = zipOf({
      'Architecture-Service-Icons_01/Arch_Compute/64/Arch_AWS-Lambda_64.svg': body,
    });
    const set = await run(['aws:Lambda'], fakeFetch(table).fetchImpl);
    expect(set.icons['aws:Lambda']!.source).toBe('official');
  });

  it('못 쓴다고 적은 항목은 TTL이 지나면 다시 받는다', async () => {
    const first = fakeFetch(routes());
    await run(['aws:No-Such-Service'], first.fetchImpl);
    const before = first.calls.length;
    await run(['aws:No-Such-Service'], first.fetchImpl, 'auto', {
      now: () => new Date(NOW.getTime() + NEGATIVE_TTL_MS),
    });
    expect(first.calls.length).toBe(before);
    await run(['aws:No-Such-Service'], first.fetchImpl, 'auto', {
      now: () => new Date(NOW.getTime() + NEGATIVE_TTL_MS + 1),
    });
    expect(first.calls.length).toBeGreaterThan(before);
  });

  it('받아 둔 아이콘은 TTL이 지나도 다시 받지 않는다', async () => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    const set = await run(['aws:Lambda'], neverFetch, 'auto', {
      now: () => new Date(NOW.getTime() + 10 * NEGATIVE_TTL_MS),
    });
    expect(set.icons['aws:Lambda']!.source).toBe('official');
  });

  it('캐시 파일 자리에 디렉터리가 있어도 던지지 않고 내장 아이콘으로 돌린다', async () => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    const file = join(cacheDir, 'aws', 'lambda.svg');
    rmSync(file);
    mkdirSync(file);
    const set = await run(['aws:Lambda'], neverFetch, 'offline');
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it.each([
    ['캐시 밖 경로', '../../outside.svg'],
    ['절대 경로', '/etc/hosts'],
    ['문자열이 아닌 값', 42],
  ])('manifest의 file이 %s면 읽지 않는다', async (_label, file) => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    writeFileSync(
      join(cacheDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        icons: { 'aws:Lambda': { file, fetchedAt: NOW.toISOString() } },
      }),
    );
    const set = await run(['aws:Lambda'], neverFetch, 'offline');
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it.each([
    ['배열', []],
    ['문자열', 'x'],
    ['null 항목', { 'aws:Lambda': null }],
  ])('manifest의 icons가 %s면 빈 캐시로 본다', async (_label, icons) => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify({ version: 1, icons }));
    const set = await run(['aws:Lambda'], neverFetch, 'offline');
    expect(set.icons['aws:Lambda']).toEqual({ source: 'fallback' });
  });

  it('깨진 manifest는 빈 캐시로 보고 mode에 따라 다시 받는다', async () => {
    await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    writeFileSync(join(cacheDir, 'manifest.json'), '{ not json');
    const offline = await run(['aws:Lambda'], neverFetch, 'offline');
    expect(offline.icons['aws:Lambda']!.source).toBe('fallback');
    const auto = await run(['aws:Lambda'], fakeFetch(routes()).fetchImpl);
    expect(auto.icons['aws:Lambda']!.source).toBe('official');
  });

  it('벤더를 모르는 키는 받으러 가지 않고 내장 아이콘이다', async () => {
    const fetchSpy = vi.fn(neverFetch);
    const set = await run(['oracle:Thing'], fetchSpy);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(set.icons['oracle:Thing']).toEqual({ source: 'fallback' });
  });

  it('같은 키를 여러 번 줘도 한 번만 세고 키 순서와 무관하게 같은 결과다', async () => {
    const a = await run(
      ['aws:Lambda', 'aws:CloudFront', 'aws:Lambda'],
      fakeFetch(routes()).fetchImpl,
    );
    expect(a.stats.official).toBe(2);
    const b = await run(['aws:CloudFront', 'aws:Lambda'], neverFetch, 'offline');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('iconModeFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('테스트 환경은 offline이다', () => {
    expect(process.env[ICON_MODE_ENV]).toBe('offline');
    expect(iconModeFromEnv()).toBe('offline');
  });

  it.each([
    ['off', 'off'],
    ['offline', 'offline'],
    ['auto', 'auto'],
    ['', 'auto'],
    ['whatever', 'auto'],
  ])('GESTALT_ARCH_ICONS=%j는 %s다', (raw, expected) => {
    vi.stubEnv(ICON_MODE_ENV, raw);
    expect(iconModeFromEnv()).toBe(expected);
  });
});

describe('vendorIconKey', () => {
  const key = (
    vendor: 'aws' | 'gcp' | 'azure',
    kind: Parameters<typeof vendorIconKey>[1]['kind'],
    extra: { label?: string; engine?: string } = {},
  ) => vendorIconKey(vendor, { kind, label: extra.label ?? 'x', ...extra });

  it.each([
    ['aws', 'cdn', 'aws:CloudFront'],
    ['aws', 'domain', 'aws:Route-53'],
    ['aws', 'bucket', 'aws:s3'],
    ['aws', 'firewall', 'aws:WAF'],
    ['gcp', 'cdn', 'gcp:Cloud CDN'],
    ['gcp', 'domain', 'gcp:Cloud DNS'],
    ['gcp', 'bucket', 'gcp:Cloud Storage'],
    ['gcp', 'firewall', 'gcp:Cloud Armor'],
    ['azure', 'cdn', 'azure:frontdoor'],
    ['azure', 'domain', 'azure:dns'],
    ['azure', 'bucket', 'azure:storage'],
    ['azure', 'subnet', 'azure:Subnet'],
    ['azure', 'firewall', 'azure:nsg'],
  ] as const)('%s %s는 %s', (vendor, kind, expected) => {
    expect(key(vendor, kind)).toBe(expected);
  });

  it('datastore는 engine으로 고르고 engine이 없으면 label로 고른다', () => {
    expect(key('aws', 'datastore', { engine: 'redis' })).toBe('aws:ElastiCache');
    expect(key('aws', 'datastore', { engine: 'aurora-mysql' })).toBe('aws:Aurora');
    expect(key('aws', 'datastore', { label: 'orders-dynamodb' })).toBe('aws:DynamoDB');
    expect(key('gcp', 'datastore', { engine: 'firestore' })).toBe('gcp:Firestore');
    expect(key('azure', 'datastore', { engine: 'cosmos' })).toBe('azure:cosmos');
  });

  it('deploy_target은 engine으로 고르고 표에 없으면 아이콘 없음이다', () => {
    expect(key('aws', 'deploy_target', { engine: 'lambda' })).toBe('aws:Lambda');
    expect(key('gcp', 'deploy_target', { engine: 'cloud-run' })).toBe('gcp:Cloud Run');
    expect(key('azure', 'deploy_target', { engine: 'app-service' })).toBe('azure:webapp');
    expect(key('aws', 'deploy_target', { engine: 'unknown-engine' })).toBeUndefined();
    expect(key('aws', 'deploy_target')).toBeUndefined();
  });

  it('cluster는 engine이 맞으면 그 아이콘, 아니면 벤더 기본 클러스터 아이콘이다', () => {
    expect(key('aws', 'cluster')).toBe('aws:eks');
    expect(key('aws', 'cluster', { engine: 'ecs' })).toBe('aws:ecs');
    expect(key('gcp', 'cluster')).toBe('gcp:GKE');
    expect(key('azure', 'cluster')).toBe('azure:aks');
  });

  it('표 밖 kind는 undefined다', () => {
    expect(key('aws', 'screen')).toBeUndefined();
    expect(key('aws', 'subnet')).toBeUndefined();
  });

  it('출처 표기가 세 벤더 모두 있다', () => {
    expect(Object.keys(ICON_CREDITS).sort()).toEqual(['aws', 'azure', 'gcp']);
  });
});
