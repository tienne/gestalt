import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatSync } from '../../../src/agent-sync/format.js';
import { runSync, splitClaudeRules } from '../../../src/agent-sync/sync.js';
import {
  CLAUDE_ONLY_MARK,
  hashFile,
  linkOf,
  makeFixture,
  recordOf,
  seedFirstSetup,
  snapshot,
  type Fixture,
} from './fixture.js';

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
  seedFirstSetup(f);
});

afterEach(() => f.restore());

function sync(dryRun = false) {
  const discovery = f.discover();
  const result = runSync({
    home: f.home,
    targets: discovery.targets,
    config: f.config(),
    dryRun,
  });
  return { discovery, result };
}

describe('splitClaudeRules', () => {
  it('Claude 전용 표시가 든 줄과 @ 가져오기 줄만 남기고 코드 블록 안은 공용으로 둔다', () => {
    const split = splitClaudeRules(
      ['a', `${CLAUDE_ONLY_MARK} b`, '@~/x.md', '```', `${CLAUDE_ONLY_MARK} c`, '```'].join('\n'),
      [CLAUDE_ONLY_MARK],
    );
    expect(split.kept).toEqual([`${CLAUDE_ONLY_MARK} b`, '@~/x.md']);
    expect(split.shared).toBe(['a', '```', `${CLAUDE_ONLY_MARK} c`, '```', ''].join('\n'));
  });

  it('이미 든 ~/.agents 가져오기 줄은 양쪽 어디에도 다시 넣지 않는다', () => {
    const split = splitClaudeRules('@~/.agents/AGENTS.md\nshared\n', []);
    expect(split.kept).toEqual([]);
    expect(split.shared).toBe('shared\n');
  });
});

describe('gestalt sync 첫 설정 (AC6)', () => {
  it('스킬 폴더를 ~/.agents/skills로 옮기고 링크 하나로 바꾸며 CLAUDE.md를 나누고 계정 홈마다 링크를 건다', () => {
    const { result } = sync();
    const agents = join(f.home, '.agents');

    expect(readdirSync(join(agents, 'skills')).sort()).toEqual([
      '.trash',
      'alpha',
      'beta',
      'dup',
      'synced',
    ]);
    expect(linkOf(join(f.home, '.claude/skills'))).toBe(join(agents, 'skills'));

    const shared = readFileSync(join(agents, 'AGENTS.md'), 'utf-8');
    expect(shared).toContain('[Tone] 한국어로 답한다');
    expect(shared).toContain(`${CLAUDE_ONLY_MARK} 코드 블록 안이라 그대로 공용`);
    expect(shared).not.toContain('[Hooks]');
    expect(shared).not.toContain('@~/.claude/extra.md');

    const claudeMd = readFileSync(join(f.home, '.claude/CLAUDE.md'), 'utf-8');
    expect(claudeMd.split('\n')[0]).toBe('@~/.agents/AGENTS.md');
    expect(claudeMd).toContain('[Hooks]');
    expect(claudeMd).toContain('@~/.claude/extra.md');
    expect(claudeMd).not.toContain('[Tone]');

    expect(linkOf(join(f.home, '.codex/AGENTS.md'))).toBe(join(agents, 'AGENTS.md'));
    for (const home of [f.claudeA, f.claudeB]) {
      expect(linkOf(join(home, 'skills'))).toBe(join(agents, 'skills'));
      expect(readFileSync(join(home, 'CLAUDE.md'), 'utf-8')).toContain('@~/.claude/CLAUDE.md');
    }
    expect(readFileSync(join(f.claudeA, 'CLAUDE.md'), 'utf-8')).toContain('# 계정 A 규칙');
    expect(linkOf(join(f.codexX, 'AGENTS.md'))).toBe(join(agents, 'AGENTS.md'));
    expect(result.hints.some((h) => h.includes('[Hooks]'))).toBe(true);
  });

  it('같은 이름 스킬은 ~/.agents 쪽을 남기고 Claude 쪽 사본은 백업 폴더에만 둔다 (AC7)', () => {
    const { result } = sync();
    expect(readFileSync(join(f.home, '.agents/skills/dup/SKILL.md'), 'utf-8')).toBe(
      '# dup from source\n',
    );
    const stashed = join(result.run!.dir, 'home/.claude/skills/dup/SKILL.md');
    expect(readFileSync(stashed, 'utf-8')).toBe('# dup from claude\n');
  });

  it('SKILL.md가 없는 폴더도 같이 옮긴다 (AC8)', () => {
    sync();
    expect(existsSync(join(f.home, '.agents/skills/.trash/old/SKILL.md'))).toBe(true);
    expect(readFileSync(join(f.home, '.agents/skills/synced/notes.md'), 'utf-8')).toBe(
      'no SKILL.md here\n',
    );
  });

  it('오르카 계정 홈 전부가 대상과 결과에 나온다 (AC9)', () => {
    const { discovery, result } = sync();
    expect(discovery.targets.map((t) => t.label)).toEqual([
      'Claude 시스템',
      'Codex 시스템',
      'Claude 계정 org-a',
      'Claude 계정 org-b',
      'Codex 계정 ws-x',
    ]);
    const out = formatSync(f.home, discovery, result, false);
    for (const label of ['Claude 계정 org-a', 'Claude 계정 org-b', 'Codex 계정 ws-x']) {
      expect(out).toContain(label);
      expect(result.changes.some((c) => c.startsWith(label))).toBe(true);
    }
  });

  it('미리보기는 바뀔 목록만 내고 파일 시스템은 그대로 둔다 (AC10)', () => {
    const before = snapshot(f.home);
    const { result } = sync(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.run).toBeUndefined();
    expect(snapshot(f.home)).toEqual(before);
    expect(existsSync(join(f.home, '.gestalt/backups'))).toBe(false);
  });

  it('덮기 전 백업을 날짜-실행id 폴더 아래 원래 경로 구조 그대로 만든다 (AC11)', () => {
    const { result } = sync();
    const run = result.run!;
    expect(run.dir).toBe(
      join(f.home, '.gestalt/backups', readdirSync(join(f.home, '.gestalt/backups'))[0]!),
    );
    expect(run.dir.split('/').pop()).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(readFileSync(join(run.dir, 'home/.claude/CLAUDE.md'), 'utf-8')).toContain('[Tone]');
    expect(readFileSync(join(run.dir, 'home/.codex/AGENTS.md'), 'utf-8')).toBe(
      '# codex 전용으로 쓰던 규칙\n',
    );
    const accountRel = join('home', f.codexX.slice(f.home.length + 1), 'AGENTS.md');
    expect(readFileSync(join(run.dir, accountRel), 'utf-8')).toBe('# 계정 Codex 규칙\n');
  });

  it('바꾼 항목과 백업 자리를 결과에 바로 보여주고 기록 파일에도 같은 내용을 남긴다 (AC14)', () => {
    const { discovery, result } = sync();
    const record = recordOf(result.run!.dir);
    expect(record.kind).toBe('sync');
    expect(record.changes).toEqual(result.changes);
    expect(record.actions.length).toBeGreaterThan(0);
    const out = formatSync(f.home, discovery, result, false);
    expect(out).toContain('바꾼 것');
    expect(out).toContain(`백업 폴더  ~/.gestalt/backups/${record.dirName}`);
    expect(out).toContain(`기록 파일  ~/.gestalt/backups/${record.dirName}/run.json`);
    expect(out).toContain(`gestalt sync --revert ${record.runId}`);
  });

  it('두 번째 실행은 바꿀 게 없고 실행 폴더도 만들지 않는다', () => {
    sync();
    const before = readdirSync(join(f.home, '.gestalt/backups'));
    const { discovery, result } = sync();
    expect(result.changes).toEqual([]);
    expect(result.run).toBeUndefined();
    expect(readdirSync(join(f.home, '.gestalt/backups'))).toEqual(before);
    expect(formatSync(f.home, discovery, result, false)).toContain('바꿀 게 없어요');
  });

  it('MCP 설정과 settings.json은 그대로 둔다 (AC17)', () => {
    const files = [
      '.claude/settings.json',
      '.claude.json',
      '.mcp.json',
      '.codex/config.toml',
      join(f.claudeA.slice(f.home.length + 1), 'settings.json'),
    ].map((p) => join(f.home, p));
    const before = files.map(hashFile);
    sync();
    expect(files.map(hashFile)).toEqual(before);
  });

  it('시스템 CLAUDE.md가 없으면 빈 ~/.agents/AGENTS.md를 만든다', () => {
    rmSync(join(f.home, '.claude/CLAUDE.md'));
    sync();
    expect(readFileSync(join(f.home, '.agents/AGENTS.md'), 'utf-8')).toBe('');
    expect(readFileSync(join(f.home, '.claude/CLAUDE.md'), 'utf-8')).toBe('@~/.agents/AGENTS.md\n');
  });

  it('~/.agents/AGENTS.md가 이미 있으면 CLAUDE.md를 나누지 않고 가져오기 줄만 넣는다', () => {
    writeFileSync(join(f.home, '.agents/AGENTS.md'), '# 이미 있던 공용 규칙\n');
    sync();
    expect(readFileSync(join(f.home, '.agents/AGENTS.md'), 'utf-8')).toBe(
      '# 이미 있던 공용 규칙\n',
    );
    const claudeMd = readFileSync(join(f.home, '.claude/CLAUDE.md'), 'utf-8');
    expect(claudeMd.split('\n')[0]).toBe('@~/.agents/AGENTS.md');
    expect(claudeMd).toContain('[Tone]');
  });
});
