import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ClientType } from '../execute/rule-writer.js';

const CLAUDE_RULE_FILE = '.claude/rules/gestalt-active.md';
const AGENTS_FILE = 'AGENTS.md';

const SECTION_START = '<!-- gestalt-active-start -->';
const SECTION_END = '<!-- gestalt-active-end -->';

// ─── Interface ───────────────────────────────────────────────────

export interface IHostAdapter {
  writeActiveContext(content: string): Promise<void>;
  clearActiveContext(): Promise<void>;
}

// ─── Claude Code Adapter ────────────────────────────────────────

export class ClaudeCodeAdapter implements IHostAdapter {
  constructor(private readonly cwd: string) {}

  async writeActiveContext(content: string): Promise<void> {
    const path = join(this.cwd, CLAUDE_RULE_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }

  async clearActiveContext(): Promise<void> {
    const path = join(this.cwd, CLAUDE_RULE_FILE);
    if (existsSync(path)) unlinkSync(path);
  }
}

// ─── Codex Adapter ──────────────────────────────────────────────

export class CodexAdapter implements IHostAdapter {
  constructor(private readonly cwd: string) {}

  async writeActiveContext(content: string): Promise<void> {
    upsertAgentsSection(this.cwd, content);
  }

  async clearActiveContext(): Promise<void> {
    removeAgentsSection(this.cwd);
  }
}

// ─── Both Adapter ───────────────────────────────────────────────

export class BothAdapter implements IHostAdapter {
  private readonly claudeCode: ClaudeCodeAdapter;
  private readonly codex: CodexAdapter;

  constructor(cwd: string) {
    this.claudeCode = new ClaudeCodeAdapter(cwd);
    this.codex = new CodexAdapter(cwd);
  }

  async writeActiveContext(content: string): Promise<void> {
    await this.claudeCode.writeActiveContext(content);
    await this.codex.writeActiveContext(content);
  }

  async clearActiveContext(): Promise<void> {
    await this.claudeCode.clearActiveContext();
    await this.codex.clearActiveContext();
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createHostAdapter(client: ClientType, cwd?: string): IHostAdapter {
  const resolvedCwd = cwd ?? process.cwd();
  switch (client) {
    case 'codex':
      return new CodexAdapter(resolvedCwd);
    case 'both':
      return new BothAdapter(resolvedCwd);
    case 'claude-code':
    default:
      return new ClaudeCodeAdapter(resolvedCwd);
  }
}

// ─── AGENTS.md section helpers ───────────────────────────────────

function upsertAgentsSection(cwd: string, content: string): void {
  const path = join(cwd, AGENTS_FILE);
  const section = `${SECTION_START}\n${content}\n${SECTION_END}`;

  if (!existsSync(path)) {
    writeFileSync(path, section + '\n', 'utf-8');
    return;
  }

  const existing = readFileSync(path, 'utf-8');
  const start = existing.indexOf(SECTION_START);
  const end = existing.indexOf(SECTION_END);

  if (start !== -1 && end !== -1 && end > start) {
    const replaced = existing.slice(0, start) + section + existing.slice(end + SECTION_END.length);
    writeFileSync(path, replaced, 'utf-8');
  } else {
    writeFileSync(path, existing.trimEnd() + '\n\n' + section + '\n', 'utf-8');
  }
}

function removeAgentsSection(cwd: string): void {
  const path = join(cwd, AGENTS_FILE);
  if (!existsSync(path)) return;

  const existing = readFileSync(path, 'utf-8');
  const start = existing.indexOf(SECTION_START);
  const end = existing.indexOf(SECTION_END);

  if (start === -1 || end === -1 || end <= start) return;

  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(end + SECTION_END.length).trimStart();

  const result = before && after ? before + '\n\n' + after : before || after;
  if (result.trim()) {
    writeFileSync(path, result + '\n', 'utf-8');
  } else {
    unlinkSync(path);
  }
}
