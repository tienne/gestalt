import { describe, it, expect } from 'vitest';
import { detectProjectType } from '../src/interview/brownfield.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

describe('detectProjectType', () => {
  const tmpDir = join('.gestalt', `test-brownfield-${randomUUID()}`);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects greenfield when no markers exist', () => {
    mkdirSync(tmpDir, { recursive: true });
    const result = detectProjectType(tmpDir);
    expect(result.projectType).toBe('greenfield');
    expect(result.detectedFiles).toHaveLength(0);
  });

  it('detects brownfield when 2+ markers exist', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), '{}');
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}');

    const result = detectProjectType(tmpDir);
    expect(result.projectType).toBe('brownfield');
    expect(result.detectedFiles).toContain('package.json');
    expect(result.detectedFiles).toContain('tsconfig.json');
  });

  it('detects greenfield with only 1 marker', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), '{}');

    const result = detectProjectType(tmpDir);
    expect(result.projectType).toBe('greenfield');
    expect(result.detectedFiles).toHaveLength(1);
  });
});
