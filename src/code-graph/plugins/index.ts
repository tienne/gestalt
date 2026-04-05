import { extname } from 'node:path';
import type { AnalyzerPlugin } from '../types.js';

export { typescriptPlugin } from './typescript.js';
export { pythonPlugin } from './python.js';
export { goPlugin } from './go.js';
export { javaPlugin } from './java.js';
export { kotlinPlugin } from './kotlin.js';
export { rustPlugin } from './rust.js';
export { swiftPlugin } from './swift.js';
export { objcPlugin } from './objc.js';

import { typescriptPlugin } from './typescript.js';
import { pythonPlugin } from './python.js';
import { goPlugin } from './go.js';
import { javaPlugin } from './java.js';
import { kotlinPlugin } from './kotlin.js';
import { rustPlugin } from './rust.js';
import { swiftPlugin } from './swift.js';
import { objcPlugin } from './objc.js';

export const pluginRegistry: AnalyzerPlugin[] = [
  typescriptPlugin,
  pythonPlugin,
  goPlugin,
  javaPlugin,
  kotlinPlugin,
  rustPlugin,
  swiftPlugin,
  objcPlugin,
];

/**
 * Returns the appropriate plugin for a given file path based on extension.
 * Returns null if no plugin supports the file type.
 */
export function getPluginForFile(filePath: string): AnalyzerPlugin | null {
  const ext = extname(filePath).toLowerCase();
  return pluginRegistry.find((p) => p.extensions.includes(ext)) ?? null;
}
