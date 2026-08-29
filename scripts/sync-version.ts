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
 * Codex와 Grok은 MCP 서버를 npx로 직접 띄운다. 스펙에 버전이 없으면 npx가 매번
 * npm의 latest를 끌어오므로, 번들된 스킬은 이 버전인데 서버만 한 발 앞선 조합이
 * 만들어진다. 핀을 여기서 같이 올려 둘이 어긋나지 않게 한다.
 *
 * Claude 쪽 매니페스트(.mcp.json)는 scripts/mcp-serve.sh를 거친다. 그 스크립트가
 * package.json에서 버전을 직접 읽으므로 여기서 건드릴 게 없다.
 */
const NPX_MANIFESTS = [
  resolve(ROOT, 'plugin', 'mcp.json'),
  resolve(ROOT, 'plugin', '.mcp.json'),
];

for (const manifestPath of NPX_MANIFESTS) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const args: unknown = manifest.mcpServers?.gestalt?.args;
  if (!Array.isArray(args)) {
    console.error(`${manifestPath}: mcpServers.gestalt.args 가 배열이 아닙니다.`);
    process.exit(1);
  }
  const index = args.findIndex(
    (arg) => typeof arg === 'string' && arg.startsWith('@tienne/gestalt')
  );
  if (index === -1) {
    console.error(`${manifestPath}: @tienne/gestalt 스펙을 찾지 못했습니다.`);
    process.exit(1);
  }
  args[index] = `@tienne/gestalt@${version}`;
  // JSON.stringify는 args를 세 줄로 펼쳐 놓는다. 릴리즈마다 의미 없는 diff가
  // 쌓이지 않게 레포 prettier 설정으로 되돌린다.
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  const prettierConfig = await resolveConfig(manifestPath);
  writeFileSync(manifestPath, await format(raw, { ...prettierConfig, filepath: manifestPath }));
}

console.log(
  `Synced version ${version} → plugin.json, marketplace.json, .codex-plugin/plugin.json, plugin/mcp.json, plugin/.mcp.json`
);
