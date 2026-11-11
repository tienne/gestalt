import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor, type Which } from '../../../src/agent-sync/doctor.js';
import { formatDoctor } from '../../../src/agent-sync/format.js';
import { runRevert, RevertError } from '../../../src/agent-sync/revert.js';
import {
  listRuns,
  pruneRuns,
  readRun,
  RunWriter,
  backupsRoot,
} from '../../../src/agent-sync/run-store.js';
import { runSync } from '../../../src/agent-sync/sync.js';
import type { Target } from '../../../src/agent-sync/targets.js';
import {
  hashFile,
  linkOf,
  makeFixture,
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

const allTools: Which = () => true;

function sync(targets: Target[] = f.discover().targets, now?: Date) {
  return runSync({ home: f.home, targets, config: f.config(), dryRun: false, now });
}

function doctor(fix: boolean, which: Which = allTools, now?: Date) {
  const discovery = f.discover();
  const result = runDoctor({
    home: f.home,
    targets: discovery.targets,
    config: f.config(),
    fix,
    which,
    now,
  });
  return { discovery, result };
}

describe('gestalt doctor', () => {
  it('sync 직후에는 어긋난 연결이 없다', () => {
    sync();
    const { result } = doctor(false);
    expect(result.issues).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  it('링크를 실제 폴더나 파일로 바꾸거나 깨뜨리면 문제로 보고하고 고치면 원본을 가리키며 바뀐 것은 백업에 남는다 (AC2)', () => {
    sync();
    const agents = join(f.home, '.agents');
    const claudeSkills = join(f.home, '.claude/skills');
    unlinkSync(claudeSkills);
    mkdirSync(join(claudeSkills, 'local'), { recursive: true });
    writeFileSync(join(claudeSkills, 'local/SKILL.md'), '# local\n');

    const codexRules = join(f.home, '.codex/AGENTS.md');
    unlinkSync(codexRules);
    symlinkSync(join(f.home, 'gone/AGENTS.md'), codexRules);

    const accountRules = join(f.codexX, 'AGENTS.md');
    unlinkSync(accountRules);
    writeFileSync(accountRules, '# 손으로 쓴 파일\n');

    const report = doctor(false);
    const kinds = Object.fromEntries(report.result.issues.map((i) => [i.path, i.kind]));
    expect(kinds).toEqual({
      [claudeSkills]: 'replaced_by_file',
      [codexRules]: 'broken_link',
      [accountRules]: 'replaced_by_file',
    });
    expect(report.result.issues.every((i) => i.fixable)).toBe(true);
    expect(existsSync(join(claudeSkills, 'local/SKILL.md'))).toBe(true);
    expect(formatDoctor(f.home, report.discovery, report.result, false)).toContain(
      'gestalt doctor --fix',
    );

    const { discovery, result } = doctor(true);
    expect(result.remaining).toEqual([]);
    expect(linkOf(claudeSkills)).toBe(join(agents, 'skills'));
    expect(linkOf(codexRules)).toBe(join(agents, 'AGENTS.md'));
    expect(linkOf(accountRules)).toBe(join(agents, 'AGENTS.md'));

    const dir = result.run!.dir;
    expect(readFileSync(join(dir, 'home/.claude/skills/local/SKILL.md'), 'utf-8')).toBe(
      '# local\n',
    );
    expect(linkOf(join(dir, 'home/.codex/AGENTS.md'))).toBe(join(f.home, 'gone/AGENTS.md'));
    const accountRel = join('home', f.codexX.slice(f.home.length + 1), 'AGENTS.md');
    expect(readFileSync(join(dir, accountRel), 'utf-8')).toBe('# 손으로 쓴 파일\n');
    expect(result.hints.some((h) => h.includes('local'))).toBe(true);

    const record = readRun(dir)!;
    expect(record.kind).toBe('doctor');
    expect(record.changes).toEqual(result.fixed);
    const out = formatDoctor(f.home, discovery, result, true);
    expect(out).toContain('고친 것');
    expect(out).toContain(`백업 폴더  ~/.gestalt/backups/${record.dirName}`);
    expect(out).toContain('고칠 것을 다 고쳤어요');
  });

  it('원본이 없으면 링크를 다시 걸지 않고 sync를 먼저 하라고 알린다', () => {
    rmSync(join(f.home, '.agents'), { recursive: true });
    const { result } = doctor(true);
    expect(result.issues.filter((i) => i.kind === 'source_missing')).toHaveLength(2);
    const linkIssues = result.issues.filter(
      (i) => i.path.endsWith('AGENTS.md') || i.path.endsWith('skills'),
    );
    expect(linkIssues.every((i) => !i.fixable)).toBe(true);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(existsSync(join(f.home, '.agents/AGENTS.md'))).toBe(false);
  });

  it('설정 목록의 도구가 없는 호스트를 호스트와 도구 이름으로 경고하고 목록 밖 도구는 보지 않는다 (AC3)', () => {
    f.writeConfig({ tools: { all: ['git'], codex: ['rg'] } });
    sync();
    const asked: string[] = [];
    const which: Which = (tool, target) => {
      asked.push(`${target.label}:${tool}`);
      return !(tool === 'rg' && target.label === 'Codex 계정 ws-x');
    };
    const { discovery, result } = doctor(false, which);
    expect(result.toolWarnings).toEqual([
      {
        label: 'Codex 계정 ws-x',
        tool: 'rg',
        message: 'Codex 계정 ws-x: rg를 PATH에서 찾지 못했어요',
      },
    ]);
    expect(new Set(asked.map((a) => a.split(':')[1]))).toEqual(new Set(['git', 'rg']));
    expect(asked).not.toContain('Claude 시스템:rg');
    expect(formatDoctor(f.home, discovery, result, false)).toContain('도구 경고');
  });

  it('도구 목록이 비어 있으면 아무 도구도 확인하지 않는다', () => {
    sync();
    const asked: string[] = [];
    doctor(false, (tool) => {
      asked.push(tool);
      return false;
    });
    expect(asked).toEqual([]);
  });

  it('고쳐도 MCP 설정과 settings.json은 그대로 둔다 (AC17)', () => {
    const files = ['.claude/settings.json', '.claude.json', '.mcp.json'].map((p) =>
      join(f.home, p),
    );
    const before = files.map(hashFile);
    sync();
    rmSync(join(f.home, '.claude/skills'));
    doctor(true);
    runRevert({ home: f.home, dryRun: false });
    expect(files.map(hashFile)).toEqual(before);
  });
});

describe('gestalt sync --revert', () => {
  it('되돌리면 스킬 자리와 CLAUDE.md, AGENTS.md가 sync 전 그대로 돌아온다 (AC4)', () => {
    const before = snapshot(f.home);
    const synced = sync();
    expect(snapshot(f.home)).not.toEqual(before);

    const preview = runRevert({ home: f.home, dryRun: true });
    expect(preview.reverted.runId).toBe(synced.run!.runId);
    expect(preview.changes.length).toBeGreaterThan(0);
    expect(preview.run).toBeUndefined();

    const result = runRevert({ home: f.home, dryRun: false });
    expect(result.notes).toEqual([]);
    expect(snapshot(f.home)).toEqual(before);

    const record = readRun(join(backupsRoot(), synced.run!.dir.split('/').pop()!))!;
    expect(record.revertedBy).toBe(result.run!.runId);
    expect(() => runRevert({ home: f.home, dryRun: false })).toThrow('되돌릴 sync 실행이 없어요');
  });

  it('sync 뒤에 생긴 것은 지우지 않고 되돌리기 백업에 둔다', () => {
    sync();
    writeFileSync(join(f.home, '.agents/skills/alpha/extra.md'), 'sync 뒤에 쓴 것\n');
    mkdirSync(join(f.home, '.agents/skills/gamma'));
    const result = runRevert({ home: f.home, dryRun: false });
    expect(readFileSync(join(f.home, '.claude/skills/alpha/extra.md'), 'utf-8')).toBe(
      'sync 뒤에 쓴 것\n',
    );
    expect(existsSync(join(f.home, '.agents/skills/gamma'))).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it('doctor 실행은 되돌리기 대상이 아니고 doctor가 고친 항목은 되돌려도 그대로 남는다 (AC13)', () => {
    const all = f.discover().targets;
    const withoutB = all.filter((t) => t.label !== 'Claude 계정 org-b');
    const synced = sync(withoutB);

    const fixed = doctor(true);
    const skillsB = join(f.claudeB, 'skills');
    expect(linkOf(skillsB)).toBe(join(f.home, '.agents/skills'));
    const doctorRun = fixed.result.run!;

    expect(() => runRevert({ home: f.home, runId: doctorRun.runId, dryRun: false })).toThrow(
      RevertError,
    );
    expect(() => runRevert({ home: f.home, runId: doctorRun.runId, dryRun: false })).toThrow(
      'doctor가 고친 것은 되돌리기 대상이 아니에요',
    );

    const result = runRevert({ home: f.home, runId: synced.run!.runId, dryRun: false });
    expect(result.reverted.runId).toBe(synced.run!.runId);
    expect(linkOf(skillsB)).toBe(join(f.home, '.agents/skills'));
    expect(readFileSync(join(f.claudeB, 'CLAUDE.md'), 'utf-8')).toBe('@~/.claude/CLAUDE.md\n');
    expect(linkOf(join(f.home, '.claude/skills'))).toBeNull();
  });

  it('더 새 sync가 살아 있으면 예전 실행은 거부한다', () => {
    const first = sync();
    rmSync(join(f.home, '.claude/skills'));
    const second = sync();
    expect(second.run).toBeDefined();
    expect(() => runRevert({ home: f.home, runId: first.run!.runId, dryRun: false })).toThrow(
      `더 새 sync 실행 ${second.run!.runId}`,
    );
  });
});

describe('백업 보관 기간 (AC12)', () => {
  it('6개월이 지난 실행 폴더는 지우고 6개월 안의 것은 남긴다', () => {
    const now = new Date('2026-11-11T12:00:00');
    const old = new RunWriter('sync', f.home, new Date('2026-05-10T12:00:00'));
    old.save();
    const recent = new RunWriter('doctor', f.home, new Date('2026-05-12T12:00:00'));
    recent.save();

    expect(pruneRuns(now)).toEqual([old.record.dirName]);
    expect(listRuns().map((r) => r.runId)).toEqual([recent.record.runId]);
  });

  it('sync가 쓰기 시작할 때 오래된 실행 폴더를 정리하고 결과에 알린다', () => {
    const old = new RunWriter('sync', f.home, new Date('2026-01-01T00:00:00'));
    old.save();
    const result = sync(undefined, new Date('2026-11-11T00:00:00'));
    expect(result.pruned).toEqual([old.record.dirName]);
    expect(readdirSync(backupsRoot())).toEqual([result.run!.dir.split('/').pop()]);
  });

  it('미리보기와 바꿀 게 없는 실행은 아무것도 지우지 않는다', () => {
    sync();
    const old = new RunWriter('sync', f.home, new Date('2025-01-01T00:00:00'));
    old.save();
    expect(
      runSync({ home: f.home, targets: f.discover().targets, config: f.config(), dryRun: true })
        .pruned,
    ).toEqual([]);
    expect(sync().pruned).toEqual([]);
    expect(existsSync(old.dir)).toBe(true);
  });
});
