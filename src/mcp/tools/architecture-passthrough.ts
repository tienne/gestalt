import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGlobalContext } from '../../architecture/global-context.js';
import {
  maskValidatedIr,
  maskWarningMessages,
  secretMaskedWarnings,
} from '../../architecture/secret-mask.js';
import { resolveRepoVisibility, type RepoVisibility } from '../../architecture/repo-visibility.js';
import { applyCommitPolicy } from '../../architecture/commit-policy.js';
import {
  buildKnowledgeIr,
  scanDocRoots,
  summarizeScan,
  type DocRoot,
} from '../../architecture/doc-scan.js';
import { analyzeDocRoutes } from '../../architecture/doc-routes.js';
import { docCommitDates, summarizeFreshness } from '../../architecture/doc-fresh.js';
import { findStaleDocs, type ChangedFile } from '../../architecture/doc-stale.js';
import { ownersOf, readCodeowners, type CodeownersRule } from '../../architecture/codeowners.js';
import { linkDocs, type FileFacts } from '../../architecture/doc-link.js';
import type { DocScanResult } from '../../architecture/doc-scan.js';
import { matchEndpoints } from '../../architecture/endpoint-match.js';
import { matchMcpTools } from '../../architecture/mcp-tool-match.js';
import { matchNameRefs } from '../../architecture/name-ref-match.js';
import {
  computeArchitectureDelta,
  deltaCounts,
  deltaOverBudget,
  deltaScope,
  type ArchitectureDelta,
  type DeltaSnapshot,
} from '../../architecture/delta.js';
import {
  computeDeltaLayout,
  renderDeltaHtml,
  reuseDeltaLayout,
} from '../../architecture/delta-renderer.js';
import { computeDrilldown, shouldDrillDown } from '../../architecture/drilldown.js';
import { renderArchitectureHtml, renderDrilldownHtml } from '../../architecture/html-renderer.js';
import {
  ArchitectureLiveServer,
  type ArchitectureLiveServerDeps,
  type ArchitectureLiveServerOptions,
} from '../../architecture/live-server.js';
import { findUnknownFields, parseArchitectureIr } from '../../architecture/ir-schema.js';
import {
  iconModeFromEnv,
  resolveVendorIcons,
  type IconStats,
} from '../../architecture/vendor-icons.js';
import { assignStages, computeLayout } from '../../architecture/layout.js';
import { mergeArchitectureIrs } from '../../architecture/merge.js';
import {
  ArchitectureStore,
  mergeWithPreviousDetailed,
  previousRunSummary,
  type PreviousMergeReport,
} from '../../architecture/store.js';
import { createGitMoveFinder, readHead, viewFreshness } from '../../architecture/git-facts.js';
import {
  ARCHITECTURE_VIEWS,
  type ArchitectureIr,
  type ArchitectureView,
} from '../../architecture/types.js';
import {
  redactForSharing,
  validateArchitectureIr,
  type BudgetWarning,
  type IgnoredFileTrackedWarning,
  type FindMovedFile,
  type ValidatedIr,
  type ValidateArchitectureIrResult,
} from '../../architecture/validator.js';
import { writeJsonAtomic } from '../../core/json-file.js';
import { gestaltPath } from '../../core/home.js';
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
  /** UNKNOWN_FIELD가 가리키는 입력 JSON 경로 */
  path?: string;
  /** 쓰려던 것으로 보이는 값 하나 */
  suggestion?: string;
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

/**
 * strict는 세션이 막 쓴 IR을 받는 validate와 render에만 켠다. zod가 모르는 키를 버리면
 * 오타 칸(discription)이 에러 없이 사라지기 때문이다. 저장된 IR을 다시 읽는 자리(load, merge, 문서 액션)는
 * 예전 IR이 막히지 않게 그대로 느슨하게 둔다
 */
function unknownFieldErrors(raw: unknown): ArchitectureToolError[] {
  return findUnknownFields(raw).map((field) => ({
    code: 'UNKNOWN_FIELD',
    message:
      field.suggestion === undefined
        ? `${field.path}: 스키마에 없는 칸 "${field.key}"다. 지우거나 스키마의 칸 이름으로 고친다.`
        : `${field.path}: 스키마에 없는 칸 "${field.key}"다. "${field.suggestion}"의 오타인지 확인한다.`,
    path: field.path,
    ...(field.suggestion === undefined ? {} : { suggestion: field.suggestion }),
  }));
}

function prepareIr(input: ArchitectureInput, repoRoot: string, strict = false): Prepared {
  let raw: unknown = input.ir;
  if (raw === undefined && input.irPath !== undefined) {
    const read = readIrFile(input.irPath, repoRoot);
    if (!read.ok) return read;
    raw = read.raw;
  }
  if (raw === undefined)
    return fail('MISSING_INPUT', `${input.action}에는 ir이나 irPath가 필요하다.`);
  const unknown = strict ? unknownFieldErrors(raw) : [];
  const parsed = parseIr(raw);
  if (!parsed.ok) return { ok: false, errors: [...unknown, ...parsed.errors] };
  if (unknown.length > 0) return { ok: false, errors: unknown };
  const ir = parsed.ir;
  if (input.view !== undefined && input.view !== ir.view) {
    return fail('VIEW_MISMATCH', `view(${input.view})와 ir.view(${ir.view})가 다르다.`);
  }
  return { ok: true, ir, repoRoot };
}

function validate(
  ir: ArchitectureIr,
  repoRoot: string,
  checkFiles: boolean | undefined,
  findMoved?: FindMovedFile,
) {
  // IR의 root는 상대경로로 적히기도 한다. 서버 cwd가 아니라 repoRoot 기준으로 풀어야 근거 파일을 찾는다
  const repoRoots = Object.fromEntries(
    ir.repos.flatMap((r) =>
      r.root === undefined ? [] : [[r.id, isAbsolute(r.root) ? r.root : resolve(repoRoot, r.root)]],
    ),
  );
  return validateArchitectureIr(ir, { repoRoots, checkFiles, ...(findMoved ? { findMoved } : {}) });
}

/** 없는 근거 파일의 새 경로를 git rename 기록에서 찾는다. 지난 저장 IR의 head가 있으면 그 뒤만 본다 */
function moveFinderFor(prev: ArchitectureIr | null): FindMovedFile {
  const heads = new Map<string, string>();
  for (const r of prev?.repos ?? []) if (r.head !== undefined) heads.set(r.id, r.head);
  return createGitMoveFinder(heads);
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
  /** 레포 공개 여부 판정. 기본은 gh로 묻는다. 테스트는 네트워크 없이 돌게 바꿔 끼운다 */
  resolveVisibility?: (repoRoot: string) => RepoVisibility;
  /** serve가 띄울 라이브 서버의 포트와 세션 연결. 테스트는 0번 포트와 가짜 세션을 넣는다 */
  live?: ArchitectureLiveServerOptions & { deps?: ArchitectureLiveServerDeps };
}

// 레포마다 라이브 서버 하나. MCP 서버 프로세스가 살아 있는 동안 유지하고 다시 serve하면 같은 서버를 돌려준다
const liveServers = new Map<string, ArchitectureLiveServer>();

/** 떠 있는 라이브 서버를 전부 내린다. 테스트 정리용 */
export async function stopArchitectureLiveServers(): Promise<void> {
  const servers = [...liveServers.values()];
  liveServers.clear();
  await Promise.all(servers.map((s) => s.stop()));
}

function runningLiveServer(repoRoot: string): ArchitectureLiveServer | undefined {
  const server = liveServers.get(repoRoot);
  return server?.running ? server : undefined;
}

async function handleServe(
  input: ArchitectureInput,
  repoRoot: string,
  opts: ArchitectureHandlerOptions,
): Promise<object> {
  let server = liveServers.get(repoRoot);
  if (server === undefined) {
    server = new ArchitectureLiveServer(repoRoot, opts.live?.deps);
    liveServers.set(repoRoot, server);
  }
  let port: number;
  try {
    port = await server.start({
      ...(opts.live?.port !== undefined ? { port: opts.live.port } : {}),
      ...(opts.live?.attempts !== undefined ? { attempts: opts.live.attempts } : {}),
    });
  } catch (e) {
    liveServers.delete(repoRoot);
    return fail('SERVE_FAILED', `라이브 서버를 띄우지 못했다. ${(e as Error).message ?? e}`);
  }
  const store = new ArchitectureStore(repoRoot);
  // 이미 그린 본인용 HTML만 주소로 싣는다. 아직 안 그린 그림은 render 뒤에 열 수 있다
  const views = ARCHITECTURE_VIEWS.filter((v) => existsSync(store.htmlPath(v, 'private')));
  const session = server.sessionAlive();
  return {
    ok: true,
    url: server.url,
    port,
    session,
    ...(input.view !== undefined ? { liveUrl: server.liveUrl(input.view) } : {}),
    liveUrls: Object.fromEntries(views.map((v) => [v, server.liveUrl(v)])),
    ...(input.view !== undefined && !views.includes(input.view)
      ? { message: `${input.view} 그림이 아직 없다. render로 그린 뒤 liveUrl을 연다.` }
      : {}),
    ...(session
      ? {}
      : {
          warning:
            '그림을 띄운 Claude Code 세션을 찾지 못했다. 뷰어의 질문 입력창은 세션이 잡힐 때까지 숨겨진다.',
        }),
  };
}

interface CommitPolicyOutcome {
  visibility?: Pick<RepoVisibility, 'verdict' | 'source' | 'fallbackReason'>;
  ignoreFilePath?: string;
  warning?: IgnoredFileTrackedWarning;
}

/**
 * 그림을 저장한 뒤 공개 여부에 맞춰 커밋할 파일을 정한다. 보조 단계라 실패해도 render는 성공으로 둔다.
 * 판정은 됐는데 .gitignore 쓰기만 실패하면 판정 결과는 응답에 남긴다
 */
function commitPolicyAfterRender(
  repoRoot: string,
  opts: ArchitectureHandlerOptions,
): CommitPolicyOutcome {
  let visibility: RepoVisibility;
  try {
    visibility = (opts.resolveVisibility ?? resolveRepoVisibility)(repoRoot);
  } catch (e) {
    log(
      `architecture: 레포 공개 여부를 못 정해 커밋 정책을 건너뜁니다 (${(e as Error).message ?? e})`,
    );
    return {};
  }
  const summary = {
    verdict: visibility.verdict,
    source: visibility.source,
    ...(visibility.fallbackReason !== undefined
      ? { fallbackReason: visibility.fallbackReason }
      : {}),
  };
  try {
    const policy = applyCommitPolicy(repoRoot, visibility.verdict);
    return {
      visibility: summary,
      ...(policy.ignoreFilePath !== undefined ? { ignoreFilePath: policy.ignoreFilePath } : {}),
      ...(policy.trackedWarning !== undefined ? { warning: policy.trackedWarning } : {}),
    };
  } catch (e) {
    log(`architecture: .gitignore를 맞추지 못했습니다 (${(e as Error).message ?? e})`);
    return { visibility: summary };
  }
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
      'FE 호출과 BE 라우트가 모이면 match_endpoints로 이어 붙이고, validate로 확인한 뒤 render한다. 서버가 context-path나 global prefix를 붙이면 beRoutes의 mountPrefix에 적는다.',
      'match_endpoints의 suggested는 경로 뒤쪽이 닮은 후보일 뿐이다. 양쪽 줄을 읽어 같은 API일 때만 엣지를 긋고 후보 여럿을 추정 엣지로 만들지 않는다.',
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
  const endpoints = http
    ? matchEndpoints({
        feCalls: input.feCalls!,
        beRoutes: input.beRoutes!,
        prefixCandidates: input.prefixCandidates,
      })
    : null;
  const suggestedCalls = endpoints?.unmatched.filter((u) => u.suggested !== undefined).length ?? 0;
  return {
    ...(endpoints ?? {}),
    ...(suggestedCalls > 0
      ? {
          suggestedNote: `못 맞춘 호출 ${suggestedCalls}개에 suggested 후보가 있다. 점수로 고른 후보라 그대로 잇지 않는다. FE 호출 줄과 BE 라우트 줄을 읽어 같은 API일 때만 IR에 엣지를 적는다.`,
        }
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
  const prepared = prepareIr(input, repoRoot, true);
  if (!prepared.ok) return prepared;
  const prev = new ArchitectureStore(repoRoot).load(prepared.ir.view);
  const result = validate(prepared.ir, repoRoot, input.checkFiles, moveFinderFor(prev));
  if (!result.ok) return asFailure(result);
  const { drawableNodeIds, drawableEdgeIds, autoUnresolved, warnings } = result.value;
  const stats = computeStats(result.value);
  const signals = loopSignals(prepared.ir.view, stats);
  return {
    ok: true,
    errors: [],
    autoUnresolved,
    ...(warnings.length > 0 ? { warnings } : {}),
    drawable: { nodeIds: [...drawableNodeIds].sort(), edgeIds: [...drawableEdgeIds].sort() },
    stats,
    ...(signals.length > 0 ? { signals } : {}),
  };
}

/** 엔드포인트를 부르는 화면이 이보다 적으면 호출 사슬을 덜 따라간 것으로 본다 */
export const SCREEN_ENDPOINT_RATIO_THRESHOLD = 0.6;

export interface LoopSignal {
  code: 'SCREEN_ENDPOINT_RATIO_LOW';
  value: number;
  threshold: number;
  hint: string;
}

// 세션이 validate를 한 번 더 돌지 정할 수 있게 문턱을 넘은 수치만 싣는다
function loopSignals(view: string, stats: ReturnType<typeof computeStats>): LoopSignal[] {
  const ratio = stats.screenToEndpointRatio;
  if (view !== 'screen-chain' || ratio === null || ratio >= SCREEN_ENDPOINT_RATIO_THRESHOLD) {
    return [];
  }
  return [
    {
      code: 'SCREEN_ENDPOINT_RATIO_LOW',
      value: ratio,
      threshold: SCREEN_ENDPOINT_RATIO_THRESHOLD,
      hint: '엔드포인트를 부르는 화면이 적어요. 엔드포인트가 안 붙은 화면부터 호출 사슬을 다시 따라가요.',
    },
  ];
}

async function handleRender(
  input: ArchitectureInput,
  repoRoot: string,
  opts: ArchitectureHandlerOptions,
): Promise<object> {
  const prepared = prepareIr(input, repoRoot, true);
  if (!prepared.ok) return prepared;
  const store = new ArchitectureStore(repoRoot);
  const prev = store.load(prepared.ir.view);
  const findMoved = moveFinderFor(prev);
  const first = validate(prepared.ir, repoRoot, input.checkFiles, findMoved);
  if (!first.ok) return asFailure(first);

  const mergeResult = prev ? mergeWithPreviousDetailed(prev, prepared.ir) : null;
  const merged = mergeResult?.ir ?? prepared.ir;
  // 병합이 id를 바꾸므로 그린 대상도 병합 결과로 다시 뽑는다
  const second = validate(merged, repoRoot, input.checkFiles, findMoved);
  if (!second.ok) return asFailure(second);
  // excerpt를 코드와 대조하는 검증이 끝난 뒤에 가린다. 앞에서 가리면 가린 글자가 코드와 안 맞아 근거가 틀렸다고 나온다.
  // 이 뒤로는 그림, 저장, 공유본, delta가 전부 가린 사본만 본다
  const { validated, hits: secretHits } = maskValidatedIr(second.value);

  // 서비스가 그려지면 노드가 많아 평면 한 장으로는 못 읽는다. 레벨로 나눠 한 파일에 담는다
  const drilldown = shouldDrillDown(validated) ? await computeDrilldown(validated) : null;
  let privateHtml: string;
  let sharedHtml: string;
  let iconStats: IconStats | undefined;
  if (drilldown) {
    // 공유본과 원본이 같은 아이콘을 쓰도록 한 번만 푼다. 받기에 실패해도 그 아이콘만 내장 아이콘으로 돌아간다
    const iconKeys = drilldown.levels.flatMap((l) => l.infra?.iconKeys ?? []);
    const icons =
      iconKeys.length > 0
        ? await resolveVendorIcons(iconKeys, {
            cacheDir: gestaltPath('architecture-icons'),
            mode: iconModeFromEnv(),
          })
        : undefined;
    iconStats = icons?.stats;
    const iconOpt = icons !== undefined ? { icons } : {};
    privateHtml = renderDrilldownHtml(validated, drilldown, { audience: 'private', ...iconOpt });
    sharedHtml = renderDrilldownHtml(validated, drilldown, { audience: 'shared', ...iconOpt });
  } else {
    const layout = await computeLayout(
      validated.ir,
      validated.drawableNodeIds,
      validated.drawableEdgeIds,
    );
    privateHtml = renderArchitectureHtml(validated, layout, { audience: 'private' });
    sharedHtml = renderArchitectureHtml(validated, layout, { audience: 'shared' });
  }

  // 자동 질문도 저장해 둬야 사람이 답을 달고 다음 실행이 그 답을 물려받는다.
  // 커밋 해시는 저장 IR에만 남긴다. HTML에 넣으면 커밋마다 바이트가 바뀌어 결정적 렌더가 깨진다
  const toSave = {
    ...validated.ir,
    repos: withRepoHeads(validated.ir.repos, repoRoot),
    unresolved: [...validated.ir.unresolved, ...validated.autoUnresolved],
  };
  const irPath = store.save(toSave);
  const viewPaths = store.saveViews(toSave);
  const view: ArchitectureView = validated.ir.view;
  const htmlPath = store.saveHtml(view, 'private', privateHtml);
  const sharedHtmlPath = store.saveHtml(view, 'shared', sharedHtml);
  log(`architecture: rendered ${view} → ${htmlPath}`);
  const delta = await renderDelta(prev, validated, repoRoot, store).catch(
    (e: unknown): { result: object; warning?: BudgetWarning } => {
      // 보조 산출물이라 메인 그림은 이미 저장됐다. 여기서 던지면 성공한 render가 실패로 보인다
      const message = e instanceof Error ? e.message : String(e);
      log(`architecture: delta ${view} failed: ${message}`);
      return {
        result: { status: 'failed', message: `구조 변경 그림을 만들지 못했다. ${message}` },
      };
    },
  );
  const commit = commitPolicyAfterRender(repoRoot, opts);
  const live = runningLiveServer(repoRoot);
  const warnings = [
    ...maskWarningMessages(validated.warnings),
    ...maskWarningMessages(mergeResult?.report.warnings ?? []),
    ...secretMaskedWarnings(secretHits),
    ...(delta.warning ? maskWarningMessages([delta.warning]) : []),
    ...(commit.warning ? [commit.warning] : []),
  ];

  return {
    ok: true,
    irPath,
    htmlPath,
    sharedHtmlPath,
    openPath: input.audience === 'shared' ? sharedHtmlPath : htmlPath,
    ...(viewPaths.length > 0 ? { viewPaths } : {}),
    // 라이브 서버가 떠 있을 때만 싣는다. 열린 뷰어는 이 주소에서 ETag 변화를 보고 스스로 갱신한다
    ...(live !== undefined ? { liveUrl: live.liveUrl(view) } : {}),
    ...(commit.visibility ? { visibility: commit.visibility } : {}),
    ...(commit.ignoreFilePath !== undefined ? { ignoreFilePath: commit.ignoreFilePath } : {}),
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
    stats: {
      ...computeStats(validated),
      ...(iconStats !== undefined ? { iconStats } : {}),
    },
    delta: delta.result,
    ...(mergeResult ? { merge: mergeSummary(mergeResult.report) } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    sourcesUsed: validated.ir.sourcesUsed,
  };
}

function absRepoRoot(repo: ArchitectureIr['repos'][number], repoRoot: string): string {
  if (repo.root === undefined) return repoRoot;
  return isAbsolute(repo.root) ? repo.root : resolve(repoRoot, repo.root);
}

/** 레포마다 지금 HEAD를 적는다. git이 아니면 head를 빼서 옛 값이 지금 것처럼 남지 않게 한다 */
function withRepoHeads(repos: ArchitectureIr['repos'], repoRoot: string): ArchitectureIr['repos'] {
  return repos.map((r) => {
    const { head: _old, ...rest } = r;
    const head = readHead(absRepoRoot(r, repoRoot));
    return head === undefined ? rest : { ...rest, head };
  });
}

function mergeSummary(report: PreviousMergeReport) {
  return {
    descriptionCarried: report.descriptionCarried.length,
    // 0이면 키를 안 넣는다. summary를 안 쓰는 예전 흐름의 응답이 그대로다
    ...(report.summaryCarried.length > 0 ? { summaryCarried: report.summaryCarried.length } : {}),
    ...(report.topLevelCarried.length > 0 ? { topLevelCarried: report.topLevelCarried } : {}),
    ...(report.relabeled.length > 0 ? { relabeled: report.relabeled } : {}),
    ...(report.flowsCarried.length > 0 ? { flowsCarried: report.flowsCarried } : {}),
    ...(report.flowsDropped.length > 0 ? { flowsDropped: report.flowsDropped } : {}),
  };
}

function deltaSnapshot(v: ValidatedIr, redact = false): DeltaSnapshot {
  return {
    ir: redact ? redactForSharing(v.ir) : v.ir,
    nodeIds: v.drawableNodeIds,
    edgeIds: v.drawableEdgeIds,
  };
}

function changeCounts(delta: ArchitectureDelta): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of delta.ledger) counts[e.change] = (counts[e.change] ?? 0) + 1;
  return counts;
}

/**
 * 병합 전에 읽은 이전 IR을 Before로, 이번 병합 결과를 After로 놓고 구조 변경 그림을 쓴다.
 * 바뀐 게 없으면 옛 delta 파일을 건드리지 않는다. 그 파일은 마지막으로 구조가 바뀐 실행의 기록이다
 */
async function renderDelta(
  prev: ArchitectureIr | null,
  next: ValidatedIr,
  repoRoot: string,
  store: ArchitectureStore,
): Promise<{ result: object; warning?: BudgetWarning }> {
  if (prev === null) {
    return { result: { status: 'no_previous', message: '비교할 이전 그림이 없다.' } };
  }
  // 이전 IR은 그때 이미 근거 파일을 확인했다. 그 뒤 옮겨진 파일 때문에 비교 자체가 막히면 안 된다
  const before = validate(prev, repoRoot, false);
  if (!before.ok) {
    return {
      result: {
        status: 'no_previous',
        message: '비교할 이전 그림이 없다. 저장된 이전 IR이 지금 검증 규칙을 통과하지 못했다.',
      },
    };
  }
  // 예전 실행이 가림 없이 저장한 IR일 수 있어 이전 쪽도 가린 뒤 비교한다. 경고는 이번 IR 것만 낸다
  const prevMasked = maskValidatedIr(before.value).validated;
  const delta = computeArchitectureDelta(deltaSnapshot(prevMasked), deltaSnapshot(next));
  if (delta.ledger.length === 0) {
    return { result: { status: 'unchanged', message: '이전 그림과 구조가 같다.' } };
  }
  const scope = deltaScope(delta);
  const view = next.ir.view;
  const privateLayout = await computeDeltaLayout(delta, scope);
  // 가린 글자끼리 다시 비교해야 공유본 원장에 계정 ID 같은 원문이 옛 값으로 새지 않는다
  const shared = computeArchitectureDelta(
    deltaSnapshot(prevMasked, true),
    deltaSnapshot(next, true),
  );
  const sharedScope = deltaScope(shared);
  const sharedLayout = await reuseDeltaLayout(privateLayout, shared, sharedScope);
  // 둘 다 그린 뒤에 쓴다. 한쪽만 쓰고 실패하면 두 파일이 서로 다른 실행의 것이 된다
  const privateHtml = renderDeltaHtml(delta, scope, privateLayout, { audience: 'private' });
  const sharedHtml = renderDeltaHtml(shared, sharedScope, sharedLayout, { audience: 'shared' });
  const htmlPath = store.saveDeltaHtml(view, 'private', privateHtml);
  const sharedHtmlPath = store.saveDeltaHtml(view, 'shared', sharedHtml);
  log(`architecture: delta ${view} → ${htmlPath}`);
  const counts = deltaCounts(delta, scope);
  const over = deltaOverBudget(counts);
  return {
    result: {
      status: 'created',
      htmlPath,
      sharedHtmlPath,
      changes: changeCounts(delta),
      ...(scope.scoped
        ? {
            scoped: {
              drawnComponents: scope.nodeIds.size,
              totalComponents: scope.total.components,
            },
          }
        : {}),
    },
    ...(over.length > 0
      ? {
          warning: {
            code: 'DELTA_OVER_BUDGET' as const,
            message: `구조 변경 그림이 한 장에 읽히는 양을 넘는다. ${over.join(', ')}. 바뀐 영역을 나눠 단계별로 다시 그린다.`,
            subjectId: view,
            counts: { ...counts },
          },
        }
      : {}),
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
    mountPrefixes: input.mountPrefixes,
  });
  if (!result.ok) return result;
  const unlinked = result.report.unlinkedEndpoints?.length ?? 0;
  const nextAction =
    '합친 IR을 validate로 확인한 뒤 render한다. render는 repoRoot의 같은 뷰 IR과 병합하므로 원래 분석 레포가 아닌 따로 둔 디렉토리를 repoRoot로 준다.' +
    (unlinked > 0
      ? ` report.unlinkedEndpoints의 ${unlinked}개는 다른 분석에서 받는 핸들러를 못 찾은 FE 엔드포인트다. 오류가 아니라 알림이다. suggested가 있으면 양쪽 줄을 읽어 같은 API일 때만 엣지를 더한다.`
      : '');
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
  // 머리줄에 수정일을 안 적는 문서가 많아서 git이 아는 마지막 커밋 날짜를 함께 싣는다. 루트마다 log 한 번이다
  for (const r of roots) {
    const dates = docCommitDates(r.path);
    for (const d of scan.docs) {
      const at = d.repoId === r.repoId ? dates.get(d.path) : undefined;
      if (at !== undefined) d.committedAt = at;
    }
  }
  const now = new Date().toISOString();
  const dir = resolve(repoRoot, '.gestalt', 'architecture');
  const scanPath = resolve(dir, 'doc-scan.json');
  const draftPath = resolve(dir, 'knowledge.draft.json');
  writeJsonAtomic(scanPath, {
    ...scan,
    roots: roots.map((r) => ({ repoId: r.repoId, name: r.name, path: r.path })),
  });
  writeJsonAtomic(draftPath, buildKnowledgeIr(roots, scan, now));
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
    summary: {
      ...summarizeScan(scan),
      questionRoutes,
      freshness: summarizeFreshness(scan.docs, now),
    },
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
          execFileSync(
            'git',
            ['-C', abs, 'log', '-1', '--format=%cd', '--date=short', '--', path],
            {
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'ignore'],
            },
          ).trim() || undefined;
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
    views[view] = prev
      ? {
          ...previousRunSummary(prev),
          freshness: viewFreshness(prev, (r) => absRepoRoot(r, repoRoot)),
        }
      : null;
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
      return handleRender(input, repoRoot, opts);
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
    case 'serve':
      return handleServe(input, repoRoot, opts);
  }
}
