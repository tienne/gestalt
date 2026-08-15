import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createHostAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  GrokAdapter,
  BothAdapter,
} from '../../../src/mcp/host-adapter.js';

function makeTempDir(): string {
  const dir = join('/tmp', `gestalt-host-adapter-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const CONTENT = '# Gestalt Active Session\n\n## Goal\n\nShip grok host support\n';
const CLAUDE_RULE = join('.claude', 'rules', 'gestalt-active.md');
const GROK_RULE = join('.grok', 'rules', 'gestalt-active.md');

describe('createHostAdapter', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns GrokAdapter for grok and writes only .grok/rules/gestalt-active.md', async () => {
    const adapter = createHostAdapter('grok', cwd);
    expect(adapter).toBeInstanceOf(GrokAdapter);

    await adapter.writeActiveContext(CONTENT);

    const grokPath = join(cwd, GROK_RULE);
    expect(existsSync(grokPath)).toBe(true);
    expect(readFileSync(grokPath, 'utf-8')).toBe(CONTENT);
    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(false);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });

  it('clears only the grok rule file', async () => {
    const grok = createHostAdapter('grok', cwd);
    const claude = createHostAdapter('claude-code', cwd);
    await grok.writeActiveContext(CONTENT);
    await claude.writeActiveContext(CONTENT);
    writeFileSync(join(cwd, 'AGENTS.md'), 'keep me\n', 'utf-8');

    await grok.clearActiveContext();

    expect(existsSync(join(cwd, GROK_RULE))).toBe(false);
    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(true);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
  });

  it('writes claude + AGENTS for both and never touches .grok/', async () => {
    const adapter = createHostAdapter('both', cwd);
    expect(adapter).toBeInstanceOf(BothAdapter);

    await adapter.writeActiveContext(CONTENT);

    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(true);
    expect(readFileSync(join(cwd, CLAUDE_RULE), 'utf-8')).toBe(CONTENT);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')).toContain(
      '<!-- gestalt-active-start -->',
    );
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')).toContain(CONTENT.trim());
    expect(existsSync(join(cwd, '.grok'))).toBe(false);
  });

  it('clears claude + AGENTS for both and leaves a pre-existing grok file', async () => {
    const both = createHostAdapter('both', cwd);
    const grok = createHostAdapter('grok', cwd);
    await both.writeActiveContext(CONTENT);
    await grok.writeActiveContext(CONTENT);

    await both.clearActiveContext();

    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(false);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(cwd, GROK_RULE))).toBe(true);
  });

  it('writes only .claude/rules/gestalt-active.md for claude-code', async () => {
    const adapter = createHostAdapter('claude-code', cwd);
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);

    await adapter.writeActiveContext(CONTENT);

    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(true);
    expect(readFileSync(join(cwd, CLAUDE_RULE), 'utf-8')).toBe(CONTENT);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(cwd, '.grok'))).toBe(false);
  });

  it('clears only the claude rule file', async () => {
    const adapter = createHostAdapter('claude-code', cwd);
    await adapter.writeActiveContext(CONTENT);
    writeFileSync(join(cwd, 'AGENTS.md'), 'keep me\n', 'utf-8');

    await adapter.clearActiveContext();

    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(false);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
  });

  it('writes only AGENTS.md for codex', async () => {
    const adapter = createHostAdapter('codex', cwd);
    expect(adapter).toBeInstanceOf(CodexAdapter);

    await adapter.writeActiveContext(CONTENT);

    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')).toContain(
      '<!-- gestalt-active-start -->',
    );
    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(false);
    expect(existsSync(join(cwd, '.grok'))).toBe(false);
  });

  it('clears only the AGENTS.md gestalt section for codex', async () => {
    const adapter = createHostAdapter('codex', cwd);
    await adapter.writeActiveContext(CONTENT);
    mkdirSync(join(cwd, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(cwd, CLAUDE_RULE), CONTENT, 'utf-8');

    await adapter.clearActiveContext();

    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(cwd, CLAUDE_RULE))).toBe(true);
  });
});
