#!/usr/bin/env tsx
/**
 * 읽기 렌즈 회귀 평가 셋의 픽스처를 ingest 결과에서 잘라 낸다.
 *
 * `.gestalt/digest/<slug>/`의 source.json과 transcript.json에서 의심 표시에 필요한 표와 문단만 남겨
 * `tests/fixtures/lens/regression/<name>/`에 쓴다. 저작권 때문에 원문 전체와 쪽 그림, 크롭 그림은 옮기지 않는다.
 *
 * lint의 cite는 segments 배열 자리로 문단을 찾아서 남긴 문단은 0부터 다시 번호를 매긴다.
 * 원래 번호는 index-map.json에 둔다. 남긴 표의 캡션 문단은 따로 적지 않아도 같이 남긴다.
 * 표의 unit이 그 캡션을 가리켜서 빠지면 source.json이 없는 문단을 가리키게 된다.
 *
 * 쓰는 법:
 *   pnpm lens:fixture <slug> <name> --tables table-2,table-4 --units 12,92-93 [--title "..."]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { lensSourceSchema, type LensSource } from '../src/digest/lens-source.js';
import { SLUG_PATTERN } from '../src/digest/schema-base.js';
import { transcriptSchema, type Transcript } from '../src/digest/schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGRESSION_DIR = join(ROOT, 'tests/fixtures/lens/regression');

/** "12,92-93,102"를 오름차순 번호 목록으로 푼다 */
export function parseUnitRanges(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim())) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`문단 범위를 읽을 수 없다: ${part}`);
    const from = Number(m[1]!);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from) throw new Error(`범위가 거꾸로다: ${part}`);
    for (let i = from; i <= to; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

export interface SliceInput {
  source: LensSource;
  transcript: Transcript;
  tables: string[];
  units: number[];
  title?: string;
}

export interface SliceOutput {
  source: LensSource;
  transcript: Transcript;
  indexMap: {
    slug: string;
    url: string | undefined;
    /** 자리가 새 문단 번호, 값이 원래 문단 번호다 */
    segments: number[];
    tables: Record<string, { unit: number; originalUnit: number }>;
  };
}

export function sliceFixture(input: SliceInput): SliceOutput {
  const { source, transcript } = input;
  const tables = input.tables.map((id) => {
    const t = source.tables.find((x) => x.id === id);
    if (!t) {
      throw new Error(`표 ${id}가 없다. 있는 표: ${source.tables.map((x) => x.id).join(', ')}`);
    }
    return t;
  });
  const keep = new Set(input.units);
  for (const t of tables) keep.add(t.unit);
  const order = [...keep].sort((a, b) => a - b);
  for (const i of order) {
    if (!transcript.segments[i]) {
      throw new Error(`문단 ${i}가 없다. 문단은 ${transcript.segments.length}개다`);
    }
  }
  const renumber = new Map(order.map((orig, i) => [orig, i]));

  const segments = order.map((orig, i) => ({ ...transcript.segments[orig]!, i }));
  const slicedTables = tables.map((t) => {
    // image는 커밋하지 않는 크롭 그림 경로라 지운다
    const { image: _image, ...rest } = t;
    return { ...rest, unit: renumber.get(t.unit)! };
  });

  return {
    source: lensSourceSchema.parse({
      schemaVersion: source.schemaVersion,
      slug: source.slug,
      kind: source.kind,
      pages: [],
      tables: slicedTables,
      figures: [],
    }),
    transcript: transcriptSchema.parse({
      ...transcript,
      meta: { ...transcript.meta, ...(input.title ? { title: input.title } : {}) },
      segments,
    }),
    indexMap: {
      slug: transcript.slug,
      url: transcript.meta.url,
      segments: order,
      tables: Object.fromEntries(
        tables.map((t) => [t.id, { unit: renumber.get(t.unit)!, originalUnit: t.unit }]),
      ),
    },
  };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) throw new Error(`${path}가 없다. gestalt lens ingest를 먼저 돌린다`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tables: { type: 'string' },
      units: { type: 'string', default: '' },
      title: { type: 'string' },
      'repo-root': { type: 'string', default: ROOT },
      out: { type: 'string', default: REGRESSION_DIR },
    },
  });
  const [slug, name] = positionals;
  if (!slug || !name || !values.tables) {
    console.error(
      '쓰는 법: pnpm lens:fixture <slug> <name> --tables table-2,table-4 --units 12,92-93 [--title "..."]',
    );
    process.exit(1);
  }
  if (!SLUG_PATTERN.test(slug) || !SLUG_PATTERN.test(name)) {
    throw new Error('slug와 name은 영문 소문자, 숫자, -만 쓴다');
  }
  const dir = join(resolve(values['repo-root']), '.gestalt', 'digest', slug);
  const out = sliceFixture({
    source: lensSourceSchema.parse(readJson(join(dir, 'source.json'))),
    transcript: transcriptSchema.parse(readJson(join(dir, 'transcript.json'))),
    tables: values.tables.split(',').map((s) => s.trim()),
    units: parseUnitRanges(values.units),
    title: values.title,
  });
  const target = join(resolve(values.out), name);
  mkdirSync(target, { recursive: true });
  const write = (file: string, data: unknown) =>
    writeFileSync(join(target, file), `${JSON.stringify(data, null, 2)}\n`);
  write('source.json', out.source);
  write('transcript.json', out.transcript);
  write('index-map.json', out.indexMap);
  console.log(
    `${target}: 표 ${out.source.tables.length}개, 문단 ${out.transcript.segments.length}개 (원래 ${out.indexMap.segments.join(', ')})`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
