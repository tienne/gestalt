import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// We test the setup logic by importing the function and running it in a temp dir
import { setupCommand } from '../src/cli/commands/setup.js';
import { initCommand } from '../src/cli/commands/init.js';
import { createCli } from '../src/cli/index.js';

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
      resolutionThreshold: 0.8,
      maxRounds: 10,
    });
    // Should only have $schema, notifications and interview
    expect(Object.keys(content)).toEqual(['$schema', 'notifications', 'interview']);
  });

  it('does not overwrite existing gestalt.json', () => {
    // Create an existing file
    const filePath = join(process.cwd(), 'gestalt.json');
    const existingContent = '{"existing": true}';
    writeFileSync(filePath, existingContent);

    setupCommand();

    // File should be unchanged
    expect(readFileSync(filePath, 'utf-8')).toBe(existingContent);
  });

  it('persists the explicitly selected Codex client', () => {
    setupCommand({ client: 'codex' });
    expect(JSON.parse(readFileSync('gestalt.json', 'utf8')).client).toBe('codex');
  });

  it('init preserves the explicit client when graph and hook steps are skipped', async () => {
    await initCommand({ client: 'codex', skipGraph: true, skipHook: true });
    expect(JSON.parse(readFileSync('gestalt.json', 'utf8')).client).toBe('codex');
  });

  it.each(['setup', 'init'])(
    'rejects invalid --client before %s creates files',
    async (command) => {
      const cli = createCli()
        .exitOverride()
        .configureOutput({ writeErr: () => {} });
      await expect(
        cli.parseAsync(['node', 'gestalt', command, '--client', 'unknown']),
      ).rejects.toThrow();
      expect(existsSync('gestalt.json')).toBe(false);
    },
  );
});
