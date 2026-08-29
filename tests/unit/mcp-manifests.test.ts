import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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

// 런처의 분기 순서는 이 PR의 핵심 로직인데 sh -n 문법 검사로는 안 잡힌다. 네트워크를
// 안 타는 두 분기(GESTALT_MCP_BIN 오버라이드, GESTALT_NODE 검증)만 스텁으로 굳힌다.
describe('scripts/mcp-serve.sh 분기 순서', () => {
  const launcher = resolve(ROOT, 'scripts/mcp-serve.sh');

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
        env: { ...process.env, GESTALT_MCP_BIN: stub },
        encoding: 'utf-8',
      });
      expect(out.trim()).toBe('STUB serve');
    });
  });

  it('GESTALT_NODE가 Node가 아니면 거기서 죽지 않고 탐색으로 넘어간다', () => {
    withStub((stub) => {
      const out = execFileSync('bash', [launcher], {
        env: { ...process.env, GESTALT_NODE: stub, GESTALT_MCP_BIN: stub },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out.trim()).toBe('STUB serve');
    });
  });
});
