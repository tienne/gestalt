import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGlobalContext } from '../../architecture/global-context.js';
import { matchEndpoints } from '../../architecture/endpoint-match.js';
import { matchMcpTools } from '../../architecture/mcp-tool-match.js';
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
    ir.repos.map((r) => [r.id, isAbsolute(r.root) ? r.root : resolve(repoRoot, r.root)]),
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
  if (!http && !mcp) {
    return fail(
      'MISSING_INPUT',
      'match_endpoints에는 feCalls와 beRoutes, 또는 skillToolCalls와 serverTools가 필요하다.',
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
  const irPath = store.save({
    ...validated.ir,
    unresolved: [...validated.ir.unresolved, ...validated.autoUnresolved],
  });
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
  }
}
