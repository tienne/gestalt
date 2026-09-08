import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gestaltPath, ensureGestaltHome } from './home.js';

const require = createRequire(import.meta.url);

/** 버전을 어디서 읽었는지. 무엇을 갱신하라고 안내할지가 여기서 갈린다 */
export type VersionSource = 'plugin' | 'server';

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  /** currentVersion을 어디서 읽었는지 */
  source: VersionSource;
}

let cachedUpdateResult: UpdateCheckResult | null = null;

export function getVersion(): string {
  const pkg = require('../../package.json');
  return pkg.version;
}

/**
 * 이 세션이 실제로 로드한 플러그인 버전. 플러그인으로 안 떴으면 null이다.
 *
 * Claude Code가 플러그인 매니페스트로 MCP 서버를 띄우면 `CLAUDE_PLUGIN_ROOT`가 서버
 * 프로세스까지 상속된다. 그 경로가 스킬과 에이전트를 읽어온 자리다.
 *
 * **서버 자기 버전(`getVersion`)과 어긋날 수 있다.** `mcp-serve.sh`는 전역 `gestalt`가
 * 있으면 핀보다 그걸 먼저 쓰므로, 누가 `npm i -g`를 해두면 서버만 최신이고 스킬은
 * 플러그인 캐시의 옛 버전이 된다. 그때 알려야 하는 쪽은 플러그인이다 — 사용자가 읽는
 * 지시문이 거기서 오기 때문이다. 서버가 최신이어도 옛 스킬이 없는 도구를 부른다.
 *
 * 캐시 경로의 마지막 조각도 버전이지만(`.../gestalt/0.72.5`) 그건 Claude Code의 캐시
 * 배치일 뿐이라 안 쓴다. 매니페스트를 읽는 쪽이 계약이다.
 */
export function getPluginVersion(): string | null {
  const root = process.env['CLAUDE_PLUGIN_ROOT'];
  if (root === undefined || root === '') return null;

  try {
    const raw = readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8');
    const manifest = JSON.parse(raw) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * 최신 여부를 잴 기준 버전. **플러그인이 있으면 플러그인이 이긴다.**
 *
 * 플러그인 없이 CLI로 부른 경우와 매니페스트를 못 읽은 경우에 서버 버전으로 떨어진다.
 */
export function getSessionVersion(): { version: string; source: VersionSource } {
  const plugin = getPluginVersion();
  if (plugin !== null) return { version: plugin, source: 'plugin' };
  return { version: getVersion(), source: 'server' };
}

export function compareSemver(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split('.').map(Number);
  const partsB = b.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getCachedUpdateResult(): UpdateCheckResult | null {
  return cachedUpdateResult;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCacheFilePath(): string {
  return gestaltPath('.update-check');
}

function readCache(): UpdateCheckResult | null {
  try {
    const cachePath = getCacheFilePath();
    if (!existsSync(cachePath)) return null;

    const raw = readFileSync(cachePath, 'utf-8');
    const data = JSON.parse(raw) as { timestamp: number; latestVersion: string };

    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;

    // 캐시에는 npm latest만 담는다. 기준 버전은 매번 다시 읽는다 — 같은 머신에서도
    // 세션마다 로드된 플러그인 버전이 달라서 캐시에 굳혀두면 남의 세션 값을 쓴다.
    const { version: currentVersion, source } = getSessionVersion();
    return {
      currentVersion,
      latestVersion: data.latestVersion,
      updateAvailable: compareSemver(data.latestVersion, currentVersion) > 0,
      source,
    };
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    ensureGestaltHome();
    writeFileSync(getCacheFilePath(), JSON.stringify({ timestamp: Date.now(), latestVersion }));
  } catch {
    // silently ignore
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult | null> {
  if (process.env['GESTALT_NO_UPDATE_CHECK'] === '1') return null;

  const cached = readCache();
  if (cached) {
    cachedUpdateResult = cached;
    return cached;
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@tienne/gestalt/latest', {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { version: string };
    const { version: currentVersion, source } = getSessionVersion();
    const latestVersion = data.version;

    writeCache(latestVersion);

    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion,
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
      source,
    };

    cachedUpdateResult = result;
    return result;
  } catch {
    return null;
  }
}

// ─── 세션에 한 번만 내보내는 알림 ────────────────────────────────────────────

/**
 * 이 프로세스에서 배너를 이미 내보냈는지.
 *
 * MCP 서버는 세션 하나당 한 프로세스라 모듈 수준 플래그가 곧 "세션당 한 번"이 된다.
 * 도구를 부를 때마다 붙이면 리뷰처럼 도구를 수십 번 부르는 스킬에서 같은 줄이
 * 그만큼 쌓인다.
 */
let bannerTaken = false;

/** 테스트에서 플래그를 되돌린다. 프로덕션 경로에서는 안 부른다 */
export function resetUpdateBanner(): void {
  bannerTaken = false;
}

/**
 * 아직 안 내보냈고 새 버전이 있으면 알림 한 줄을 돌려준다. 그 외에는 null이다.
 *
 * 여기서 네트워크를 안 탄다. `checkForUpdates()`가 서버 기동 때 걸어둔 결과만 읽으므로
 * 도구 응답이 조회를 기다리는 일이 없다. 기동 직후 첫 호출이 조회보다 빠르면 그 판은
 * 그냥 넘어가고 다음 도구 호출에서 뜬다.
 */
export function takeUpdateBanner(): string | null {
  if (bannerTaken) return null;

  const result = getCachedUpdateResult();
  if (!result?.updateAvailable) return null;

  bannerTaken = true;
  return formatUpdateBanner(result);
}

/**
 * 알림 문구. 어디를 갱신해야 하는지가 `source`에 따라 갈린다.
 *
 * 플러그인이 뒤처진 경우에 `npm i -g`를 안내하면 안 된다. 그건 서버만 올리고 스킬은
 * 그대로 두는 명령이라, 사용자가 시킨 대로 해도 같은 알림이 다음 세션에 또 뜬다.
 */
export function formatUpdateBanner(result: UpdateCheckResult): string {
  const { currentVersion, latestVersion, source } = result;
  const how =
    source === 'plugin'
      ? '`/plugin install gestalt@gestalt` 로 갱신하고 세션을 다시 시작하세요.'
      : '`gestalt update` 로 갱신하세요.';

  return `[gestalt] 새 버전이 있어요 — ${currentVersion} → ${latestVersion}\n${how}`;
}
