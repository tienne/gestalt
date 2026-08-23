import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { LocalPrEngine } from '../local-pr/engine.js';
import type { RegisteredRepo } from '../local-pr/registry.js';
import type { PullRequest } from '../local-pr/types.js';
import { generatePrDetailHtml, generatePrListHtml } from './html-generator.js';
import type { RepoTab } from './html-generator.js';

const REPO_KEY = '([0-9a-f]{8})';
const PR_LIST_PATH = new RegExp(`^/r/${REPO_KEY}/?$`);
const PR_DETAIL_PATH = new RegExp(`^/r/${REPO_KEY}/prs/([^/]+)$`);
const API_PR_LIST_PATH = new RegExp(`^/api/r/${REPO_KEY}/prs$`);
const API_PR_DETAIL_PATH = new RegExp(`^/api/r/${REPO_KEY}/prs/([^/]+)$`);

/**
 * 로컬 PR을 브라우저에서 읽는 HTTP 서버. 읽기 전용이다.
 *
 * graph-viz/server.ts와 같은 자리다. 다른 점은 데이터를 생성 시점에 한 번 굳히지
 * 않고 매 요청마다 LocalPrEngine에서 다시 읽는다는 것 — PR 목록은 서버가 떠 있는
 * 동안에도 다른 워커가 코멘트를 달거나 판정을 남기며 바뀐다.
 *
 * 레포 여럿을 한 서버가 보여준다. URL에 실리는 건 경로가 아니라 등록된 레포의
 * 키다 — 요청이 경로를 지정할 수 있으면 인증 없는 이 서버가 이 머신의 아무 git
 * 레포나 읽어주는 도구가 된다. 모르는 키는 404다.
 *
 * Routes:
 *   GET /                       → `pr serve`를 친 레포의 목록으로 302
 *   GET /r/:key                 → 그 레포의 PR 목록 HTML
 *   GET /r/:key/prs/:id         → PR 상세 HTML (diff, 코멘트 스레드, 라운드별 판정)
 *   GET /api/repos              → 등록된 레포 목록 JSON
 *   GET /api/r/:key/prs         → PR 목록 JSON
 *   GET /api/r/:key/prs/:id     → PR 상세 JSON
 *   *                           → 404
 */
export class PrWebServer {
  private server: Server | null = null;
  private sigintHandler: (() => void) | null = null;
  private diffCache = new DiffCache();

  /**
   * 레포 탭에 붙는 열린 PR 수. 마지막으로 센 값과 그 시각이다.
   *
   * 목록 페이지 한 번에 탭마다 `engine.list('open')`이 돌면 그 레포의 이벤트를
   * 통째로 다시 접는다. 배지 숫자 하나 때문에 PR 전체를 복원하는 셈이다. 그 비용이
   * 등록된 레포 수만큼 곱해진다.
   *
   * 이벤트 저장소에 집계 경로를 내는 길도 있었다. 안 골랐다 — `EventStore`는 로컬 PR
   * 바깥에서도 쓰는 공용 모듈이라 배지 하나 때문에 조회 API를 늘리게 된다. 여기서는
   * 짧은 TTL로 충분하다. 지금 보는 레포는 이 캐시를 아예 안 탄다 — 같은 요청이 이미
   * 만든 목록에서 센다. 그래서 뒤처질 수 있는 건 남의 레포 배지뿐이다.
   */
  private navCounts = new Map<string, { count: number; at: number }>();

  /** 남의 레포 배지를 붙잡아 두는 시간 */
  private static readonly NAV_COUNT_TTL_MS = 5_000;

  /**
   * @param engines 레포 키 → 엔진. 시작할 때 정해지고 요청이 못 늘린다
   * @param primaryKey `pr serve`를 친 자리의 레포. `/`가 여기로 보낸다
   */
  constructor(
    private engines: Map<string, { repo: RegisteredRepo; engine: LocalPrEngine }>,
    private primaryKey: string,
  ) {}

  /** Start the server on the given port. Resolves when listening. */
  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // 핸들러가 던지면 createServer 콜백을 빠져나가 uncaughtException으로 프로세스가
        // 죽는다. `GET /%` 한 번이면 되고 그건 임의 웹페이지가 img 태그로 보낼 수 있다.
        // 읽기 전용 뷰어가 원격 요청 하나에 내려가지 않게 여기서 접는다.
        try {
          this.handleRequest(req, res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[local-pr-web] request failed: ${msg}\n`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          res.end('Internal Server Error');
        }
      });

      this.server.once('error', reject);

      this.server.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);

        this.server!.on('error', (err) => {
          process.stderr.write(`[local-pr-web] server error: ${err.message}\n`);
        });

        this.registerSigintHandler();
        resolve();
      });
    });
  }

  /** Stop the server gracefully. Safe to call even if server was never started. */
  stop(): Promise<void> {
    this.removeSigintHandler();

    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }

  /** Port the server is listening on, or undefined if not started. */
  get port(): number | undefined {
    const addr = this.server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return undefined;
  }

  // ─── Private ───────────────────────────────────────────────────

  /** 퍼센트 인코딩이 깨져 있으면 null. 부르는 쪽이 400으로 접는다 */
  private static safeDecode(raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // 읽기 전용 서버라 GET과 HEAD만 받는다. 나머지는 404가 아니라 405로 답해야
    // 부르는 쪽이 "없는 자리"와 "여기선 못 하는 일"을 가릴 수 있다
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('Method Not Allowed');
      return;
    }

    // 127.0.0.1에만 바인딩해도 DNS 리바인딩은 남의 이름으로 이 자리에 닿는다.
    // Host를 함께 봐야 그 경로가 막힌다
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('Forbidden');
      return;
    }

    // 경로 전체를 먼저 디코딩하면 id 안의 %2F가 슬래시로 풀려 라우트가 갈라진다.
    // 목록 페이지가 링크를 encodeURIComponent로 만드는 것과 짝이 맞으려면
    // 정규식을 raw에 먼저 물리고 캡처된 세그먼트만 디코딩해야 한다
    const rawPath = (req.url ?? '/').split('?')[0]!;
    const path = PrWebServer.safeDecode(rawPath);
    if (path === null) {
      res.writeHead(400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('Bad Request');
      return;
    }

    if (path === '/') {
      res.writeHead(302, { Location: `/r/${this.primaryKey}` });
      res.end();
      return;
    }

    if (path === '/api/repos') {
      // path는 안 내보낸다. URL에 경로가 아니라 키만 싣기로 한 설계(registry.ts)를
      // 이 엔드포인트가 되돌리면 안 된다. 인증이 없는 서버라 응답도 같은 선을 지킨다
      this.sendJson(
        res,
        [...this.engines.values()].map((e) => ({
          key: e.repo.key,
          name: e.repo.name,
          addedAt: e.repo.addedAt,
        })),
      );
      return;
    }

    const apiList = rawPath.match(API_PR_LIST_PATH);
    if (apiList) {
      const held = this.engines.get(apiList[1]!);
      if (!held) return this.notFound(res);
      this.sendJson(res, held.engine.list());
      return;
    }

    const apiDetail = rawPath.match(API_PR_DETAIL_PATH);
    if (apiDetail) {
      const held = this.engines.get(apiDetail[1]!);
      const apiId = PrWebServer.safeDecode(apiDetail[2]!);
      const pr = held && apiId !== null ? held.engine.get(apiId) : null;
      if (!pr) return this.notFound(res);
      this.sendJson(res, pr);
      return;
    }

    const listMatch = rawPath.match(PR_LIST_PATH);
    if (listMatch) {
      const held = this.engines.get(listMatch[1]!);
      if (!held) return this.notFound(res);
      // 한 번만 접는다. 탭 숫자도 이 목록에서 센다
      const prs = held.engine.list();
      this.sendHtml(res, generatePrListHtml(prs, this.repoNav(listMatch[1]!, prs)));
      return;
    }

    const detailMatch = rawPath.match(PR_DETAIL_PATH);
    if (detailMatch) {
      const key = detailMatch[1]!;
      const held = this.engines.get(key);
      const id = PrWebServer.safeDecode(detailMatch[2]!);
      const pr = held && id !== null ? held.engine.get(id) : null;
      if (!pr || !held) return this.notFound(res);
      this.sendHtml(
        res,
        generatePrDetailHtml(pr, this.diffOf(key, held.engine, pr), key, held.repo.name),
      );
      return;
    }

    this.notFound(res);
  }

  /**
   * 레포 탭 줄. 지금 보는 레포의 숫자는 `activePrs`에서 세고 나머지는 TTL 캐시를 탄다.
   *
   * @param activePrs 이 요청이 이미 만든 목록. 같은 레포를 두 번 접지 않으려고 받는다
   */
  private repoNav(activeKey: string, activePrs: PullRequest[]): RepoTab[] {
    const now = Date.now();
    return [...this.engines.values()].map((e) => {
      const key = e.repo.key;
      let openCount: number;
      if (key === activeKey) {
        openCount = activePrs.filter((pr) => pr.status === 'open').length;
        this.navCounts.set(key, { count: openCount, at: now });
      } else {
        openCount = this.cachedOpenCount(key, e.engine, now);
      }
      return { key, name: e.repo.name, active: key === activeKey, openCount };
    });
  }

  private cachedOpenCount(key: string, engine: LocalPrEngine, now: number): number {
    const hit = this.navCounts.get(key);
    if (hit && now - hit.at < PrWebServer.NAV_COUNT_TTL_MS) return hit.count;

    const count = engine.list('open').length;
    this.navCounts.set(key, { count, at: now });
    return count;
  }

  /**
   * PR의 diff. 같은 sha 쌍이면 캐시에서 준다.
   *
   * 캐시 키에 레포를 함께 넣는다. 등록된 자리 둘이 같은 레포의 클론이면 sha 쌍이
   * 겹친다. 지금은 두 자리의 diff가 어차피 같다. 그래도 캐시가 레포 경계를 넘어
   * 값을 옮기는 구조 자체를 안 두는 편이 낫다. 한쪽에만 객체가 없는 경우처럼
   * 같은 sha가 다른 결과를 내는 자리가 있다.
   */
  private diffOf(
    repoKey: string,
    engine: LocalPrEngine,
    pr: { id: string; baseSha: string; headSha: string },
  ): string {
    // head가 옮겨가면 키가 갈린다. update가 headSha를 바꾸기 때문이다
    const key = `${repoKey}:${pr.baseSha}..${pr.headSha}`;
    const hit = this.diffCache.get(key);
    if (hit !== undefined) return hit;

    const diff = engine.diff(pr.id);
    this.diffCache.set(key, diff);
    return diff;
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
  }

  /**
   * JSON 응답.
   *
   * CORS 헤더를 안 붙인다. 이 API를 부르는 건 같은 오리진에서 뜬 자기 페이지뿐이라
   * 필요가 없다. 와일드카드를 열면 127.0.0.1 바인딩으로 얻은 격리가 풀린다 —
   * 사용자가 열어둔 아무 웹페이지나 리뷰 중인 비공개 소스를 읽어갈 수 있다.
   */
  private sendJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('Not Found');
  }

  private registerSigintHandler(): void {
    this.sigintHandler = () => {
      process.stderr.write('\n[local-pr-web] SIGINT received — shutting down server...\n');
      // finally로 받는다. close가 실패해도 프로세스는 끝나야 Ctrl+C가 먹는다
      void this.stop().finally(() => {
        process.exit(0);
      });
    };
    process.once('SIGINT', this.sigintHandler);
  }

  private removeSigintHandler(): void {
    if (this.sigintHandler) {
      process.off('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
  }
}

/**
 * diff 캐시.
 *
 * diff는 base와 head 두 sha에 대해 불변이라 캐시 키가 공짜로 주어져 있다. 안 쓰면
 * 새로고침마다 execFileSync로 git을 부르는데, 동기 spawn이라 그동안 이벤트 루프가
 * 통째로 멈춰 다른 요청도 함께 기다린다.
 *
 * 개수와 바이트를 함께 묶는다. 개수만 묶으면 `git.diff`의 maxBuffer가 64MB라
 * 32개가 이론상 2GB가 된다. 예산보다 큰 diff 하나는 아예 안 담는다 — 담아 봐야
 * 남은 걸 전부 밀어내고도 예산을 넘긴다.
 *
 * 상한을 생성자로 받는 건 테스트가 작은 값으로 밀어내기를 확인하려고 그렇다.
 */
export class DiffCache {
  private entries = new Map<string, string>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 32,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string): void {
    const size = Buffer.byteLength(value);
    if (size > this.maxBytes) return;

    const previous = this.entries.get(key);
    if (previous !== undefined) this.bytes -= Buffer.byteLength(previous);
    this.entries.set(key, value);
    this.bytes += size;

    // Map은 삽입 순서를 지킨다. 앞에서부터 걷어내면 오래된 것부터 나간다
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.bytes -= Buffer.byteLength(this.entries.get(oldest)!);
      this.entries.delete(oldest);
    }
  }

  /** 담고 있는 항목 수 */
  get size(): number {
    return this.entries.size;
  }

  /** 담고 있는 바이트 합 */
  get byteSize(): number {
    return this.bytes;
  }
}
