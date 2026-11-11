import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPluginLaunchers,
  pickHighest,
  resolvePluginDelegation,
} from '../../src/cli/follow-plugin.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'follow-plugin-'));
  dirs.push(dir);
  return dir;
}

function pluginRoot(root: string, version: string) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'gestalt-cli.mjs'), '');
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version }));
}

function claudeInstall(configDir: string, key: string, installs: string[]) {
  mkdirSync(join(configDir, 'plugins'), { recursive: true });
  writeFileSync(
    join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { [key]: installs.map((installPath) => ({ scope: 'user', installPath })) },
    }),
  );
}

const GLOBAL_BIN = '/usr/local/lib/node_modules/@tienne/gestalt/dist/bin/gestalt.js';

describe('findPluginLaunchers', () => {
  it('Claude 등록부와 Codex 캐시를 둘 다 훑는다', () => {
    const home = tempHome();
    const claudeRepo = join(home, 'claude-cache', '0.126.0');
    pluginRoot(join(claudeRepo, 'plugin'), '0.126.0');
    claudeInstall(join(home, '.claude'), 'gestalt@gestalt', [claudeRepo]);
    pluginRoot(
      join(home, '.codex', 'plugins', 'cache', 'gestalt', 'gestalt', '0.127.0'),
      '0.127.0',
    );

    const found = findPluginLaunchers({ env: {}, home });
    expect(found.map((f) => [f.host, f.version]).sort()).toEqual([
      ['claude', '0.126.0'],
      ['codex', '0.127.0'],
    ]);
  });

  it('CLAUDE_CONFIG_DIR와 CODEX_HOME을 따른다', () => {
    const home = tempHome();
    const other = join(home, 'profile');
    const repo = join(home, 'repo');
    pluginRoot(join(repo, 'plugin'), '0.130.0');
    claudeInstall(other, 'gestalt@my-market', [repo]);
    const codexHome = join(home, 'codex-home');
    pluginRoot(join(codexHome, 'plugins', 'cache', 'mk', 'gestalt', '0.129.0'), '0.129.0');

    const found = findPluginLaunchers({
      env: { CLAUDE_CONFIG_DIR: other, CODEX_HOME: codexHome },
      home,
    });
    expect(found.map((f) => f.version).sort()).toEqual(['0.129.0', '0.130.0']);
  });

  it('런처가 없거나 매니페스트 버전이 깨진 설치는 건너뛴다', () => {
    const home = tempHome();
    const noLauncher = join(home, 'a');
    mkdirSync(join(noLauncher, 'plugin', '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(noLauncher, 'plugin', '.codex-plugin', 'plugin.json'),
      '{"version":"1.0.0"}',
    );
    const badVersion = join(home, 'b');
    pluginRoot(join(badVersion, 'plugin'), 'latest');
    claudeInstall(join(home, '.claude'), 'gestalt@gestalt', [noLauncher, badVersion]);

    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);
  });

  it('등록부가 없거나 깨져도 던지지 않는다', () => {
    const home = tempHome();
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);
  });
});

describe('pickHighest', () => {
  it('semver로 가장 높은 버전을 고른다', () => {
    const items = ['0.99.0', '0.127.0', '0.126.3'].map((version) => ({
      launcher: version,
      version,
      host: 'claude' as const,
    }));
    expect(pickHighest(items)?.version).toBe('0.127.0');
    expect(pickHighest([])).toBeNull();
  });
});

describe('resolvePluginDelegation', () => {
  function setup(version: string) {
    const home = tempHome();
    pluginRoot(join(home, '.codex', 'plugins', 'cache', 'gestalt', 'gestalt', version), version);
    return home;
  }

  it('전역 설치 버전과 플러그인 버전이 다르면 런처를 돌려준다', () => {
    const home = setup('0.128.0');
    const hit = resolvePluginDelegation({
      selfPath: GLOBAL_BIN,
      currentVersion: '0.127.0',
      env: {},
      home,
    });
    expect(hit?.version).toBe('0.128.0');
  });

  it('플러그인이 더 낮아도 플러그인을 따른다', () => {
    const home = setup('0.120.0');
    const hit = resolvePluginDelegation({
      selfPath: GLOBAL_BIN,
      currentVersion: '0.127.0',
      env: {},
      home,
    });
    expect(hit?.version).toBe('0.120.0');
  });

  it('버전이 같으면 넘기지 않는다', () => {
    const home = setup('0.127.0');
    expect(
      resolvePluginDelegation({ selfPath: GLOBAL_BIN, currentVersion: '0.127.0', env: {}, home }),
    ).toBeNull();
  });

  it('GESTALT_FOLLOW_PLUGIN=0이면 넘기지 않는다', () => {
    const home = setup('0.128.0');
    expect(
      resolvePluginDelegation({
        selfPath: GLOBAL_BIN,
        currentVersion: '0.127.0',
        env: { GESTALT_FOLLOW_PLUGIN: '0' },
        home,
      }),
    ).toBeNull();
  });

  it('레포 체크아웃 빌드와 npx 실행은 넘기지 않는다', () => {
    const home = setup('0.128.0');
    for (const selfPath of [
      '/work/gestalt/dist/bin/gestalt.js',
      '/home/me/.npm/_npx/abc/node_modules/@tienne/gestalt/dist/bin/gestalt.js',
    ]) {
      expect(
        resolvePluginDelegation({ selfPath, currentVersion: '0.127.0', env: {}, home }),
      ).toBeNull();
    }
  });

  it('플러그인이 없으면 넘기지 않는다', () => {
    expect(
      resolvePluginDelegation({
        selfPath: GLOBAL_BIN,
        currentVersion: '0.127.0',
        env: {},
        home: tempHome(),
      }),
    ).toBeNull();
  });
});
