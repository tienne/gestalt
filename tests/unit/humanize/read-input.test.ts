/**
 * 검사 대상을 읽는 경계.
 *
 * humanize-scan 과 humanize-check 가 같은 탐지기를 돌리므로 읽는 경계도 같아야 한다.
 * 한쪽만 막으면 다른 쪽으로 상한을 우회해 같은 정규식에 임의 크기를 먹일 수 있다.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReadFailure, readInput, MAX_INPUT_BYTES } from '../../../src/humanize/read-input.js';

const dir = mkdtempSync(join(tmpdir(), 'read-input-'));
const write = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readInput', () => {
  it('파일 내용을 그대로 돌려준다', () => {
    expect(readInput(write('a.md', '값을 산출합니다.\n'))).toBe('값을 산출합니다.\n');
  });

  it('상한을 넘으면 읽지 않고 크기를 알려준다', () => {
    const result = readInput(write('big.md', 'a'.repeat(MAX_INPUT_BYTES + 1)));
    expect(isReadFailure(result)).toBe(true);
    if (isReadFailure(result)) expect(result.message).toContain('너무 큽니다');
  });

  it('파일이 아니면 그 사실을 가른다', () => {
    const result = readInput(dir);
    expect(isReadFailure(result)).toBe(true);
    if (isReadFailure(result)) expect(result.message).toContain('파일이 아닙니다');
  });

  it('없는 파일과 못 읽는 파일을 다르게 말한다', () => {
    const missing = readInput(join(dir, '없는파일.md'));
    expect(isReadFailure(missing) && missing.message).toContain('파일이 없습니다');

    // 끊긴 심볼릭 링크는 ENOENT 라 부재로 읽힌다. 권한과 링크 순환은 다른 코드로 갈린다
    const dangling = join(dir, 'dangling.md');
    symlinkSync(join(dir, '대상없음.md'), dangling);
    const broken = readInput(dangling);
    expect(isReadFailure(broken)).toBe(true);
  });

  it('상한과 정확히 같은 크기는 읽는다', () => {
    // 상한 하나만 넘겨 보면 부등호 방향이 안 고정된다. 양쪽을 다 밟아야 >= 로 바뀌는 걸 잡는다
    expect(typeof readInput(write('exact.md', 'a'.repeat(MAX_INPUT_BYTES)))).toBe('string');
  });

  it('크기를 0 으로 보고하는 특수 파일도 막는다', () => {
    // isFile() 을 !isDirectory() 로 느슨하게 바꾸면 /dev/zero 가 size 0 으로 통과한다.
    // 디렉터리만 밟으면 그 변경이 초록불로 지나간다
    if (!existsSync('/dev/zero')) return;
    const result = readInput('/dev/zero');
    expect(isReadFailure(result)).toBe(true);
    if (isReadFailure(result)) expect(result.message).toContain('파일이 아닙니다');
  });

  it('label 을 주면 메시지 앞에 붙는다', () => {
    const result = readInput(join(dir, '없는파일.md'), '원문');
    expect(isReadFailure(result) && result.message.startsWith('원문 ')).toBe(true);
  });
});
