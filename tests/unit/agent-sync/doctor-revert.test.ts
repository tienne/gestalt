import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor, type Which } from '../../../src/agent-sync/doctor.js';
import { formatDoctor } from '../../../src/agent-sync/format.js';
import { lstatOrNull, movePath } from '../../../src/agent-sync/fs-ops.js';
import { isInside, tildify } from '../../../src/agent-sync/paths.js';
import { revertSlotPaths, runRevert, RevertError } from '../../../src/agent-sync/revert.js';
import {
  backupPathIn,
  listRunsNewestFirst,
  pruneRuns,
  RunWriter,
  backupsRoot,
  type RunAction,
} from '../../../src/agent-sync/run-store.js';
import { runSync } from '../../../src/agent-sync/sync.js';
import type { Target } from '../../../src/agent-sync/targets.js';
import {
  CLAUDE_ONLY_MARK,
  hashFile,
  linkOf,
  makeFixture,
  recordOf,
  seedFirstSetup,
  snapshot,
  type Fixture,
  type Snapshot,
} from './fixture.js';

// 실패 주입용. 평소에는 실제 함수를 그대로 부른다
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), cpSync: vi.fn(actual.cpSync) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function errno(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${code}: 주입한 실패`);
  e.code = code;
  return e;
}

/** `to`가 맞으면 rename을 `code`로 실패시킨다. `once`면 한 번만 */
function failRename(match: (to: string) => boolean, code: string, once = false): void {
  let fired = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (!(once && fired) && match(String(to))) {
      fired = true;
      throw errno(code);
    }
    realFs.renameSync(from, to);
  });
}

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
  seedFirstSetup(f);
});

afterEach(() => {
  vi.mocked(renameSync).mockImplementation(realFs.renameSync);
  vi.mocked(cpSync).mockImplementation(realFs.cpSync);
  f.restore();
});

const allTools: Which = () => true;

function sync(targets: Target[] = f.discover().targets, now?: Date) {
  return runSync({ home: f.home, targets, config: f.config(), dryRun: false, now });
}

/** 파일이면 내용 해시, 폴더면 안쪽 전부 */
function snapshotOf(path: string): Snapshot | string {
  return statSync(path).isDirectory() ? snapshot(path) : hashFile(path);
}

/** 되돌리기가 받을 자리. CLI처럼 지금 찾은 홈으로 만든다 */
function scope() {
  return { home: f.home, slotPaths: revertSlotPaths(f.home, f.discover().knownHomes) };
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

  it('링크를 실제 폴더나 파일로 바꾸거나 깨뜨리면 문제로 보고하고 고치면 ~/.agents를 가리키며 바뀐 것은 백업에 남는다 (AC2)', () => {
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

    const record = recordOf(dir);
    expect(record.kind).toBe('doctor');
    expect(record.changes).toEqual(result.fixed);
    const out = formatDoctor(f.home, discovery, result, true);
    expect(out).toContain('고친 것');
    expect(out).toContain(`백업 폴더  ~/.gestalt/backups/${record.dirName}`);
    expect(out).toContain('고칠 것을 다 고쳤어요');
  });

  it('~/.agents가 없으면 링크를 다시 걸지 않고 sync를 먼저 하라고 알린다', () => {
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
    runRevert({ ...scope(), dryRun: false });
    expect(files.map(hashFile)).toEqual(before);
  });
});

describe('gestalt sync --revert', () => {
  it('되돌리면 스킬 자리와 CLAUDE.md, AGENTS.md가 sync 전 그대로 돌아온다 (AC4)', () => {
    const before = snapshot(f.home);
    const synced = sync();
    expect(snapshot(f.home)).not.toEqual(before);

    const preview = runRevert({ ...scope(), dryRun: true });
    expect(preview.reverted.runId).toBe(synced.run!.runId);
    expect(preview.changes.length).toBeGreaterThan(0);
    expect(preview.run).toBeUndefined();

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([]);
    expect(snapshot(f.home)).toEqual(before);

    const record = recordOf(synced.run!.dir);
    expect(record.revertedBy).toBe(result.run!.runId);
    expect(() => runRevert({ ...scope(), dryRun: false })).toThrow('되돌릴 sync 실행이 없어요');
  });

  it('sync 뒤에 생긴 것은 지우지 않고 되돌리기 백업에 둔다', () => {
    sync();
    writeFileSync(join(f.home, '.agents/skills/alpha/extra.md'), 'sync 뒤에 쓴 것\n');
    mkdirSync(join(f.home, '.agents/skills/gamma'));
    const result = runRevert({ ...scope(), dryRun: false });
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

    expect(() => runRevert({ ...scope(), runId: doctorRun.runId, dryRun: false })).toThrow(
      RevertError,
    );
    expect(() => runRevert({ ...scope(), runId: doctorRun.runId, dryRun: false })).toThrow(
      'doctor가 고친 것은 되돌리기 대상이 아니에요',
    );

    const result = runRevert({ ...scope(), runId: synced.run!.runId, dryRun: false });
    expect(result.reverted.runId).toBe(synced.run!.runId);
    expect(linkOf(skillsB)).toBe(join(f.home, '.agents/skills'));
    expect(readFileSync(join(f.claudeB, 'CLAUDE.md'), 'utf-8')).toBe('@~/.claude/CLAUDE.md\n');
    expect(linkOf(join(f.home, '.claude/skills'))).toBeNull();
  });

  it('orcaDataDir를 홈 밖으로 두고 시스템 홈만 sync해도 되돌린다 (sec-r2-1)', () => {
    f.writeConfig({
      rules: { claudeOnly: [CLAUDE_ONLY_MARK] },
      orcaDataDir: join(f.root, 'orca-out'),
    });
    const before = snapshot(f.home);
    const { run } = sync();
    expect(recordOf(run!.dir).actions.length).toBeGreaterThan(0);
    runRevert({ ...scope(), dryRun: false });
    expect(snapshot(f.home)).toEqual(before);
  });

  it('sync 뒤에 계정을 skip해도 그 계정 홈까지 되돌린다 (sec-r2-1)', () => {
    const before = snapshot(f.home);
    sync();
    f.writeConfig({
      rules: { claudeOnly: [CLAUDE_ONLY_MARK] },
      accounts: { 'acct-a': { skip: true } },
    });
    expect(f.discover().targets.map((t) => t.home)).not.toContain(f.claudeA);
    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([]);
    expect(snapshot(f.home)).toEqual(before);
  });

  it('아직 되돌리지 않은 더 새 sync가 있으면 예전 실행은 거부한다', () => {
    const first = sync();
    rmSync(join(f.home, '.claude/skills'));
    const second = sync();
    expect(second.run).toBeDefined();
    expect(() => runRevert({ ...scope(), runId: first.run!.runId, dryRun: false })).toThrow(
      `더 새 sync 실행 ${second.run!.runId}`,
    );
  });
});

describe('백업 보관 기간 (AC12)', () => {
  it('6개월이 지난 실행 폴더는 지우고 6개월 안의 것은 남긴다', () => {
    const now = new Date('2026-11-11T12:00:00');
    const old = new RunWriter('doctor', f.home, new Date('2026-05-10T12:00:00'));
    old.save();
    const recent = new RunWriter('doctor', f.home, new Date('2026-05-12T12:00:00'));
    recent.save();

    expect(pruneRuns(now)).toEqual([old.record.dirName]);
    expect(listRunsNewestFirst().runs.map((r) => r.runId)).toEqual([recent.record.runId]);
  });

  it('아직 되돌리지 않은 가장 최근 sync는 기간이 지나도 남기고 그보다 예전 sync는 지운다', () => {
    const now = new Date('2026-11-11T12:00:00');
    const older = new RunWriter('sync', f.home, new Date('2025-01-01T12:00:00'));
    older.save();
    const latest = new RunWriter('sync', f.home, new Date('2025-02-01T12:00:00'));
    latest.save();
    const reverted = new RunWriter('sync', f.home, new Date('2025-03-01T12:00:00'));
    reverted.record.revertedAt = '2025-03-02T00:00:00.000Z';
    reverted.save();

    expect(pruneRuns(now).sort()).toEqual([older.record.dirName, reverted.record.dirName].sort());
    expect(listRunsNewestFirst().runs.map((r) => r.runId)).toEqual([latest.record.runId]);
  });

  it('sync가 쓰기 시작할 때 오래된 실행 폴더를 정리하고 결과에 알린다', () => {
    const old = new RunWriter('doctor', f.home, new Date('2026-01-01T00:00:00'));
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

  it('실행 폴더는 0700, run.json은 0600으로 만든다', () => {
    const { run } = sync();
    expect(statSync(run!.dir).mode & 0o777).toBe(0o700);
    expect(statSync(run!.recordFile).mode & 0o777).toBe(0o600);
  });
});

describe('깨진 실행 기록 (Q2)', () => {
  function corruptRun(at: Date): RunWriter {
    const run = new RunWriter('doctor', f.home, at);
    run.save();
    writeFileSync(run.recordFile, '{');
    return run;
  }

  it('doctor가 경고하고 정리하지 않으며 더 새 깨진 기록이 있으면 되돌리기를 거부한다', () => {
    sync();
    const afterSync = snapshot(f.home);
    const junk = corruptRun(new Date());
    expect(listRunsNewestFirst().corrupt.map((c) => c.dirName)).toEqual([junk.record.dirName]);

    const { discovery, result } = doctor(false);
    expect(result.recordWarnings).toHaveLength(1);
    expect(result.recordWarnings[0]).toContain(junk.record.dirName);
    expect(formatDoctor(f.home, discovery, result, false)).toContain(junk.record.dirName);

    expect(() => runRevert({ ...scope(), dryRun: false })).toThrow('기록을 읽지 못했어요');
    expect(snapshot(f.home)).toEqual(afterSync);
    expect(pruneRuns(new Date('2099-01-01T00:00:00'))).toEqual([]);
    expect(existsSync(junk.dir)).toBe(true);
  });

  it('더 예전 깨진 기록은 되돌리기를 막지 않고 참고로 알린다', () => {
    const junk = corruptRun(new Date('2026-01-01T00:00:00'));
    const before = snapshot(f.home);
    sync();
    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([expect.stringContaining(junk.record.dirName)]);
    expect(snapshot(f.home)).toEqual(before);
  });
});

describe('변조된 run.json (SEC-1)', () => {
  type Raw = { actions: Record<string, unknown>[]; dirName: string };
  const tamperings: [string, (raw: Raw, home: string) => void][] = [
    [
      '백업 경로가 실행 폴더 밖',
      (raw, home) => {
        const stash = raw.actions.find((a) => a['op'] === 'stash')!;
        stash['backup'] = join(home, 'elsewhere/AGENTS.md');
      },
    ],
    [
      '옮긴 곳이 ~/.agents 밖',
      (raw, home) => {
        raw.actions.find((a) => a['op'] === 'move')!['to'] = join(home, 'evil/alpha');
      },
    ],
    [
      '다루지 않는 자리의 링크',
      (raw, home) => {
        raw.actions.find((a) => a['op'] === 'create_link')!['path'] = join(home, '.ssh/config');
      },
    ],
    [
      '상대 경로',
      (raw) => {
        raw.actions.find((a) => a['op'] === 'create_link')!['path'] = '.codex/AGENTS.md';
      },
    ],
    [
      '.. 이 섞인 경로',
      (raw, home) => {
        raw.actions.find((a) => a['op'] === 'stash')!['path'] =
          `${home}/.agents/../.codex/AGENTS.md`;
      },
    ],
    [
      'sync가 남기지 않는 동작',
      (raw, home) => {
        raw.actions.push({ op: 'restore', path: join(home, '.codex/AGENTS.md') });
      },
    ],
    ['모르는 동작', (raw) => void raw.actions.push({ op: 'chmod', path: '/etc/passwd' })],
    ...(['work/proj/CLAUDE.md', 'Documents/skills'] as const).flatMap(
      (rel): [string, (raw: Raw, home: string) => void][] => [
        [
          `이름만 슬롯인 ${rel}로 stash`,
          (raw, home) => {
            const stash = raw.actions.find((a) => a['op'] === 'stash')!;
            stash['path'] = join(home, rel);
            stash['backup'] = backupPathIn(join(backupsRoot(), raw.dirName), home, join(home, rel));
          },
        ],
        [
          `이름만 슬롯인 ${rel}로 write_file`,
          (raw, home) => {
            raw.actions.push({
              op: 'write_file',
              path: join(home, rel),
              backup: backupPathIn(join(backupsRoot(), raw.dirName), home, join(home, rel)),
            });
          },
        ],
        [
          `이름만 슬롯인 ${rel}로 create_link`,
          (raw, home) => {
            raw.actions.find((a) => a['op'] === 'create_link')!['path'] = join(home, rel);
          },
        ],
      ],
    ),
    [
      '대상 홈 밖 skills 폴더에서 온 move',
      (raw) => {
        raw.actions.find((a) => a['op'] === 'move')!['from'] = '/tmp/x/skills/alpha';
      },
    ],
    [
      '동작 수보다 큰 revertProgress',
      (raw) => {
        (raw as Raw & { revertProgress?: number }).revertProgress = raw.actions.length + 1;
      },
    ],
    ['폴더 이름과 다른 dirName', (raw) => void (raw.dirName = '2020-01-01-00000000')],
  ];

  it.each(tamperings)('%s면 아무것도 바꾸지 않고 거부한다', (_name, tamper) => {
    const { run } = sync();
    const afterSync = snapshot(f.home);
    const raw = JSON.parse(readFileSync(run!.recordFile, 'utf-8')) as Raw;
    tamper(raw, f.home);
    writeFileSync(run!.recordFile, JSON.stringify(raw));

    expect(() => runRevert({ ...scope(), runId: run!.runId, dryRun: false })).toThrow(RevertError);
    expect(() => runRevert({ ...scope(), dryRun: true })).toThrow(RevertError);
    expect(snapshot(f.home)).toEqual(afterSync);
  });

  const notSlotTampers = tamperings.filter(([name]) =>
    [
      '백업 경로가 실행 폴더 밖',
      '옮긴 곳이 ~/.agents 밖',
      '모르는 동작',
      '동작 수보다 큰 revertProgress',
    ].includes(name),
  );

  it.each(notSlotTampers)(
    '%s면 계정과 설정을 되돌리라는 안내를 붙이지 않는다 (q-r3-3)',
    (_n, tamper) => {
      const { run } = sync();
      const raw = JSON.parse(readFileSync(run!.recordFile, 'utf-8')) as Raw;
      tamper(raw, f.home);
      writeFileSync(run!.recordFile, JSON.stringify(raw));

      const error = (() => {
        try {
          runRevert({ ...scope(), dryRun: true });
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(RevertError);
      expect((error as Error).message).not.toContain('sync할 때의 계정과 설정');
    },
  );

  it('sync 뒤 오르카에서 계정이 빠지면 거부하면서 계정과 설정을 되돌리거나 백업에서 꺼내라고 안내한다 (sec-r3-1)', () => {
    const { run } = sync();
    const afterSync = snapshot(f.home);
    const i = f.listing.accounts.findIndex((a) => a.id === 'acct-a');
    f.listing.accounts.splice(i, 1);

    expect(() => runRevert({ ...scope(), dryRun: false })).toThrow(
      `sync할 때의 계정과 설정으로 되돌린 뒤 다시 실행해 주세요. 그럴 수 없으면 백업 폴더 ${tildify(run!.dir, f.home)}에서 직접 꺼내 주세요`,
    );
    expect(snapshot(f.home)).toEqual(afterSync);
  });
});

describe('실패 경로 (Q6)', () => {
  const alphaIn = () => join(f.home, '.agents/skills/alpha');
  const alphaOut = () => join(f.home, '.claude/skills/alpha');

  it('sync가 중간에 멈춰도 거기까지의 run.json이 남고 다시 sync한 뒤 둘 다 되돌리면 처음 그대로다', () => {
    const before = snapshot(f.home);
    failRename((to) => to === alphaIn(), 'EIO', true);
    expect(() => sync()).toThrow('여기까지 한 일은');

    const [failed] = listRunsNewestFirst().runs;
    expect(failed!.changes.at(-1)).toMatch(/^\(실패\) /);
    expect(failed!.actions.at(-1)).toEqual({
      op: 'pending',
      action: { op: 'move', from: alphaOut(), to: alphaIn() },
    });
    expect(existsSync(join(alphaOut(), 'SKILL.md'))).toBe(true);

    sync();
    expect(doctor(false).result.issues).toEqual([]);
    runRevert({ ...scope(), dryRun: false });
    runRevert({ ...scope(), dryRun: false });
    expect(snapshot(f.home)).toEqual(before);
  });

  it('되돌리기가 중간에 멈추면 다시 돌릴 때 멈춘 단계부터 이어간다 (Q1)', () => {
    const before = snapshot(f.home);
    sync();
    const all = runRevert({ ...scope(), dryRun: true }).changes;

    failRename((to) => to === alphaOut(), 'EIO', true);
    expect(() => runRevert({ ...scope(), dryRun: false })).toThrow(RevertError);
    const target = listRunsNewestFirst().runs.find((r) => r.kind === 'sync')!;
    expect(target.revertedAt).toBeUndefined();
    expect(target.revertProgress).toBeGreaterThan(0);

    const left = runRevert({ ...scope(), dryRun: true }).changes;
    expect(left.length).toBeLessThan(all.length);
    expect(all.slice(all.length - left.length)).toEqual(left);

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([]);
    expect(snapshot(f.home)).toEqual(before);
  });

  it('백업이 없어진 항목은 알리고 나머지는 되돌린다', () => {
    const { run } = sync();
    const codexRules = join(f.home, '.codex/AGENTS.md');
    const missing = backupPathIn(run!.dir, f.home, codexRules);
    rmSync(missing);

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([
      `~/.codex/AGENTS.md의 백업 ${tildify(missing, f.home)}가 없어 돌리지 못했어요`,
    ]);
    expect(existsSync(codexRules)).toBe(false);
    expect(linkOf(join(f.home, '.claude/skills'))).toBeNull();
    expect(existsSync(join(alphaOut(), 'SKILL.md'))).toBe(true);
  });

  it('옮기다 멈춘 pending 항목은 옮겨 간 자리에 있으면 되돌린다', () => {
    const before = snapshot(f.home);
    const { run } = sync();
    const raw = JSON.parse(readFileSync(run!.recordFile, 'utf-8')) as { actions: RunAction[] };
    raw.actions = raw.actions.map((a) =>
      a.op === 'stash' || a.op === 'move' ? { op: 'pending', action: a } : a,
    );
    writeFileSync(run!.recordFile, JSON.stringify(raw));

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([]);
    expect(snapshot(f.home)).toEqual(before);
  });

  /**
   * sync 기록을 `~/.codex/AGENTS.md` stash에서 멈춘 모양으로 자르고 그 stash를 pending으로 바꾼다.
   * 스킬 폴더 stash를 고르면 앞의 move가 되돌아오며 그 폴더 내용이 바뀌어 비교할 수 없다
   */
  function stopAtCodexStash(recordFile: string) {
    const codexRules = join(f.home, '.codex/AGENTS.md');
    const raw = JSON.parse(readFileSync(recordFile, 'utf-8')) as { actions: RunAction[] };
    const at = raw.actions.findIndex((a) => a.op === 'stash' && a.path === codexRules);
    const stash = raw.actions[at] as Extract<RunAction, { op: 'stash' }>;
    raw.actions = [...raw.actions.slice(0, at), { op: 'pending', action: stash }];
    writeFileSync(recordFile, JSON.stringify(raw));
    return stash;
  }

  it('옮기다 멈춘 pending 항목은 옮겨 간 자리에 없으면 건너뛴다', () => {
    const { run } = sync();
    const stash = stopAtCodexStash(run!.recordFile);
    if (lstatOrNull(stash.path)) rmSync(stash.path, { recursive: true });
    renameSync(stash.backup, stash.path);
    const original = snapshotOf(stash.path);

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([]);
    expect(snapshotOf(stash.path)).toEqual(original);
    expect(existsSync(stash.backup)).toBe(false);
  });

  it('옮기다 멈춘 항목이 원래 자리와 옮겨 간 자리에 둘 다 있으면 손대지 않고 알린다', () => {
    const { run } = sync();
    const stash = stopAtCodexStash(run!.recordFile);
    if (lstatOrNull(stash.path)) rmSync(stash.path, { recursive: true });
    cpSync(stash.backup, stash.path, { recursive: true });
    const both = [snapshotOf(stash.path), snapshotOf(stash.backup)];

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toEqual([
      `${tildify(stash.path, f.home)}를 옮기다 멈춘 흔적이에요. ${tildify(stash.path, f.home)}와 ${tildify(stash.backup, f.home)}가 둘 다 있어 어느 쪽이 온전한지 몰라 그대로 뒀어요. 확인해서 하나만 남겨 주세요`,
    ]);
    expect([snapshotOf(stash.path), snapshotOf(stash.backup)]).toEqual(both);
  });

  it('되돌릴 단계가 없으면 실행 폴더를 만들지 않고 revertedBy도 남기지 않는다', () => {
    const codexRules = join(f.home, '.codex/AGENTS.md');
    const empty = new RunWriter('sync', f.home);
    empty.log({
      op: 'pending',
      action: { op: 'stash', path: codexRules, backup: empty.backupPathFor(codexRules) },
    });
    const dirsBefore = readdirSync(backupsRoot());

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.changes).toEqual([]);
    expect(result.run).toBeUndefined();
    expect(readdirSync(backupsRoot())).toEqual(dirsBefore);
    const record = recordOf(empty.dir);
    expect(record.revertedAt).toBeDefined();
    expect(record.revertedBy).toBeUndefined();
  });

  it('상대 경로 링크인 스킬은 옮긴 뒤에도 되돌린 뒤에도 같은 곳을 가리킨다', () => {
    f.write('shared/rel-skill/SKILL.md', '# rel\n');
    symlinkSync('../../shared/rel-skill', join(f.home, '.claude/skills/rel'));
    sync();
    expect(linkOf(join(f.home, '.agents/skills/rel'))).toBe(join(f.home, 'shared/rel-skill'));
    expect(readFileSync(join(f.home, '.agents/skills/rel/SKILL.md'), 'utf-8')).toBe('# rel\n');

    runRevert({ ...scope(), dryRun: false });
    expect(readFileSync(join(f.home, '.claude/skills/rel/SKILL.md'), 'utf-8')).toBe('# rel\n');
  });

  it('rename이 EXDEV로 실패하면 복사하고 지워서 옮기고 되돌리기도 된다', () => {
    const before = snapshot(f.home);
    failRename((to) => to === alphaIn(), 'EXDEV');
    sync();
    expect(vi.mocked(cpSync)).toHaveBeenCalled();
    expect(readFileSync(join(alphaIn(), 'SKILL.md'), 'utf-8')).toBe('# alpha\n');
    expect(linkOf(join(f.home, '.claude/skills'))).toBe(join(f.home, '.agents/skills'));

    runRevert({ ...scope(), dryRun: false });
    expect(snapshot(f.home)).toEqual(before);
  });

  it('EXDEV 복사가 중간에 실패하면 반쯤 복사된 것을 지우고 원래 것은 남긴다', () => {
    const from = join(f.home, 'x/dir');
    f.write('x/dir/a.md', 'a\n');
    const to = join(f.home, 'y/dir');
    failRename((dest) => dest === to, 'EXDEV');
    vi.mocked(cpSync).mockImplementation((_src, dest) => {
      realFs.mkdirSync(String(dest), { recursive: true });
      realFs.writeFileSync(join(String(dest), 'half'), '');
      throw errno('ENOSPC');
    });

    expect(() => movePath(from, to)).toThrow('ENOSPC');
    expect(existsSync(to)).toBe(false);
    expect(readFileSync(join(from, 'a.md'), 'utf-8')).toBe('a\n');
  });

  it('sync 뒤 링크 자리에 실제 파일을 두면 되돌릴 때 그 파일을 백업하고 알린다', () => {
    const before = snapshot(f.home);
    sync();
    const codexRules = join(f.home, '.codex/AGENTS.md');
    unlinkSync(codexRules);
    writeFileSync(codexRules, '# sync 뒤에 쓴 것\n');

    const result = runRevert({ ...scope(), dryRun: false });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('~/.codex/AGENTS.md에 sync 뒤로 바뀐 것이 있어');
    const backup = recordOf(result.run!.dir).actions.find(
      (a) => a.op === 'backup' && a.path === codexRules,
    );
    expect(backup?.op === 'backup' && readFileSync(backup.backup, 'utf-8')).toBe(
      '# sync 뒤에 쓴 것\n',
    );
    expect(snapshot(f.home)).toEqual(before);
  });
});

describe('경로 판정 (Q8)', () => {
  it('같은 경로와 ..으로 시작하는 이름은 안쪽, 부모와 형제는 바깥이다', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/..cache/x')).toBe(true);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
  });

  it('홈 아래 ..cache 같은 이름도 home/ 아래에 백업하고 ~로 줄인다', () => {
    const dir = join(backupsRoot(), 'run');
    const path = join(f.home, '..cache/x');
    expect(backupPathIn(dir, f.home, path)).toBe(join(dir, 'home', '..cache/x'));
    expect(tildify(path, f.home)).toBe('~/..cache/x');
    expect(backupPathIn(dir, f.home, '/etc/hosts')).toBe(join(dir, 'root', 'etc/hosts'));
  });
});
