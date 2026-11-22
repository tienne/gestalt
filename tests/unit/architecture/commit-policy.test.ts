import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCommitPolicy,
  ARCHITECTURE_DIR,
  IGNORED_FILE_TRACKED,
  PUBLIC_IGNORE_PATTERNS,
} from '../../../src/architecture/commit-policy.js';

let root: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function put(name: string, body = '{}'): string {
  const path = join(root, ARCHITECTURE_DIR, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return join(ARCHITECTURE_DIR, name);
}

function ignored(rel: string): boolean {
  try {
    git('check-ignore', '-q', '--no-index', '--', rel);
    return true;
  } catch {
    return false;
  }
}

const ignorePath = () => join(root, ARCHITECTURE_DIR, '.gitignore');

beforeEach(() => {
  root = join(process.cwd(), '.gestalt-test', `commit-policy-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('applyCommitPolicy — 공개 레포', () => {
  it('본인용 HTML과 IR JSON, 투영은 무시하고 공유본은 커밋할 수 있다', () => {
    const r = applyCommitPolicy(root, 'public');
    expect(r.ignoreFilePath).toBe(ignorePath());
    expect(r.ignored).toEqual([...PUBLIC_IGNORE_PATTERNS]);
    expect(r.trackedWarning).toBeUndefined();

    const rel = (n: string) => put(n);
    expect(ignored(rel('web.html'))).toBe(true);
    expect(ignored(rel('web.json'))).toBe(true);
    expect(ignored(rel('web.delta.html'))).toBe(true);
    expect(ignored(rel('views/web.p1.json'))).toBe(true);
    expect(ignored(rel('web.shared.html'))).toBe(false);
    expect(ignored(rel('web.delta.shared.html'))).toBe(false);
    expect(ignored(join(ARCHITECTURE_DIR, '.gitignore'))).toBe(false);
  });

  it('원자적 쓰기의 임시 파일과 격리 파일도 무시한다', () => {
    applyCommitPolicy(root, 'public');
    expect(ignored(put('screen-chain.json.corrupt-1700000000000'))).toBe(true);
    expect(ignored(put('screen-chain.html.1.abc.tmp'))).toBe(true);
    // 공유본 이름이 들어 있어도 임시 파일은 예외에 안 걸린다
    expect(ignored(put('screen-chain.shared.html.1.abc.tmp'))).toBe(true);
    expect(ignored(put('views/q1.json.corrupt-1700000000000'))).toBe(true);
  });

  it('두 번 돌려도 내용이 같다', () => {
    applyCommitPolicy(root, 'public');
    const first = readFileSync(ignorePath(), 'utf8');
    applyCommitPolicy(root, 'public');
    expect(readFileSync(ignorePath(), 'utf8')).toBe(first);
  });

  it('사람이 적은 줄은 남기고 관리 구역만 바꾼다', () => {
    put('.gitignore', 'notes.md\n');
    applyCommitPolicy(root, 'public');
    const text = readFileSync(ignorePath(), 'utf8');
    expect(text.startsWith('notes.md\n')).toBe(true);
    for (const p of PUBLIC_IGNORE_PATTERNS) expect(text).toContain(`\n${p}\n`);
    applyCommitPolicy(root, 'public');
    expect(readFileSync(ignorePath(), 'utf8')).toBe(text);
  });

  it('이미 추적 중인 무시 대상이 둘이어도 경고는 한 건이고 git rm은 하지 않는다', () => {
    put('web.html', '<p>');
    put('web.json');
    put('web.shared.html', '<p>');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const r = applyCommitPolicy(root, 'public');
    expect(r.trackedWarning).toBeDefined();
    expect(r.trackedWarning!.code).toBe(IGNORED_FILE_TRACKED);
    expect(r.trackedWarning!.paths).toEqual([
      '.gestalt/architecture/web.html',
      '.gestalt/architecture/web.json',
    ]);
    expect(r.trackedWarning!.message).toContain('git rm --cached --');
    // 서버가 추적을 풀지 않았다
    expect(git('ls-files', '--', ARCHITECTURE_DIR).trim().split('\n')).toHaveLength(3);
  });

  it('git이 실패해도 던지지 않고 경고 없이 끝낸다', () => {
    const r = applyCommitPolicy(root, 'public', {
      listTrackedIgnored: () => {
        throw new Error('not a git repository');
      },
    });
    expect(r.trackedWarning).toBeUndefined();
    expect(existsSync(ignorePath())).toBe(true);
  });
});

describe('applyCommitPolicy — 비공개 레포', () => {
  it('아무것도 무시하지 않고 .gitignore를 만들지 않는다', () => {
    const r = applyCommitPolicy(root, 'private');
    expect(r).toEqual({ ignored: [] });
    expect(existsSync(ignorePath())).toBe(false);
    expect(ignored(put('web.html'))).toBe(false);
    expect(ignored(put('web.json'))).toBe(false);
  });

  it('공개였다가 비공개가 되면 관리 구역만 걷어낸다', () => {
    put('.gitignore', 'notes.md\n');
    applyCommitPolicy(root, 'public');
    applyCommitPolicy(root, 'private');
    expect(readFileSync(ignorePath(), 'utf8')).toBe('notes.md\n');
  });

  it('관리 구역만 있던 파일은 지운다', () => {
    applyCommitPolicy(root, 'public');
    applyCommitPolicy(root, 'private');
    expect(existsSync(ignorePath())).toBe(false);
  });
});
