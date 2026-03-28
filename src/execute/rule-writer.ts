import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const RULE_FILE = '.claude/rules/gestalt-active.md';
const ACTIVE_SESSION_FILE = '.gestalt/active-session.json';

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

export function writeGestaltRule(cwd: string, spec: RuleSpec, currentTask: RuleTask | null): void {
  const path = join(cwd, RULE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatRuleContent(spec, currentTask), 'utf-8');
}

export function updateGestaltRule(cwd: string, spec: RuleSpec, currentTask: RuleTask | null): void {
  const path = join(cwd, RULE_FILE);
  if (!existsSync(path)) return;
  writeFileSync(path, formatRuleContent(spec, currentTask), 'utf-8');
}

export function deleteGestaltRule(cwd: string): void {
  const path = join(cwd, RULE_FILE);
  if (existsSync(path)) unlinkSync(path);
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
