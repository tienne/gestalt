import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

let cachedUpdateResult: UpdateCheckResult | null = null;

export function getVersion(): string {
  const pkg = require('../../package.json');
  return pkg.version;
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
  return join(homedir(), '.gestalt', '.update-check');
}

function readCache(): UpdateCheckResult | null {
  try {
    const cachePath = getCacheFilePath();
    if (!existsSync(cachePath)) return null;

    const raw = readFileSync(cachePath, 'utf-8');
    const data = JSON.parse(raw) as { timestamp: number; latestVersion: string };

    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null;

    const currentVersion = getVersion();
    return {
      currentVersion,
      latestVersion: data.latestVersion,
      updateAvailable: compareSemver(data.latestVersion, currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    const dir = join(homedir(), '.gestalt');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
    const currentVersion = getVersion();
    const latestVersion = data.version;

    writeCache(latestVersion);

    const result: UpdateCheckResult = {
      currentVersion,
      latestVersion,
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    };

    cachedUpdateResult = result;
    return result;
  } catch {
    return null;
  }
}
