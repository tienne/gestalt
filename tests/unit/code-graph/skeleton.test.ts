import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractTypeScriptSkeleton } from '../../../src/code-graph/plugins/typescript-skeleton.js';
import { CodeGraphEngine } from '../../../src/code-graph/engine.js';
import { codeGraphEngine } from '../../../src/code-graph/index.js';
import { handleCodeGraphPassthrough } from '../../../src/mcp/tools/code-graph-passthrough.js';

const sigs = (src: string, file = 'x.ts') =>
  extractTypeScriptSkeleton(file, src).map((e) => `${'  '.repeat(e.depth)}${e.signature}`);

describe('TS 시그니처 추출', () => {
  it('오버로드는 선언마다 한 줄씩, 구현은 본문을 뺀다', () => {
    const src = [
      'export function parse(x: string): number;',
      'export function parse(x: number): string;',
      'export function parse(x: string | number): number | string {',
      '  return typeof x === "string" ? Number(x) : String(x);',
      '}',
    ].join('\n');
    const entries = extractTypeScriptSkeleton('x.ts', src);
    expect(entries.map((e) => e.signature)).toEqual([
      'export function parse(x: string): number',
      'export function parse(x: number): string',
      'export function parse(x: string | number): number | string',
    ]);
    expect(entries.map((e) => [e.lineStart, e.lineEnd])).toEqual([
      [1, 1],
      [2, 2],
      [3, 5],
    ]);
  });

  it('제네릭 제약과 기본값을 그대로 남긴다', () => {
    const src = [
      'export function pick<T extends object, K extends keyof T = keyof T>(',
      '  obj: T,',
      '  keys: K[],',
      '): Pick<T, K> {',
      '  return {} as Pick<T, K>;',
      '}',
      'export type Box<T = unknown> = { value: T };',
      'export interface Repo<T extends { id: string }> {',
      '  get(id: string): Promise<T | null>;',
      '  readonly size: number;',
      '}',
    ].join('\n');
    expect(sigs(src)).toEqual([
      'export function pick<T extends object, K extends keyof T = keyof T>(obj: T, keys: K[]): Pick<T, K>',
      'export type Box<T = unknown> = { value: T }',
      'export interface Repo<T extends { id: string }>',
      '  get(id: string): Promise<T | null>',
      '  readonly size: number',
    ]);
  });

  it('클래스 멤버는 들여쓰고 본문과 초기값을 뺀다', () => {
    const src = [
      'export abstract class Store<T> extends Base implements Closeable {',
      '  static instances = 0;',
      '  private cache = new Map<string, T>();',
      '  readonly name: string;',
      '  constructor(name: string) {',
      '    super();',
      '    this.name = name;',
      '  }',
      '  get size(): number {',
      '    return this.cache.size;',
      '  }',
      '  abstract load(id: string): Promise<T>;',
      '  async save(id: string, value: T): Promise<void> {',
      '    this.cache.set(id, value);',
      '  }',
      '  handle = (e: Event): void => {',
      '    console.log(e);',
      '  };',
      '}',
    ].join('\n');
    expect(sigs(src)).toEqual([
      'export abstract class Store<T> extends Base implements Closeable',
      '  static instances',
      '  private cache',
      '  readonly name: string',
      '  constructor(name: string)',
      '  get size(): number',
      '  abstract load(id: string): Promise<T>',
      '  async save(id: string, value: T): Promise<void>',
      '  handle = (e: Event): void => …',
    ]);
  });

  it('default export는 이름 있는 것, 없는 것, 식 모두 잡는다', () => {
    expect(sigs('export default function main(argv: string[]): void {\n  run(argv);\n}\n')).toEqual(
      ['export default function main(argv: string[]): void'],
    );
    expect(sigs('export default class {\n  run(): void {}\n}\n')).toEqual([
      'export default class',
      '  run(): void',
    ]);
    expect(
      sigs('export default async (req: Request): Promise<Response> => {\n  return ok();\n};\n'),
    ).toEqual(['export default async (req: Request): Promise<Response> => …']);
    expect(sigs('const config = {};\nexport default config;\n')).toEqual([
      'const config = {}',
      'export default config',
    ]);
  });

  it('화살표 함수 export는 => 까지만 남긴다', () => {
    const src = [
      'export const add = (a: number, b: number): number => a + b;',
      'export const load = async <T,>(url: string): Promise<T> => {',
      '  const res = await fetch(url);',
      '  return res.json() as Promise<T>;',
      '};',
      'export const legacy = function named(x: number) {',
      '  return x;',
      '};',
      'export const LIMIT = 10, NAME: string = "x";',
    ].join('\n');
    expect(sigs(src)).toEqual([
      'export const add = (a: number, b: number): number => …',
      'export const load = async <T,>(url: string): Promise<T> => …',
      'export const legacy = function named(x: number) …',
      'export const LIMIT = 10',
      'export const NAME: string = "x"',
    ]);
  });

  it('긴 초기값은 접고 import는 뺀다', () => {
    const long = `export const TABLE = [${Array.from({ length: 40 }, (_, i) => i).join(', ')}];`;
    const [entry, ...rest] = sigs(`import { x } from './x.js';\n${long}\n`);
    expect(rest).toEqual([]);
    expect(entry!.endsWith('…')).toBe(true);
    expect(entry!.length).toBeLessThan(long.length);
  });

  it('enum과 namespace 멤버도 담는다', () => {
    const src =
      'export enum Kind {\n  A = 1,\n  B,\n}\nnamespace NS {\n  export function f(): void {}\n}\n';
    expect(sigs(src)).toEqual([
      'export enum Kind',
      '  A',
      '  B',
      'namespace NS',
      '  export function f(): void',
    ]);
  });
});

describe('engine.skeleton', () => {
  let repoRoot: string;
  let engine: CodeGraphEngine;

  beforeEach(() => {
    repoRoot = resolve(process.cwd(), '.gestalt-test', `skeleton-${randomUUID()}`);
    mkdirSync(repoRoot, { recursive: true });
    engine = new CodeGraphEngine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('첫 줄에 원본 대비 줄인 크기를 적는다', () => {
    const body = '  const a = 1;\n'.repeat(50);
    writeFileSync(
      join(repoRoot, 'a.ts'),
      `export function big(): number {\n${body}  return 1;\n}\n`,
    );

    const r = engine.skeleton(repoRoot, 'a.ts');
    const [first, ...lines] = r.text.split('\n');
    expect(first).toMatch(/^원본 [\d,]+자 → \d+자 \(\d+\.\d% 줄임\) — a\.ts$/);
    expect(r.skeletonChars).toBeLessThan(r.originalChars);
    expect(lines).toEqual(['L1-53 export function big(): number']);
    expect(r.text).not.toContain('const a = 1');
  });

  it('시그니처를 못 뽑는 언어는 그래프 노드 이름과 줄 범위로 대신한다', () => {
    writeFileSync(
      join(repoRoot, 'm.py'),
      'class Greeter:\n    def hello(self):\n        return 1\n\ndef main():\n    pass\n',
    );
    engine.build(repoRoot, { mode: 'full' });

    const r = engine.skeleton(repoRoot, 'm.py');
    expect(r.source).toBe('graph_nodes');
    expect(r.text.split('\n')[0]).toContain('그래프 노드 이름만');
    expect(r.entries.map((e) => e.signature)).toEqual(
      expect.arrayContaining(['class Greeter', 'function main']),
    );
  });

  it('repoRoot 밖 파일은 거절한다', () => {
    expect(() => engine.skeleton(repoRoot, '../../package.json')).toThrow(/outside repoRoot/);
  });
});

describe('ges_code_graph skeleton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('filePath가 없으면 에러를 돌려준다', async () => {
    expect(await handleCodeGraphPassthrough({ action: 'skeleton', repoRoot: '/repo' })).toEqual({
      error: 'filePath is required for skeleton action',
    });
  });

  it('최신화를 거친 뒤 답하고 stale이면 첫 줄 다음에 알린다', async () => {
    const order: string[] = [];
    vi.spyOn(codeGraphEngine, 'refresh').mockImplementation(async () => {
      order.push('refresh');
      return {
        status: 'stale',
        reason: 'locked',
        message: '갱신 중이라 이전 그래프 기준',
        durationMs: 0,
      };
    });
    vi.spyOn(codeGraphEngine, 'skeleton').mockImplementation(() => {
      order.push('skeleton');
      return {
        filePath: '/repo/a.ts',
        source: 'signatures',
        entries: [],
        originalChars: 100,
        skeletonChars: 10,
        text: '원본 100자 → 10자 (90.0% 줄임) — a.ts\nL1 export const a = 1',
      };
    });

    const result = (await handleCodeGraphPassthrough({
      action: 'skeleton',
      repoRoot: '/repo',
      filePath: 'a.ts',
    })) as { text: string };

    expect(order).toEqual(['refresh', 'skeleton']);
    expect(result.text.split('\n')).toEqual([
      '원본 100자 → 10자 (90.0% 줄임) — a.ts',
      '(갱신 중이라 이전 그래프 기준)',
      'L1 export const a = 1',
    ]);
  });
});
