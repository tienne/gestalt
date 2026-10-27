import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptTail } from '../../../src/peer/tail.js';

describe('TranscriptTail', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-tail-'));
    file = join(dir, 't.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('바이트 위치로 이어 읽는다', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const tail = new TranscriptTail(file);
    expect(tail.read()).toEqual({ lines: ['{"a":1}', '{"a":2}'], status: 'ok' });
    expect(tail.read()).toEqual({ lines: [], status: 'ok' });
    appendFileSync(file, '{"a":3}\n');
    expect(tail.read().lines).toEqual(['{"a":3}']);
  });

  it('개행 없는 마지막 줄은 다음 읽기까지 미룬다', () => {
    writeFileSync(file, '{"a":1}\n{"a":');
    const tail = new TranscriptTail(file);
    expect(tail.read().lines).toEqual(['{"a":1}']);
    expect(tail.position).toBe(8);
    appendFileSync(file, '2}');
    expect(tail.read().lines).toEqual([]);
    appendFileSync(file, '\n');
    expect(tail.read().lines).toEqual(['{"a":2}']);
  });

  it('멀티바이트 글자가 쓰기 경계에 걸려도 깨지지 않는다', () => {
    const line = JSON.stringify({ t: '한글' });
    const bytes = Buffer.from(line + '\n');
    writeFileSync(file, bytes.subarray(0, 9));
    const tail = new TranscriptTail(file);
    expect(tail.read().lines).toEqual([]);
    appendFileSync(file, bytes.subarray(9));
    expect(tail.read().lines).toEqual([line]);
  });

  it('파일이 줄어들면 처음부터 다시 읽지 않고 멈춘다', () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const tail = new TranscriptTail(file);
    tail.read();
    writeFileSync(file, '{"b":1}\n');
    expect(tail.read()).toEqual({ lines: [], status: 'truncated' });
    appendFileSync(file, '{"b":2}\n{"b":3}\n{"b":4}\n');
    expect(tail.read()).toEqual({ lines: [], status: 'truncated' });
  });

  it('다른 파일로 바뀌면 멈춘다', () => {
    writeFileSync(file, '{"a":1}\n');
    const tail = new TranscriptTail(file);
    tail.read();
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, '{"a":1}\n{"x":1}\n');
    renameSync(other, file);
    expect(tail.read().status).toBe('truncated');
  });

  it('파일이 없으면 missing이고 생기면 읽는다', () => {
    const tail = new TranscriptTail(file);
    expect(tail.read()).toEqual({ lines: [], status: 'missing' });
    writeFileSync(file, '{"a":1}\n');
    expect(tail.read()).toEqual({ lines: ['{"a":1}'], status: 'ok' });
  });
});
