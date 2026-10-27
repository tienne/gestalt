import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLensSource } from '../../../src/digest/lens-source.js';
import { DigestStore } from '../../../src/digest/store.js';
import type { RunCommand } from '../../../src/digest/ytdlp.js';
import { CommandError } from '../../../src/digest/ytdlp.js';
import { ingestLens } from '../../../src/lens/ingest.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const r = resolve('.gestalt-test', `lens-ingest-${randomUUID()}`);
  mkdirSync(r, { recursive: true });
  dirs.push(r);
  return r;
}

const EXTRACT = {
  title: '',
  pageCount: 1,
  pages: [{ n: 1, width: 595, height: 842, image: 'pages/p1.jpg' }],
  units: [
    {
      i: 0,
      page: 1,
      role: 'heading',
      text: 'A Paper Title',
      rects: [{ page: 1, bbox: [70, 70, 500, 90] }],
    },
    {
      i: 1,
      page: 1,
      role: 'para',
      text: 'Body text.',
      rects: [{ page: 1, bbox: [70, 100, 290, 200] }],
    },
    {
      i: 2,
      page: 1,
      role: 'caption',
      ref: 'table-1',
      text: 'Table 1: Numbers',
      rects: [{ page: 1, bbox: [306, 100, 524, 120] }],
    },
  ],
  tables: [
    {
      id: 'table-1',
      number: '1',
      caption: 'Table 1: Numbers',
      page: 1,
      rows: [
        ['a', 'b'],
        ['x', '1'],
      ],
      grid: 'ok',
      unit: 2,
    },
  ],
  figures: [{ id: 'figure-1', number: '1', caption: 'Figure 1: Pic', page: 1, unit: 2 }],
};

function pdfFile(dir: string): string {
  const p = join(dir, 'paper.pdf');
  writeFileSync(p, '%PDF-1.7\n...');
  return p;
}

describe('ingestLens (pdf)', () => {
  it('추출 결과로 문단 transcript.json과 source.json을 쓴다', async () => {
    const root = repo();
    const calls: string[][] = [];
    const run: RunCommand = async (cmd, args, opts) => {
      calls.push([cmd, ...args.slice(0, 2)]);
      // 파이썬은 레포 밖 임시 폴더에서 돈다
      expect(opts.cwd.startsWith(root)).toBe(false);
      mkdirSync(join(args[4]!, 'pages'), { recursive: true });
      writeFileSync(join(args[4]!, 'pages', 'p1.jpg'), 'jpg');
      return { stdout: `progress\n${JSON.stringify(EXTRACT)}\n`, stderr: '' };
    };
    const r = await ingestLens(pdfFile(root), { repoRoot: root, run, python: '/usr/bin/python3' });
    expect(calls[0]).toEqual(['/usr/bin/python3', '-I', '-c']);
    expect(r.kind).toBe('pdf');
    expect(r.title).toBe('A Paper Title');
    expect(r.slug).toMatch(/^a-paper-title-[0-9a-f]{8}$/);
    const store = new DigestStore(root);
    const t = store.readTranscript(r.slug);
    expect(t.ok && t.transcript.meta.source).toBe('pdf');
    expect(t.ok && t.transcript.segments[1]).toMatchObject({
      i: 1,
      startSec: 0,
      page: 1,
      role: 'para',
    });
    expect(readLensSource(store, r.slug)?.tables[0]?.rows).toEqual([
      ['a', 'b'],
      ['x', '1'],
    ]);
    expect(existsSync(join(store.dir(r.slug), 'pages', 'p1.jpg'))).toBe(true);
    expect(readFileSync(join(store.dir(r.slug), 'cache', 'source.pdf'), 'utf-8')).toContain('%PDF');
    expect(r.figures).toEqual([{ id: 'figure-1', cropped: false }]);
    expect(r.warnings.join('\n')).toContain('figure-1');
  });

  it('PDF가 아닌 파일은 거절한다', async () => {
    const root = repo();
    const p = join(root, 'fake.pdf');
    writeFileSync(p, '<html></html>');
    await expect(
      ingestLens(p, { repoRoot: root, run: async () => ({ stdout: '', stderr: '' }) }),
    ).rejects.toThrow(/PDF가 아니에요/);
  });

  it('유튜브 주소는 video-digest로 돌려보낸다', async () => {
    await expect(ingestLens('https://youtu.be/abc', { repoRoot: repo() })).rejects.toThrow(
      /video-digest/,
    );
  });

  it('파이썬 모듈이 없으면 설치 명령을 알려 준다', async () => {
    const root = repo();
    const run: RunCommand = async () => {
      throw new CommandError('python', "ModuleNotFoundError: No module named 'pdfplumber'", 'fail');
    };
    await expect(
      ingestLens(pdfFile(root), { repoRoot: root, run, python: '/x/python' }),
    ).rejects.toThrow(/pdfplumber.*\n.*pip install pdfplumber/s);
  });
});
