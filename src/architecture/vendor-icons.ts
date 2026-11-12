import { mkdirSync } from 'node:fs';
import { log } from '../core/log.js';
import {
  fetchVendor,
  needsFetch,
  readCached,
  readManifest,
  writeManifest,
} from './vendor-icon-cache.js';
import { splitKey } from './vendor-icon-keys.js';
import type { CloudProvider } from './types.js';

/**
 * 클라우드 벤더 공식 아이콘. 벤더가 배포하는 패키지에서 필요한 SVG만 풀어 홈 캐시에 두고
 * 렌더는 캐시에서 읽은 data URI만 쓴다. 받지 못하면 언제나 내장 선 아이콘으로 돌아간다.
 */

export type IconMode = 'auto' | 'offline' | 'off';

/** dataUri는 살균하지 않은 외부 SVG라 <img src>로만 싣는다. 인라인 svg나 object로 넣으면 스크립트가 돈다 */
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

/** 아이콘 출처 표기. 상표는 각 소유자의 것이다 */
export const ICON_CREDITS: Record<CloudProvider, string> = {
  aws: 'AWS Architecture Icons',
  gcp: 'Google Cloud product icons',
  azure: 'Azure Public Service Icons',
};

/**
 * iconKey 목록을 아이콘으로 바꾼다. 캐시에 있는 건 그대로 쓴다. auto 모드면 캐시에 없는 벤더 패키지를
 * 한 번 받아 필요한 SVG만 캐시에 푼다. 어떤 실패도 던지지 않고 그 아이콘만 내장 아이콘으로 돌린다
 */
export async function resolveVendorIcons(
  keys: Iterable<string>,
  opts: ResolveVendorIconsOptions,
): Promise<IconSet> {
  const mode = opts.mode ?? iconModeFromEnv();
  const now = opts.now ?? ((): Date => new Date());
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
  const at = now();
  const missing = sorted.filter((k) => needsFetch(manifest.icons[k], at));
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
            now,
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
