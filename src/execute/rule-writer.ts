import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CLAUDE_RULE_FILE = '.claude/rules/gestalt-active.md';
const AGENTS_FILE = 'AGENTS.md';
const ACTIVE_SESSION_FILE = '.gestalt/active-session.json';

const SECTION_START = '<!-- gestalt-active-start -->';
const SECTION_END = '<!-- gestalt-active-end -->';

export type ClientType = 'claude-code' | 'codex' | 'both';

interface RuleSpec {
  goal: string;
  constraints: string[];
}

interface RuleTask {
  taskId: string;
  title: string;
}

interface ActiveSession {
  sessionId: string;
  specId: string;
  updatedAt: string;
}

export function writeGestaltRule(
  cwd: string,
  spec: RuleSpec,
  currentTask: RuleTask | null,
  client: ClientType = 'claude-code',
): void {
  const content = formatRuleContent(spec, currentTask);
  if (client === 'claude-code' || client === 'both') {
    const path = join(cwd, CLAUDE_RULE_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
  if (client === 'codex' || client === 'both') {
    upsertAgentsSection(cwd, content);
  }
}

export function updateGestaltRule(
  cwd: string,
  spec: RuleSpec,
  currentTask: RuleTask | null,
  client: ClientType = 'claude-code',
): void {
  const content = formatRuleContent(spec, currentTask);
  if (client === 'claude-code' || client === 'both') {
    const path = join(cwd, CLAUDE_RULE_FILE);
    if (existsSync(path)) writeFileSync(path, content, 'utf-8');
  }
  if (client === 'codex' || client === 'both') {
    upsertAgentsSection(cwd, content);
  }
}

export function deleteGestaltRule(cwd: string, client: ClientType = 'claude-code'): void {
  if (client === 'claude-code' || client === 'both') {
    const path = join(cwd, CLAUDE_RULE_FILE);
    if (existsSync(path)) unlinkSync(path);
  }
  if (client === 'codex' || client === 'both') {
    removeAgentsSection(cwd);
  }
}

export function writeActiveSession(cwd: string, sessionId: string, specId: string): void {
  const path = join(cwd, ACTIVE_SESSION_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const data: ActiveSession = { sessionId, specId, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

export function deleteActiveSession(cwd: string): void {
  const path = join(cwd, ACTIVE_SESSION_FILE);
  if (existsSync(path)) unlinkSync(path);
}

// ─── AGENTS.md section management ────────────────────────────────

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

function formatRuleContent(spec: RuleSpec, currentTask: RuleTask | null): string {
  const lines: string[] = [
    '---',
    'description: Active Gestalt execution context — goal, constraints, and current task',
    '---',
    '',
    '# Gestalt Active Session',
    '',
    '## Goal',
    '',
    spec.goal,
    '',
  ];

  if (spec.constraints.length > 0) {
    lines.push('## Constraints', '');
    for (const c of spec.constraints) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  if (currentTask) {
    lines.push('## Current Task', '', `**${currentTask.taskId}**: ${currentTask.title}`, '');
  }

  return lines.join('\n');
}
