import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectType } from '../core/types.js';

const BROWNFIELD_MARKERS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  '.git',
  'src',
];

export interface BrownfieldResult {
  projectType: ProjectType;
  detectedFiles: string[];
}

export function detectProjectType(cwd?: string): BrownfieldResult {
  const dir = cwd ?? process.cwd();
  const detectedFiles: string[] = [];

  for (const marker of BROWNFIELD_MARKERS) {
    if (existsSync(join(dir, marker))) {
      detectedFiles.push(marker);
    }
  }

  return {
    projectType: detectedFiles.length >= 2 ? 'brownfield' : 'greenfield',
    detectedFiles,
  };
}
