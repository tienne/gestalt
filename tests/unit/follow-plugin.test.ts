import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPluginLaunchers,
  isNpmGlobalInstall,
  pickHighest,
  resolvePluginDelegation,
  runDelegated,
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

function pluginRoot(root: string, version: string, name = 'gestalt') {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'gestalt-cli.mjs'), '');
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version }));
}

/** Claude가 플러그인을 까는 자리 <configDir>/plugins/cache/gestalt/gestalt/<버전> */
function claudeRepo(configDir: string, version: string): string {
  return join(configDir, 'plugins', 'cache', 'gestalt', 'gestalt', version);
}

function claudeInstall(
  configDir: string,
  installs: string[],
  options: { key?: string; scope?: string } = {},
) {
  mkdirSync(join(configDir, 'plugins'), { recursive: true });
  writeFileSync(
    join(configDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        [options.key ?? 'gestalt@gestalt']: installs.map((installPath) => ({
          scope: options.scope ?? 'user',
          installPath,
        })),
      },
    }),
  );
}

function codexInstall(codexHome: string, version: string, marketplace = 'gestalt') {
  pluginRoot(join(codexHome, 'plugins', 'cache', marketplace, 'gestalt', version), version);
}

/** <prefix>/lib/node_modules/@tienne/gestalt 꼴의 가짜 npm 전역 설치를 만들고 실행 파일 경로를 준다 */
function npmGlobal(prefix: string): string {
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'gestalt'), '');
  return join(prefix, 'lib', 'node_modules', '@tienne', 'gestalt', 'dist', 'bin', 'gestalt.js');
}

describe('findPluginLaunchers', () => {
  it('Claude 등록부와 Codex 캐시를 둘 다 훑는다', () => {
    const home = tempHome();
    const repo = claudeRepo(join(home, '.claude'), '0.126.0');
    pluginRoot(join(repo, 'plugin'), '0.126.0');
    claudeInstall(join(home, '.claude'), [repo]);
    codexInstall(join(home, '.codex'), '0.127.0');

    const found = findPluginLaunchers({ env: {}, home });
    expect(found.map((f) => [f.host, f.version]).sort()).toEqual([
      ['claude', '0.126.0'],
      ['codex', '0.127.0'],
    ]);
  });

  it('CLAUDE_CONFIG_DIR와 CODEX_HOME을 따른다', () => {
    const home = tempHome();
    const other = join(home, 'profile');
    const repo = claudeRepo(other, '0.130.0');
    pluginRoot(join(repo, 'plugin'), '0.130.0');
    claudeInstall(other, [repo]);
    const codexHome = join(home, 'codex-home');
    codexInstall(codexHome, '0.129.0');

    const found = findPluginLaunchers({
      env: { CLAUDE_CONFIG_DIR: other, CODEX_HOME: codexHome },
      home,
    });
    expect(found.map((f) => f.version).sort()).toEqual(['0.129.0', '0.130.0']);
  });

  it('런처가 없거나 매니페스트 버전이 깨진 설치는 건너뛴다', () => {
    const home = tempHome();
    const noLauncher = claudeRepo(join(home, '.claude'), '1.0.0');
    mkdirSync(join(noLauncher, 'plugin', '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(noLauncher, 'plugin', '.codex-plugin', 'plugin.json'),
      '{"version":"1.0.0"}',
    );
    const badVersion = claudeRepo(join(home, '.claude'), 'latest');
    pluginRoot(join(badVersion, 'plugin'), 'latest');
    claudeInstall(join(home, '.claude'), [noLauncher, badVersion]);

    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);
  });

  it('공식 마켓플레이스가 아닌 설치와 프로젝트 범위 설치는 건너뛴다', () => {
    const home = tempHome();
    const repo = claudeRepo(join(home, '.claude'), '0.130.0');
    pluginRoot(join(repo, 'plugin'), '0.130.0');
    const other = join(home, 'other');
    const otherRepo = claudeRepo(other, '0.130.0');
    pluginRoot(join(otherRepo, 'plugin'), '0.130.0');
    claudeInstall(join(home, '.claude'), [repo], { key: 'gestalt@my-market' });
    claudeInstall(other, [otherRepo], { scope: 'project' });
    codexInstall(join(home, '.codex'), '0.129.0', 'my-market');

    expect(findPluginLaunchers({ env: { CLAUDE_CONFIG_DIR: other }, home })).toEqual([]);
  });

  it('상대 경로로 적힌 설치와 환경변수는 건너뛴다', () => {
    const home = tempHome();
    claudeInstall(join(home, '.claude'), ['relative/repo']);
    codexInstall(join(home, '.codex'), '0.129.0');

    expect(
      findPluginLaunchers({
        env: { CLAUDE_CONFIG_DIR: 'profile', CODEX_HOME: 'codex-home' },
        home,
      }),
    ).toEqual([]);
  });

  it('Codex config.toml에서 꺼 둔 플러그인은 건너뛴다', () => {
    const home = tempHome();
    codexInstall(join(home, '.codex'), '0.129.0');
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      '[plugins."other@gestalt"]\nenabled = true\n\n[plugins."gestalt@gestalt"]\nenabled = false\n',
    );
    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);
  });

  it('Codex 표 머리와 값에 줄 끝 주석이 붙어도 꺼 둔 걸 알아본다', () => {
    const home = tempHome();
    codexInstall(join(home, '.codex'), '0.129.0');
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      '[plugins."gestalt@gestalt"] # 잠깐 끔\nenabled = false # 메모\n',
    );
    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);
  });

  it('Claude settings.json에서 꺼 둔 플러그인은 건너뛰고 깨진 settings는 켜진 걸로 본다', () => {
    const home = tempHome();
    const claude = join(home, '.claude');
    const repo = claudeRepo(claude, '0.126.0');
    pluginRoot(join(repo, 'plugin'), '0.126.0');
    claudeInstall(claude, [repo]);

    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'gestalt@gestalt': false } }),
    );
    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);

    writeFileSync(join(claude, 'settings.json'), '{not json');
    expect(findPluginLaunchers({ env: {}, home })).toHaveLength(1);
  });

  it('마켓플레이스 캐시 밖 설치와 이름이 다른 매니페스트는 건너뛴다', () => {
    const home = tempHome();
    const claude = join(home, '.claude');
    const outside = join(home, 'elsewhere', '0.130.0');
    pluginRoot(join(outside, 'plugin'), '0.130.0');
    // 접두만 같은 이웃 디렉토리도 캐시 밖이다
    const sibling = join(claude, 'plugins', 'cache', 'gestalt', 'gestalt-evil', '0.130.0');
    pluginRoot(join(sibling, 'plugin'), '0.130.0');
    const renamed = claudeRepo(claude, '0.131.0');
    pluginRoot(join(renamed, 'plugin'), '0.131.0', 'not-gestalt');
    claudeInstall(claude, [outside, sibling, renamed]);
    pluginRoot(
      join(home, '.codex', 'plugins', 'cache', 'gestalt', 'gestalt', '0.132.0'),
      '0.132.0',
      'x',
    );

    expect(findPluginLaunchers({ env: {}, home })).toEqual([]);
  });

  it('plugins 디렉토리가 심링크여도 실제 경로로 캐시 안을 판정한다', () => {
    const home = tempHome();
    const shared = join(home, 'shared-plugins');
    const repo = join(shared, 'cache', 'gestalt', 'gestalt', '0.126.0');
    pluginRoot(join(repo, 'plugin'), '0.126.0');
    const profile = join(home, 'profile');
    mkdirSync(profile, { recursive: true });
    symlinkSync(shared, join(profile, 'plugins'));
    claudeInstall(profile, [repo]);
    // 심링크 밖의 진짜 경로로 적혀 있어도 같은 캐시다
    expect(
      findPluginLaunchers({ env: { CLAUDE_CONFIG_DIR: profile }, home }).map((f) => f.version),
    ).toEqual(['0.126.0']);
  });

  it('CLAUDE_CONFIG_DIR가 ~/.claude와 같은 설치를 가리키면 한 번만 센다', () => {
    const home = tempHome();
    const repo = claudeRepo(join(home, '.claude'), '0.126.0');
    pluginRoot(join(repo, 'plugin'), '0.126.0');
    claudeInstall(join(home, '.claude'), [repo]);
    const linked = join(home, 'linked-claude');
    symlinkSync(join(home, '.claude'), linked);

    for (const dir of [join(home, '.claude'), linked]) {
      expect(findPluginLaunchers({ env: { CLAUDE_CONFIG_DIR: dir }, home })).toHaveLength(1);
    }
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

describe('isNpmGlobalInstall', () => {
  it('POSIX와 Windows npm 전역 설치를 알아본다', () => {
    const home = tempHome();
    expect(isNpmGlobalInstall(npmGlobal(join(home, 'usr-local')))).toBe(true);

    const winPrefix = join(home, 'AppData', 'npm');
    mkdirSync(winPrefix, { recursive: true });
    writeFileSync(join(winPrefix, 'gestalt.cmd'), '');
    expect(
      isNpmGlobalInstall(
        join(winPrefix, 'node_modules', '@tienne', 'gestalt', 'dist', 'bin', 'gestalt.js'),
      ),
    ).toBe(true);
  });

  it('체크아웃, 프로젝트 의존성, npx, pnpm dlx, bunx는 전역으로 안 본다', () => {
    const home = tempHome();
    const pkg = join('node_modules', '@tienne', 'gestalt', 'dist', 'bin', 'gestalt.js');
    const project = join(home, 'proj');
    mkdirSync(join(project, 'bin'), { recursive: true });
    writeFileSync(join(project, 'bin', 'gestalt'), '');
    for (const selfPath of [
      join(home, 'work', 'gestalt', 'dist', 'bin', 'gestalt.js'),
      join(project, pkg),
      join(home, '.npm', '_npx', 'abc', pkg),
      join(home, 'Library', 'Caches', 'pnpm', 'dlx', 'abc', pkg),
      join(home, 'bunx-501-@tienne', pkg),
    ]) {
      expect(isNpmGlobalInstall(selfPath)).toBe(false);
    }
  });
});

describe('resolvePluginDelegation', () => {
  let GLOBAL_BIN = '';
  function setup(version: string) {
    const home = tempHome();
    codexInstall(join(home, '.codex'), version);
    GLOBAL_BIN = npmGlobal(join(home, 'prefix'));
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

  it('npm 전역 설치가 아니면 넘기지 않는다', () => {
    const home = setup('0.128.0');
    const selfPath = join(
      home,
      '.npm',
      '_npx',
      'abc',
      'node_modules',
      '@tienne',
      'gestalt',
      'x.js',
    );
    expect(
      resolvePluginDelegation({ selfPath, currentVersion: '0.127.0', env: {}, home }),
    ).toBeNull();
  });

  it('플러그인이 없으면 넘기지 않는다', () => {
    const home = tempHome();
    expect(
      resolvePluginDelegation({
        selfPath: npmGlobal(join(home, 'prefix')),
        currentVersion: '0.127.0',
        env: {},
        home,
      }),
    ).toBeNull();
  });
});

describe('runDelegated', () => {
  function fakeLauncher(body: string) {
    const dir = tempHome();
    const launcher = join(dir, 'gestalt-cli.mjs');
    writeFileSync(launcher, body);
    return { launcher, version: '0.128.0', host: 'codex' as const };
  }

  it('인자를 넘기고 자식에 끄기 환경변수를 붙여 종료 코드를 돌려준다', async () => {
    const target = fakeLauncher(
      `if (process.argv[2] !== 'a' || process.env.GESTALT_FOLLOW_PLUGIN !== '0') process.exit(1);\nprocess.exit(7);\n`,
    );
    await expect(runDelegated(target, ['a'], { env: {} })).resolves.toEqual({
      code: 7,
      signal: null,
    });
  });

  it('SIGTERM을 자식에게 전하고 끝나면 리스너를 뗀다', async () => {
    const target = fakeLauncher(`setInterval(() => {}, 1000);\n`);
    const signals = new EventEmitter();
    const run = runDelegated(target, [], { env: {}, signals });
    await new Promise((resolve) => setTimeout(resolve, 300));
    signals.emit('SIGTERM');
    await expect(run).resolves.toEqual({ code: null, signal: 'SIGTERM' });
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
});
