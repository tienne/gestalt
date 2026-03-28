import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  writeGestaltRule,
  updateGestaltRule,
  deleteGestaltRule,
  writeActiveSession,
  deleteActiveSession,
} from '../../../src/execute/rule-writer.js';

function makeTempDir(): string {
  const dir = join('/tmp', `gestalt-rule-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SPEC = { goal: 'Build a task manager', constraints: ['TypeScript only', 'No DB'] };
const TASK = { taskId: 'T1', title: 'Setup project' };

describe('rule-writer', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe('writeGestaltRule', () => {
    it('creates .claude/rules/gestalt-active.md with goal and constraints', () => {
      writeGestaltRule(cwd, SPEC, null);
      const path = join(cwd, '.claude', 'rules', 'gestalt-active.md');
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('Build a task manager');
      expect(content).toContain('TypeScript only');
      expect(content).toContain('No DB');
    });

    it('includes current task when provided', () => {
      writeGestaltRule(cwd, SPEC, TASK);
      const path = join(cwd, '.claude', 'rules', 'gestalt-active.md');
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('T1');
      expect(content).toContain('Setup project');
    });

    it('omits current task section when null', () => {
      writeGestaltRule(cwd, SPEC, null);
      const path = join(cwd, '.claude', 'rules', 'gestalt-active.md');
      const content = readFileSync(path, 'utf-8');
      expect(content).not.toContain('## Current Task');
    });

    it('creates parent directories recursively', () => {
      writeGestaltRule(cwd, SPEC, null);
      expect(existsSync(join(cwd, '.claude', 'rules'))).toBe(true);
    });
  });

  describe('updateGestaltRule', () => {
    it('updates existing rule file', () => {
      writeGestaltRule(cwd, SPEC, null);
      updateGestaltRule(cwd, { ...SPEC, goal: 'Updated goal' }, TASK);
      const content = readFileSync(join(cwd, '.claude', 'rules', 'gestalt-active.md'), 'utf-8');
      expect(content).toContain('Updated goal');
      expect(content).toContain('T1');
    });

    it('does nothing if file does not exist', () => {
      expect(() => updateGestaltRule(cwd, SPEC, null)).not.toThrow();
    });
  });

  describe('deleteGestaltRule', () => {
    it('removes the rule file', () => {
      writeGestaltRule(cwd, SPEC, null);
      const path = join(cwd, '.claude', 'rules', 'gestalt-active.md');
      expect(existsSync(path)).toBe(true);
      deleteGestaltRule(cwd);
      expect(existsSync(path)).toBe(false);
    });

    it('does nothing if file does not exist', () => {
      expect(() => deleteGestaltRule(cwd)).not.toThrow();
    });
  });

  describe('writeActiveSession', () => {
    it('creates .gestalt/active-session.json with sessionId and specId', () => {
      writeActiveSession(cwd, 'sess-123', 'spec-456');
      const path = join(cwd, '.gestalt', 'active-session.json');
      expect(existsSync(path)).toBe(true);
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      expect(data.sessionId).toBe('sess-123');
      expect(data.specId).toBe('spec-456');
      expect(data.updatedAt).toBeDefined();
    });
  });

  describe('deleteActiveSession', () => {
    it('removes active-session.json', () => {
      writeActiveSession(cwd, 'sess-123', 'spec-456');
      const path = join(cwd, '.gestalt', 'active-session.json');
      expect(existsSync(path)).toBe(true);
      deleteActiveSession(cwd);
      expect(existsSync(path)).toBe(false);
    });

    it('does nothing if file does not exist', () => {
      expect(() => deleteActiveSession(cwd)).not.toThrow();
    });
  });
});
