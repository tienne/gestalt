import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readJsonOrQuarantine, writeJsonAtomic } from '../../../src/core/json-file.js';

describe('json-file', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = join(tmpdir(), `gestalt-json-file-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'data.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('없는 파일은 undefined를 돌려준다', () => {
    expect(readJsonOrQuarantine(file)).toBeUndefined();
  });

  it('쓰고 나면 임시 파일이 안 남는다', () => {
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });

    expect(readdirSync(dir)).toEqual(['data.json']);
    expect(readJsonOrQuarantine(file)).toEqual({ a: 2 });
  });

  it('없는 디렉토리도 만들어서 쓴다', () => {
    const nested = join(dir, 'a', 'b', 'data.json');
    writeJsonAtomic(nested, [1]);
    expect(readJsonOrQuarantine(nested)).toEqual([1]);
  });

  it('깨진 JSON은 백업으로 옮기고 경고를 남긴다', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(file, '{"specHistory": [', 'utf-8');

    expect(readJsonOrQuarantine(file)).toBeUndefined();

    // 내용이 백업에 그대로 남아야 사람이 되살릴 수 있다
    expect(existsSync(file)).toBe(false);
    const backups = readdirSync(dir).filter((n) => n.startsWith('data.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf-8')).toBe('{"specHistory": [');
    expect(stderr).toHaveBeenCalledWith('[gestalt]', expect.stringContaining(backups[0]!));
  });

  it('모양이 안 맞는 JSON도 백업으로 옮긴다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(file, 'null', 'utf-8');

    expect(readJsonOrQuarantine(file, (v) => typeof v === 'object' && v !== null)).toBeUndefined();
    expect(readdirSync(dir).some((n) => n.startsWith('data.json.corrupt-'))).toBe(true);
  });

  it('quarantine을 끄면 깨진 파일을 그대로 둔다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(file, '{"specHistory": [', 'utf-8');

    expect(readJsonOrQuarantine(file, undefined, { quarantine: false })).toBeUndefined();
    expect(readdirSync(dir)).toEqual(['data.json']);
  });

  it('mode를 주면 그 권한으로 쓴다', () => {
    writeJsonAtomic(file, { a: 1 }, { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
