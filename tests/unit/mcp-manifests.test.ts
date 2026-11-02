import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readManifest(relativePath: string): {
  mcpServers: Record<string, { command: string; args: string[] }>;
} {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf-8'));
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { version: string };

// npx가 버전 없는 스펙을 만나면 매번 npm의 latest를 끌어온다. 그러면 번들된 스킬은
// 이 버전인데 서버만 앞서 나간 조합이 생긴다. sync-version.ts가 핀을 갱신하는데,
// 릴리즈에서 그 단계를 건너뛰면 여기서 걸린다.
describe('Codex와 Grok MCP 매니페스트', () => {
  // 네 자리 전부 sync-version.ts가 갱신한다. 하나라도 빠지면 번들 스킬과 서버가
  // 어긋나므로, 파일마다가 아니라 목록째로 고정한다.
  it.each(['plugin/mcp.json', 'plugin/.mcp.json', '.mcp.json', '.claude-plugin/.mcp.json'])(
    '%s 가 package.json 버전으로 핀되어 있다',
    (path) => {
      const args = readManifest(path).mcpServers.gestalt!.args;
      expect(args.some((arg) => arg.includes(`@tienne/gestalt@${pkg.version}`))).toBe(true);
      expect(args.some((arg) => /@tienne\/gestalt(?!@)/.test(arg))).toBe(false);
    },
  );

  it('Grok이 읽는 점 파일이 plugin/mcp.json과 같다', () => {
    expect(readManifest('plugin/.mcp.json')).toEqual(readManifest('plugin/mcp.json'));
  });
});

describe('Claude MCP 매니페스트', () => {
  const paths = ['.mcp.json', '.claude-plugin/.mcp.json'];

  // plugin.json의 "mcpServers": "./.mcp.json" 이 플러그인 루트 기준인지
  // .claude-plugin/ 기준인지 관측으로 못 가른다. 어느 쪽이 로드돼도 같도록 둘을 맞춘다.
  it('두 위치의 내용이 같다', () => {
    expect(readManifest('.claude-plugin/.mcp.json')).toEqual(readManifest('.mcp.json'));
  });

  it.each(paths)('%s 가 런처를 거쳐 기동한다', (path) => {
    const server = readManifest(path).mcpServers.gestalt!;
    expect(server.command).toBe('sh');
    expect(server.args[1]).toContain('scripts/mcp-serve.sh');
  });

  // cwd 기준 경로를 후보로 두면 남의 레포를 열었을 때 거기 있는 동명 실행 파일이
  // 서버 대신 돈다. 로컬 런처는 실행 비트가 아니라 GESTALT_LAUNCHER로만 연다.
  it.each(paths)('%s 의 명령이 cwd 기준 경로를 후보로 안 쓴다', (path) => {
    const command = readManifest(path).mcpServers.gestalt!.args[1]!;
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(command).toContain('GESTALT_LAUNCHER');
    expect(command).not.toContain('$PWD');
    // 스크립트를 못 찾아도 서버는 떠야 한다.
    expect(command).toContain(`npx -y @tienne/gestalt@${pkg.version} serve`);
  });

  // 문자열 검사만으로는 상대 경로가 걸러지는지 모른다. 실제로 돌려서 본다.
  it('상대 경로 GESTALT_LAUNCHER는 cwd에 파일이 있어도 실행되지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-relpath-'));
    try {
      const nested = join(dir, 'scripts');
      mkdirSync(nested);
      writeFileSync(join(nested, 'mcp-serve.sh'), '#!/bin/sh\necho LAUNCHER_RAN\n', {
        mode: 0o755,
      });
      const command = readManifest('.mcp.json').mcpServers.gestalt!.args[1]!;
      const out = execFileSync('sh', ['-c', command.replace('exec npx', 'echo WOULD_NPX')], {
        cwd: dir,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: join(dir, 'absent'),
          GESTALT_LAUNCHER: 'scripts/mcp-serve.sh',
        },
        encoding: 'utf-8',
      });
      expect(out).not.toContain('LAUNCHER_RAN');
      expect(out).toContain('WOULD_NPX');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 빈 CLAUDE_PLUGIN_ROOT가 후보를 만들면 "/scripts/mcp-serve.sh"라는 고정 절대 경로가
  // 되어 절대 경로 가드를 그냥 통과한다. 값이 실제로 채워졌을 때만 후보가 되어야 한다.
  //
  // 판정은 `sh -x` 트레이스로 한다. 그 후보를 실제로 훑었는지는 실행 결과로는 안 보인다 —
  // 어느 쪽이든 그 경로에 파일이 없어 npx로 떨어지므로 stdout이 똑같다. 트레이스는
  // stderr로 나가니 stdout만 보면 이 테스트는 버그가 있어도 통과한다.
  it('CLAUDE_PLUGIN_ROOT가 비면 루트 경로를 후보로 삼지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-emptyroot-'));
    try {
      const command = readManifest('.mcp.json').mcpServers.gestalt!.args[1]!;
      const env = { ...process.env };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.GESTALT_LAUNCHER;
      const run = spawnSync('sh', ['-xc', command.replace('exec npx', 'echo WOULD_NPX')], {
        cwd: dir,
        env,
        encoding: 'utf-8',
      });
      const trace = `${run.stdout}${run.stderr}`;
      expect(trace).toContain('WOULD_NPX');
      // 가드가 없으면 트레이스에 `[ -x /scripts/mcp-serve.sh ]`가 찍힌다.
      expect(trace).not.toContain(' /scripts/mcp-serve.sh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('절대 경로 GESTALT_LAUNCHER는 실행되고 그 사실이 stderr에 남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-abspath-'));
    try {
      const stub = join(dir, 'launcher.sh');
      writeFileSync(stub, '#!/bin/sh\necho LAUNCHER_RAN\n', { mode: 0o755 });
      const command = readManifest('.mcp.json').mcpServers.gestalt!.args[1]!;
      const out = execFileSync('sh', ['-c', command.replace('exec npx', 'echo WOULD_NPX')], {
        cwd: dir,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: join(dir, 'absent'),
          GESTALT_LAUNCHER: stub,
        },
        encoding: 'utf-8',
      });
      expect(out).toContain('LAUNCHER_RAN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('명령이 sh 문법으로 유효하다', () => {
    const command = readManifest('.mcp.json').mcpServers.gestalt!.args[1]!;
    expect(() => execFileSync('sh', ['-n', '-c', command])).not.toThrow();
  });
});

// 런처의 분기 순서는 sh -n 문법 검사로는 안 잡힌다. 네트워크를 안 타는 분기(GESTALT_MCP_BIN
// 오버라이드, GESTALT_NODE 검증, 전역 gestalt와 핀의 버전 비교)만 스텁으로 굳힌다.
describe('scripts/mcp-serve.sh 분기 순서', () => {
  const launcher = resolve(ROOT, 'scripts/mcp-serve.sh');

  // 분기가 어긋나 진짜 서버가 뜨면 stdio 서버라 stdin을 기다리며 안 죽는다. 그대로 두면
  // 테스트가 실패하는 대신 멈춰서, 게이트를 돌린 사람이 원인을 못 보고 기다리게 된다.
  const LAUNCHER_TIMEOUT_MS = 15_000;

  /**
   * 런처에 물려줄 환경을 셸 프로필에서 떼어낸다.
   *
   * BASH_ENV 가 걸려 있으면 bash 는 비대화형으로 뜰 때도 그 파일을 읽는다. 거기서 PATH 를
   * 다시 깔면 이 테스트가 지정한 경로가 맨 뒤로 밀린다. 그러면 스텁 대신 그 PATH 에 있던
   * 전역 gestalt 가 잡힌다. 그러면 진짜 stdio 서버가 떠서 stdin 을 기다리고 테스트가 끝나지
   * 않는다. 개발자 머신에서만 재현되고 CI 는 BASH_ENV 가 없어 통과하므로 원인이 안 보인다.
   */
  const launcherEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
    delete env.BASH_ENV;
    return env;
  };

  // 전역 gestalt는 `--version`이 핀과 같을 때만 쓰인다. 이 테스트들의 node 스텁은 어떤
  // 질의에도 22를 돌려줘서 핀이 `@tienne/gestalt@22`가 되므로, 스텁도 22로 답한다.
  const STUB_PIN_VERSION = '22';
  const versionedStub = (onServe: string, version = STUB_PIN_VERSION): string =>
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; else echo "${onServe}"; fi\n`;

  function withStub<T>(body: (stub: string, dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-launcher-'));
    const stub = join(dir, 'fake-gestalt');
    writeFileSync(stub, '#!/bin/sh\necho "STUB $*"\n', { mode: 0o755 });
    try {
      return body(stub, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('GESTALT_MCP_BIN이 있으면 npx를 안 거치고 그걸 실행한다', () => {
    withStub((stub) => {
      const out = execFileSync('bash', [launcher], {
        env: launcherEnv({ GESTALT_MCP_BIN: stub }),
        encoding: 'utf-8',
        timeout: LAUNCHER_TIMEOUT_MS,
      });
      expect(out.trim()).toBe('STUB serve');
    });
  });

  // 실패 경로만 굳히면 오버라이드가 통째로 무력화되는 회귀가 안 잡힌다. 이 PR이 고친
  // 버그가 정확히 그것이라, 성공 경로도 함께 굳힌다.
  //
  // 두 디렉토리에 서로 다른 gestalt 스텁을 둔다. 오버라이드가 이기면 런처가 그 node의
  // 디렉토리를 PATH 앞에 붙이므로 A가 잡힌다. 무시되면 PATH에 있던 B가 잡힌다. 어느
  // 쪽이든 npx까지 안 가므로 네트워크를 안 탄다.
  it('유효한 GESTALT_NODE는 탐색 결과를 이긴다', () => {
    const overrideDir = mkdtempSync(join(tmpdir(), 'gestalt-node-a-'));
    const pathDir = mkdtempSync(join(tmpdir(), 'gestalt-node-b-'));
    try {
      writeFileSync(join(overrideDir, 'node'), '#!/bin/sh\necho 22\n', { mode: 0o755 });
      writeFileSync(join(overrideDir, 'gestalt'), versionedStub('FROM_OVERRIDE'), {
        mode: 0o755,
      });
      writeFileSync(join(pathDir, 'gestalt'), versionedStub('FROM_PATH'), { mode: 0o755 });
      const run = spawnSync('bash', [launcher], {
        env: launcherEnv({
          PATH: `${pathDir}:${process.env.PATH ?? ''}`,
          GESTALT_NODE: join(overrideDir, 'node'),
        }),
        encoding: 'utf-8',
        timeout: LAUNCHER_TIMEOUT_MS,
      });
      expect(run.stdout.trim()).toBe('FROM_OVERRIDE');
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  // GESTALT_MCP_BIN을 같이 주면 그 분기에서 먼저 빠져나가 pick_node에 닿지도 않는다.
  // 여기서는 PATH에 gestalt 스텁을 심어, 잘못된 GESTALT_NODE로 pick_node를 통과한 뒤
  // 전역 분기에서 멈추게 한다. 네트워크를 안 타면서 경고가 실제로 찍히는지 본다.
  it('GESTALT_NODE가 Node가 아니면 경고를 남기고 탐색으로 넘어간다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-badnode-'));
    try {
      writeFileSync(join(dir, 'gestalt'), versionedStub('STUB $*'), { mode: 0o755 });
      // 런처는 pick_node가 고른 node의 디렉토리를 PATH 맨 앞에 다시 붙인다. 실제 PATH를
      // 그대로 물려주면 node와 전역 gestalt가 같은 디렉토리에 깔린 머신(예: Homebrew)에서
      // 그 디렉토리가 이 스텁을 밀어낸다. 그러면 진짜 stdio 서버가 떠 stdin을 기다리고
      // 테스트가 끝나지 않는다. 탐색이 이 디렉토리 안에서 끝나도록 PATH를 좁힌다 —
      // /usr/bin 과 /bin 은 런처가 쓰는 dirname 같은 외부 명령 몫이고 gestalt는 없다.
      writeFileSync(join(dir, 'node'), '#!/bin/sh\necho 22\n', { mode: 0o755 });
      const run = spawnSync('bash', [launcher], {
        env: launcherEnv({ PATH: `${dir}:/usr/bin:/bin`, GESTALT_NODE: '/bin/echo' }),
        encoding: 'utf-8',
        timeout: LAUNCHER_TIMEOUT_MS,
      });
      expect(run.stderr).toContain('is not Node >= 22');
      expect(run.stdout.trim()).toBe('STUB serve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 전역 버전이 핀과 다르면 무시하고 npx 해석 결과(핀된 버전)를 써야 한다.
  // npx 는 스텁으로 막아 네트워크를 안 탄다.
  it('전역 gestalt 버전이 핀과 다르면 무시하고 핀된 버전을 쓴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-stale-global-'));
    try {
      writeFileSync(join(dir, 'node'), '#!/bin/sh\necho 22\n', { mode: 0o755 });
      writeFileSync(join(dir, 'gestalt'), versionedStub('FROM_STALE_GLOBAL', '21'), {
        mode: 0o755,
      });
      const resolved = join(dir, 'resolved-gestalt');
      writeFileSync(resolved, '#!/bin/sh\necho "RESOLVED $*"\n', { mode: 0o755 });
      writeFileSync(join(dir, 'npx'), `#!/bin/sh\necho ${resolved}\n`, { mode: 0o755 });
      const run = spawnSync('bash', [launcher], {
        env: launcherEnv({ PATH: `${dir}:/usr/bin:/bin`, GESTALT_NODE: join(dir, 'node') }),
        encoding: 'utf-8',
        timeout: LAUNCHER_TIMEOUT_MS,
      });
      expect(run.stderr).toContain('differs from pin');
      expect(run.stdout.trim()).toBe('RESOLVED serve');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 파일 이름 → 내용으로 스텁을 깔고 런처를 돌린다. npx 스텁은 같은 디렉토리의
  // resolved-gestalt 를 해석 결과로 돌려줘서 네트워크를 안 탄다.
  const runWithStubs = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'gestalt-version-gate-'));
    try {
      writeFileSync(join(dir, 'resolved-gestalt'), '#!/bin/sh\necho "RESOLVED $*"\n', {
        mode: 0o755,
      });
      writeFileSync(join(dir, 'npx'), '#!/bin/sh\necho "$(dirname "$0")/resolved-gestalt"\n', {
        mode: 0o755,
      });
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body, { mode: 0o755 });
      }
      return spawnSync('bash', [launcher], {
        env: launcherEnv({ PATH: `${dir}:/usr/bin:/bin`, GESTALT_NODE: join(dir, 'node') }),
        encoding: 'utf-8',
        timeout: LAUNCHER_TIMEOUT_MS,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const PIN_22_NODE = '#!/bin/sh\necho 22\n';

  // package.json 에서 버전을 못 읽으면 비교할 기준이 없다. 이때는 전역을 그대로 쓴다.
  // 핀 조회(`-p require(...)`)만 실패하게 하고 pick_node 의 버전 확인(`-p process...`)은 통과시킨다.
  it('핀을 못 읽으면 버전 비교 없이 전역 gestalt를 쓴다', () => {
    const run = runWithStubs({
      node: '#!/bin/sh\ncase "$2" in *require*) exit 1;; *) echo 22;; esac\n',
      gestalt: versionedStub('FROM_GLOBAL', '21'),
    });
    expect(run.stderr).toContain('no version pin');
    expect(run.stdout.trim()).toBe('FROM_GLOBAL');
  });

  it('전역 gestalt가 --version에서 비정상 종료하면 무시한다', () => {
    const run = runWithStubs({
      node: PIN_22_NODE,
      gestalt: '#!/bin/sh\nexit 1\n',
    });
    expect(run.stderr).toContain('unknown version');
    expect(run.stdout.trim()).toBe('RESOLVED serve');
  });

  // 스텁은 제어 문자와 `$(...)` 를 문자 그대로 찍는다. 작은따옴표 안이라 스텁 쉘은 실행하지 않는다.
  // 런처가 정제하지 않으면 stderr 에 그대로 남는다.
  it('--version 출력의 제어 문자와 쉘 문자는 로그에 남기지 않는다', () => {
    const run = runWithStubs({
      node: PIN_22_NODE,
      gestalt: `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '1.2.3\\033[31m$(touch x)\\n'; else echo FROM_GLOBAL; fi\n`,
    });
    expect(run.stdout.trim()).toBe('RESOLVED serve');
    expect(run.stderr).toContain('global gestalt 1.2.331mtouchx');
    expect(run.stderr).not.toContain('\x1b');
    expect(run.stderr).not.toContain('$(');
  });

  it('--version 출력의 공백과 캐리지 리턴은 버전 비교 전에 걷어낸다', () => {
    const run = runWithStubs({
      node: PIN_22_NODE,
      gestalt: `#!/bin/sh\nif [ "$1" = "--version" ]; then printf ' ${STUB_PIN_VERSION}\\r\\n'; else echo FROM_GLOBAL; fi\n`,
    });
    expect(run.stdout.trim()).toBe('FROM_GLOBAL');
  });

  it('--version 출력이 여러 줄이면 마지막 줄을 버전으로 본다', () => {
    const run = runWithStubs({
      node: PIN_22_NODE,
      gestalt: `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "update available"; echo ${STUB_PIN_VERSION}; else echo FROM_GLOBAL; fi\n`,
    });
    expect(run.stdout.trim()).toBe('FROM_GLOBAL');
  });
});
