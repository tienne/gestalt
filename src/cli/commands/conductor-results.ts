import { loadConfig } from '../../core/config.js';
import { findAvailablePort } from '../../graph-viz/port-finder.js';
import {
  getOrderDetail,
  listOrders,
  loadResults,
  parseSince,
  readRefBody,
  resolveOrderId,
  searchResults,
  type ClassifiedRef,
  type FileBody,
  type LoadedResults,
  type ResultFilters,
} from '../../conductor/results.js';
import { resolveStateDir } from '../../conductor/state-dir.js';
import { ORDER_STATUSES } from '../../conductor/types.js';
import { terminalBody, terminalText } from '../../conductor/terminal-text.js';
import { ConductorWebServer } from '../../conductor-web/server.js';

/**
 * `gestalt conductor results`와 `browse` — 컨덕터 결과를 찾아보는 읽기 전용 명령.
 * 저장소에 아무것도 쓰지 않으니 tick 잠금을 잡지 않고 언제 불러도 된다.
 */

export interface ResultsCommonOptions {
  stateDir?: string;
  json?: boolean;
}

export interface ResultsFilterOptions extends ResultsCommonOptions {
  repo?: string;
  status?: string;
  since?: string;
  limit?: string;
}

/** 이 browse 서버는 digest serve(7893부터)와 겹치지 않게 7894부터 빈 포트를 찾는다 */
const DEFAULT_BROWSE_PORT = 7894;

const KIND_LABEL: Record<ClassifiedRef['kind'], string> = {
  file: '파일',
  dir: '디렉토리',
  url: '링크',
  outside: '바깥',
  missing: '없음',
  unsupported: '형식',
  reference: '참조',
};

function load(opts: ResultsCommonOptions): LoadedResults {
  const config = loadConfig().conductor;
  return loadResults({
    stateDir: resolveStateDir(opts.stateDir, config),
    repoPaths: config.repoPaths,
  });
}

function filtersOf(opts: ResultsFilterOptions): ResultFilters {
  if (opts.status && !(ORDER_STATUSES as readonly string[]).includes(opts.status)) {
    throw new Error(`--status는 ${ORDER_STATUSES.join(', ')} 중 하나예요: ${opts.status}`);
  }
  if (opts.since) parseSince(opts.since);
  return {
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.since ? { since: opts.since } : {}),
  };
}

function limitOf(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--limit는 1 이상의 정수여야 해요: ${v}`);
  return n;
}

/** 한 줄 칸. 개행까지 공백으로 접는다 */
function cell(text: string): string {
  return terminalText(text).replace(/\s*\n\s*/g, ' ');
}

/** 로컬 시각 `YYYY-MM-DD HH:mm` */
function stamp(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return cell(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function kb(size: number | undefined): string {
  if (size === undefined) return '';
  return size < 1024 ? `${size}B` : `${Math.round(size / 1024)}KB`;
}

function print(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function run(body: () => void): void {
  try {
    body();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

export function conductorResultsListCommand(opts: ResultsFilterOptions): void {
  run(() => {
    const filters = filtersOf(opts);
    const limit = limitOf(opts.limit, 30);
    const results = load(opts);
    const { total, orders } = listOrders(results, filters);
    const shown = orders.slice(0, limit);
    if (opts.json) return print({ total, orders: shown });
    if (total === 0) return console.log('맞는 주문이 없어요');
    console.log(`주문 ${total}개 중 ${shown.length}개 (최근 갱신순)`);
    const repoWidth = Math.max(...shown.map((o) => cell(o.repo).length));
    for (const o of shown) {
      console.log(
        [
          o.id,
          o.status.padEnd(12),
          cell(o.repo).padEnd(repoWidth),
          stamp(o.updatedAt).slice(0, 10),
          `보고 ${o.reportCount}`.padEnd(6),
          `참조 ${o.refCount}`.padEnd(6),
          cell(o.title),
        ].join('  '),
      );
    }
  });
}

export interface ResultsSearchOptions extends ResultsFilterOptions {
  /** commander가 `--no-body`를 body: false로 준다 */
  body?: boolean;
}

export function conductorResultsSearchCommand(query: string, opts: ResultsSearchOptions): void {
  run(() => {
    if (!query.trim()) throw new Error('찾을 말을 적어 주세요');
    const filters = filtersOf(opts);
    const limit = limitOf(opts.limit, 20);
    const results = load(opts);
    const found = searchResults(results, query, { ...filters, body: opts.body !== false, limit });
    if (opts.json) return print(found);
    // 0건이어도 큰 파일 뒷부분엔 있을 수 있어 0건 안내보다 먼저 알린다
    if (found.partialFiles) console.log('큰 파일은 앞부분만 찾았어요');
    if (found.total === 0) return console.log(`"${cell(found.query)}"에 맞는 결과가 없어요`);
    const count =
      found.total > found.hits.length
        ? `전체 ${found.total}건 중 ${found.hits.length}건만 보여요`
        : `${found.total}건`;
    console.log(`"${cell(found.query)}" 결과 ${count}`);
    let lastHead = '';
    for (const h of found.hits) {
      const head = h.orderId
        ? `${h.orderId}  ${cell(h.repo ?? '')}  ${cell(h.title)}`
        : `주문 없음  ${cell(h.where)}`;
      if (head !== lastHead) {
        console.log('');
        console.log(head);
        lastHead = head;
      }
      const where =
        h.source === 'title'
          ? '제목'
          : h.source === 'summary'
            ? `요약 #${h.reportIndex}`
            : `${cell(h.where)}${h.line ? `:${h.line}` : ''}`;
      const more = h.moreInFile ? `  (이 파일에 ${h.moreInFile}건 더)` : '';
      console.log(`  ${stamp(h.at)}  ${where}${more}`);
      console.log(`    ${cell(h.excerpt)}`);
    }
  });
}

export interface ResultsShowOptions extends ResultsCommonOptions {
  report?: string;
  /** commander가 `--no-body`를 body: false로 준다 */
  body?: boolean;
}

export function conductorResultsShowCommand(id: string, opts: ResultsShowOptions): void {
  run(() => {
    const results = load(opts);
    const resolved = resolveOrderId(results, id);
    if (!resolved.ok) {
      if (resolved.reason === 'removed') throw new Error(`지운 주문이에요: ${id}`);
      if (resolved.reason === 'ambiguous') {
        const list = resolved.candidates.slice(0, 10).join(', ');
        const rest =
          resolved.candidates.length > 10 ? ` 외 ${resolved.candidates.length - 10}개` : '';
        throw new Error(`${id}로 시작하는 주문이 여럿이에요: ${list}${rest}`);
      }
      throw new Error(`모르는 주문이에요: ${id}`);
    }
    const detail = getOrderDetail(results, resolved.id)!;
    let reportNo: number | undefined;
    if (opts.report !== undefined) {
      reportNo = Number(opts.report);
      if (!Number.isInteger(reportNo) || reportNo < 1 || reportNo > detail.reports.length) {
        throw new Error(`--report는 1부터 ${detail.reports.length} 사이여야 해요: ${opts.report}`);
      }
    }
    const reports =
      reportNo === undefined ? detail.reports : detail.reports.filter((r) => r.index === reportNo);
    const citedRefs = new Set(reports.flatMap((r) => r.refs));
    const refs =
      reportNo === undefined ? detail.refs : detail.refs.filter((r) => citedRefs.has(r.ref));
    const withBody = opts.body !== false;
    const bodies = new Map<number, FileBody | null>();
    if (withBody) {
      for (const r of refs)
        if (r.kind === 'file') bodies.set(r.index, readRefBody(results, resolved.id, r));
    }
    const related = reportNo === undefined ? detail.related : [];

    if (opts.json) {
      return print({
        order: detail.order,
        workers: detail.workers,
        reports,
        gates: detail.gates,
        bypasses: detail.bypasses,
        refs: refs.map((r) => ({
          ...r,
          ...(bodies.get(r.index) ? { body: bodies.get(r.index) } : {}),
        })),
        related,
      });
    }

    const o = detail.order;
    console.log(`${o.id}  ${cell(o.title)}`);
    console.log(`  레포: ${cell(o.repo)}  상태: ${o.status}  범위: ${o.scope}`);
    console.log(`  지라: ${o.issueKey ?? '없음'}  PR: ${o.prRef ? cell(o.prRef) : '없음'}`);
    console.log(`  생성: ${stamp(o.createdAt)}  갱신: ${stamp(o.updatedAt)}`);

    console.log('');
    console.log(
      reportNo === undefined
        ? `보고 이력 (${detail.reports.length}건)`
        : `보고 #${reportNo} (전체 ${detail.reports.length}건 중)`,
    );
    if (reports.length === 0) console.log('  없음');
    for (const r of reports) {
      const extra = [r.skill, r.prRef ? `PR ${cell(r.prRef)}` : undefined]
        .filter(Boolean)
        .join('  ');
      console.log(
        `  #${r.index}  ${stamp(r.at)}  ${r.workerId}  ${r.status}${extra ? `  ${extra}` : ''}`,
      );
      console.log(`    ${terminalText(r.summary)}`);
      if (r.need) console.log(`    필요: ${r.need.kind}  ${terminalText(r.need.detail)}`);
    }

    if (reportNo === undefined && detail.gates.length > 0) {
      console.log('');
      console.log(`사람 확인 (${detail.gates.length})`);
      for (const g of detail.gates) {
        console.log(
          `  ${g.id}  ${g.type}  ${g.status}${g.decision ? `  ${g.decision}` : ''}  ${stamp(g.openedAt)}`,
        );
        console.log(`    ${terminalText(g.reason)}`);
        if (g.answer) console.log(`    답: ${terminalText(g.answer)}`);
      }
    }
    if (reportNo === undefined && detail.bypasses.length > 0) {
      console.log('');
      console.log(`bypass (${detail.bypasses.length})`);
      for (const b of detail.bypasses) {
        console.log(`  ${stamp(b.at)}  ${b.need}${b.step ? `/${b.step}` : ''}  ${cell(b.action)}`);
      }
    }

    console.log('');
    console.log(`참조 (${refs.length})`);
    if (refs.length === 0) console.log('  없음');
    for (const r of refs) {
      const size = r.size !== undefined ? `  ${kb(r.size)}` : '';
      const note = r.kind === 'outside' ? '  (허용 범위 밖이라 본문을 안 읽어요)' : '';
      console.log(`  [${r.index}] ${KIND_LABEL[r.kind]}  ${cell(r.display)}${size}${note}`);
      for (const e of r.entries ?? []) console.log(`        ${cell(e.name)}  ${kb(e.size)}`);
      if (r.entriesTotal !== undefined && r.entriesTotal > (r.entries?.length ?? 0)) {
        console.log(`        (파일 ${r.entriesTotal}개 중 ${r.entries?.length ?? 0}개만 보여요)`);
      }
    }

    if (related.length > 0) {
      console.log('');
      console.log(
        `관련 파일 (${related.length})  이름에 이 주문 id가 있는 저장소 파일이에요. 본문은 browse에서 읽어요`,
      );
      for (const f of related) console.log(`  ${cell(f.rel)}  ${kb(f.size)}`);
    }

    if (!withBody) return;
    for (const r of refs) {
      const b = bodies.get(r.index);
      if (b) printBody(`[${r.index}] ${cell(r.display)}`, b);
    }
  });
}

function printBody(title: string, body: FileBody): void {
  console.log('');
  console.log(`── ${title} ──`);
  if (body.truncated) {
    console.log(
      `(파일이 커서 앞 ${kb(Buffer.byteLength(body.text))}만 보여요. 전체 ${kb(body.size)})`,
    );
  }
  console.log(terminalBody(body.text).replace(/\n+$/, ''));
}

export interface BrowseOptions {
  stateDir?: string;
  port?: string;
  /** commander가 `--no-open`을 open: false로 준다 */
  open?: boolean;
}

export async function conductorBrowseCommand(opts: BrowseOptions): Promise<void> {
  let port: number;
  let server: ConductorWebServer;
  try {
    if (opts.port !== undefined && !/^\d{1,5}$/.test(opts.port)) {
      throw new Error(`--port는 0 이상의 정수여야 해요: ${opts.port}`);
    }
    const requested = opts.port === undefined ? undefined : Number(opts.port);
    const config = loadConfig().conductor;
    server = new ConductorWebServer({
      stateDir: resolveStateDir(opts.stateDir, config),
      repoPaths: config.repoPaths,
    });
    port = requested === 0 ? 0 : await findAvailablePort(requested ?? DEFAULT_BROWSE_PORT);
    await server.start(port);
  } catch (e) {
    console.error(`결과 뷰어를 못 띄웠어요: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${server.port ?? port}`;
  console.log(`컨덕터 결과 뷰어: ${url}`);
  console.log('Ctrl+C로 멈춰요.');
  if (opts.open !== false) await openUrl(url);
  // 서버의 SIGINT 핸들러가 프로세스를 끝낼 때까지 살려 둔다
  await new Promise<void>(() => {});
}

async function openUrl(url: string): Promise<void> {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch (err) {
    console.error(`브라우저를 못 열었어요. 주소를 직접 열어 주세요: ${(err as Error).message}`);
  }
}
