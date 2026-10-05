import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGlobalContext } from '../../architecture/global-context.js';
import {
  buildKnowledgeIr,
  scanDocRoots,
  summarizeScan,
  type DocRoot,
} from '../../architecture/doc-scan.js';
import { analyzeDocRoutes } from '../../architecture/doc-routes.js';
import { findStaleDocs, type ChangedFile } from '../../architecture/doc-stale.js';
import { ownersOf, readCodeowners, type CodeownersRule } from '../../architecture/codeowners.js';
import { linkDocs, type FileFacts } from '../../architecture/doc-link.js';
import type { DocScanResult } from '../../architecture/doc-scan.js';
import { matchEndpoints } from '../../architecture/endpoint-match.js';
import { matchMcpTools } from '../../architecture/mcp-tool-match.js';
import { matchNameRefs } from '../../architecture/name-ref-match.js';
import { computeDrilldown, shouldDrillDown } from '../../architecture/drilldown.js';
import { renderArchitectureHtml, renderDrilldownHtml } from '../../architecture/html-renderer.js';
import { parseArchitectureIr } from '../../architecture/ir-schema.js';
import { assignStages, computeLayout } from '../../architecture/layout.js';
import { mergeArchitectureIrs } from '../../architecture/merge.js';
import {
  ArchitectureStore,
  mergeWithPrevious,
  previousRunSummary,
} from '../../architecture/store.js';
import {
  ARCHITECTURE_VIEWS,
  type ArchitectureIr,
  type ArchitectureView,
} from '../../architecture/types.js';
import {
  validateArchitectureIr,
  type ValidatedIr,
  type ValidateArchitectureIrResult,
} from '../../architecture/validator.js';
import { writeJsonAtomic } from '../../core/json-file.js';
import { log } from '../../core/log.js';
import {
  READ_ONLY_ALLOW_WORDS,
  READ_ONLY_CLI_VERBS,
  READ_ONLY_DENY_WORDS,
  filterReadOnlyTools,
} from '../../utils/read-only-tools.js';
import type { ArchitectureInput } from '../schemas.js';

// dist/src/mcp/tools와 src/mcp/tools 둘 다 세 단계 위가 패키지 루트다. postbuild가 schemas를 dist로 복사한다
const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'schemas',
  'architecture-ir.schema.json',
);

interface ArchitectureToolError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  evidenceIndex?: number;
}

interface ArchitectureFailure {
  ok: false;
  errors: ArchitectureToolError[];
}

function fail(code: string, message: string): ArchitectureFailure {
  return { ok: false, errors: [{ code, message }] };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

type Prepared = { ok: true; ir: ArchitectureIr; repoRoot: string } | ArchitectureFailure;

function readIrFile(
  path: string,
  repoRoot: string,
): { ok: true; raw: unknown } | ArchitectureFailure {
  const abs = resolve(repoRoot, path);
  try {
    return { ok: true, raw: JSON.parse(readFileSync(abs, 'utf-8')) as unknown };
  } catch (e) {
    return fail('IR_READ_ERROR', `IR 파일 "${abs}"를 읽지 못했다: ${(e as Error).message}`);
  }
}

function parseIr(raw: unknown, label = ''): { ok: true; ir: ArchitectureIr } | ArchitectureFailure {
  const parsed = parseArchitectureIr(raw);
  if (parsed.ok) return { ok: true, ir: parsed.value };
  const issues = parsed.error.issues.length > 0 ? parsed.error.issues : [parsed.error.message];
  return {
    ok: false,
    errors: issues.map((message) => ({ code: 'IR_PARSE_ERROR', message: `${label}${message}` })),
  };
}

function prepareIr(input: ArchitectureInput, repoRoot: string): Prepared {
  let raw: unknown = input.ir;
  if (raw === undefined && input.irPath !== undefined) {
    const read = readIrFile(input.irPath, repoRoot);
    if (!read.ok) return read;
    raw = read.raw;
  }
  if (raw === undefined)
    return fail('MISSING_INPUT', `${input.action}에는 ir이나 irPath가 필요하다.`);
  const parsed = parseIr(raw);
  if (!parsed.ok) return parsed;
  const ir = parsed.ir;
  if (input.view !== undefined && input.view !== ir.view) {
    return fail('VIEW_MISMATCH', `view(${input.view})와 ir.view(${ir.view})가 다르다.`);
  }
  return { ok: true, ir, repoRoot };
}

function validate(ir: ArchitectureIr, repoRoot: string, checkFiles: boolean | undefined) {
  // IR의 root는 상대경로로 적히기도 한다. 서버 cwd가 아니라 repoRoot 기준으로 풀어야 근거 파일을 찾는다
  const repoRoots = Object.fromEntries(
    ir.repos.flatMap((r) =>
      r.root === undefined ? [] : [[r.id, isAbsolute(r.root) ? r.root : resolve(repoRoot, r.root)]],
    ),
  );
  return validateArchitectureIr(ir, { repoRoots, checkFiles });
}

function asFailure(result: Extract<ValidateArchitectureIrResult, { ok: false }>) {
  return { ok: false as const, errors: result.errors };
}

function computeStats(validated: ValidatedIr) {
  const {
    ir,
    drawableNodeIds,
    drawableEdgeIds,
    drawableStepIds,
    drawableTransitionIds,
    autoUnresolved,
  } = validated;
  const drawnEdges = ir.edges.filter((e) => drawableEdgeIds.has(e.id));
  const kindOf = new Map(ir.nodes.map((n) => [n.id, n.kind]));
  const drawnNodes = ir.nodes.filter((n) => drawableNodeIds.has(n.id));

  const screens = drawnNodes.filter((n) => n.kind === 'screen');
  const screensToEndpoint = new Set(
    drawnEdges.filter((e) => kindOf.get(e.to) === 'endpoint').map((e) => e.from),
  );
  const endpoints = drawnNodes.filter((n) => n.kind === 'endpoint');
  const handledEndpoints = new Set(
    drawnEdges
      .filter((e) => e.kind === 'handles' && kindOf.get(e.to) === 'app_module')
      .map((e) => e.from),
  );
  const staged = assignStages(ir);
  const open = [...ir.unresolved, ...autoUnresolved].filter(
    (q) => q.answer === undefined || q.answer.trim() === '',
  );

  return {
    nodes: ir.nodes.length,
    edges: ir.edges.length,
    drawnEdges: drawnEdges.length,
    droppedEdges: ir.edges.length - drawnEdges.length,
    unresolvedOpen: open.length,
    screenToEndpointRatio: ratio(
      screens.filter((n) => screensToEndpoint.has(n.id)).length,
      screens.length,
    ),
    endpointMatchRatio: ratio(
      endpoints.filter((n) => handledEndpoints.has(n.id)).length,
      endpoints.length,
    ),
    // 흐름이 없는 IR은 키를 안 넣는다. 기존 응답을 읽는 쪽이 그대로 돈다
    ...(ir.flows !== undefined && ir.flows.length > 0
      ? {
          flows: ir.flows.length,
          drawnSteps: drawableStepIds.size,
          drawnTransitions: drawableTransitionIds.size,
        }
      : {}),
    // 세션이 구간 규칙을 빠뜨린 노드는 맨 끝 "그 밖"으로 간다. 숫자로 알려야 세션이 규칙을 보탠다
    ...(staged !== undefined
      ? {
          stages: ir.stages!.length,
          unstagedNodes: drawnNodes.filter((n) => staged.indexOf.get(n.id) === ir.stages!.length)
            .length,
        }
      : {}),
  };
}

export interface ArchitectureHandlerOptions {
  /** 테스트에서 실제 홈 디렉토리를 건드리지 않게 주입한다 */
  homeDir?: string;
  projectsRoot?: string;
}

function handleStart(
  input: ArchitectureInput,
  repoRoot: string,
  opts: ArchitectureHandlerOptions,
): object {
  if (input.view === undefined) {
    return fail('MISSING_INPUT', `start에는 view가 필요하다 (${ARCHITECTURE_VIEWS.join(', ')}).`);
  }
  const prev = new ArchitectureStore(repoRoot).load(input.view);
  let previous = null;
  if (prev) {
    const { sourcesUsed: _sourcesUsed, ...rest } = previousRunSummary(prev);
    previous = rest;
  }
  return {
    view: input.view,
    previous,
    previousSourcesUsed: prev?.sourcesUsed ?? [],
    contextCandidates: collectGlobalContext({ repoRoot, ...opts }),
    schemaPath: SCHEMA_PATH,
    readOnlyRule: { allow: [...READ_ONLY_ALLOW_WORDS], deny: [...READ_ONLY_DENY_WORDS] },
    readOnlyCliRule: { verbs: [...READ_ONLY_CLI_VERBS] },
    nextAction: 'filter_tools',
    instructions: [
      'contextCandidates 중 exists가 true인 파일을 읽어 맥락을 모은다. private 파일 내용은 excerpt에 옮기지 않는다.',
      '세션에 붙은 MCP 도구 이름을 filter_tools에 넘겨 allowed만 쓴다. ambiguous는 부르지 않는다.',
      'schemaPath의 JSON Schema대로 IR을 만든다. 실선 엣지에는 code나 spec 근거가 있어야 한다.',
      '클라우드 조회 결과는 live 근거로 싣는다. 명령의 하위 명령은 readOnlyCliRule.verbs로 시작해야 하고 응답 원문은 excerpt에 넣지 않는다.',
      'FE 호출과 BE 라우트가 모이면 match_endpoints로 이어 붙이고, validate로 확인한 뒤 render한다.',
    ],
  };
}

function handleFilterTools(input: ArchitectureInput): object {
  if (input.toolNames === undefined) {
    return fail('MISSING_INPUT', 'filter_tools에는 toolNames가 필요하다.');
  }
  return filterReadOnlyTools(input.toolNames);
}

function handleMatchEndpoints(input: ArchitectureInput): object {
  const http = input.feCalls !== undefined && input.beRoutes !== undefined;
  const mcp = input.skillToolCalls !== undefined && input.serverTools !== undefined;
  const names = input.nameRefs !== undefined;
  if (!http && !mcp && !names) {
    return fail(
      'MISSING_INPUT',
      'match_endpoints에는 feCalls와 beRoutes, skillToolCalls와 serverTools, nameRefs 중 하나가 필요하다.',
    );
  }
  return {
    ...(http
      ? matchEndpoints({
          feCalls: input.feCalls!,
          beRoutes: input.beRoutes!,
          prefixCandidates: input.prefixCandidates,
        })
      : {}),
    ...(mcp
      ? {
          tools: matchMcpTools({
            skillToolCalls: input.skillToolCalls!,
            serverTools: input.serverTools!,
          }),
        }
      : {}),
    ...(names ? { refs: matchNameRefs(input.nameRefs!) } : {}),
  };
}

function handleValidate(input: ArchitectureInput, repoRoot: string): object {
  const prepared = prepareIr(input, repoRoot);
  if (!prepared.ok) return prepared;
  const result = validate(prepared.ir, repoRoot, input.checkFiles);
  if (!result.ok) return asFailure(result);
  const { drawableNodeIds, drawableEdgeIds, autoUnresolved } = result.value;
  return {
    ok: true,
    errors: [],
    autoUnresolved,
    drawable: { nodeIds: [...drawableNodeIds].sort(), edgeIds: [...drawableEdgeIds].sort() },
  };
}

async function handleRender(input: ArchitectureInput, repoRoot: string): Promise<object> {
  const prepared = prepareIr(input, repoRoot);
  if (!prepared.ok) return prepared;
  const first = validate(prepared.ir, repoRoot, input.checkFiles);
  if (!first.ok) return asFailure(first);

  const store = new ArchitectureStore(repoRoot);
  const prev = store.load(prepared.ir.view);
  const merged = prev ? mergeWithPrevious(prev, prepared.ir) : prepared.ir;
  // 병합이 id를 바꾸므로 그린 대상도 병합 결과로 다시 뽑는다
  const second = validate(merged, repoRoot, input.checkFiles);
  if (!second.ok) return asFailure(second);
  const validated = second.value;

  // 서비스가 그려지면 노드가 많아 평면 한 장으로는 못 읽는다. 레벨로 나눠 한 파일에 담는다
  const drilldown = shouldDrillDown(validated) ? await computeDrilldown(validated) : null;
  let privateHtml: string;
  let sharedHtml: string;
  if (drilldown) {
    privateHtml = renderDrilldownHtml(validated, drilldown, { audience: 'private' });
    sharedHtml = renderDrilldownHtml(validated, drilldown, { audience: 'shared' });
  } else {
    const layout = await computeLayout(
      validated.ir,
      validated.drawableNodeIds,
      validated.drawableEdgeIds,
    );
    privateHtml = renderArchitectureHtml(validated, layout, { audience: 'private' });
    sharedHtml = renderArchitectureHtml(validated, layout, { audience: 'shared' });
  }

  // 자동 질문도 저장해 둬야 사람이 답을 달고 다음 실행이 그 답을 물려받는다
  const toSave = {
    ...validated.ir,
    unresolved: [...validated.ir.unresolved, ...validated.autoUnresolved],
  };
  const irPath = store.save(toSave);
  const viewPaths = store.saveViews(toSave);
  const view: ArchitectureView = validated.ir.view;
  const htmlPath = store.saveHtml(view, 'private', privateHtml);
  const sharedHtmlPath = store.saveHtml(view, 'shared', sharedHtml);
  log(`architecture: rendered ${view} → ${htmlPath}`);

  return {
    ok: true,
    irPath,
    htmlPath,
    sharedHtmlPath,
    openPath: input.audience === 'shared' ? sharedHtmlPath : htmlPath,
    ...(viewPaths.length > 0 ? { viewPaths } : {}),
    ...(drilldown
      ? {
          levels: drilldown.levels.map((l) => ({
            id: l.id,
            title: l.title,
            nodes: l.nodeIds.length,
            edges: l.edges.length,
          })),
        }
      : {}),
    stats: computeStats(validated),
    sourcesUsed: validated.ir.sourcesUsed,
  };
}

function handleMerge(input: ArchitectureInput, repoRoot: string): object {
  const raws: unknown[] = [...(input.irs ?? [])];
  for (const path of input.irPaths ?? []) {
    const read = readIrFile(path, repoRoot);
    if (!read.ok) return read;
    raws.push(read.raw);
  }
  const irs: ArchitectureIr[] = [];
  for (const [i, raw] of raws.entries()) {
    const parsed = parseIr(raw, `입력 ${i}: `);
    if (!parsed.ok) return parsed;
    irs.push(parsed.ir);
  }
  const result = mergeArchitectureIrs(irs, {
    prefixCandidates: input.prefixCandidates,
    groupNames: input.groupNames,
  });
  if (!result.ok) return result;
  const nextAction =
    '합친 IR을 validate로 확인한 뒤 render한다. render는 repoRoot의 같은 뷰 IR과 병합하므로 원래 분석 레포가 아닌 따로 둔 디렉토리를 repoRoot로 준다.';
  if (input.outPath === undefined) {
    return { ok: true, ir: result.ir, report: result.report, nextAction };
  }
  const outPath = resolve(repoRoot, input.outPath);
  writeJsonAtomic(outPath, result.ir);
  log(`architecture: merged ${irs.length} IRs → ${outPath}`);
  return { ok: true, irPath: outPath, report: result.report, nextAction };
}

/**
 * 문서 레포를 읽기만 하고 결과는 `.gestalt/architecture/` 아래 파일로 남긴다. md 수백 개를 응답에 실으면
 * 세션 맥락이 넘치니 응답은 요약과 경로만 돌려준다
 */
function handleScanDocs(input: ArchitectureInput, repoRoot: string): object {
  if (input.docRoots === undefined || input.docRoots.length === 0) {
    return fail('MISSING_INPUT', 'scan_docs에는 docRoots가 필요하다.');
  }
  const roots: DocRoot[] = input.docRoots.map((r) => ({
    ...r,
    path: isAbsolute(r.path) ? r.path : resolve(repoRoot, r.path),
  }));
  let scan;
  try {
    scan = scanDocRoots(roots, input.docPatterns);
  } catch (err) {
    return fail('SCAN_FAILED', `문서 레포를 못 읽었다: ${String(err)}`);
  }
  const dir = resolve(repoRoot, '.gestalt', 'architecture');
  const scanPath = resolve(dir, 'doc-scan.json');
  const draftPath = resolve(dir, 'knowledge.draft.json');
  writeJsonAtomic(scanPath, {
    ...scan,
    roots: roots.map((r) => ({ repoId: r.repoId, name: r.name, path: r.path })),
  });
  writeJsonAtomic(draftPath, buildKnowledgeIr(roots, scan, new Date().toISOString()));
  const routes = analyzeDocRoutes(scan);
  const routesPath = resolve(dir, 'doc-routes.json');
  writeJsonAtomic(routesPath, routes);
  const questionRoutes = {
    entries: routes.entries.length,
    reachable: routes.reachable,
    orphans: routes.orphans.length,
    deadRoutes: routes.deadRoutes.length,
    keywordConflicts: routes.conflicts.length,
  };
  return {
    summary: { ...summarizeScan(scan), questionRoutes },
    skipped: scan.skipped,
    scanPath,
    draftPath,
    routesPath,
  };
}

// 같은 파일을 여러 문서가 가리키므로 파일마다 한 번만 git을 부른다
function fileFactsFrom(codeRoots: Record<string, string>, repoRoot: string): FileFacts {
  const cache = new Map<string, ReturnType<FileFacts>>();
  return (repoName, path) => {
    const root = codeRoots[repoName];
    if (root === undefined) return undefined;
    const key = `${repoName}:${path}`;
    if (cache.has(key)) return cache.get(key);
    const abs = isAbsolute(root) ? root : resolve(repoRoot, root);
    let facts: ReturnType<FileFacts>;
    if (!existsSync(resolve(abs, path))) {
      facts = { exists: false };
    } else {
      let committedAt: string | undefined;
      try {
        committedAt =
          execFileSync('git', ['-C', abs, 'log', '-1', '--format=%cs', '--', path], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim() || undefined;
      } catch {
        committedAt = undefined;
      }
      facts = { exists: true, ...(committedAt !== undefined ? { committedAt } : {}) };
    }
    cache.set(key, facts);
    return facts;
  };
}

// 레포마다 CODEOWNERS를 한 번만 읽는다. 문서 레포와 코드 레포를 같은 이름 공간으로 본다
function ownersFrom(roots: Record<string, string>, repoRoot: string) {
  const cache = new Map<string, CodeownersRule[]>();
  return (repoName: string, path: string) => {
    const root = roots[repoName];
    if (root === undefined) return undefined;
    let rules = cache.get(repoName);
    if (rules === undefined) {
      rules = readCodeowners(isAbsolute(root) ? root : resolve(repoRoot, root));
      cache.set(repoName, rules);
    }
    return ownersOf(rules, path);
  };
}

const SIGNAL_SAMPLE = 20;

function handleLinkDocs(input: ArchitectureInput, repoRoot: string): object {
  if (input.irPath === undefined && input.ir === undefined)
    return fail('MISSING_INPUT', 'link_docs에는 기술 IR(ir이나 irPath)이 필요하다.');
  const prepared = prepareIr(input, repoRoot);
  if (!prepared.ok) return prepared;
  const dir = resolve(repoRoot, '.gestalt', 'architecture');
  const scanPath = resolve(dir, 'doc-scan.json');
  const draftPath = resolve(dir, 'knowledge.draft.json');
  let scan: DocScanResult;
  let knowledgeRaw: unknown;
  try {
    scan = JSON.parse(readFileSync(scanPath, 'utf-8')) as DocScanResult;
    knowledgeRaw = JSON.parse(readFileSync(draftPath, 'utf-8')) as unknown;
  } catch {
    return fail('MISSING_INPUT', 'link_docs 전에 scan_docs를 먼저 돌려야 한다.');
  }
  const knowledge = parseIr(knowledgeRaw, 'knowledge.draft.json: ');
  if (!knowledge.ok) return knowledge;
  const ownerRoots: Record<string, string> = {
    ...Object.fromEntries((scan.roots ?? []).map((r) => [r.name, r.path])),
    ...(input.codeRoots ?? {}),
  };
  const result = linkDocs(prepared.ir, knowledge.ir, scan.docs, {
    ...(input.repoAliases !== undefined ? { repoAliases: input.repoAliases } : {}),
    ...(input.screenIndexPrefixes !== undefined
      ? { screenIndexPrefixes: input.screenIndexPrefixes }
      : {}),
    ...(input.codeRoots !== undefined
      ? { fileFacts: fileFactsFrom(input.codeRoots, repoRoot) }
      : {}),
    ...(Object.keys(ownerRoots).length > 0 ? { ownersOf: ownersFrom(ownerRoots, repoRoot) } : {}),
    generatedAt: new Date().toISOString(),
  });
  // 링크 상태를 다시 센 값은 문서 지도에도 돌려 쓴다. 그래야 두 그림의 깨진 링크 수가 같다
  const updated: ArchitectureIr = {
    ...knowledge.ir,
    nodes: knowledge.ir.nodes.map((n) => {
      const doc = result.docInfo.get(n.id);
      const owners = n.owners ?? result.docOwners.get(n.id);
      return doc !== undefined || owners !== undefined
        ? {
            ...n,
            ...(doc !== undefined ? { doc } : {}),
            ...(owners !== undefined ? { owners } : {}),
          }
        : n;
    }),
  };
  writeJsonAtomic(draftPath, updated);
  const linkPath = resolve(dir, 'knowledge-link.draft.json');
  const signalsPath = resolve(dir, 'doc-link.json');
  writeJsonAtomic(linkPath, result.ir);
  writeJsonAtomic(signalsPath, result.signals);
  const s = result.signals;
  return {
    summary: {
      linkedDocs: s.linkedDocs,
      describes: s.describes,
      coverage: s.coverage,
      links: s.links,
      staleCount: s.stale.length,
      apiMismatchCount: s.apiMismatches.length,
      screensOnlyInCode: s.screensOnlyInCode.length,
      screensOnlyInIndex: s.screensOnlyInIndex.length,
      uncoveredCount: s.uncovered.length,
      ...(s.ownership !== undefined
        ? { ownership: { tech: s.ownership.tech, docs: s.ownership.docs } }
        : {}),
      ...(Object.keys(s.gapsByOwner).length > 0 ? { gapsByOwner: s.gapsByOwner } : {}),
    },
    uncoveredSample: s.uncovered.slice(0, SIGNAL_SAMPLE),
    draftPath: linkPath,
    knowledgeDraftPath: draftPath,
    signalsPath,
  };
}

function changedFilesOf(
  input: ArchitectureInput,
  repoRoot: string,
): { ok: true; files: ChangedFile[] } | ReturnType<typeof fail> {
  if (input.changedFiles !== undefined) {
    const files: ChangedFile[] = [];
    for (const f of input.changedFiles) {
      const i = f.indexOf(':');
      if (i <= 0)
        return fail('INVALID_INPUT', `changedFiles는 \`<레포 이름>:<경로>\` 꼴이어야 한다: ${f}`);
      files.push({ repo: f.slice(0, i), path: f.slice(i + 1) });
    }
    return { ok: true, files };
  }
  const repo = input.changedRepo;
  const root = repo !== undefined ? input.codeRoots?.[repo] : undefined;
  if (input.diffBase === undefined || repo === undefined || root === undefined) {
    return fail(
      'MISSING_INPUT',
      'stale_docs에는 changedFiles나 diffBase, changedRepo, codeRoots[changedRepo]가 필요하다.',
    );
  }
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        isAbsolute(root) ? root : resolve(repoRoot, root),
        'diff',
        '--name-only',
        `${input.diffBase}...HEAD`,
      ],
      // 큰 레포는 몇백 커밋만 넘어가도 파일 목록이 기본 버퍼(1MB)를 넘는다
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      ok: true,
      files: out
        .split('\n')
        .filter(Boolean)
        .map((path) => ({ repo, path })),
    };
  } catch (err) {
    return fail('DIFF_FAILED', `git diff를 못 돌렸다: ${String(err)}`);
  }
}

/** 바뀐 파일로 손봐야 할 문서를 고른다. link_docs를 돌렸으면 기술 노드를 거쳐 닿는 문서까지 본다 */
function handleStaleDocs(input: ArchitectureInput, repoRoot: string): object {
  const changed = changedFilesOf(input, repoRoot);
  if (!changed.ok) return changed;
  const dir = resolve(repoRoot, '.gestalt', 'architecture');
  let scan: DocScanResult;
  try {
    scan = JSON.parse(readFileSync(resolve(dir, 'doc-scan.json'), 'utf-8')) as DocScanResult;
  } catch {
    return fail('MISSING_INPUT', 'stale_docs 전에 scan_docs를 먼저 돌려야 한다.');
  }
  const linkPath = resolve(dir, 'knowledge-link.draft.json');
  let linkIr: ArchitectureIr | undefined;
  if (existsSync(linkPath)) {
    const parsed = parseIr(
      JSON.parse(readFileSync(linkPath, 'utf-8')),
      'knowledge-link.draft.json: ',
    );
    if (!parsed.ok) return parsed;
    linkIr = parsed.ir;
  }
  const docs = findStaleDocs(scan.docs, changed.files, {
    ...(input.repoAliases !== undefined ? { repoAliases: input.repoAliases } : {}),
    ...(linkIr !== undefined ? { linkIr } : {}),
  });
  const stalePath = resolve(dir, 'stale-docs.json');
  writeJsonAtomic(stalePath, { changedFiles: changed.files, docs });
  return {
    summary: {
      changedFiles: changed.files.length,
      staleDocs: docs.length,
      viaCodeRef: docs.filter((d) => d.reasons.some((r) => r.kind === 'code-ref')).length,
      viaNode: docs.filter((d) => d.reasons.some((r) => r.kind === 'node')).length,
      linkedIr: linkIr !== undefined,
    },
    sample: docs.slice(0, SIGNAL_SAMPLE).map((d) => ({
      doc: d.doc,
      ...(d.title !== undefined ? { title: d.title } : {}),
      files: [...new Set(d.reasons.map((r) => r.file))],
    })),
    stalePath,
  };
}

function handleStatus(repoRoot: string): object {
  const store = new ArchitectureStore(repoRoot);
  const views: Record<string, unknown> = {};
  for (const view of ARCHITECTURE_VIEWS) {
    const prev = store.load(view);
    views[view] = prev ? previousRunSummary(prev) : null;
  }
  return { views };
}

/** `ges_architecture` 핸들러. LLM을 부르지 않고 세션이 만든 IR을 검증하고 그린다 */
export async function handleArchitecturePassthrough(
  input: ArchitectureInput,
  cwd: string = process.cwd(),
  opts: ArchitectureHandlerOptions = {},
): Promise<object> {
  const repoRoot = resolve(cwd, input.repoRoot ?? '.');
  switch (input.action) {
    case 'start':
      return handleStart(input, repoRoot, opts);
    case 'filter_tools':
      return handleFilterTools(input);
    case 'match_endpoints':
      return handleMatchEndpoints(input);
    case 'validate':
      return handleValidate(input, repoRoot);
    case 'render':
      return handleRender(input, repoRoot);
    case 'status':
      return handleStatus(repoRoot);
    case 'merge':
      return handleMerge(input, repoRoot);
    case 'scan_docs':
      return handleScanDocs(input, repoRoot);
    case 'link_docs':
      return handleLinkDocs(input, repoRoot);
    case 'stale_docs':
      return handleStaleDocs(input, repoRoot);
  }
}
