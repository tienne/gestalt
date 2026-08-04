#!/usr/bin/env tsx
/**
 * Sync version from package.json → Claude Code and Codex plugin manifests.
 *
 * Codex reads plugin/.codex-plugin/plugin.json and shows its version in
 * `codex plugin list`, so it has to move with the others.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(
  `Synced version ${version} → plugin.json, marketplace.json, .codex-plugin/plugin.json`
);
