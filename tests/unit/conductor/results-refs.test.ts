import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIR_ENTRIES,
  MAX_FULL_READ_BYTES,
  TRUNCATED_READ_BYTES,
  classifyRef,
  loadResults,
  readRefBody,
  readTextFile,
  type RefContext,
} from '../../../src/conductor/results.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';
import { cleanupOutsideDirs, outsideDir, put, seed } from './results-fixtures.js';

afterEach(() => {
  cleanupStateDirs();
  cleanupOutsideDirs();
});

function ctx(roots: string[], worktreeNames: string[] = []): RefContext {
  return { roots: roots.map((r) => realpathSync(r)), worktreeNames };
}

describe('classifyRef', () => {
  it('허용 루트 안의 파일은 file이고 realpath와 크기를 낸다', () => {
    const dir = tempStateDir();
    const p = put(join(realpathSync(dir), 'reports', 'a.md'), '# 제목');
    const c = classifyRef(p, ctx([dir]));
    expect(c.kind).toBe('file');
    expect(c.path).toBe(realpathSync(p));
    expect(c.size).toBe(Buffer.byteLength('# 제목'));
    expect(c.ref).toBe(p);
  });

  it('허용 루트 밖에 있는 파일은 outside이고 경로를 안 준다', () => {
    const dir = tempStateDir();
    const out = put(join(outsideDir(), 'a.md'));
    const c = classifyRef(out, ctx([dir]));
    expect(c.kind).toBe('outside');
    expect(c.path).toBeUndefined();
  });

  it('repoPaths로 넘긴 루트는 허용한다', () => {
    const dir = tempStateDir();
    const repo = outsideDir();
    const p = put(join(repo, 'docs', 'note.md'));
    expect(classifyRef(p, ctx([dir])).kind).toBe('outside');
    expect(classifyRef(p, ctx([dir, repo])).kind).toBe('file');
  });

  it('루트와 이름만 앞부분이 같은 형제 디렉토리는 허용하지 않는다', () => {
    const base = outsideDir();
    const root = join(base, 'repo');
    mkdirSync(root);
    const sibling = put(join(base, 'repo-evil', 'a.md'));
    expect(classifyRef(sibling, ctx([root])).kind).toBe('outside');
  });

  it('심링크로 허용 루트 밖을 가리키면 outside', () => {
    const dir = realpathSync(tempStateDir());
    const target = put(join(outsideDir(), 'secret.md'));
    const link = join(dir, 'link.md');
    symlinkSync(target, link);
    expect(classifyRef(link, ctx([dir])).kind).toBe('outside');
  });

  it('.. 로 루트를 빠져나가는 경로는 outside', () => {
    const base = outsideDir();
    const root = join(base, 'root');
    mkdirSync(root);
    const secret = put(join(base, 'secret.md'));
    expect(classifyRef(join(root, '..', 'secret.md'), ctx([root])).kind).toBe('outside');
    expect(secret).toBeTruthy();
  });

  it('없는 파일은 missing, 허용 루트 밖이어도 realpath가 안 풀리면 missing', () => {
    const dir = tempStateDir();
    expect(classifyRef(join(realpathSync(dir), 'nope.md'), ctx([dir])).kind).toBe('missing');
    expect(classifyRef(join(outsideDir(), 'nope.md'), ctx([dir])).kind).toBe('missing');
  });

  it('확장자 화이트리스트 밖(이미지, 확장자 없음)은 unsupported', () => {
    const dir = realpathSync(tempStateDir());
    const png = put(join(dir, 'shot.png'));
    const bare = put(join(dir, 'README'));
    expect(classifyRef(png, ctx([dir])).kind).toBe('unsupported');
    expect(classifyRef(bare, ctx([dir])).kind).toBe('unsupported');
    for (const ext of ['md', 'markdown', 'txt', 'log', 'json', 'diff', 'patch', 'MD']) {
      expect(classifyRef(put(join(dir, `ok.${ext}`)), ctx([dir])).kind, ext).toBe('file');
    }
  });

  it('http와 https만 url이고 다른 스킴과 상대 경로, SHA는 reference', () => {
    const c = ctx([tempStateDir()]);
    const url = classifyRef('https://example.com/a b?x=1', c);
    expect(url.kind).toBe('url');
    expect(url.display).toBe('https://example.com/a%20b?x=1');
    expect(classifyRef('http://example.com/', c).kind).toBe('url');
    for (const v of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'data:text/html,<b>',
      'docs/a.md',
      '../a.md',
      '~/a.md',
      'a1b2c3d',
      'acme/app#12',
      '',
    ]) {
      expect(classifyRef(v, c).kind, v).toBe('reference');
    }
  });

  it('널 문자가 섞인 경로는 reference', () => {
    expect(classifyRef('/tmp/a\0.md', ctx([tempStateDir()])).kind).toBe('reference');
  });

  it('디렉토리는 dir이고 바로 아래 읽을 수 있는 파일만 이름순으로 낸다', () => {
    const dir = realpathSync(tempStateDir());
    const d = join(dir, 'refs', 'ord-x');
    put(join(d, 'b.md'), 'bb');
    put(join(d, 'a.log'), 'a');
    put(join(d, 'c.png'));
    put(join(d, 'sub', 'deep.md'));
    symlinkSync(put(join(outsideDir(), 'out.md')), join(d, 'link.md'));
    const c = classifyRef(d, ctx([dir]));
    expect(c.kind).toBe('dir');
    expect(c.entries?.map((e) => e.name)).toEqual(['a.log', 'b.md']);
    expect(c.entries?.[1]?.size).toBe(2);
  });

  it('디렉토리 항목은 최대 50개까지만 낸다', () => {
    const dir = realpathSync(tempStateDir());
    const d = join(dir, 'many');
    for (let i = 0; i < MAX_DIR_ENTRIES + 5; i++) put(join(d, `f${String(i).padStart(3, '0')}.md`));
    expect(classifyRef(d, ctx([dir])).entries).toHaveLength(MAX_DIR_ENTRIES);
  });

  it('오르카 워크트리 이름은 상위 디렉토리 조각에만 걸리고 파일 이름에는 안 걸린다', () => {
    const base = outsideDir();
    const inTree = put(join(base, 'ord-0123abcd-1', 'out.md'));
    const asFile = put(join(base, 'ord-0123abcd-1.md'));
    const c = ctx([tempStateDir()], ['ord-0123abcd-1']);
    expect(classifyRef(inTree, c).kind).toBe('file');
    expect(classifyRef(asFile, c).kind).toBe('outside');
  });
});

describe('readTextFile', () => {
  it('1MB 이하는 통째로 읽는다', () => {
    const dir = realpathSync(tempStateDir());
    const p = put(join(dir, 'a.txt'), '가나다');
    expect(readTextFile(p, [dir])).toEqual({ text: '가나다', truncated: false, size: 9 });
  });

  it('1MB를 넘으면 앞 256KB만 읽고 truncated와 원래 크기를 낸다', () => {
    const dir = realpathSync(tempStateDir());
    const p = join(dir, 'big.log');
    writeFileSync(p, 'x'.repeat(MAX_FULL_READ_BYTES + 1));
    const b = readTextFile(p, [dir])!;
    expect(b.truncated).toBe(true);
    expect(b.size).toBe(MAX_FULL_READ_BYTES + 1);
    expect(b.text).toHaveLength(TRUNCATED_READ_BYTES);
  });

  it('정확히 1MB는 자르지 않는다', () => {
    const dir = realpathSync(tempStateDir());
    const p = join(dir, 'edge.log');
    writeFileSync(p, 'x'.repeat(MAX_FULL_READ_BYTES));
    const b = readTextFile(p, [dir])!;
    expect(b.truncated).toBe(false);
    expect(b.text).toHaveLength(MAX_FULL_READ_BYTES);
  });

  it('분류 뒤 심링크로 바뀐 파일, 루트 밖 파일, 허용 안 된 확장자는 null', () => {
    const dir = realpathSync(tempStateDir());
    const secret = put(join(outsideDir(), 'secret.md'), '비밀');
    const link = join(dir, 'swapped.md');
    symlinkSync(secret, link);
    expect(readTextFile(link, [dir])).toBeNull();
    expect(readTextFile(secret, [dir])).toBeNull();
    expect(readTextFile(put(join(dir, 'a.png')), [dir])).toBeNull();
    expect(readTextFile(join(dir, 'gone.md'), [dir])).toBeNull();
  });
});

describe('readRefBody', () => {
  it('본문은 경로별로 캐시한다. 같은 LoadedResults로는 바뀐 파일이 안 보인다', () => {
    const base = tempStateDir();
    const note = put(join(realpathSync(base), 'reports', 'n.md'), '첫 본문');
    const { dir } = seed([{ reports: [{ refs: [note] }] }], base);
    const results = loadResults({ stateDir: dir });
    const [id] = Object.keys(results.snapshot.orders);
    const ref = results.orderRefs.get(id!)!.refs[0]!;
    expect(readRefBody(results, id!, ref)?.text).toBe('첫 본문');
    writeFileSync(note, '바뀐 본문');
    expect(readRefBody(results, id!, ref)?.text).toBe('첫 본문');
    expect(readRefBody(loadResults({ stateDir: dir }), id!, ref)?.text).toBe('바뀐 본문');
  });

  it('file이 아닌 ref와 범위 밖 디렉토리 항목 번호는 null', () => {
    const base = tempStateDir();
    const d = join(realpathSync(base), 'refs', 'x');
    put(join(d, 'a.md'), 'A');
    const { dir } = seed([{ reports: [{ refs: [d, 'https://example.com/x'] }] }], base);
    const results = loadResults({ stateDir: dir });
    const [id] = Object.keys(results.snapshot.orders);
    const [dirRef, urlRef] = results.orderRefs.get(id!)!.refs;
    expect(readRefBody(results, id!, urlRef!)).toBeNull();
    expect(readRefBody(results, id!, dirRef!)).toBeNull();
    expect(readRefBody(results, id!, dirRef!, 0)?.text).toBe('A');
    expect(readRefBody(results, id!, dirRef!, 5)).toBeNull();
  });
});
