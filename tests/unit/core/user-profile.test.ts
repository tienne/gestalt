import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadUserProfile, profilePath } from '../../../src/core/user-profile.js';

/**
 * 프로필은 홈 한 곳에서만 읽는다. 여기 값이 자동 APPROVE를 켜므로 어디서 읽는지가 곧
 * 누가 내 계정의 승인을 켤 수 있는지다.
 */
describe('사용자 프로필', () => {
  const saved = process.env['GESTALT_HOME'];
  const made: string[] = [];
  let home: string;

  const write = (content: string) => {
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    writeFileSync(join(home, '.gestalt', 'profile.json'), content);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), `gestalt-profile-${randomUUID().slice(0, 8)}-`));
    made.push(home);
    process.env['GESTALT_HOME'] = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['GESTALT_HOME'];
    else process.env['GESTALT_HOME'] = saved;
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('GESTALT_HOME 아래 .gestalt/profile.json을 읽는다', () => {
    expect(profilePath()).toBe(join(home, '.gestalt', 'profile.json'));
    write(JSON.stringify({ review: { audience: 'junior', approveWhenNoBlocking: true } }));

    const p = loadUserProfile();
    expect(p.exists).toBe(true);
    expect(p.review).toEqual({ audience: 'junior', approveWhenNoBlocking: true });
    expect(p.warnings).toEqual([]);
  });

  it('파일이 없으면 빈 프로필이고 경고도 없다', () => {
    const p = loadUserProfile();
    expect(p).toEqual({ path: profilePath(), exists: false, review: {}, warnings: [] });
  });

  it('JSON이 깨졌으면 경고하고 전부 비운다', () => {
    write('{ "review": { "audience": "junior", }');
    const p = loadUserProfile();
    expect(p.exists).toBe(true);
    expect(p.review).toEqual({});
    expect(p.warnings).toHaveLength(1);
  });

  it('맨 바깥이 객체가 아니면 경고하고 전부 비운다', () => {
    write('[]');
    const p = loadUserProfile();
    expect(p.review).toEqual({});
    expect(p.warnings).toHaveLength(1);
  });

  it('값이 틀린 칸만 비우고 나머지는 살린다', () => {
    write(
      JSON.stringify({
        review: { audience: 'senior', postVerdict: false, approveWhenNoBlocking: 'yes' },
      }),
    );
    const p = loadUserProfile();
    expect(p.review).toEqual({ postVerdict: false });
    expect(p.warnings.some((w) => w.includes('review.audience'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('review.approveWhenNoBlocking'))).toBe(true);
  });

  it('모르는 키는 경고하고 무시한다', () => {
    write(
      JSON.stringify({ ship: { skipCopilot: true }, review: { audience: 'peer', autoPost: true } }),
    );
    const p = loadUserProfile();
    expect(p.review).toEqual({ audience: 'peer' });
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ship'),
        expect.stringContaining('review.autoPost'),
      ]),
    );
  });

  it('review 칸이 객체가 아니면 경고하고 그 칸을 비운다', () => {
    write(JSON.stringify({ review: 'junior' }));
    const p = loadUserProfile();
    expect(p.review).toEqual({});
    expect(p.warnings).toHaveLength(1);
  });

  it('파일 자리에 디렉토리가 있으면 경고하고 비운다', () => {
    mkdirSync(join(home, '.gestalt', 'profile.json'), { recursive: true });
    const p = loadUserProfile();
    expect(p.exists).toBe(true);
    expect(p.review).toEqual({});
    expect(p.warnings).toHaveLength(1);
  });
});

describe('CLI profile show', { timeout: 60_000 }, () => {
  const bin = resolve('bin/gestalt.ts');
  const made: string[] = [];

  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const tmp = (label: string) => {
    const d = mkdtempSync(join(tmpdir(), `gestalt-profile-${label}-${randomUUID().slice(0, 8)}-`));
    made.push(d);
    return d;
  };

  it('남의 레포에서 불러도 홈 프로필만 읽고 레포 쪽 파일은 안 본다', () => {
    const home = tmp('home');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    writeFileSync(
      join(home, '.gestalt', 'profile.json'),
      JSON.stringify({ review: { audience: 'junior' } }),
    );

    // 남의 레포가 자동 APPROVE를 켜 두려고 심어 둔 파일들
    const repo = tmp('repo');
    mkdirSync(join(repo, '.gestalt'), { recursive: true });
    writeFileSync(
      join(repo, '.gestalt', 'profile.json'),
      JSON.stringify({ review: { approveWhenNoBlocking: true } }),
    );
    writeFileSync(
      join(repo, 'gestalt.json'),
      JSON.stringify({ review: { approveWhenNoBlocking: true } }),
    );

    const stdout = execFileSync('npx', ['tsx', bin, 'profile', 'show', '--json'], {
      cwd: repo,
      encoding: 'utf-8',
      env: { ...process.env, GESTALT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = JSON.parse(stdout) as { review: Record<string, unknown>; path: string };
    expect(out.path).toBe(join(home, '.gestalt', 'profile.json'));
    expect(out.review).toEqual({ audience: 'junior' });
  });

  it('깨진 파일도 종료 코드 0으로 경고를 싣는다', () => {
    const home = tmp('broken');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    writeFileSync(join(home, '.gestalt', 'profile.json'), 'not json');

    const stdout = execFileSync('npx', ['tsx', bin, 'profile', 'show', '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, GESTALT_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = JSON.parse(stdout) as { review: Record<string, unknown>; warnings: string[] };
    expect(out.review).toEqual({});
    expect(out.warnings).toHaveLength(1);
  });
});
