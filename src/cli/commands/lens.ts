import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LENS_SOURCES, type LensKind } from '../../digest/schema.js';
import { attachContext } from '../../lens/attach.js';
import { ingestLens } from '../../lens/ingest.js';
import { findKnowledge } from '../../lens/knowledge.js';
import {
  addNoteSources,
  declineNoteSources,
  detectNoteFolders,
  notionAppInstalled,
  readUserLens,
  removeNoteSource,
  setNotion,
  userLensFilePath,
} from '../../lens/notes.js';
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
    url?: string;
    speakers?: boolean;
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
      sourceUrl: opts.url,
      // commander의 --no-speakers가 없으면 true로 온다
      speakers: opts.speakers !== false,
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

export async function lensNotesCommand(
  action: string,
  dirs: string[],
  opts: LensCommonOptions & { scan?: string[] },
): Promise<void> {
  try {
    if (action === 'list') {
      const f = readUserLens();
      if (opts.json) console.log(JSON.stringify({ path: userLensFilePath(), ...f }, null, 2));
      else {
        console.log(`연결한 노트 폴더: ${f.knowledgeSources.join(', ') || '없음'}`);
        console.log(`노션에서도 찾기: ${f.notion ? '켬' : '끔'}`);
        if (f.declined) console.log('노트 폴더를 쓰지 않겠다고 답해 두었어요. 다시 묻지 않아요');
      }
      return;
    }
    if (action === 'detect') {
      const candidates = detectNoteFolders({ repoRoot: rootOf(opts), scan: opts.scan });
      const notionApp = notionAppInstalled();
      if (opts.json) console.log(JSON.stringify({ candidates, notionApp }, null, 2));
      else if (candidates.length === 0) console.log('노트 폴더 후보를 못 찾았어요');
      else {
        for (const c of candidates) {
          const mark = c.configured ? ' (연결됨)' : '';
          console.log(
            `${c.path}${mark} (${c.reason}) 노트 ${c.notes}개, 최근: ${c.recent.join(', ')}`,
          );
        }
      }
      if (!opts.json && notionApp)
        console.log('노션 앱이 깔려 있어요. 노션 MCP가 붙은 세션이면 노션에서도 찾을 수 있어요');
      return;
    }
    if (action === 'add') {
      if (dirs.length === 0) throw new Error('연결할 폴더를 하나 이상 주세요');
      const f = addNoteSources(dirs);
      console.log(`연결한 노트 폴더: ${f.knowledgeSources.join(', ')}`);
      return;
    }
    if (action === 'remove') {
      if (dirs.length !== 1) throw new Error('뺄 폴더 하나를 주세요');
      const f = removeNoteSource(dirs[0]!);
      console.log(`연결한 노트 폴더: ${f.knowledgeSources.join(', ') || '없음'}`);
      return;
    }
    if (action === 'notion-on' || action === 'notion-off') {
      const f = setNotion(action === 'notion-on');
      console.log(`노션에서도 찾기: ${f.notion ? '켬' : '끔'}`);
      return;
    }
    if (action === 'decline') {
      declineNoteSources();
      console.log(
        '노트 폴더 없이 쓰겠다고 적어 두었어요. gestalt lens notes add로 언제든 연결해요',
      );
      return;
    }
    throw new Error(
      `모르는 동작이에요: ${action}. list, detect, add, remove, notion-on, notion-off, decline 중 하나예요`,
    );
  } catch (e) {
    fail(e);
  }
}
