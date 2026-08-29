import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  const paths = ['plugin/mcp.json', 'plugin/.mcp.json'];

  it.each(paths)('%s 가 package.json 버전으로 핀되어 있다', (path) => {
    const args = readManifest(path).mcpServers.gestalt!.args;
    expect(args).toContain(`@tienne/gestalt@${pkg.version}`);
  });

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

  it.each(paths)('%s 의 명령이 플러그인 루트와 cwd를 모두 훑는다', (path) => {
    const command = readManifest(path).mcpServers.gestalt!.args[1]!;
    expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(command).toContain('$PWD');
    // 스크립트를 못 찾아도 서버는 떠야 한다.
    expect(command).toContain('npx -y @tienne/gestalt serve');
  });

  it('명령이 sh 문법으로 유효하다', () => {
    const command = readManifest('.mcp.json').mcpServers.gestalt!.args[1]!;
    expect(() => execFileSync('sh', ['-n', '-c', command])).not.toThrow();
  });
});
