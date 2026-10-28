import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DigestStore } from '../../../src/digest/store.js';
import { findKnowledge, knowledgeRoots } from '../../../src/lens/knowledge.js';
import {
  addNoteSources,
  declineNoteSources,
  detectNoteFolders,
  readUserLens,
  removeNoteSource,
  setNotion,
} from '../../../src/lens/notes.js';
import { LENS_SLUG, lensTranscript } from './fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const r = resolve('.gestalt-test', `lens-notes-${randomUUID()}`);
  mkdirSync(r, { recursive: true });
  dirs.push(r);
  return realpathSync(r);
}
function notes(dir: string, names: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), `# ${n}\nFlavorGraph 메모\n`);
}

describe('노트 폴더 탐지', () => {
  it('Orca 없이 레포와 홈의 흔한 폴더에서 노트 폴더와 노트 앱 보관함을 찾는다', () => {
    const root = tmp();
    const home = join(root, 'home');
    const repo = join(home, 'work', 'app');
    notes(join(repo, 'docs', 'notes'), ['a.md', 'b.md', 'c.md']);
    // 노트가 셋보다 적은 폴더와 이름만 그럴듯한 폴더는 후보가 아니다
    notes(join(repo, 'wiki'), ['only.md']);
    notes(join(repo, 'plugin', 'skills', 'research'), ['x.md', 'y.md', 'z.md']);
    notes(join(repo, 'node_modules', 'pkg', 'notes'), ['a.md', 'b.md', 'c.md']);
    const vault = join(home, 'Documents', 'MyVault');
    notes(join(vault, 'daily'), ['1.md', '2.md', '3.md']);
    mkdirSync(join(vault, '.obsidian'));
    const graph = join(home, 'notes', 'graph');
    notes(join(graph, 'pages'), ['p1.md', 'p2.md', 'p3.md']);
    mkdirSync(join(graph, 'logseq'));
    writeFileSync(join(graph, 'logseq', 'config.edn'), '{}');
    const exported = join(home, 'Downloads', 'Export-abc');
    notes(exported, [
      `회의록 ${'a'.repeat(32)}.md`,
      `아이디어 ${'b'.repeat(32)}.md`,
      `참고 ${'c'.repeat(32)}.md`,
    ]);
    const { candidates: found, partialBases } = detectNoteFolders({
      repoRoot: repo,
      home,
      userFile: join(root, 'lens.json'),
    });
    expect(partialBases).toEqual([]);
    const byPath = Object.fromEntries(found.map((c) => [c.path, c.reason]));
    expect(byPath).toEqual({
      [join(repo, 'docs', 'notes')]: 'name',
      [vault]: 'obsidian',
      [graph]: 'logseq',
      [exported]: 'notion-export',
    });
    expect(found.find((c) => c.path === vault)?.notes).toBe(3);
  });

  it('넘겨받은 폴더(Orca 레포 같은)도 더 훑고 연결해 둔 폴더는 표시한다', () => {
    const root = tmp();
    const other = join(root, 'other-repo');
    notes(join(other, 'kb'), ['1.md', '2.md', '3.md']);
    const file = join(root, 'lens.json');
    addNoteSources([join(other, 'kb')], file);
    const { candidates: found } = detectNoteFolders({
      repoRoot: join(root, 'nowhere'),
      home: join(root, 'home'),
      scan: [other],
      userFile: file,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: join(other, 'kb'), configured: true });
  });

  it('폴더 수 상한을 바탕 폴더마다 나눠 앞 폴더가 다 써도 뒤 폴더를 훑고 멈춘 폴더를 알린다', () => {
    const root = tmp();
    const repo = join(root, 'x', 'repo');
    for (let i = 0; i < 20; i++) mkdirSync(join(repo, `d${i}`), { recursive: true });
    const other = join(root, 'other');
    notes(join(other, 'kb'), ['1.md', '2.md', '3.md']);
    const { candidates, partialBases } = detectNoteFolders({
      repoRoot: repo,
      home: join(root, 'home'),
      scan: [other],
      userFile: join(root, 'lens.json'),
      visitCap: 9,
    });
    expect(candidates.map((c) => c.path)).toEqual([join(other, 'kb')]);
    expect(partialBases).toEqual([repo, join(root, 'x')]);
  });

  it('노트가 상한보다 많으면 세다 멈추고 notesCapped를 단다', () => {
    const root = tmp();
    const kb = join(root, 'repo', 'kb');
    notes(
      kb,
      Array.from({ length: 2001 }, (_, i) => `${i}.md`),
    );
    const { candidates } = detectNoteFolders({
      repoRoot: join(root, 'repo'),
      home: join(root, 'home'),
      userFile: join(root, 'lens.json'),
    });
    expect(candidates[0]).toMatchObject({ path: kb, notes: 2000, notesCapped: true });
  });
});

describe('노트 연결 저장(~/.gestalt/lens.json)', () => {
  it('연결과 빼기, 노션 켜기, 쓰지 않음을 적고 다시 연결하면 쓰지 않음을 지운다', () => {
    const root = tmp();
    const file = join(root, 'g', 'lens.json');
    notes(join(root, 'kb'), ['a.md']);
    expect(readUserLens(file)).toEqual({ knowledgeSources: [], notion: false, declined: false });
    expect(declineNoteSources(file).declined).toBe(true);
    const added = addNoteSources([join(root, 'kb'), join(root, 'kb')], file);
    expect(added).toEqual({ knowledgeSources: [join(root, 'kb')], notion: false, declined: false });
    expect(setNotion(true, file).notion).toBe(true);
    expect(removeNoteSource(join(root, 'kb'), file).knowledgeSources).toEqual([]);
    expect(() => addNoteSources([join(root, 'missing')], file)).toThrow(/폴더가 아니에요/);
  });

  it('연결해 둔 폴더와 노션 스냅샷 폴더가 노트 후보 찾기에 들어간다', () => {
    const root = tmp();
    const file = join(root, 'lens.json');
    notes(join(root, 'kb'), ['flavor.md']);
    addNoteSources([join(root, 'kb')], file);
    expect(knowledgeRoots(join(root, 'repo'), [], file).roots).toEqual([join(root, 'kb')]);

    const store = new DigestStore(root);
    store.saveTranscript(lensTranscript());
    const snap = join(store.dir(LENS_SLUG), 'knowledge-snapshots');
    mkdirSync(snap, { recursive: true });
    writeFileSync(
      join(snap, 'notion-1.md'),
      '<!-- source: https://www.notion.so/abc -->\nFlavorDiffusion 읽을거리\n',
    );
    const { file: k } = findKnowledge(LENS_SLUG, { repoRoot: root, userFile: file });
    expect(k.roots).toEqual([join(root, 'kb'), realpathSync(snap)]);
    expect(k.hits.some((h) => h.path.endsWith('notion-1.md'))).toBe(true);
  });
});
