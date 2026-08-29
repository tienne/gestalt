#!/usr/bin/env tsx
/**
 * Sync version from package.json → Claude Code and Codex plugin manifests.
 *
 * Codex reads plugin/.codex-plugin/plugin.json and shows its version in
 * `codex plugin list`, so it has to move with the others. plugin/mcp.json and
 * plugin/.mcp.json pin the npx spec to the same version, so they move too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const version: string = pkg.version;

// plugin.json
const pluginPath = resolve(ROOT, '.claude-plugin', 'plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'));
plugin.version = version;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');

// marketplace.json
const marketplacePath = resolve(ROOT, '.claude-plugin', 'marketplace.json');
const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'));
if (marketplace.metadata) {
  marketplace.metadata.version = version;
}
for (const p of marketplace.plugins) {
  p.version = version;
}
writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');

// Codex plugin.json
const codexPluginPath = resolve(ROOT, 'plugin', '.codex-plugin', 'plugin.json');
const codexPlugin = JSON.parse(readFileSync(codexPluginPath, 'utf-8'));
codexPlugin.version = version;
writeFileSync(codexPluginPath, JSON.stringify(codexPlugin, null, 2) + '\n');

/**
 * 버전 없는 npx 스펙은 매번 npm의 latest를 끌어온다. 그러면 번들된 스킬은 이 버전인데
 * 서버만 한 발 앞선 조합이 생긴다. 그 조합이 나올 수 있는 자리는 네 곳이고 전부 여기서
 * 같이 올린다.
 *
 * Codex와 Grok(plugin/*)은 npx를 인자 배열로 직접 부른다. Claude(.mcp.json 쪽)는
 * scripts/mcp-serve.sh를 거친다. 다만 그 스크립트를 못 찾았을 때 도는 최후 폴백이 매니페스트
 * 안의 sh 문자열에 박혀 있다. 스크립트가 없다는 건 package.json도 없다는 뜻이라 그 자리는
 * 런타임에 버전을 못 읽는다. 그래서 문자열 안의 스펙을 여기서 갈아 끼운다.
 */
const NPX_MANIFESTS = [
  resolve(ROOT, 'plugin', 'mcp.json'),
  resolve(ROOT, 'plugin', '.mcp.json'),
  resolve(ROOT, '.mcp.json'),
  resolve(ROOT, '.claude-plugin', '.mcp.json'),
];

const SPEC_PATTERN = /@tienne\/gestalt(@[^\s"']+)?/;

/**
 * 같은 쌍끼리 내용이 같아야 한다는 규칙을 테스트가 지킨다(파싱 결과 기준이지 바이트 기준은
 * 아니다). 하나를 쓴 뒤 다음 파일에서 exit하면 릴리즈 도중에 그 규칙이 깨진 채 남으므로,
 * 검증과 포맷을 전부 끝낸 뒤에 쓰기로 넘어간다.
 *
 * prettier 설정은 넷 다 같은 레포 루트 아래에서 나오므로 한 번만 찾는다.
 */
const prettierConfig = await resolveConfig(NPX_MANIFESTS[0]!);
const pending: { path: string; contents: string }[] = [];

for (const manifestPath of NPX_MANIFESTS) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const args: unknown = manifest.mcpServers?.gestalt?.args;
  if (!Array.isArray(args)) {
    console.error(`${manifestPath}: mcpServers.gestalt.args 가 배열이 아닙니다.`);
    process.exit(1);
  }
  const index = args.findIndex((arg) => typeof arg === 'string' && SPEC_PATTERN.test(arg));
  if (index === -1) {
    console.error(`${manifestPath}: @tienne/gestalt 스펙을 찾지 못했습니다.`);
    process.exit(1);
  }
  // 인자 하나가 통째로 스펙인 경우(plugin/*)와 sh 문자열 안에 박힌 경우(.mcp.json 쪽)를
  // 같은 치환으로 다룬다.
  args[index] = (args[index] as string).replace(SPEC_PATTERN, `@tienne/gestalt@${version}`);
  // JSON.stringify는 args를 여러 줄로 펼쳐 놓는다. 릴리즈마다 의미 없는 diff가
  // 쌓이지 않게 레포 prettier 설정으로 되돌린다.
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  pending.push({
    path: manifestPath,
    contents: await format(raw, { ...prettierConfig, filepath: manifestPath }),
  });
}

for (const { path, contents } of pending) {
  writeFileSync(path, contents);
}

console.log(
  `Synced version ${version} → plugin.json, marketplace.json, .codex-plugin/plugin.json, and 4 MCP manifests`
);
