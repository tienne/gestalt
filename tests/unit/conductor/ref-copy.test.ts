import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyReportRefs, REFS_DIR, removeOrderRefCopies } from '../../../src/conductor/ref-copy.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

const osTemps: string[] = [];
afterEach(() => {
  cleanupStateDirs();
  for (const d of osTemps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * 저장소와 워커 작업 자리, 홈을 따로 만든다. 워커 쪽은 절대 경로로 넘긴다.
 * 홈을 따로 두는 건 레포가 실제 홈 아래 어디에 있든 위치 판정이 같게 돌게 하려는 것이다
 */
function setup() {
  const stateDir = tempStateDir();
  const work = resolve(tempStateDir());
  const home = resolve(tempStateDir());
  const put = (root: string, name: string, body: string | Buffer) => {
    const p = join(root, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const file = (name: string, body: string | Buffer) => put(work, name, body);
  const homeFile = (name: string, body: string) => put(home, name, body);
  const copy = (refs: string[], over: Partial<Parameters<typeof copyReportRefs>[0]> = {}) =>
    copyReportRefs({
      stateDir,
      orderId: 'ord-1',
      reportName: 'r1.json',
      refs,
      homeDir: home,
      ...over,
    });
  return { stateDir, work, home, file, homeFile, copy };
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
    const target = file('target.key', 'x');
    symlinkSync(target, join(work, 'link.md'));
    const inside = join(stateDir, 'results.md');
    writeFileSync(inside, '이미 저장소 안');
    const dotted = join(resolve(stateDir), '..cache', 'x.md');
    mkdirSync(join(dotted, '..'));
    writeFileSync(dotted, '저장소 안 ..cache');
    file('sub/x.md', 'x');

    const out = copy([join(work, 'link.md'), `${work}/sub/../sub/x.md`, resolve(inside), dotted]);

    expect(out).toEqual([]);
  });

  it('홈 바로 아래 점 디렉토리, Library, 비밀 이름 파일은 거부한 사실만 남긴다', () => {
    const { work, file, homeFile, copy } = setup();
    const config = homeFile('.config/x.json', '{}');
    const keychain = homeFile('Library/Keychains/x.json', '{}');
    const named = file('aws-credentials.json', '{}');
    symlinkSync(join(config, '..'), join(work, 'via'));
    const viaLink = join(work, 'via', 'x.json');

    const out = copy([config, keychain, named, viaLink]);

    expect(out).toEqual([
      { ref: config, skipped: 'denied' },
      { ref: keychain, skipped: 'denied' },
      { ref: named, skipped: 'denied' },
      { ref: viaLink, skipped: 'denied' },
    ]);
  });

  it('소문자 library와 심링크로 걸린 홈 점 디렉토리, 흔한 비밀 이름도 거부한다', () => {
    const { home, file, homeFile, copy } = setup();
    const lower = homeFile('library/Keychains/y.json', '{}');
    homeFile('dotfiles/docker/config.json', '{}');
    symlinkSync(join(home, 'dotfiles', 'docker'), join(home, '.docker'));
    const linkedDot = '~/.docker/config.json';
    const names = [
      file('db-password.txt', 'x'),
      file('openai_api_key.txt', 'x'),
      file('kubeconfig.json', '{}'),
    ];

    const out = copy([lower, linkedDot, ...names]);

    expect(out).toEqual([lower, linkedDot, ...names].map((ref) => ({ ref, skipped: 'denied' })));
  });

  it('비밀 값 파일에 흔한 이름은 막고 그 말로 시작하는 문서는 복사한다', () => {
    const { file, copy } = setup();
    const blocked = [
      'password.txt',
      'api_key.json',
      'private-key.json',
      'service-account.json',
      'service-account-key.json',
      'x-firebase-adminsdk-ab12c-123.json',
      'auth.json',
    ].map((n) => file(n, '{}'));
    const allowed = [
      'password-reset-flow.md',
      'api-key-rotation-review.md',
      'service-account-migration.md',
    ].map((n) => file(n, 'x'));

    const out = copy([...blocked, ...allowed]);

    expect(out.filter((c) => c.skipped === 'denied').map((c) => c.ref)).toEqual(blocked);
    expect(out.filter((c) => c.path).map((c) => c.ref)).toEqual(allowed);
  });

  it('저장소 안이어도 워커 워크트리 파일은 복사한다', () => {
    const { stateDir, copy } = setup();
    const inWorktree = join(resolve(stateDir), 'worktrees', 'w1', 'out.md');
    mkdirSync(join(inWorktree, '..'), { recursive: true });
    writeFileSync(inWorktree, '워크트리 결과');

    const out = copy([inWorktree]);

    expect(out).toHaveLength(1);
    expect(readFileSync(join(stateDir, out[0]!.path!), 'utf-8')).toBe('워크트리 결과');
  });

  it('다른 경로로 같은 파일을 가리키면 사본 하나를 같이 쓴다', () => {
    const { stateDir, work, file, copy } = setup();
    const md = file('a.md', 'x');
    symlinkSync(work, join(work, 'alias'));
    const alias = join(work, 'alias', 'a.md');

    const out = copy([md, alias]);

    expect(out.map((c) => c.ref)).toEqual([md, alias]);
    expect(out[1]!.path).toBe(out[0]!.path);
    expect(readdirSync(join(stateDir, REFS_DIR, 'ord-1'))).toHaveLength(1);
  });

  it('오르카 첨부 자리와 레포 안 점 디렉토리, 시스템 임시 디렉토리는 복사한다', () => {
    const { homeFile, copy } = setup();
    const attached = homeFile(
      'Library/Application Support/orca/agent-session-attachments/s1/a.md',
      '첨부',
    );
    const review = homeFile('dev/repo/.git/review/a.md', '리뷰');
    const tmp = mkdtempSync(join(tmpdir(), 'ref-copy-'));
    osTemps.push(tmp);
    const inTmp = join(tmp, 'out.md');
    writeFileSync(inTmp, '임시');

    const out = copy([attached, review, inTmp]);

    expect(out.map((c) => c.ref)).toEqual([attached, review, inTmp]);
    expect(out.every((c) => c.path && !c.skipped)).toBe(true);
  });

  it('사본은 소유자만 읽고 쓰게 만든다', () => {
    const { stateDir, file, copy } = setup();
    const out = copy([file('a.md', 'x')]);
    const path = join(stateDir, out[0]!.path!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it('같은 ref가 두 번 오면 한 번만 복사하고 예산도 한 번만 쓴다', () => {
    const { file, copy } = setup();
    const a = file('a.md', 'a'.repeat(30));
    const b = file('b.md', 'b'.repeat(5));
    const out = copy([a, a, b], { maxReportBytes: 40 });
    expect(out.map((c) => c.ref)).toEqual([a, b]);
    expect(out.every((c) => c.path)).toBe(true);
  });

  it('파일 상한과 보고 상한을 둘 다 넘는 파일 하나는 앞부분 사본으로 남는다', () => {
    const { stateDir, file, copy } = setup();
    const big = file('big.log', 'a'.repeat(100));
    const out = copy([big], { maxFileBytes: 40, maxReportBytes: 50 });
    expect(out[0]).toMatchObject({ truncated: true, size: 100 });
    expect(readFileSync(join(stateDir, out[0]!.path!), 'utf-8')).toBe('a'.repeat(40));
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

  it('주문 디렉토리가 심링크로 바뀌어 있어도 쓰지 않고 실패로 남긴다', () => {
    const { stateDir, work, file, copy } = setup();
    const md = file('a.md', 'x');
    const elsewhere = join(work, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(stateDir, REFS_DIR));
    symlinkSync(resolve(elsewhere), join(stateDir, REFS_DIR, 'ord-1'));

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

describe('지운 주문의 사본 정리', () => {
  it('주문 사본 디렉토리를 지운다', () => {
    const { stateDir, file, copy } = setup();
    copy([file('a.md', 'x')]);
    expect(removeOrderRefCopies(stateDir, 'ord-1')).toBeUndefined();
    expect(existsSync(join(stateDir, REFS_DIR, 'ord-1'))).toBe(false);
  });

  it('사본이 없으면 아무것도 안 한다', () => {
    const { stateDir } = setup();
    expect(removeOrderRefCopies(stateDir, 'ord-1')).toBeUndefined();
  });

  it('refs가 저장소 밖 심링크면 밖의 디렉토리를 지우지 않고 경고만 돌려준다', () => {
    const { stateDir, work } = setup();
    const outside = join(work, 'outside');
    mkdirSync(join(outside, 'ord-1'), { recursive: true });
    symlinkSync(resolve(outside), join(stateDir, REFS_DIR));

    expect(removeOrderRefCopies(stateDir, 'ord-1')).toMatch(/디렉토리가 아니라/);
    expect(existsSync(join(outside, 'ord-1'))).toBe(true);
  });

  it('주문 디렉토리가 저장소 밖 심링크면 밖을 지우지 않고 경고를 돌려준다', () => {
    const { stateDir, work } = setup();
    const outside = join(work, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.md'), 'x');
    mkdirSync(join(stateDir, REFS_DIR));
    symlinkSync(resolve(outside), join(stateDir, REFS_DIR, 'ord-1'));

    expect(removeOrderRefCopies(stateDir, 'ord-1')).toMatch(/ord-1가 디렉토리가 아니라/);
    expect(existsSync(join(outside, 'keep.md'))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    '확인 중에 권한 오류가 나도 던지지 않고 경고를 돌려준다',
    () => {
      const { stateDir } = setup();
      const refs = join(stateDir, REFS_DIR);
      mkdirSync(join(refs, 'ord-1'), { recursive: true });
      chmodSync(refs, 0o000);
      try {
        expect(removeOrderRefCopies(stateDir, 'ord-1')).toMatch(/못 지웠어요/);
      } finally {
        chmodSync(refs, 0o700);
      }
    },
  );

  it('주문 id가 경로를 벗어날 꼴이면 지우지 않는다', () => {
    const { stateDir } = setup();
    expect(removeOrderRefCopies(stateDir, '../x')).toMatch(/꼴이 이상해/);
  });
});
