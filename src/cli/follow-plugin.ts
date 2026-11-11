import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compareSemver } from '../core/version.js';

/**
 * 전역으로 설치한 `gestalt`가 설치된 gestalt 플러그인 버전을 따라가게 한다.
 *
 * 플러그인을 업데이트해도 전역 npm 설치는 그대로라 터미널 CLI만 옛 버전으로 남는다.
 * 그래서 전역 실행 파일은 맨 앞에서 플러그인 런처를 찾고 버전이 다르면 그 런처로 넘긴다.
 * 런처는 자기 매니페스트에 적힌 버전을 그대로 받아 돌린다.
 *
 * 플러그인이 여럿이면(Claude 계정 둘, Codex) 가장 높은 버전을 고른다.
 */

/** 이 값이 `0`이면 넘기지 않는다. 런처로 넘긴 자식과 mcp-serve.sh가 켠다 */
export const FOLLOW_PLUGIN_ENV = 'GESTALT_FOLLOW_PLUGIN';

export interface PluginLauncher {
  launcher: string;
  version: string;
  host: 'claude' | 'codex';
}

interface Context {
  env: NodeJS.ProcessEnv;
  home: string;
}

function readVersion(pluginRoot: string): string | null {
  try {
    const raw = readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

function candidate(pluginRoot: string, host: PluginLauncher['host']): PluginLauncher | null {
  const launcher = join(pluginRoot, 'scripts', 'gestalt-cli.mjs');
  if (!existsSync(launcher)) return null;
  const version = readVersion(pluginRoot);
  return version === null ? null : { launcher, version, host };
}

function claudeLaunchers({ env, home }: Context): PluginLauncher[] {
  const dirs = new Set([env['CLAUDE_CONFIG_DIR'], join(home, '.claude')].filter(Boolean));
  const found: PluginLauncher[] = [];
  for (const dir of dirs) {
    let plugins: Record<string, unknown>;
    try {
      const raw = readFileSync(join(dir!, 'plugins', 'installed_plugins.json'), 'utf8');
      plugins = (JSON.parse(raw) as { plugins?: Record<string, unknown> }).plugins ?? {};
    } catch {
      continue;
    }
    for (const [key, entries] of Object.entries(plugins)) {
      // 마켓플레이스 이름은 설치한 사람마다 다를 수 있어 플러그인 이름만 본다
      if (!key.startsWith('gestalt@') || !Array.isArray(entries)) continue;
      for (const entry of entries as { installPath?: unknown }[]) {
        if (typeof entry?.installPath !== 'string') continue;
        // Claude는 레포를 통째로 설치해서 플러그인 자산이 plugin/ 아래에 있다
        const hit = candidate(join(entry.installPath, 'plugin'), 'claude');
        if (hit) found.push(hit);
      }
    }
  }
  return found;
}

function codexLaunchers({ env, home }: Context): PluginLauncher[] {
  const codexHome = env['CODEX_HOME'] || join(home, '.codex');
  const cache = join(codexHome, 'plugins', 'cache');
  const found: PluginLauncher[] = [];
  let marketplaces: string[];
  try {
    marketplaces = readdirSync(cache);
  } catch {
    return found;
  }
  for (const marketplace of marketplaces) {
    const base = join(cache, marketplace, 'gestalt');
    let versions: string[];
    try {
      versions = readdirSync(base);
    } catch {
      continue;
    }
    // Codex는 plugin/만 복사하므로 버전 디렉토리가 곧 플러그인 루트다
    for (const version of versions) {
      const hit = candidate(join(base, version), 'codex');
      if (hit) found.push(hit);
    }
  }
  return found;
}

export function findPluginLaunchers(ctx: Context): PluginLauncher[] {
  return [...claudeLaunchers(ctx), ...codexLaunchers(ctx)];
}

export function pickHighest(launchers: PluginLauncher[]): PluginLauncher | null {
  let best: PluginLauncher | null = null;
  for (const item of launchers) {
    if (best === null || compareSemver(item.version, best.version) > 0) best = item;
  }
  return best;
}

/**
 * 넘길 런처를 고른다. 넘기지 않을 때는 null이다.
 *
 * 전역 npm 설치에서 돌 때만 넘긴다. 레포 체크아웃에서 돌리는 개발 빌드나
 * `npx @tienne/gestalt@x`처럼 버전을 집어 부른 실행은 그 버전 그대로 돈다.
 */
export function resolvePluginDelegation(options: {
  selfPath: string;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): PluginLauncher | null {
  const env = options.env ?? process.env;
  if (env[FOLLOW_PLUGIN_ENV] === '0') return null;

  const parts = options.selfPath.split(/[\\/]/);
  if (!parts.includes('node_modules') || parts.includes('_npx')) return null;

  const best = pickHighest(findPluginLaunchers({ env, home: options.home ?? homedir() }));
  if (best === null || best.version === options.currentVersion) return null;
  return best;
}
