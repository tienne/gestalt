import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// We test the setup logic by importing the function and running it in a temp dir
import { setupCommand } from '../src/cli/commands/setup.js';

describe('setupCommand', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = join('.gestalt-test', `setup-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates gestalt.json when it does not exist', () => {
    setupCommand();
    const filePath = join(process.cwd(), 'gestalt.json');
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.$schema).toContain('gestalt.schema.json');
    expect(content.interview).toEqual({
      ambiguityThreshold: 0.2,
      maxRounds: 10,
    });
    // Should only have $schema and interview
    expect(Object.keys(content)).toEqual(['$schema', 'interview']);
  });

  it('does not overwrite existing gestalt.json', () => {
    // Create an existing file
    const filePath = join(process.cwd(), 'gestalt.json');
    const existingContent = '{"existing": true}';
    require('node:fs').writeFileSync(filePath, existingContent);

    setupCommand();

    // File should be unchanged
    expect(readFileSync(filePath, 'utf-8')).toBe(existingContent);
  });
});
