import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LENS_SOURCES, type LensKind } from '../../digest/schema.js';
import { attachContext } from '../../lens/attach.js';
import { ingestLens } from '../../lens/ingest.js';
import { findKnowledge } from '../../lens/knowledge.js';
import { setFigurePanels } from '../../lens/panels.js';

/**
 * `gestalt lens` — 읽기 렌즈 CLI. 논문 PDF와 웹 글, 팟캐스트를 문단 단위 원문으로 받는다.
 * 합치기와 렌더, 띄우기는 영상과 같은 저장소를 써서 `gestalt digest` 명령을 그대로 쓴다
 */

export interface LensCommonOptions {
  repoRoot?: string;
  json?: boolean;
}

const rootOf = (opts: LensCommonOptions) => resolve(opts.repoRoot ?? process.cwd());

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

function parseKind(kind: string | undefined): LensKind | undefined {
  if (kind === undefined) return undefined;
  if ((LENS_SOURCES as readonly string[]).includes(kind)) return kind as LensKind;
  throw new Error(`--kind는 ${LENS_SOURCES.join(', ')} 중 하나예요: ${kind}`);
}

export async function lensIngestCommand(
  input: string,
  opts: LensCommonOptions & {
    slug?: string;
    kind?: string;
    episode?: string;
    whisperModel?: string;
  },
): Promise<void> {
  try {
    const episode = opts.episode === undefined ? undefined : Number(opts.episode);
    if (episode !== undefined && (!Number.isInteger(episode) || episode < 0)) {
      throw new Error(`--episode는 0 이상의 정수예요: ${opts.episode}`);
    }
    const r = await ingestLens(input, {
      repoRoot: rootOf(opts),
      slug: opts.slug,
      kind: parseKind(opts.kind),
      episode,
      whisperModel: opts.whisperModel,
    });
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log(`${r.title} (${r.kind})`);
    console.log(
      `문단 ${r.units}개, 쪽 ${r.pages}장, 표 ${r.tables.length}개, 그림 ${r.figures.length}개`,
    );
    console.log(`slug: ${r.slug}`);
    console.log(`저장: ${r.transcriptPath}`);
    console.log(`원문 구조: ${r.sourcePath}`);
    for (const w of r.warnings) console.log(`주의: ${w}`);
    if (r.staleDigest) {
      const before = r.staleDigest.previousSegmentCount ?? '?';
      console.log(
        `문단 번호가 바뀌어 기존 요약을 옮겼어요(문단 ${before}개 → ${r.units}개): ${r.staleDigest.movedTo}`,
      );
    }
  } catch (e) {
    fail(e);
  }
}

export async function lensKnowledgeCommand(
  slug: string,
  opts: LensCommonOptions & { source?: string[] },
): Promise<void> {
  try {
    const { path, file } = findKnowledge(slug, { repoRoot: rootOf(opts), sources: opts.source });
    if (opts.json) {
      console.log(
        JSON.stringify(
          { path, roots: file.roots, terms: file.terms, hits: file.hits.length },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`지식 소스: ${file.roots.join(', ') || '없음'}`);
    console.log(`찾은 말: ${file.terms.join(', ')}`);
    console.log(`겹치는 줄 ${file.hits.length}개`);
    console.log(`저장: ${path}`);
  } catch (e) {
    fail(e);
  }
}

export async function lensAttachCommand(
  slug: string,
  file: string,
  opts: LensCommonOptions & { report?: string },
): Promise<void> {
  try {
    const input = JSON.parse(readFileSync(resolve(file), 'utf-8')) as unknown;
    const r = attachContext(rootOf(opts), slug, input, opts.report);
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(
        r.saved
          ? `붙였어요: ${r.key} (${r.digestPath})`
          : `오류가 있어 저장하지 않았어요: ${r.key}`,
      );
      for (const i of r.issues) console.log(`${i.severity} ${i.code} ${i.path}: ${i.message}`);
    }
    if (!r.saved) process.exitCode = 1;
  } catch (e) {
    fail(e);
  }
}

export async function lensPanelsCommand(
  slug: string,
  figure: string,
  panels: string,
  opts: LensCommonOptions,
): Promise<void> {
  try {
    const r = setFigurePanels(rootOf(opts), slug, figure, Number(panels));
    if (opts.json) console.log(JSON.stringify(r, null, 2));
    else console.log(`${r.figure} 장면 ${r.panels}개를 적었어요: ${r.path}`);
  } catch (e) {
    fail(e);
  }
}
