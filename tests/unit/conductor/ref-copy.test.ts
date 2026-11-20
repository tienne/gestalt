import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyReportRefs, REFS_DIR } from '../../../src/conductor/ref-copy.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(cleanupStateDirs);

/** 저장소와 워커 작업 자리를 따로 만든다. 워커 쪽은 절대 경로로 넘긴다 */
function setup() {
  const stateDir = tempStateDir();
  const work = resolve(tempStateDir());
  const file = (name: string, body: string | Buffer) => {
    const p = join(work, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const copy = (refs: string[], over: Partial<Parameters<typeof copyReportRefs>[0]> = {}) =>
    copyReportRefs({ stateDir, orderId: 'ord-1', reportName: 'r1.json', refs, ...over });
  return { stateDir, work, file, copy };
}

describe('refs 사본', () => {
  it('저장소 밖 텍스트 파일을 refs/<주문 id>/로 복사하고 원래 값을 함께 남긴다', () => {
    const { stateDir, file, copy } = setup();
    const md = file('out/review.md', '# 리뷰\n본문');
    const log = file('run.log', 'line\n');

    const out = copy([md, log]);

    expect(out).toHaveLength(2);
    expect(out[0]!.ref).toBe(md);
    expect(out[0]!.path).toMatch(/^refs\/ord-1\/[0-9a-f]{8}-review\.md$/);
    expect(readFileSync(join(stateDir, out[0]!.path!), 'utf-8')).toBe('# 리뷰\n본문');
    expect(out[1]!.path).toMatch(/-run\.log$/);
    expect(out.every((c) => !c.truncated && !c.skipped)).toBe(true);
  });

  it('주소, 상대 경로, 디렉토리, 없는 파일, 허용 밖 확장자, 바이너리는 결과에 넣지 않는다', () => {
    const { stateDir, work, file, copy } = setup();
    const bin = file('dump.log', Buffer.from([0x61, 0x00, 0x62]));
    const png = file('shot.png', 'x');
    file('rel.md', 'x');

    const out = copy([
      'https://example.com/a.md',
      'acme/app#12',
      'rel.md',
      work,
      join(work, 'gone.md'),
      png,
      bin,
    ]);

    expect(out).toEqual([]);
    expect(existsSync(join(stateDir, REFS_DIR))).toBe(false);
  });

  it('~/ 경로는 홈 디렉토리 기준으로 푼다', () => {
    const { work, file, copy } = setup();
    file('note.txt', '메모');
    const out = copy(['~/note.txt'], { homeDir: work });
    expect(out[0]!.path).toMatch(/-note\.txt$/);
  });

  it('파일 상한을 넘으면 앞부분만 남기고 원래 크기를 적는다', () => {
    const { stateDir, file, copy } = setup();
    const big = file('big.log', 'a'.repeat(100));
    const out = copy([big], { maxFileBytes: 40 });
    expect(out[0]).toMatchObject({ truncated: true, size: 100 });
    expect(readFileSync(join(stateDir, out[0]!.path!), 'utf-8')).toBe('a'.repeat(40));
  });

  it('보고 합계 상한을 넘는 파일부터는 복사하지 않고 건너뛴 사실을 남긴다', () => {
    const { file, copy } = setup();
    const a = file('a.md', 'a'.repeat(30));
    const b = file('b.md', 'b'.repeat(30));
    const c = file('c.md', 'c'.repeat(5));
    const out = copy([a, b, c], { maxReportBytes: 40 });
    expect(out[0]!.path).toBeDefined();
    expect(out[1]).toEqual({ ref: b, skipped: 'report-limit', size: 30 });
    expect(out[2]!.path).toBeDefined();
  });

  it('심링크와 .. 경로, 저장소 안 파일은 복사하지 않는다', () => {
    const { stateDir, work, file, copy } = setup();
    const secret = file('secret.key', 'token');
    symlinkSync(secret, join(work, 'link.md'));
    const inside = join(stateDir, 'results.md');
    writeFileSync(inside, '이미 저장소 안');
    file('sub/x.md', 'x');

    const out = copy([join(work, 'link.md'), `${work}/sub/../sub/x.md`, resolve(inside)]);

    expect(out).toEqual([]);
  });

  it('주문 id가 경로를 벗어날 꼴이면 아무것도 복사하지 않는다', () => {
    const { stateDir, file, copy } = setup();
    const md = file('a.md', 'x');
    expect(copy([md], { orderId: '../evil' })).toEqual([]);
    expect(copy([md], { orderId: 'a/b' })).toEqual([]);
    expect(existsSync(join(stateDir, REFS_DIR))).toBe(false);
  });

  it('refs 디렉토리가 심링크로 바뀌어 있으면 쓰지 않고 실패로 남긴다', () => {
    const { stateDir, work, file, copy } = setup();
    const md = file('a.md', 'x');
    const elsewhere = join(work, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(resolve(elsewhere), join(stateDir, REFS_DIR));

    const out = copy([md]);

    expect(out[0]).toMatchObject({ ref: md, skipped: 'error' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('같은 보고를 다시 처리해도 사본은 하나다', () => {
    const { stateDir, file, copy } = setup();
    const md = file('a.md', 'x');
    const first = copy([md]);
    const second = copy([md]);
    expect(second).toEqual(first);
    expect(readdirSync(join(stateDir, REFS_DIR, 'ord-1'))).toHaveLength(1);
  });
});
