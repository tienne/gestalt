import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
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

/** 런처로 넘긴 자식과 MCP 기동 경로는 이 값을 `0`으로 둬서 넘기지 않게 한다 */
export const FOLLOW_PLUGIN_ENV = 'GESTALT_FOLLOW_PLUGIN';

const PLUGIN_NAME = 'gestalt';
const MARKETPLACE = 'gestalt';
const PLUGIN_KEY = `${PLUGIN_NAME}@${MARKETPLACE}`;

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
    const { name, version } = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (name !== PLUGIN_NAME) return null;
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

function absoluteDir(value: string | undefined): string | null {
  return value && isAbsolute(value) ? value : null;
}

/** 실제 경로가 마켓플레이스 캐시 아래에 있는지 본다. 어느 쪽이든 실제 경로를 못 구하면 아니라고 본다 */
function insideCache(path: string, cacheRoot: string): boolean {
  try {
    return realpathSync(path).startsWith(realpathSync(cacheRoot) + sep);
  } catch {
    return false;
  }
}

/** Claude settings.json에서 이 플러그인을 꺼 뒀는지 본다. 파일이 없거나 깨졌으면 켜진 것으로 본다 */
function claudePluginDisabled(configDir: string): boolean {
  try {
    const raw = readFileSync(join(configDir, 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> };
    return settings.enabledPlugins?.[PLUGIN_KEY] === false;
  } catch {
    return false;
  }
}

function claudeLaunchers({ env, home }: Context): PluginLauncher[] {
  const dirs = new Set(
    [absoluteDir(env['CLAUDE_CONFIG_DIR']), join(home, '.claude')].filter(
      (dir): dir is string => dir !== null,
    ),
  );
  const found: PluginLauncher[] = [];
  for (const dir of dirs) {
    if (claudePluginDisabled(dir)) continue;
    let plugins: Record<string, unknown>;
    try {
      const raw = readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8');
      plugins = (JSON.parse(raw) as { plugins?: Record<string, unknown> }).plugins ?? {};
    } catch {
      continue;
    }
    // 같은 이름의 플러그인을 다른 마켓플레이스에서 깔 수 있어 공식 마켓플레이스 키만 본다.
    // 프로젝트 범위 설치는 그 레포 안에서만 켜지므로 터미널 전체를 맡기지 않는다
    // 등록부 한 줄만 바뀌어도 아무 스크립트나 돌 수 있어 마켓플레이스 캐시 안의 설치만 믿는다
    const entries = plugins[PLUGIN_KEY];
    if (!Array.isArray(entries)) continue;
    const cacheRoot = join(dir, 'plugins', 'cache', MARKETPLACE, PLUGIN_NAME);
    for (const entry of entries as { installPath?: unknown; scope?: unknown }[]) {
      if (entry?.scope !== 'user') continue;
      const installPath = typeof entry.installPath === 'string' ? entry.installPath : undefined;
      if (absoluteDir(installPath) === null || !insideCache(installPath!, cacheRoot)) continue;
      // Claude는 레포를 통째로 설치해서 플러그인 자산이 plugin/ 아래에 있다
      const hit = candidate(join(installPath!, 'plugin'), 'claude');
      if (hit) found.push(hit);
    }
  }
  return found;
}

/**
 * Codex config.toml에서 이 플러그인을 꺼 뒀는지 본다. TOML 의존성 없이 해당 표만 읽는다.
 * 키에 `#`이 들어갈 일이 없어 줄 끝 주석은 `#`부터 걷어낸다
 */
function codexPluginDisabled(codexHome: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return false;
  }
  // 알아보는 표기는 `[plugins."gestalt@gestalt"]` 표, 첫 표 머리 앞의 `plugins."gestalt@gestalt".enabled` 점 키,
  // `[plugins]` 표 아래 점 키와 한 줄 인라인 표다. 루트의 `plugins = { ... }` 인라인 표와 여러 줄 인라인 표는 안 읽는다
  let section: 'root' | 'plugin' | 'plugins' | null = 'root';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/\s*#.*$/, '').trim();
    if (trimmed.startsWith('[')) {
      if (/^\[\s*plugins\s*\.\s*(["'])gestalt@gestalt\1\s*\]$/.test(trimmed)) section = 'plugin';
      else if (/^\[\s*plugins\s*\]$/.test(trimmed)) section = 'plugins';
      else section = null;
      continue;
    }
    if (section === 'plugin' && /^enabled\s*=\s*false\b/.test(trimmed)) return true;
    if (
      section === 'root' &&
      /^plugins\s*\.\s*(["'])gestalt@gestalt\1\s*\.\s*enabled\s*=\s*false\b/.test(trimmed)
    ) {
      return true;
    }
    if (section !== 'plugins') continue;
    if (/^(["'])gestalt@gestalt\1\s*\.\s*enabled\s*=\s*false\b/.test(trimmed)) return true;
    // 안쪽 표의 enabled는 이 플러그인 값이 아니라서 중괄호가 낀 앞부분은 건너뛰지 않는다
    if (
      /^(["'])gestalt@gestalt\1\s*=\s*\{(?:[^{}]*,)?\s*enabled\s*=\s*false\s*[,}]/.test(trimmed)
    ) {
      return true;
    }
  }
  return false;
}

function codexLaunchers({ env, home }: Context): PluginLauncher[] {
  const codexHome = env['CODEX_HOME'] ? absoluteDir(env['CODEX_HOME']) : join(home, '.codex');
  if (codexHome === null || codexPluginDisabled(codexHome)) return [];
  const base = join(codexHome, 'plugins', 'cache', MARKETPLACE, PLUGIN_NAME);
  let versions: string[];
  try {
    versions = readdirSync(base);
  } catch {
    return [];
  }
  // Codex는 plugin/만 복사하므로 버전 디렉토리가 곧 플러그인 루트다
  return versions
    .filter((version) => insideCache(join(base, version), base))
    .map((version) => candidate(join(base, version), 'codex'))
    .filter((hit): hit is PluginLauncher => hit !== null);
}

function realLauncher(item: PluginLauncher): string {
  try {
    return realpathSync(item.launcher);
  } catch {
    return item.launcher;
  }
}

export function findPluginLaunchers(ctx: Context): PluginLauncher[] {
  // CLAUDE_CONFIG_DIR가 ~/.claude를 가리키거나 심링크로 이어져 있으면 같은 설치가 두 번 잡힌다
  const seen = new Set<string>();
  return [...claudeLaunchers(ctx), ...codexLaunchers(ctx)].filter((item) => {
    const key = realLauncher(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pickHighest(launchers: PluginLauncher[]): PluginLauncher | null {
  let best: PluginLauncher | null = null;
  for (const item of launchers) {
    if (best === null || compareSemver(item.version, best.version) > 0) best = item;
  }
  return best;
}

/**
 * `npm i -g`로 깐 자리인지 본다. 프로젝트 의존성, npx 캐시, pnpm dlx, bunx는 전부
 * `node_modules` 아래에서 돌지만 전역 설치가 아니라 고른 버전 그대로 돌아야 한다.
 */
export function isNpmGlobalInstall(selfPath: string): boolean {
  const match = /^(.+)[\\/]node_modules[\\/]@tienne[\\/]gestalt[\\/]/.exec(selfPath);
  if (!match) return false;
  const owner = match[1]!;
  // Windows 전역은 <prefix>\node_modules에 깔리고 실행 파일이 <prefix>\gestalt.cmd다
  if (existsSync(join(owner, 'gestalt.cmd'))) return true;
  // POSIX 전역은 <prefix>/lib/node_modules에 깔리고 실행 파일이 <prefix>/bin/gestalt다
  return basename(owner) === 'lib' && existsSync(join(dirname(owner), 'bin', 'gestalt'));
}

/**
 * 넘길 런처를 고른다. 넘기지 않을 때는 null이다.
 *
 * npm 전역 설치에서 돌 때만 넘긴다. 레포 체크아웃의 개발 빌드나 프로젝트 의존성,
 * npx 캐시에서 도는 실행은 그 버전 그대로 돈다. 다만 npx는 요청한 버전에 맞는 전역 설치가
 * 있으면 그 실행 파일을 부르고 버전을 안 적으면 전역에 깔린 어느 버전이든 맞는다고 본다.
 * 그래서 MCP 기동 경로는 `GESTALT_FOLLOW_PLUGIN=0`을 함께 건다.
 */
export function resolvePluginDelegation(options: {
  selfPath: string;
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): PluginLauncher | null {
  const env = options.env ?? process.env;
  if (env[FOLLOW_PLUGIN_ENV] === '0') return null;
  if (!isNpmGlobalInstall(options.selfPath)) return null;

  const best = pickHighest(findPluginLaunchers({ env, home: options.home ?? homedir() }));
  if (best === null || best.version === options.currentVersion) return null;
  return best;
}

interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * 플러그인 런처를 자식으로 띄우고 끝날 때까지 기다린다.
 * 시그널 전달 규칙은 plugin/scripts/gestalt-cli.mjs의 자식 실행부와 같게 맞춘다.
 */
export function runDelegated(
  target: PluginLauncher,
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; signals?: SignalSource } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const signals = options.signals ?? process;
  const child = spawn(process.execPath, [target.launcher, ...argv], {
    stdio: 'inherit',
    env: { ...(options.env ?? process.env), [FOLLOW_PLUGIN_ENV]: '0' },
  });
  const terminate = () => child.kill('SIGTERM');
  const hangup = () => child.kill('SIGHUP');
  // Ctrl-C는 프로세스 그룹 전체에 가므로 자식에게 다시 보내지 않는다
  const interrupt = () => {};
  signals.on('SIGTERM', terminate);
  signals.on('SIGHUP', hangup);
  signals.on('SIGINT', interrupt);
  const detach = () => {
    signals.off('SIGTERM', terminate);
    signals.off('SIGHUP', hangup);
    signals.off('SIGINT', interrupt);
  };
  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      detach();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      detach();
      resolve({ code, signal });
    });
  });
}
